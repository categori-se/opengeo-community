import asyncio
import ipaddress
import socket
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from time import monotonic
from typing import Any, Literal, Protocol, cast

VerificationErrorCode = Literal[
    "credentials_rejected",
    "dns_resolution_failed",
    "postgis_required",
    "tls_verification_failed",
    "unsafe_network_target",
    "verification_cancelled",
    "verification_failed",
    "verification_timeout",
]

_MAX_DNS_ANSWERS = 8
_MAX_PINNED_ATTEMPTS = 2
_FIXED_PROBE_SQL = """
SELECT
  current_setting('transaction_read_only') = 'on' AS transaction_read_only,
  COALESCE(
    (SELECT ssl FROM pg_catalog.pg_stat_ssl WHERE pid = pg_catalog.pg_backend_pid()),
    false
  ) AS tls_active,
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'postgis'
  ) AS postgis_installed
""".strip()


class VerificationFailure(RuntimeError):
    def __init__(
        self,
        code: VerificationErrorCode,
        *,
        network_reachable: bool = False,
        tls_verified: bool = False,
        credentials_verified: bool = False,
    ) -> None:
        self.code = code
        self.network_reachable = network_reachable
        self.tls_verified = tls_verified
        self.credentials_verified = credentials_verified
        super().__init__(code)


@dataclass(frozen=True, slots=True, repr=False)
class PostgreSqlCredentials:
    username: str
    password: str


@dataclass(frozen=True, slots=True)
class PostgreSqlVerificationTarget:
    host: str
    port: int
    database_name: str
    tls_mode: str = "verify_full"
    network_mode: str = "public_internet"


@dataclass(frozen=True, slots=True)
class VerificationOutcome:
    succeeded: bool
    network_reachable: bool
    tls_verified: bool
    credentials_verified: bool
    postgis_verified: bool
    sanitized_error_code: VerificationErrorCode | None
    duration_ms: int


class AddressResolver(Protocol):
    async def resolve(self, host: str, port: int) -> tuple[str, ...]: ...


class PostgreSqlProbe(Protocol):
    async def probe(
        self,
        target: PostgreSqlVerificationTarget,
        credentials: PostgreSqlCredentials,
        pinned_address: str,
    ) -> None: ...


class SystemAddressResolver:
    async def resolve(self, host: str, port: int) -> tuple[str, ...]:
        loop = asyncio.get_running_loop()
        try:
            answers = await loop.getaddrinfo(
                host,
                port,
                family=socket.AF_UNSPEC,
                type=socket.SOCK_STREAM,
                proto=socket.IPPROTO_TCP,
            )
        except (socket.gaierror, TimeoutError, OSError) as error:
            raise VerificationFailure("dns_resolution_failed") from error
        addresses = tuple(dict.fromkeys(cast(str, answer[4][0]) for answer in answers))
        if not addresses or len(addresses) > _MAX_DNS_ANSWERS:
            raise VerificationFailure("dns_resolution_failed")
        if any(not public_connection_address(address) for address in addresses):
            raise VerificationFailure("unsafe_network_target")
        return addresses


def public_connection_address(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    return bool(
        address.is_global
        and not address.is_loopback
        and not address.is_link_local
        and not address.is_multicast
        and not address.is_private
        and not address.is_reserved
        and not address.is_unspecified
    )


class PsycopgPostgreSqlProbe:
    async def probe(
        self,
        target: PostgreSqlVerificationTarget,
        credentials: PostgreSqlCredentials,
        pinned_address: str,
    ) -> None:
        async with verified_postgresql_connection(target, credentials, pinned_address):
            pass


@asynccontextmanager
async def verified_postgresql_connection(
    target: PostgreSqlVerificationTarget,
    credentials: PostgreSqlCredentials,
    pinned_address: str,
) -> AsyncIterator[Any]:
    """Share the verifier's fixed connection policy with isolated catalog reads."""
    import psycopg

    connection: psycopg.AsyncConnection[Any] | None = None
    try:
        connection = await psycopg.AsyncConnection.connect(
            host=target.host,
            hostaddr=pinned_address,
            port=target.port,
            dbname=target.database_name,
            user=credentials.username,
            password=credentials.password,
            sslmode="verify-full",
            sslrootcert="system",
            connect_timeout=4,
            target_session_attrs="read-only",
            application_name="opengeo-connection-verifier",
            options=(
                "-c default_transaction_read_only=on "
                "-c statement_timeout=4000 "
                "-c lock_timeout=1000 "
                "-c idle_in_transaction_session_timeout=4000"
            ),
            autocommit=False,
        )
        async with connection.cursor() as cursor:
            await cursor.execute(_FIXED_PROBE_SQL)
            row = await cursor.fetchone()
        if row is None or len(row) != 3:
            raise VerificationFailure("verification_failed", network_reachable=True)
        read_only, tls_active, postgis_installed = (bool(value) for value in row)
        if not read_only:
            raise VerificationFailure(
                "verification_failed",
                network_reachable=True,
                tls_verified=tls_active,
                credentials_verified=True,
            )
        if not tls_active:
            raise VerificationFailure(
                "tls_verification_failed",
                network_reachable=True,
                credentials_verified=True,
            )
        if not postgis_installed:
            raise VerificationFailure(
                "postgis_required",
                network_reachable=True,
                tls_verified=True,
                credentials_verified=True,
            )
    except (asyncio.CancelledError, VerificationFailure):
        raise
    except Exception as error:
        raise _classify_driver_failure(error) from None
    else:
        yield connection
    finally:
        if connection is not None:
            pending_error = sys.exception()
            try:
                try:
                    await connection.rollback()
                finally:
                    await connection.close()
            except asyncio.CancelledError:
                raise
            except Exception as error:
                if pending_error is None:
                    raise _classify_driver_failure(error) from None


class PostgreSqlConnectionVerifier:
    def __init__(
        self,
        *,
        resolver: AddressResolver | None = None,
        probe: PostgreSqlProbe | None = None,
        timeout_seconds: float = 12.0,
    ) -> None:
        if not 1.0 <= timeout_seconds <= 20.0:
            raise ValueError("verification timeout must be between 1 and 20 seconds")
        self._resolver = resolver or SystemAddressResolver()
        self._probe = probe or PsycopgPostgreSqlProbe()
        self._timeout_seconds = timeout_seconds

    async def verify(
        self,
        target: PostgreSqlVerificationTarget,
        credentials: PostgreSqlCredentials,
    ) -> VerificationOutcome:
        started = monotonic()
        if target.tls_mode != "verify_full" or target.network_mode != "public_internet":
            return self._failure(started, VerificationFailure("verification_failed"))
        try:
            async with asyncio.timeout(self._timeout_seconds):
                addresses = await self._resolver.resolve(target.host, target.port)
                last_failure: VerificationFailure | None = None
                for address in addresses[:_MAX_PINNED_ATTEMPTS]:
                    try:
                        await self._probe.probe(target, credentials, address)
                    except VerificationFailure as error:
                        last_failure = error
                        if error.code in {
                            "credentials_rejected",
                            "postgis_required",
                            "tls_verification_failed",
                        }:
                            break
                    else:
                        return VerificationOutcome(
                            succeeded=True,
                            network_reachable=True,
                            tls_verified=True,
                            credentials_verified=True,
                            postgis_verified=True,
                            sanitized_error_code=None,
                            duration_ms=_bounded_duration(started),
                        )
                return self._failure(
                    started,
                    last_failure or VerificationFailure("verification_failed"),
                )
        except TimeoutError:
            return self._failure(started, VerificationFailure("verification_timeout"))
        except VerificationFailure as error:
            return self._failure(started, error)

    @staticmethod
    def _failure(started: float, error: VerificationFailure) -> VerificationOutcome:
        return VerificationOutcome(
            succeeded=False,
            network_reachable=error.network_reachable,
            tls_verified=error.tls_verified,
            credentials_verified=error.credentials_verified,
            postgis_verified=False,
            sanitized_error_code=error.code,
            duration_ms=_bounded_duration(started),
        )


def _classify_driver_failure(error: Exception) -> VerificationFailure:
    sqlstate = getattr(error, "sqlstate", None)
    if isinstance(sqlstate, str) and sqlstate.startswith("28"):
        return VerificationFailure(
            "credentials_rejected", network_reachable=True, tls_verified=True
        )
    # libpq does not expose a distinct SQLSTATE for certificate/hostname failures.
    # Inspect only for classification; the driver message is never returned or logged.
    message = str(error).casefold()
    if any(marker in message for marker in ("certificate", "ssl", "tls")):
        return VerificationFailure("tls_verification_failed", network_reachable=True)
    return VerificationFailure("verification_failed")


def _bounded_duration(started: float) -> int:
    return min(20000, max(0, round((monotonic() - started) * 1000)))

import asyncio

import pytest

from opengeo_api.connection_verification import (
    PostgreSqlConnectionVerifier,
    PostgreSqlCredentials,
    PostgreSqlVerificationTarget,
    PsycopgPostgreSqlProbe,
    SystemAddressResolver,
    VerificationFailure,
    public_connection_address,
)


class FixedResolver:
    def __init__(self, *addresses: str) -> None:
        self.addresses = addresses
        self.calls: list[tuple[str, int]] = []

    async def resolve(self, host: str, port: int) -> tuple[str, ...]:
        self.calls.append((host, port))
        return self.addresses


class RecordingProbe:
    def __init__(self, failures: list[VerificationFailure] | None = None) -> None:
        self.failures = list(failures or [])
        self.calls: list[tuple] = []

    async def probe(self, target, credentials, pinned_address) -> None:
        self.calls.append((target, credentials, pinned_address))
        if self.failures:
            raise self.failures.pop(0)


def target() -> PostgreSqlVerificationTarget:
    return PostgreSqlVerificationTarget(
        host="gis.example.test",
        port=5432,
        database_name="research",
    )


def credentials() -> PostgreSqlCredentials:
    return PostgreSqlCredentials("read_only", "database-password")


@pytest.mark.parametrize(
    "address",
    [
        "127.0.0.1",
        "0.0.0.0",
        "10.0.0.1",
        "100.64.0.1",
        "169.254.169.254",
        "172.16.0.1",
        "192.168.1.1",
        "224.0.0.1",
        "::1",
        "fc00::1",
        "fe80::1",
        "ff02::1",
        "2001:db8::1",
    ],
)
def test_public_address_policy_rejects_non_global_targets(address: str) -> None:
    assert public_connection_address(address) is False


def test_public_address_policy_accepts_public_ipv4_and_ipv6() -> None:
    assert public_connection_address("8.8.8.8") is True
    assert public_connection_address("2606:4700:4700::1111") is True


def test_system_resolver_rejects_the_entire_answer_set_when_one_answer_is_unsafe(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def answers(*args, **kwargs):
        del args, kwargs
        return [
            (2, 1, 6, "", ("8.8.8.8", 5432)),
            (2, 1, 6, "", ("169.254.169.254", 5432)),
        ]

    loop = asyncio.new_event_loop()
    monkeypatch.setattr(loop, "getaddrinfo", answers)
    asyncio.set_event_loop(loop)
    try:
        with pytest.raises(VerificationFailure) as caught:
            loop.run_until_complete(SystemAddressResolver().resolve("gis.example.test", 5432))
    finally:
        loop.close()
        asyncio.set_event_loop(None)
    assert caught.value.code == "unsafe_network_target"


def test_verifier_resolves_once_and_pins_checked_answers_with_bounded_retry() -> None:
    resolver = FixedResolver("8.8.8.8", "1.1.1.1", "9.9.9.9")
    probe = RecordingProbe([VerificationFailure("verification_failed")])
    verifier = PostgreSqlConnectionVerifier(resolver=resolver, probe=probe)

    outcome = asyncio.run(verifier.verify(target(), credentials()))

    assert outcome.succeeded is True
    assert resolver.calls == [("gis.example.test", 5432)]
    assert [call[2] for call in probe.calls] == ["8.8.8.8", "1.1.1.1"]
    assert all(call[0].host == "gis.example.test" for call in probe.calls)


def test_psycopg_probe_preserves_tls_hostname_but_connects_to_the_pinned_address(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    recorded: dict[str, object] = {}

    class Cursor:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            del args

        async def execute(self, statement: str) -> None:
            recorded["statement"] = statement

        async def fetchone(self):
            return (True, True, True)

    class Connection:
        def cursor(self):
            return Cursor()

        async def rollback(self) -> None:
            recorded["rolled_back"] = True

        async def close(self) -> None:
            recorded["closed"] = True

    async def connect(**kwargs):
        recorded["kwargs"] = kwargs
        return Connection()

    monkeypatch.setattr(
        "psycopg.AsyncConnection.connect", connect
    )
    asyncio.run(PsycopgPostgreSqlProbe().probe(target(), credentials(), "8.8.8.8"))

    kwargs = recorded["kwargs"]
    assert isinstance(kwargs, dict)
    assert kwargs["host"] == "gis.example.test"
    assert kwargs["hostaddr"] == "8.8.8.8"
    assert kwargs["sslmode"] == "verify-full"
    assert kwargs["sslrootcert"] == "system"
    assert kwargs["target_session_attrs"] == "read-only"
    assert "default_transaction_read_only=on" in str(kwargs["options"])
    assert recorded["rolled_back"] is True
    assert recorded["closed"] is True
    statement = str(recorded["statement"])
    assert "pg_catalog.pg_extension" in statement
    assert "postgis" in statement
    assert "gis.example.test" not in statement
    assert "research" not in statement


def test_verifier_does_not_retry_credential_or_policy_failures() -> None:
    for failure in [
        VerificationFailure("credentials_rejected", network_reachable=True, tls_verified=True),
        VerificationFailure(
            "postgis_required",
            network_reachable=True,
            tls_verified=True,
            credentials_verified=True,
        ),
    ]:
        probe = RecordingProbe([failure])
        outcome = asyncio.run(
            PostgreSqlConnectionVerifier(
                resolver=FixedResolver("8.8.8.8", "1.1.1.1"), probe=probe
            ).verify(target(), credentials())
        )
        assert outcome.succeeded is False
        assert outcome.sanitized_error_code == failure.code
        assert len(probe.calls) == 1


def test_verifier_times_out_and_propagates_cancellation() -> None:
    class SlowProbe:
        async def probe(self, target, credentials, pinned_address) -> None:
            del target, credentials, pinned_address
            await asyncio.sleep(2)

    outcome = asyncio.run(
        PostgreSqlConnectionVerifier(
            resolver=FixedResolver("8.8.8.8"),
            probe=SlowProbe(),
            timeout_seconds=1,
        ).verify(target(), credentials())
    )
    assert outcome.sanitized_error_code == "verification_timeout"

    async def cancel() -> None:
        task = asyncio.create_task(
            PostgreSqlConnectionVerifier(
                resolver=FixedResolver("8.8.8.8"), probe=SlowProbe()
            ).verify(target(), credentials())
        )
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(cancel())


def test_credentials_repr_is_redacted() -> None:
    value = credentials()
    assert "read_only" not in repr(value)
    assert "database-password" not in repr(value)

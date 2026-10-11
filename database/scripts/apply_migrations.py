#!/usr/bin/env python3
"""Initialize or upgrade OpenGeo PostgreSQL through Aurora Data API.

The Data API accepts one SQL statement per request, so this runner splits the
checked-in psql-compatible files without splitting quoted strings, comments,
or dollar-quoted function bodies. A fresh database uses the verified direct
baseline by default. A database with an existing migration ledger continues
through forward migrations. Each explicit PostgreSQL transaction is preserved,
and the checksum ledger prevents an applied migration from being silently
changed or applied twice.

By default the command is read-only and prints a validated plan. Supplying
``--apply`` enables AWS and database mutations. Database passwords are read
directly from Secrets Manager and are sent only as bound Data API parameters;
they are never printed, written to disk, or placed in command arguments.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

MAX_DATA_API_SQL_CHARS = 65_536
SCHEMA_ONLY_MAX_REQUESTS = 150
SCHEMA_ONLY_MAX_SECONDS = 600
SCHEMA_ONLY_ROLLBACK_RESERVE = 2
SCHEMA_ONLY_CLEANUP_SECONDS = 90
BOUNDED_REQUEST_SECONDS = 45
MIGRATION_NAME = re.compile(r"^(?P<number>[0-9]{4})_[a-z0-9_]+\.sql$")
BASELINE_SCHEMA_VERSION = "opengeo.database-baseline-manifest.1.0.0"
BASELINE_POSTGRES_MAJOR = 16
BASELINE_POSTGIS_SERIES = "3.5"
BASELINE_GENERATOR_IMAGE = (
    "docker.io/postgis/postgis@"
    "sha256:8828b03e9a95269f808abe62aa83215b22a2d3710f54a55e8040327b7b5f9932"
)
CLUSTER_ARN = re.compile(
    r"^arn:(?P<partition>aws(?:-[a-z]+)?):rds:(?P<region>[a-z0-9-]+):"
    r"(?P<account>[0-9]{12}):cluster:[A-Za-z0-9-]+$"
)
SECRET_ARN = re.compile(
    r"^arn:(?P<partition>aws(?:-[a-z]+)?):secretsmanager:"
    r"(?P<region>[a-z0-9-]+):(?P<account>[0-9]{12}):secret:[A-Za-z0-9/_+=.@-]+$"
)
ALLOWED_DATABASE_ROLES = frozenset(
    {
        "opengeo_runtime",
        "opengeo_worker",
        "opengeo_connector",
        "opengeo_dataset_verifier",
        "opengeo_observable_coordinator",
        "opengeo_framework_publisher",
        "opengeo_repository_copier",
        "opengeo_source_archiver",
    }
)


class MigrationError(RuntimeError):
    """Raised when a migration or deployment invariant fails closed."""


@dataclass(frozen=True)
class Migration:
    path: Path
    name: str
    number: int
    sha256: str
    statements: tuple[str, ...]
    transaction_count: int


@dataclass(frozen=True)
class Baseline:
    path: Path
    manifest_path: Path
    name: str
    release: int
    sha256: str
    migration_chain_sha256: str
    migrations: tuple[tuple[str, str], ...]
    statements: tuple[str, ...]
    transaction_count: int


def split_sql(source: str) -> list[str]:
    """Split PostgreSQL SQL on normal-state semicolons.

    PostgreSQL function bodies commonly contain semicolons inside dollar quotes;
    comments, quoted identifiers, and strings can contain them as well. This is
    deliberately a lexical splitter rather than a naive ``str.split``.
    """

    statements: list[str] = []
    start = 0
    index = 0
    state = "normal"
    dollar_delimiter = ""
    block_depth = 0

    while index < len(source):
        current = source[index]
        following = source[index + 1] if index + 1 < len(source) else ""

        if state == "normal":
            if current == "'":
                state = "single"
                index += 1
                continue
            if current == '"':
                state = "double"
                index += 1
                continue
            if current == "-" and following == "-":
                state = "line_comment"
                index += 2
                continue
            if current == "/" and following == "*":
                state = "block_comment"
                block_depth = 1
                index += 2
                continue
            if current == "$":
                match = re.match(r"\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$", source[index:])
                if match:
                    dollar_delimiter = match.group(0)
                    state = "dollar"
                    index += len(dollar_delimiter)
                    continue
            if current == ";":
                statement = source[start:index].strip()
                if _has_sql_content(statement):
                    statements.append(statement)
                start = index + 1
            index += 1
            continue

        if state == "single":
            if current == "\\" and following:
                index += 2
                continue
            if current == "'":
                if following == "'":
                    index += 2
                    continue
                state = "normal"
            index += 1
            continue

        if state == "double":
            if current == '"':
                if following == '"':
                    index += 2
                    continue
                state = "normal"
            index += 1
            continue

        if state == "line_comment":
            if current in "\r\n":
                state = "normal"
            index += 1
            continue

        if state == "block_comment":
            if current == "/" and following == "*":
                block_depth += 1
                index += 2
                continue
            if current == "*" and following == "/":
                block_depth -= 1
                index += 2
                if block_depth == 0:
                    state = "normal"
                continue
            index += 1
            continue

        if state == "dollar":
            if source.startswith(dollar_delimiter, index):
                index += len(dollar_delimiter)
                dollar_delimiter = ""
                state = "normal"
                continue
            index += 1
            continue

        raise AssertionError(f"unknown SQL parser state: {state}")

    if state not in {"normal", "line_comment"}:
        raise MigrationError(f"unterminated SQL {state.replace('_', ' ')}")

    remainder = source[start:].strip()
    if _has_sql_content(remainder):
        statements.append(remainder)
    return statements


def _has_sql_content(value: str) -> bool:
    return bool(_strip_leading_comments(value))


def _strip_leading_comments(value: str) -> str:
    remaining = value.lstrip()
    while remaining:
        if remaining.startswith("--"):
            newline = remaining.find("\n")
            if newline < 0:
                return ""
            remaining = remaining[newline + 1 :].lstrip()
            continue
        if remaining.startswith("/*"):
            depth = 1
            index = 2
            while index < len(remaining) and depth:
                if remaining.startswith("/*", index):
                    depth += 1
                    index += 2
                elif remaining.startswith("*/", index):
                    depth -= 1
                    index += 2
                else:
                    index += 1
            if depth:
                raise MigrationError("unterminated leading SQL block comment")
            remaining = remaining[index:].lstrip()
            continue
        break
    return remaining


def statement_command(statement: str) -> str:
    return _strip_leading_comments(statement).strip().upper()


def load_migrations(
    directory: Path, *, through_version: int | None = None,
    after_version: int | None = None,
) -> list[Migration]:
    if through_version is not None and (
        type(through_version) is not int or not 1 <= through_version <= 9999
    ):
        raise MigrationError("through version must be an integer from 1 to 9999")
    if after_version is not None and (
        type(after_version) is not int or through_version is None
        or not 1 <= after_version < through_version
    ):
        raise MigrationError("after version requires a larger finite through version")
    paths = sorted(directory.glob("*.sql"))
    if not paths:
        raise MigrationError(f"no migrations found in {directory}")

    if through_version is not None:
        selected: list[Path] = []
        for path in paths:
            match = MIGRATION_NAME.fullmatch(path.name)
            if not match:
                raise MigrationError(f"invalid migration filename: {path.name}")
            if int(match.group("number")) <= through_version:
                selected.append(path)
        paths = selected

    migrations: list[Migration] = []
    for expected, path in enumerate(paths, start=1):
        match = MIGRATION_NAME.fullmatch(path.name)
        if not match:
            raise MigrationError(f"invalid migration filename: {path.name}")
        number = int(match.group("number"))
        if number != expected:
            raise MigrationError(
                f"migration sequence is not contiguous: expected {expected:04d}, found {number:04d}"
            )
        source_bytes = path.read_bytes()
        if after_version is not None and number <= after_version:
            # Already-deployed history is bound by its raw checksum, not parsed
            # under newer transaction rules and never eligible for replay.
            migrations.append(Migration(
                path=path, name=path.name, number=number,
                sha256=hashlib.sha256(source_bytes).hexdigest(),
                statements=(), transaction_count=0,
            ))
            continue
        try:
            source = source_bytes.decode("utf-8")
        except UnicodeDecodeError as error:
            raise MigrationError(f"migration is not UTF-8: {path.name}") from error
        if "\x00" in source:
            raise MigrationError(f"migration contains a NUL byte: {path.name}")
        statements = tuple(split_sql(source))
        # Later migrations also use PostgreSQL's implicit transaction form.
        # Execute each such file atomically through Data API without rewriting
        # its source or the checksum retained in existing migration ledgers.
        # Partially explicit files still fail the normal boundary validation.
        boundaries = {"BEGIN", "BEGIN TRANSACTION", "COMMIT", "COMMIT WORK", "ROLLBACK"}
        if statements and not any(statement_command(item) in boundaries for item in statements):
            statements = ("BEGIN", *statements, "COMMIT")
        transaction_count = validate_transactions(path.name, statements)
        for statement_index, statement in enumerate(statements, start=1):
            if len(statement) > MAX_DATA_API_SQL_CHARS:
                raise MigrationError(
                    f"{path.name} statement {statement_index} exceeds the Data API SQL limit"
                )
        migrations.append(
            Migration(
                path=path,
                name=path.name,
                number=number,
                sha256=hashlib.sha256(source_bytes).hexdigest(),
                statements=statements,
                transaction_count=transaction_count,
            )
        )
    if through_version is not None and (
        not migrations or migrations[-1].number != through_version
    ):
        raise MigrationError(f"requested through version {through_version:04d} is missing")
    return migrations


def migration_chain_sha256(migrations: Sequence[Migration]) -> str:
    digest = hashlib.sha256()
    for migration in migrations:
        digest.update(migration.name.encode("utf-8"))
        digest.update(b"\0")
        digest.update(migration.path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def load_baseline(
    baseline_path: Path,
    manifest_path: Path,
    migrations: Sequence[Migration],
) -> Baseline:
    if not baseline_path.is_file() or not manifest_path.is_file():
        raise MigrationError("fresh-database baseline or manifest is missing")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise MigrationError("fresh-database baseline manifest is invalid") from error
    required_fields = {
        "schemaVersion",
        "release",
        "baseline",
        "baselineSha256",
        "migrationChainSha256",
        "postgresMajor",
        "postgisSeries",
        "generatorImage",
        "containsUserData",
        "migrations",
    }
    if not isinstance(manifest, dict) or set(manifest) != required_fields:
        raise MigrationError("fresh-database baseline manifest fields are invalid")
    source_bytes = baseline_path.read_bytes()
    baseline_digest = hashlib.sha256(source_bytes).hexdigest()
    release = manifest.get("release")
    if type(release) is not int or not migrations or not 1 <= release <= migrations[-1].number:
        raise MigrationError("fresh-database baseline release is invalid")
    baseline_migrations = tuple(item for item in migrations if item.number <= release)
    expected_migrations = tuple((item.name, item.sha256) for item in baseline_migrations)
    manifest_migrations = manifest.get("migrations")
    if not isinstance(manifest_migrations, list):
        raise MigrationError("fresh-database baseline migration ledger is invalid")
    recorded_migrations: list[tuple[str, str]] = []
    for record in manifest_migrations:
        if not isinstance(record, dict) or set(record) != {"name", "sha256"}:
            raise MigrationError("fresh-database baseline migration record is invalid")
        name = record.get("name")
        digest = record.get("sha256")
        if not isinstance(name, str) or not isinstance(digest, str):
            raise MigrationError("fresh-database baseline migration values are invalid")
        recorded_migrations.append((name, digest))
    chain_digest = migration_chain_sha256(baseline_migrations)
    if (
        manifest.get("schemaVersion") != BASELINE_SCHEMA_VERSION
        or len(baseline_migrations) != release
        or manifest.get("baseline") != baseline_path.name
        or manifest.get("baselineSha256") != baseline_digest
        or manifest.get("migrationChainSha256") != chain_digest
        or manifest.get("postgresMajor") != BASELINE_POSTGRES_MAJOR
        or manifest.get("postgisSeries") != BASELINE_POSTGIS_SERIES
        or manifest.get("generatorImage") != BASELINE_GENERATOR_IMAGE
        or manifest.get("containsUserData") is not False
        or tuple(recorded_migrations) != expected_migrations
    ):
        raise MigrationError(
            "fresh-database baseline does not match the migration chain"
        )
    try:
        source = source_bytes.decode("utf-8")
    except UnicodeDecodeError as error:
        raise MigrationError("fresh-database baseline is not UTF-8") from error
    if "\x00" in source:
        raise MigrationError("fresh-database baseline contains a NUL byte")
    statements = tuple(split_sql(source))
    transaction_count = validate_transactions(baseline_path.name, statements)
    if transaction_count != 1:
        raise MigrationError("fresh-database baseline must contain one transaction")
    for index, statement in enumerate(statements, start=1):
        if len(statement) > MAX_DATA_API_SQL_CHARS:
            raise MigrationError(
                f"{baseline_path.name} statement {index} exceeds the Data API SQL limit"
            )
    return Baseline(
        path=baseline_path,
        manifest_path=manifest_path,
        name=baseline_path.name,
        release=release,
        sha256=baseline_digest,
        migration_chain_sha256=chain_digest,
        migrations=expected_migrations,
        statements=statements,
        transaction_count=transaction_count,
    )


def validate_transactions(name: str, statements: Sequence[str]) -> int:
    active = False
    transactions = 0
    for index, statement in enumerate(statements, start=1):
        command = statement_command(statement)
        if command in {"BEGIN", "BEGIN TRANSACTION"}:
            if active:
                raise MigrationError(f"{name} statement {index} nests BEGIN")
            active = True
            transactions += 1
            continue
        if command in {"COMMIT", "COMMIT WORK"}:
            if not active:
                raise MigrationError(
                    f"{name} statement {index} has COMMIT without BEGIN"
                )
            active = False
            continue
        if not active:
            raise MigrationError(
                f"{name} statement {index} is outside an explicit transaction"
            )
    if active:
        raise MigrationError(f"{name} has an uncommitted transaction")
    if transactions == 0:
        raise MigrationError(f"{name} has no explicit transaction")
    return transactions


class DataApiMigrator:
    def __init__(
        self,
        *,
        rds_data: Any,
        secrets_manager: Any,
        cluster_arn: str,
        admin_secret_arn: str,
        database: str,
        request_limit: int | None = None,
        deadline: float | None = None,
        initial_requests: int = 0,
        rollback_reserve: int = 0,
    ) -> None:
        if request_limit is not None:
            if (type(request_limit) is not int or not 3 <= request_limit <= SCHEMA_ONLY_MAX_REQUESTS
                or type(initial_requests) is not int or not 0 <= initial_requests < request_limit
                or type(rollback_reserve) is not int or not 0 <= rollback_reserve < request_limit
                or not isinstance(deadline, (int, float))
                or not 0 < deadline - time.monotonic() <= SCHEMA_ONLY_MAX_SECONDS):
                raise MigrationError("invalid finite migration execution budget")
        elif deadline is not None or initial_requests or rollback_reserve:
            raise MigrationError("migration deadline and reserves require a request limit")
        self.rds_data = rds_data
        self.secrets_manager = secrets_manager
        self.cluster_arn = cluster_arn
        self.admin_secret_arn = admin_secret_arn
        self.database = database
        self.request_limit = request_limit
        self.deadline = deadline
        self.requests_used = initial_requests
        self.rollback_reserve = rollback_reserve

    def _check_budget(self, operation_name: str, *, claim: bool = False, sleep_seconds: float = 0) -> None:
        if self.request_limit is None:
            return
        cleanup = operation_name == "rollback_transaction"
        ceiling = self.request_limit if cleanup else self.request_limit - self.rollback_reserve
        if self.requests_used >= ceiling:
            raise MigrationError("migration request budget exhausted; reconcile before retrying")
        reserve = 0 if cleanup else SCHEMA_ONLY_CLEANUP_SECONDS
        if time.monotonic() + sleep_seconds + BOUNDED_REQUEST_SECONDS + reserve > self.deadline:
            raise MigrationError("migration time budget exhausted; reconcile before retrying")
        if claim:
            self.requests_used += 1

    def _budget_sleep(self, seconds: float, operation_name: str = "execute_statement") -> None:
        self._check_budget(operation_name, sleep_seconds=seconds)
        time.sleep(seconds)

    def _base(self, secret_arn: str | None = None) -> dict[str, str]:
        return {
            "resourceArn": self.cluster_arn,
            "secretArn": secret_arn or self.admin_secret_arn,
            "database": self.database,
        }

    def _transaction_base(self, secret_arn: str | None = None) -> dict[str, str]:
        """Commit/Rollback do not accept the Begin/Execute ``database`` field."""

        return {
            "resourceArn": self.cluster_arn,
            "secretArn": secret_arn or self.admin_secret_arn,
        }

    def _rds_call(self, operation_name: str, **kwargs: Any) -> dict[str, Any]:
        """Retry only Aurora's explicit pre-acceptance cold-resume response."""

        operation = getattr(self.rds_data, operation_name)
        delay_seconds = 2
        for attempt in range(10):
            self._check_budget(operation_name, claim=True)
            try:
                response = operation(**kwargs)
                if self.deadline is not None and time.monotonic() > self.deadline:
                    raise MigrationError("migration time budget expired during request; reconcile before retrying")
                if not isinstance(response, dict):
                    raise MigrationError(
                        f"Data API {operation_name} returned an invalid response"
                    )
                return response
            except Exception as error:
                error_code, _ = self._error_summary(error)
                if error_code != "DatabaseResumingException":
                    raise
                if attempt == 9:
                    raise MigrationError(
                        "Aurora did not resume within the bounded migration window"
                    ) from error
                print(
                    f"Aurora is resuming; retrying {operation_name} in {delay_seconds}s",
                    file=sys.stderr,
                )
                self._budget_sleep(delay_seconds, operation_name)
                delay_seconds = min(delay_seconds * 2, 10)
        raise AssertionError("unreachable Data API retry state")

    @staticmethod
    def _error_summary(error: Exception) -> tuple[str | None, str]:
        response = getattr(error, "response", None)
        if not isinstance(response, dict):
            return None, type(error).__name__
        detail = response.get("Error")
        if not isinstance(detail, dict):
            return None, type(error).__name__
        code = detail.get("Code")
        message = detail.get("Message")
        safe_code = code if isinstance(code, str) else None
        safe_message = message if isinstance(message, str) else type(error).__name__
        return safe_code, safe_message[:500]

    def _execute_migration_statement(
        self,
        *,
        transaction_id: str,
        statement: str,
        label: str,
    ) -> None:
        try:
            self._rds_call(
                "execute_statement",
                **self._base(),
                transactionId=transaction_id,
                sql=statement,
                continueAfterTimeout=True,
            )
            return
        except Exception as error:
            code, _ = self._error_summary(error)
            if code != "StatementTimeoutException":
                raise

        print(
            f"{label} exceeded the Data API response window; waiting for accepted DDL",
            file=sys.stderr,
        )
        for _ in range(90):
            self._budget_sleep(5)
            try:
                self._rds_call(
                    "execute_statement",
                    **self._base(),
                    transactionId=transaction_id,
                    sql="SELECT 1",
                )
                return
            except Exception as probe_error:
                code, message = self._error_summary(probe_error)
                if code == "DatabaseErrorException" and (
                    "still running a query" in message.lower()
                    or "transaction is still running" in message.lower()
                ):
                    continue
                raise MigrationError(
                    f"{label} did not complete after its continued Data API timeout: "
                    f"{code or type(probe_error).__name__}"
                ) from probe_error
        raise MigrationError(f"{label} exceeded the 7.5-minute continued-DDL limit")

    def database_initialization_state(self) -> str:
        response = self._rds_call(
            "execute_statement",
            **self._base(),
            sql=(
                "SELECT to_regnamespace('app') IS NOT NULL AS app_schema, "
                "to_regclass('opengeo_deploy.schema_migrations') IS NOT NULL "
                "AS migration_ledger"
            ),
            formatRecordsAs="JSON",
        )
        try:
            records = json.loads(response.get("formattedRecords", "[]"))
        except (TypeError, json.JSONDecodeError) as error:
            raise MigrationError("database initialization state is invalid") from error
        if not isinstance(records, list) or len(records) != 1:
            raise MigrationError("database initialization state is invalid")
        record = records[0]
        if not isinstance(record, dict) or set(record) != {
            "app_schema",
            "migration_ledger",
        }:
            raise MigrationError("database initialization state is invalid")
        app_schema = record.get("app_schema")
        migration_ledger = record.get("migration_ledger")
        if not isinstance(app_schema, bool) or not isinstance(migration_ledger, bool):
            raise MigrationError("database initialization state is invalid")
        if not app_schema and not migration_ledger:
            return "fresh"
        if app_schema and migration_ledger:
            return "managed"
        raise MigrationError(
            "database has an inconsistent OpenGeo schema and migration ledger"
        )

    def apply_baseline(self, baseline: Baseline) -> list[str]:
        if self.database_initialization_state() != "fresh":
            raise MigrationError(
                "fresh-database baseline requires an empty OpenGeo catalog"
            )
        transaction_id: str | None = None
        statement_position = 0
        try:
            for index, statement in enumerate(baseline.statements, start=1):
                statement_position = index
                command = statement_command(statement)
                if command in {"BEGIN", "BEGIN TRANSACTION"}:
                    response = self._rds_call("begin_transaction", **self._base())
                    transaction_id = response.get("transactionId")
                    if not isinstance(transaction_id, str) or not transaction_id:
                        raise MigrationError(
                            "Data API did not return a baseline transaction id"
                        )
                    continue
                if command in {"COMMIT", "COMMIT WORK"}:
                    if transaction_id is None:
                        raise MigrationError(
                            "baseline transaction disappeared before COMMIT"
                        )
                    self._rds_call(
                        "commit_transaction",
                        **self._transaction_base(),
                        transactionId=transaction_id,
                    )
                    transaction_id = None
                    continue
                if transaction_id is None:
                    raise MigrationError(
                        f"{baseline.name} statement {index} is outside a Data API transaction"
                    )
                self._execute_migration_statement(
                    transaction_id=transaction_id,
                    statement=statement,
                    label=f"{baseline.name} statement {index}/{len(baseline.statements)}",
                )
        except Exception as error:
            original_code, _ = self._error_summary(error)
            original_summary = original_code or type(error).__name__
            if transaction_id is not None:
                try:
                    self._rds_call(
                        "rollback_transaction",
                        **self._transaction_base(),
                        transactionId=transaction_id,
                    )
                except Exception as rollback_error:
                    rollback_code, _ = self._error_summary(rollback_error)
                    raise MigrationError(
                        f"failed to initialize {baseline.name} at statement "
                        f"{statement_position}/{len(baseline.statements)} "
                        f"({original_summary}); rollback could not be confirmed "
                        f"({rollback_code or type(rollback_error).__name__})"
                    ) from rollback_error
            if isinstance(error, MigrationError):
                raise
            raise MigrationError(
                f"failed to initialize {baseline.name} at statement "
                f"{statement_position}/{len(baseline.statements)} ({original_summary})"
            ) from error

        recorded = self.applied()
        expected = dict(baseline.migrations)
        if recorded != expected:
            raise MigrationError(
                "fresh-database baseline committed with an unexpected migration ledger"
            )
        return list(expected)

    def ensure_ledger(self) -> None:
        statements = (
            "CREATE SCHEMA IF NOT EXISTS opengeo_deploy",
            """
            CREATE TABLE IF NOT EXISTS opengeo_deploy.schema_migrations (
              migration_name text PRIMARY KEY,
              sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
              applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
            )
            """,
            "REVOKE ALL ON SCHEMA opengeo_deploy FROM PUBLIC",
            "REVOKE ALL ON TABLE opengeo_deploy.schema_migrations FROM PUBLIC",
        )
        for statement in statements:
            self._rds_call("execute_statement", **self._base(), sql=statement.strip())

    def applied(self) -> dict[str, str]:
        response = self._rds_call(
            "execute_statement",
            **self._base(),
            sql=(
                "SELECT migration_name, sha256 "
                "FROM opengeo_deploy.schema_migrations ORDER BY migration_name"
            ),
            formatRecordsAs="JSON",
        )
        records = json.loads(response.get("formattedRecords", "[]"))
        if not isinstance(records, list):
            raise MigrationError("migration ledger returned an invalid result")
        result: dict[str, str] = {}
        for record in records:
            if not isinstance(record, dict):
                raise MigrationError("migration ledger row is invalid")
            name = record.get("migration_name")
            digest = record.get("sha256")
            if not isinstance(name, str) or not isinstance(digest, str):
                raise MigrationError("migration ledger values are invalid")
            result[name] = digest
        return result

    def apply(
        self, migrations: Iterable[Migration], *, through_version: int | None = None,
        schema_only: bool = False, after_version: int | None = None,
    ) -> tuple[list[str], list[str]]:
        if schema_only and through_version is None:
            raise MigrationError("schema-only upgrades require a through version")
        if after_version is not None and (
            not schema_only or type(after_version) is not int
            or type(through_version) is not int or not 1 <= after_version < through_version
        ):
            raise MigrationError("after version requires a bounded schema-only upgrade")
        expected: dict[str, str] | None = None
        if through_version is not None:
            if type(through_version) is not int or not 1 <= through_version <= 9999:
                raise MigrationError("through version must be an integer from 1 to 9999")
            migrations = list(migrations)
            if [item.number for item in migrations] != list(range(1, through_version + 1)):
                raise MigrationError("bounded migrations must be the exact contiguous prefix")
            expected = {item.name: item.sha256 for item in migrations}
            if len(expected) != through_version or any(
                not (match := MIGRATION_NAME.fullmatch(item.name))
                or int(match.group("number")) != item.number
                or re.fullmatch(r"[a-f0-9]{64}", item.sha256) is None
                for item in migrations
            ):
                raise MigrationError("bounded migration identity is invalid")
        if schema_only:
            if self.database_initialization_state() != "managed":
                raise MigrationError("schema-only upgrades require an initialized migration ledger")
        else:
            self.ensure_ledger()
        already_applied = self.applied()
        if expected is not None:
            for name, digest in already_applied.items():
                if name not in expected:
                    raise MigrationError(
                        f"recorded migration is outside the requested prefix: {name}"
                    )
                if expected[name] != digest:
                    raise MigrationError(f"applied migration checksum changed: {name}")
            recorded_prefix = list(expected)[:len(already_applied)]
            if after_version is None and set(already_applied) != set(recorded_prefix):
                raise MigrationError("recorded migrations are not a contiguous prefix")
            # Explicit retained history must be complete. Checksum-verified rows
            # beyond it may already be committed and must be skipped, not replayed.
            if after_version is not None and not set(list(expected)[:after_version]) <= set(already_applied):
                raise MigrationError("retained migration history is incomplete; refusing replay")
        applied_now: list[str] = []
        skipped: list[str] = []

        for migration in migrations:
            recorded_digest = already_applied.get(migration.name)
            if recorded_digest is not None:
                if recorded_digest != migration.sha256:
                    raise MigrationError(
                        f"applied migration checksum changed: {migration.name}"
                    )
                skipped.append(migration.name)
                continue
            if not migration.statements:
                raise MigrationError("metadata-only migration history cannot be executed")
            self._apply_one(migration)
            applied_now.append(migration.name)
        if expected is not None and self.applied() != expected:
            raise MigrationError("bounded migration ledger readback differs; reconcile before retrying")
        return applied_now, skipped

    def _apply_one(self, migration: Migration) -> None:
        transaction_id: str | None = None
        statement_position = 0
        commit_indexes = [
            index
            for index, statement in enumerate(migration.statements)
            if statement_command(statement) in {"COMMIT", "COMMIT WORK"}
        ]
        final_commit_index = commit_indexes[-1]

        try:
            for index, statement in enumerate(migration.statements):
                statement_position = index + 1
                command = statement_command(statement)
                if command in {"BEGIN", "BEGIN TRANSACTION"}:
                    response = self._rds_call("begin_transaction", **self._base())
                    transaction_id = response.get("transactionId")
                    if not isinstance(transaction_id, str) or not transaction_id:
                        raise MigrationError("Data API did not return a transaction id")
                    continue
                if command in {"COMMIT", "COMMIT WORK"}:
                    if transaction_id is None:
                        raise MigrationError(
                            "migration transaction disappeared before COMMIT"
                        )
                    if index == final_commit_index:
                        self._rds_call(
                            "execute_statement",
                            **self._base(),
                            transactionId=transaction_id,
                            sql=(
                                "INSERT INTO opengeo_deploy.schema_migrations "
                                "(migration_name, sha256) VALUES (:name, :sha256)"
                            ),
                            parameters=[
                                {
                                    "name": "name",
                                    "value": {"stringValue": migration.name},
                                },
                                {
                                    "name": "sha256",
                                    "value": {"stringValue": migration.sha256},
                                },
                            ],
                        )
                    self._rds_call(
                        "commit_transaction",
                        **self._transaction_base(),
                        transactionId=transaction_id,
                    )
                    transaction_id = None
                    continue

                if transaction_id is None:
                    raise MigrationError(
                        "migration statement is outside a Data API transaction"
                    )
                self._execute_migration_statement(
                    transaction_id=transaction_id,
                    statement=statement,
                    label=(
                        f"{migration.name} statement {statement_position}/"
                        f"{len(migration.statements)}"
                    ),
                )
        except Exception as error:
            original_code, _ = self._error_summary(error)
            original_summary = original_code or type(error).__name__
            if transaction_id is not None:
                try:
                    self._rds_call(
                        "rollback_transaction",
                        **self._transaction_base(),
                        transactionId=transaction_id,
                    )
                except Exception as rollback_error:
                    rollback_code, _ = self._error_summary(rollback_error)
                    raise MigrationError(
                        f"failed to apply {migration.name} at statement {statement_position}/"
                        f"{len(migration.statements)} ({original_summary}); rollback could not "
                        f"be confirmed ({rollback_code or type(rollback_error).__name__})"
                    ) from rollback_error
            if isinstance(error, MigrationError):
                raise
            raise MigrationError(
                f"failed to apply {migration.name} at statement {statement_position}/"
                f"{len(migration.statements)} ({original_summary})"
            ) from error

    def configure_role(self, role: str, role_secret_arn: str) -> None:
        if role not in ALLOWED_DATABASE_ROLES:
            raise MigrationError(f"database role is not allowlisted: {role}")
        secret = self._read_database_secret(role_secret_arn, role)
        transaction = self._rds_call("begin_transaction", **self._base())
        transaction_id = transaction.get("transactionId")
        if not isinstance(transaction_id, str) or not transaction_id:
            raise MigrationError("Data API did not return a role transaction id")
        try:
            self._rds_call(
                "execute_statement",
                **self._base(),
                transactionId=transaction_id,
                sql="SELECT set_config('opengeo_deploy.role_password', :password, true)",
                parameters=[
                    {"name": "password", "value": {"stringValue": secret["password"]}}
                ],
            )
            self._rds_call(
                "execute_statement",
                **self._base(),
                transactionId=transaction_id,
                sql=f"""
                DO $opengeo_role$
                DECLARE
                  configured_password text :=
                    current_setting('opengeo_deploy.role_password', true);
                BEGIN
                  IF configured_password IS NULL OR configured_password = '' THEN
                    RAISE EXCEPTION 'database role password is unavailable';
                  END IF;
                  EXECUTE format('ALTER ROLE {role} PASSWORD %L', configured_password);
                  -- Only an explicitly supplied, matching dedicated secret enables login.
                  ALTER ROLE {role} LOGIN;
                  PERFORM set_config('opengeo_deploy.role_password', '', true);
                END;
                $opengeo_role$
                """.strip(),
            )
            self._rds_call(
                "commit_transaction",
                **self._transaction_base(),
                transactionId=transaction_id,
            )
        except Exception as error:
            try:
                self._rds_call(
                    "rollback_transaction",
                    **self._transaction_base(),
                    transactionId=transaction_id,
                )
            except Exception as rollback_error:
                raise MigrationError(
                    f"failed to configure {role}; rollback could not be confirmed"
                ) from rollback_error
            raise MigrationError(f"failed to configure {role}") from error

        response = self._rds_call(
            "execute_statement",
            **self._base(role_secret_arn),
            sql="SELECT current_user",
            formatRecordsAs="JSON",
        )
        rows = json.loads(response.get("formattedRecords", "[]"))
        if rows != [{"current_user": role}]:
            raise MigrationError(f"{role} credential verification failed")

    def _read_database_secret(self, secret_arn: str, role: str) -> dict[str, str]:
        response = self.secrets_manager.get_secret_value(SecretId=secret_arn)
        raw = response.get("SecretString")
        if not isinstance(raw, str):
            raise MigrationError(f"{role} secret has no SecretString")
        try:
            value = json.loads(raw)
        except json.JSONDecodeError as error:
            raise MigrationError(f"{role} secret is not JSON") from error
        if not isinstance(value, dict) or value.get("username") != role:
            raise MigrationError(f"{role} secret has the wrong username")
        password = value.get("password")
        if not isinstance(password, str) or len(password) < 20:
            raise MigrationError(f"{role} secret has an invalid password")
        return {"username": role, "password": password}

    def verify_roles(self, *, publisher_enabled: bool = False) -> None:
        response = self._rds_call(
            "execute_statement",
            **self._base(),
            sql="""
            SELECT rolname, rolcanlogin, rolinherit, rolbypassrls, rolsuper
            FROM pg_roles
            WHERE rolname IN (
              'opengeo_connector', 'opengeo_dataset_verifier',
              'opengeo_observable_coordinator',
              'opengeo_repository_copier', 'opengeo_runtime',
              'opengeo_source_archiver', 'opengeo_worker'
            )
            ORDER BY rolname
            """.strip(),
            formatRecordsAs="JSON",
        )
        rows = json.loads(response.get("formattedRecords", "[]"))
        expected = [
            {
                "rolname": "opengeo_connector",
                "rolcanlogin": True,
                "rolinherit": False,
                "rolbypassrls": False,
                "rolsuper": False,
            },
            {
                "rolname": "opengeo_dataset_verifier",
                "rolcanlogin": True,
                "rolinherit": False,
                "rolbypassrls": False,
                "rolsuper": False,
            },
            {
                "rolname": "opengeo_observable_coordinator",
                "rolcanlogin": True,
                "rolinherit": False,
                "rolbypassrls": False,
                "rolsuper": False,
            },
            {
                "rolname": "opengeo_repository_copier",
                "rolcanlogin": True,
                "rolinherit": False,
                "rolbypassrls": False,
                "rolsuper": False,
            },
            {
                "rolname": "opengeo_runtime",
                "rolcanlogin": True,
                "rolinherit": False,
                "rolbypassrls": False,
                "rolsuper": False,
            },
            {
                "rolname": "opengeo_source_archiver",
                "rolcanlogin": True,
                "rolinherit": False,
                "rolbypassrls": False,
                "rolsuper": False,
            },
            {
                "rolname": "opengeo_worker",
                "rolcanlogin": True,
                "rolinherit": False,
                "rolbypassrls": False,
                "rolsuper": False,
            },
        ]
        if rows != expected:
            raise MigrationError(
                "runtime database roles violate the least-privilege contract"
            )
        if publisher_enabled:
            response = self._rds_call(
                "execute_statement", **self._base(),
                sql="SELECT rolcanlogin, rolinherit, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'opengeo_framework_publisher'",
                formatRecordsAs="JSON",
            )
            if json.loads(response.get("formattedRecords", "[]")) != [{
                "rolcanlogin": True, "rolinherit": False,
                "rolbypassrls": False, "rolsuper": False,
            }]:
                raise MigrationError("publisher database role violates the least-privilege contract")


def validate_arn(value: str, pattern: re.Pattern[str], *, name: str) -> re.Match[str]:
    match = pattern.fullmatch(value)
    if not match:
        raise MigrationError(f"invalid {name} ARN")
    return match


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    database_root = Path(__file__).resolve().parent.parent
    default_migrations = database_root / "migrations"
    default_baseline = database_root / "baselines" / "0089_opengeo_schema.sql"
    default_manifest = database_root / "baselines" / "0089_opengeo_schema.manifest.json"
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--migrations-dir", type=Path, default=default_migrations)
    parser.add_argument(
        "--through-version", type=int,
        help="validate and apply only the exact contiguous migration prefix through this version",
    )
    parser.add_argument(
        "--schema-only", action="store_true",
        help="upgrade an initialized ledger through a finite version without configuring role credentials",
    )
    parser.add_argument(
        "--after-version", type=int,
        help="hash retained schema-only history through this version without reparsing or replaying it",
    )
    parser.add_argument("--baseline", type=Path, default=default_baseline)
    parser.add_argument("--baseline-manifest", type=Path, default=default_manifest)
    parser.add_argument(
        "--fresh-initialization",
        choices=("baseline", "migrations"),
        default="baseline",
        help="create a fresh OpenGeo catalog directly or replay its history",
    )
    parser.add_argument("--apply", action="store_true", help="apply the validated plan")
    parser.add_argument("--profile", help="AWS profile name")
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--expected-account", required=False)
    parser.add_argument("--cluster-arn")
    parser.add_argument("--admin-secret-arn")
    parser.add_argument("--runtime-secret-arn")
    parser.add_argument("--worker-secret-arn")
    parser.add_argument("--connector-secret-arn")
    parser.add_argument("--dataset-verifier-secret-arn")
    parser.add_argument("--observable-coordinator-secret-arn")
    parser.add_argument("--framework-publisher-secret-arn")
    parser.add_argument("--source-archiver-secret-arn")
    parser.add_argument("--repository-copier-secret-arn")
    parser.add_argument("--database", default="opengeo")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    if args.after_version is not None and (
        not args.schema_only or args.through_version is None
        or not 1 <= args.after_version < args.through_version
    ):
        raise MigrationError("--after-version requires --schema-only and a larger --through-version")
    if args.schema_only:
        if args.through_version is None:
            raise MigrationError("--schema-only requires --through-version")
        role_secrets = [args.runtime_secret_arn, args.worker_secret_arn,
            args.connector_secret_arn, args.dataset_verifier_secret_arn,
            args.observable_coordinator_secret_arn, args.framework_publisher_secret_arn,
            args.source_archiver_secret_arn, args.repository_copier_secret_arn]
        if any(value is not None for value in role_secrets):
            raise MigrationError("--schema-only forbids role secret arguments")
    migrations = load_migrations(
        args.migrations_dir.resolve(), through_version=args.through_version,
        after_version=args.after_version,
    )
    baseline = load_baseline(
        args.baseline.resolve(),
        args.baseline_manifest.resolve(),
        migrations,
    )
    max_statement = max(
        max(len(statement) for item in migrations for statement in item.statements),
        max(len(statement) for statement in baseline.statements),
    )
    print(
        json.dumps(
            {
                "status": "validated",
                "mode": "apply" if args.apply else "plan",
                "migrationCount": len(migrations),
                "firstMigration": migrations[0].name,
                "lastMigration": migrations[-1].name,
                "transactionCount": sum(item.transaction_count for item in migrations),
                "freshInitialization": "existing-ledger-only" if args.schema_only else args.fresh_initialization,
                "baseline": baseline.name,
                "baselineRelease": baseline.release,
                "baselineSha256": baseline.sha256,
                "upgradePath": "forward-migrations",
                "maximumStatementCharacters": max_statement,
                "dataApiStatementLimit": MAX_DATA_API_SQL_CHARS,
                **({"throughVersion": args.through_version} if args.through_version is not None else {}),
                **({"schemaOnly": True} if args.schema_only else {}),
                **({"afterVersion": args.after_version} if args.after_version is not None else {}),
            },
            indent=2,
        )
    )
    if not args.apply:
        return 0

    required = {
        "expected-account": args.expected_account,
        "cluster-arn": args.cluster_arn,
        "admin-secret-arn": args.admin_secret_arn,
        **({} if args.schema_only else {
            "runtime-secret-arn": args.runtime_secret_arn,
            "worker-secret-arn": args.worker_secret_arn,
        }),
    }
    missing = [name for name, value in required.items() if not value]
    if missing:
        raise MigrationError(
            f"--apply requires: {', '.join('--' + item for item in missing)}"
        )
    if not re.fullmatch(r"[0-9]{12}", args.expected_account):
        raise MigrationError("expected account must be a 12-digit AWS account id")
    if not re.fullmatch(r"[a-z0-9-]{1,63}", args.region):
        raise MigrationError("invalid AWS region")
    if args.database != "opengeo":
        raise MigrationError("production migrations require the opengeo database")

    cluster_match = validate_arn(args.cluster_arn, CLUSTER_ARN, name="cluster")
    secret_values = ((args.admin_secret_arn,) if args.schema_only else (
        args.admin_secret_arn, args.runtime_secret_arn, args.worker_secret_arn,
    ))
    secret_matches = [
        validate_arn(value, SECRET_ARN, name="Secrets Manager")
        for value in secret_values
    ]
    connector_match = (
        validate_arn(
            args.connector_secret_arn,
            SECRET_ARN,
            name="connector Secrets Manager",
        )
        if args.connector_secret_arn is not None
        else None
    )
    if connector_match is not None:
        secret_matches.append(connector_match)
    dataset_verifier_match = (
        validate_arn(
            args.dataset_verifier_secret_arn,
            SECRET_ARN,
            name="dataset verifier Secrets Manager",
        )
        if args.dataset_verifier_secret_arn is not None
        else None
    )
    if dataset_verifier_match is not None:
        secret_matches.append(dataset_verifier_match)
    coordinator_match = (
        validate_arn(
            args.observable_coordinator_secret_arn,
            SECRET_ARN,
            name="Observable coordinator Secrets Manager",
        )
        if args.observable_coordinator_secret_arn is not None
        else None
    )
    if coordinator_match is not None:
        secret_matches.append(coordinator_match)
    publisher_match = (
        validate_arn(
            args.framework_publisher_secret_arn,
            SECRET_ARN,
            name="Framework publisher Secrets Manager",
        )
        if args.framework_publisher_secret_arn is not None
        else None
    )
    if publisher_match is not None:
        secret_matches.append(publisher_match)
    source_archiver_match = (
        validate_arn(
            args.source_archiver_secret_arn,
            SECRET_ARN,
            name="source archiver Secrets Manager",
        )
        if args.source_archiver_secret_arn is not None
        else None
    )
    if source_archiver_match is not None:
        secret_matches.append(source_archiver_match)
    repository_copier_match = (
        validate_arn(
            args.repository_copier_secret_arn,
            SECRET_ARN,
            name="repository copier Secrets Manager",
        )
        if args.repository_copier_secret_arn is not None
        else None
    )
    if repository_copier_match is not None:
        secret_matches.append(repository_copier_match)
    for match in [cluster_match, *secret_matches]:
        if match.group("account") != args.expected_account:
            raise MigrationError(
                "AWS resource account does not match --expected-account"
            )
        if match.group("region") != args.region:
            raise MigrationError("AWS resource region does not match --region")

    try:
        import boto3
    except ImportError as error:
        raise MigrationError("boto3 is required for --apply") from error

    session = boto3.Session(profile_name=args.profile, region_name=args.region)
    client_options: dict[str, Any] = {}
    if args.through_version is not None:
        from botocore.config import Config

        # The finite release path must surface ambiguous failures to its operator.
        # Explicit pre-acceptance Aurora resume handling remains in _rds_call.
        client_options["config"] = Config(
            retries={"total_max_attempts": 1}, connect_timeout=10, read_timeout=35
        )
    execution_started = time.monotonic() if args.schema_only else None
    execution_deadline = execution_started + SCHEMA_ONLY_MAX_SECONDS if args.schema_only else None
    identity = session.client("sts", **client_options).get_caller_identity()
    if identity.get("Account") != args.expected_account:
        raise MigrationError("active AWS identity does not match --expected-account")

    migrator = DataApiMigrator(
        rds_data=session.client("rds-data", **client_options),
        secrets_manager=None if args.schema_only else session.client("secretsmanager", **client_options),
        cluster_arn=args.cluster_arn,
        admin_secret_arn=args.admin_secret_arn,
        database=args.database,
        **({"request_limit": SCHEMA_ONLY_MAX_REQUESTS, "deadline": execution_deadline,
            "initial_requests": 1, "rollback_reserve": SCHEMA_ONLY_ROLLBACK_RESERVE}
           if args.schema_only else {}),
    )
    if args.schema_only:
        applied, skipped = migrator.apply(
            migrations, through_version=args.through_version, schema_only=True,
            after_version=args.after_version,
        )
        print(json.dumps({
            "status": "applied", "schemaOnly": True, "throughVersion": args.through_version,
            **({"afterVersion": args.after_version} if args.after_version is not None else {}),
            "appliedCount": len(applied), "skippedCount": len(skipped),
            "lastMigration": migrations[-1].name, "databaseInitialization": "forward-migrations",
            "databaseRoles": [], "passwordsExposed": False,
            "requestBudget": {"maximumRequests": SCHEMA_ONLY_MAX_REQUESTS,
                "requestsUsed": migrator.requests_used, "rollbackReserve": SCHEMA_ONLY_ROLLBACK_RESERVE,
                "maximumSeconds": SCHEMA_ONLY_MAX_SECONDS,
                "elapsedSeconds": time.monotonic() - execution_started,
                "credentialProviderInternalRequests": "unmeasured"},
        }, indent=2))
        return 0
    database_state = migrator.database_initialization_state()
    if database_state == "fresh" and args.fresh_initialization == "baseline":
        applied = migrator.apply_baseline(baseline)
        # The retained baseline may precede the newest forward migrations.
        # Recheck its seeded ledger before applying the tail, just as on upgrade.
        tail_applied, _ = migrator.apply(
            migrations, **({"through_version": args.through_version} if args.through_version is not None else {})
        )
        applied.extend(tail_applied)
        skipped: list[str] = []
        initialization = f"baseline-{baseline.release:04d}"
    else:
        applied, skipped = migrator.apply(
            migrations, **({"through_version": args.through_version} if args.through_version is not None else {})
        )
        initialization = (
            "migration-replay" if database_state == "fresh" else "forward-migrations"
        )
    migrator.configure_role("opengeo_runtime", args.runtime_secret_arn)
    migrator.configure_role("opengeo_worker", args.worker_secret_arn)
    configured_roles = ["opengeo_runtime", "opengeo_worker"]
    if args.connector_secret_arn is not None:
        migrator.configure_role("opengeo_connector", args.connector_secret_arn)
        configured_roles.append("opengeo_connector")
    if args.dataset_verifier_secret_arn is not None:
        migrator.configure_role(
            "opengeo_dataset_verifier", args.dataset_verifier_secret_arn
        )
        configured_roles.append("opengeo_dataset_verifier")
    if args.observable_coordinator_secret_arn is not None:
        migrator.configure_role(
            "opengeo_observable_coordinator",
            args.observable_coordinator_secret_arn,
        )
        configured_roles.append("opengeo_observable_coordinator")
    if args.framework_publisher_secret_arn is not None:
        migrator.configure_role(
            "opengeo_framework_publisher",
            args.framework_publisher_secret_arn,
        )
        configured_roles.append("opengeo_framework_publisher")
    if args.source_archiver_secret_arn is not None:
        migrator.configure_role(
            "opengeo_source_archiver",
            args.source_archiver_secret_arn,
        )
        configured_roles.append("opengeo_source_archiver")
    if args.repository_copier_secret_arn is not None:
        migrator.configure_role(
            "opengeo_repository_copier",
            args.repository_copier_secret_arn,
        )
        configured_roles.append("opengeo_repository_copier")
    migrator.verify_roles(publisher_enabled=args.framework_publisher_secret_arn is not None)
    print(
        json.dumps(
            {
                "status": "applied",
                "appliedCount": len(applied),
                "skippedCount": len(skipped),
                "lastMigration": migrations[-1].name,
                "databaseInitialization": initialization,
                "databaseRoles": configured_roles,
                "passwordsExposed": False,
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except MigrationError as error:
        print(f"migration error: {error}", file=sys.stderr)
        raise SystemExit(1) from error

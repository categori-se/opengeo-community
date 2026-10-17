#!/usr/bin/env python3
"""Build or verify OpenGeo's deterministic fresh-database baseline.

The script applies the complete migration chain to a temporary, network-isolated
PostgreSQL/PostGIS container and exports the final ``app`` catalog with
``pg_dump``. A second empty container produces PostgreSQL's stable round-trip
form, and a third proves that the checked candidate restores to that exact
catalog. It accepts the candidate only when object identities, OpenGeo roles,
extension versions, and the stable catalog all agree. By default it verifies the
checked-in artifact. ``--write`` updates the artifact and manifest after the
same equivalence checks pass.
"""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import NoReturn, Self

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS_DIR = ROOT / "migrations"
BASELINES_DIR = ROOT / "baselines"
PREAMBLE_PATH = Path(__file__).with_name("baseline-preamble.sql")
BASELINE_RELEASE = 89
BASELINE_NAME = "0089_opengeo_schema.sql"
MANIFEST_NAME = "0089_opengeo_schema.manifest.json"
IMAGE = (
    "docker.io/postgis/postgis@"
    "sha256:8828b03e9a95269f808abe62aa83215b22a2d3710f54a55e8040327b7b5f9932"
)
MIGRATION_NAME = re.compile(r"^[0-9]{4}_[a-z0-9_]+\.sql$")
PSQL_META = re.compile(r"^\\(?:restrict|unrestrict)\b.*$", re.MULTILINE)
ROLE_QUERY = """
SELECT rolname, rolcanlogin, rolinherit, rolcreatedb, rolcreaterole,
       rolsuper, rolbypassrls, rolconnlimit, coalesce(array_to_string(rolconfig, ','), '')
FROM pg_roles
WHERE rolname LIKE 'opengeo_%'
ORDER BY rolname
""".strip()
EXTENSION_QUERY = """
SELECT extname, extversion
FROM pg_extension
WHERE extname IN ('pgcrypto', 'postgis')
ORDER BY extname
""".strip()
OBJECT_IDENTITY_QUERY = """
SELECT identity
FROM (
  SELECT 'class|' || c.relkind::text || '|' || c.relname AS identity
  FROM pg_class AS c
  JOIN pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = 'app'
  UNION ALL
  SELECT 'function|' || p.oid::regprocedure::text
  FROM pg_proc AS p
  JOIN pg_namespace AS n ON n.oid = p.pronamespace
  WHERE n.nspname = 'app'
  UNION ALL
  SELECT 'type|' || t.typtype::text || '|' || t.typname
  FROM pg_type AS t
  JOIN pg_namespace AS n ON n.oid = t.typnamespace
  WHERE n.nspname = 'app'
  UNION ALL
  SELECT 'constraint|' || co.contype::text || '|' || co.conrelid::regclass::text || '|' || co.conname
  FROM pg_constraint AS co
  JOIN pg_namespace AS n ON n.oid = co.connamespace
  WHERE n.nspname = 'app'
  UNION ALL
  SELECT 'policy|' || p.polrelid::regclass::text || '|' || p.polname
  FROM pg_policy AS p
  JOIN pg_class AS c ON c.oid = p.polrelid
  JOIN pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = 'app'
  UNION ALL
  SELECT 'trigger|' || t.tgrelid::regclass::text || '|' || t.tgname
  FROM pg_trigger AS t
  JOIN pg_class AS c ON c.oid = t.tgrelid
  JOIN pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = 'app' AND NOT t.tgisinternal
) AS catalog
ORDER BY identity
""".strip()


class BaselineError(RuntimeError):
    """Raised when generation or equivalence fails closed."""


@dataclass(frozen=True)
class MigrationSource:
    name: str
    sha256: str
    path: Path


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def fail(message: str) -> NoReturn:
    raise BaselineError(message)


def run(
    arguments: Sequence[str],
    *,
    capture: bool = False,
    check: bool = True,
) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        list(arguments),
        check=check,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )


def load_migrations() -> list[MigrationSource]:
    paths = sorted(MIGRATIONS_DIR.glob("*.sql"))
    if len(paths) < BASELINE_RELEASE:
        fail(f"expected at least {BASELINE_RELEASE} migrations, found {len(paths)}")
    sources: list[MigrationSource] = []
    for expected, path in enumerate(paths, start=1):
        if not MIGRATION_NAME.fullmatch(path.name):
            fail(f"invalid migration filename: {path.name}")
        if int(path.name[:4]) != expected:
            fail(f"migration sequence is not contiguous at {path.name}")
        # Later migrations remain forward upgrades, not changes to this baseline.
        # Validate their sequence too, but reproduce only the pinned release.
        if expected <= BASELINE_RELEASE:
            data = path.read_bytes()
            sources.append(MigrationSource(path.name, sha256(data), path))
    return sources


def migration_chain_sha256(sources: Sequence[MigrationSource]) -> str:
    digest = hashlib.sha256()
    for source in sources:
        digest.update(source.name.encode("utf-8"))
        digest.update(b"\0")
        digest.update(source.path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def normalize_dump(value: str) -> str:
    normalized = PSQL_META.sub("", value).replace("\r\n", "\n")
    return normalized.strip() + "\n"


def ledger_sql(sources: Sequence[MigrationSource]) -> str:
    values = ",\n".join(f"  ('{source.name}', '{source.sha256}')" for source in sources)
    return f"""
CREATE SCHEMA opengeo_deploy;

CREATE TABLE opengeo_deploy.schema_migrations (
  migration_name text PRIMARY KEY,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{{64}}$'),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

REVOKE ALL ON SCHEMA opengeo_deploy FROM PUBLIC;
REVOKE ALL ON TABLE opengeo_deploy.schema_migrations FROM PUBLIC;

INSERT INTO opengeo_deploy.schema_migrations (migration_name, sha256) VALUES
{values};

COMMIT;
""".lstrip()


def candidate_sql(schema_dump: str, sources: Sequence[MigrationSource]) -> bytes:
    preamble = PREAMBLE_PATH.read_text(encoding="utf-8").rstrip()
    body = normalize_dump(schema_dump).rstrip()
    value = (
        f"-- OpenGeo fresh-database baseline {BASELINE_RELEASE:04d}.\n"
        "-- Generated only after migration-chain and restore catalogs compare exactly.\n"
        f"-- Source chain SHA-256: {migration_chain_sha256(sources)}\n\n"
        f"{preamble}\n\n{body}\n\n{ledger_sql(sources)}"
    )
    return value.encode("utf-8")


def manifest(candidate: bytes, sources: Sequence[MigrationSource]) -> dict[str, object]:
    return {
        "schemaVersion": "opengeo.database-baseline-manifest.1.0.0",
        "release": BASELINE_RELEASE,
        "baseline": BASELINE_NAME,
        "baselineSha256": sha256(candidate),
        "migrationChainSha256": migration_chain_sha256(sources),
        "postgresMajor": 16,
        "postgisSeries": "3.5",
        "generatorImage": IMAGE,
        "containsUserData": False,
        "migrations": [
            {"name": source.name, "sha256": source.sha256} for source in sources
        ],
    }


class TemporaryDatabase:
    def __init__(self, runtime: str, init_directory: Path, label: str) -> None:
        self.runtime = runtime
        self.init_directory = init_directory
        self.label = label
        self.name = f"opengeo-baseline-{label}-{os.getpid()}-{secrets.token_hex(4)}"

    def __enter__(self) -> Self:
        mount_arguments = (
            [
                "--volume",
                f"{self.init_directory}:/docker-entrypoint-initdb.d:ro,Z",
            ]
            if self.runtime == "podman"
            else [
                "--mount",
                (
                    "type=bind,"
                    f"src={self.init_directory},"
                    "dst=/docker-entrypoint-initdb.d,ro=true"
                ),
            ]
        )
        run(
            [
                self.runtime,
                "run",
                "--detach",
                # Readiness requires entrypoint logs; host journald may expose none.
                *(["--log-driver=k8s-file"] if self.runtime == "podman" else []),
                "--name",
                self.name,
                "--network",
                "none",
                "--env",
                "POSTGRES_HOST_AUTH_METHOD=trust",
                "--env",
                "POSTGRES_DB=opengeo",
                *mount_arguments,
                IMAGE,
            ],
            capture=True,
        )
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            logs = run([self.runtime, "logs", self.name], capture=True, check=False)
            log_text = (logs.stdout + logs.stderr).decode("utf-8", "replace")
            ready = run(
                [
                    self.runtime,
                    "exec",
                    self.name,
                    "pg_isready",
                    "--username",
                    "postgres",
                    "--dbname",
                    "opengeo",
                ],
                capture=True,
                check=False,
            )
            if (
                "PostgreSQL init process complete; ready for start up." in log_text
                and ready.returncode == 0
            ):
                return self
            status = run(
                [self.runtime, "inspect", "--format", "{{.State.Running}}", self.name],
                capture=True,
                check=False,
            )
            if status.returncode != 0 or status.stdout.strip() != b"true":
                run(
                    [self.runtime, "rm", "--force", "--volumes", self.name],
                    capture=True,
                    check=False,
                )
                fail(
                    f"temporary {self.label} database stopped during initialization:\n"
                    f"{log_text[-20000:]}"
                )
            time.sleep(1)
        fail(f"temporary {self.label} database did not become ready within 120 seconds")

    def __exit__(self, *_error: object) -> None:
        run(
            [self.runtime, "rm", "--force", "--volumes", self.name],
            capture=True,
            check=False,
        )

    def dump_app_schema(self) -> str:
        completed = run(
            [
                self.runtime,
                "exec",
                self.name,
                "pg_dump",
                "--username",
                "postgres",
                "--dbname",
                "opengeo",
                "--schema-only",
                "--schema=app",
                "--no-owner",
                "--no-table-access-method",
                "--no-tablespaces",
            ],
            capture=True,
        )
        return completed.stdout.decode("utf-8")

    def query(self, sql: str) -> str:
        completed = run(
            [
                self.runtime,
                "exec",
                self.name,
                "psql",
                "--username",
                "postgres",
                "--dbname",
                "opengeo",
                "--no-align",
                "--tuples-only",
                "--field-separator=|",
                "--command",
                sql,
            ],
            capture=True,
        )
        return completed.stdout.decode("utf-8").strip()


def prepare_init_directory(target: Path, files: Sequence[tuple[str, bytes]]) -> None:
    target.mkdir(mode=0o755)
    for name, content in files:
        (target / name).write_bytes(content)


def choose_runtime(explicit: str | None) -> str:
    if explicit:
        if explicit not in {"docker", "podman"}:
            fail("--runtime must be docker or podman")
        if shutil.which(explicit) is None:
            fail(f"container runtime is unavailable: {explicit}")
        return explicit
    for candidate in ("docker", "podman"):
        if shutil.which(candidate):
            return candidate
    fail("Docker or Podman is required to build or verify the database baseline")


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--write", action="store_true", help="update the checked artifact"
    )
    parser.add_argument("--runtime", choices=("docker", "podman"))
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    runtime = choose_runtime(args.runtime)
    sources = load_migrations()

    with tempfile.TemporaryDirectory(prefix="opengeo-baseline-") as temporary:
        work = Path(temporary)
        migration_init = work / "migration-init"
        prepare_init_directory(
            migration_init,
            [(source.name, source.path.read_bytes()) for source in sources],
        )
        with TemporaryDatabase(runtime, migration_init, "migrations") as migrated:
            migrated_dump = normalize_dump(migrated.dump_app_schema())
            migrated_objects = migrated.query(OBJECT_IDENTITY_QUERY)
            migrated_roles = migrated.query(ROLE_QUERY)
            migrated_extensions = migrated.query(EXTENSION_QUERY)
            migrated_server = migrated.query("SHOW server_version")

        first_round_candidate = candidate_sql(migrated_dump, sources)
        canonical_init = work / "canonical-init"
        prepare_init_directory(canonical_init, [(BASELINE_NAME, first_round_candidate)])
        with TemporaryDatabase(runtime, canonical_init, "canonical") as canonical:
            canonical_dump = normalize_dump(canonical.dump_app_schema())
            canonical_objects = canonical.query(OBJECT_IDENTITY_QUERY)
            canonical_roles = canonical.query(ROLE_QUERY)
            canonical_extensions = canonical.query(EXTENSION_QUERY)
            canonical_server = canonical.query("SHOW server_version")

        if migrated_objects != canonical_objects:
            fail("baseline round trip changes the OpenGeo catalog object identities")
        if migrated_roles != canonical_roles:
            fail("baseline round trip changes the OpenGeo role contract")
        if migrated_extensions != canonical_extensions:
            fail("baseline round trip changes the extension contract")
        if migrated_server != canonical_server:
            fail("baseline round trip changes the PostgreSQL version")

        candidate = candidate_sql(canonical_dump, sources)
        baseline_init = work / "baseline-init"
        prepare_init_directory(baseline_init, [(BASELINE_NAME, candidate)])
        with TemporaryDatabase(runtime, baseline_init, "baseline") as initialized:
            initialized_dump = normalize_dump(initialized.dump_app_schema())
            initialized_objects = initialized.query(OBJECT_IDENTITY_QUERY)
            initialized_roles = initialized.query(ROLE_QUERY)
            initialized_extensions = initialized.query(EXTENSION_QUERY)
            initialized_server = initialized.query("SHOW server_version")
            ledger_count = initialized.query(
                "SELECT count(*) FROM opengeo_deploy.schema_migrations"
            )

        if canonical_dump != initialized_dump:
            difference = "".join(
                list(
                    difflib.unified_diff(
                        canonical_dump.splitlines(keepends=True),
                        initialized_dump.splitlines(keepends=True),
                        fromfile="canonical-app-schema",
                        tofile="baseline-app-schema",
                        n=2,
                    )
                )[:160]
            )
            fail(
                "baseline restore does not reproduce the migration-chain app catalog:\n"
                f"{difference[:12000]}"
            )
        if canonical_objects != initialized_objects:
            fail("baseline restore changes the OpenGeo catalog object identities")
        if canonical_roles != initialized_roles:
            fail("baseline restore does not reproduce the OpenGeo role contract")
        if canonical_extensions != initialized_extensions:
            fail("baseline restore does not reproduce the extension contract")
        if canonical_server != initialized_server:
            fail("baseline restore does not reproduce the PostgreSQL version")
        if ledger_count != str(BASELINE_RELEASE):
            fail(
                f"baseline ledger contains {ledger_count} rows, expected {BASELINE_RELEASE}"
            )

        expected_manifest = manifest(candidate, sources)
        manifest_bytes = (
            json.dumps(expected_manifest, indent=2, sort_keys=False) + "\n"
        ).encode("utf-8")
        baseline_path = BASELINES_DIR / BASELINE_NAME
        manifest_path = BASELINES_DIR / MANIFEST_NAME
        if args.write:
            BASELINES_DIR.mkdir(exist_ok=True)
            baseline_path.write_bytes(candidate)
            manifest_path.write_bytes(manifest_bytes)
            mode = "written"
        else:
            if not baseline_path.exists() or not manifest_path.exists():
                fail("checked baseline is missing; run with --write after review")
            if baseline_path.read_bytes() != candidate:
                fail("checked baseline differs from the deterministic migration result")
            if manifest_path.read_bytes() != manifest_bytes:
                fail("checked baseline manifest is stale")
            mode = "verified"

    print(
        json.dumps(
            {
                "status": mode,
                "baseline": BASELINE_NAME,
                "release": BASELINE_RELEASE,
                "migrationCount": len(sources),
                "baselineSha256": expected_manifest["baselineSha256"],
                "migrationChainSha256": expected_manifest["migrationChainSha256"],
                "canonicalCatalogSha256": sha256(canonical_dump.encode("utf-8")),
                "catalogObjectIdentityCount": len(canonical_objects.splitlines()),
                "postgresVersion": canonical_server,
                "extensions": dict(
                    line.split("|", maxsplit=1)
                    for line in canonical_extensions.splitlines()
                    if line
                ),
                "catalogEquivalent": True,
                "rolesEquivalent": True,
                "extensionsEquivalent": True,
                "containsUserData": False,
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as error:
        detail = (error.stderr or b"").decode("utf-8", "replace").strip()
        suffix = f":\n{detail[-4000:]}" if detail else ""
        print(f"baseline error: {error}{suffix}", file=sys.stderr)
        raise SystemExit(1) from error
    except BaselineError as error:
        print(f"baseline error: {error}", file=sys.stderr)
        raise SystemExit(1) from error

"""Restore only an owned synthetic Studio checkpoint, never an AWS database.

The caller stops its local API before taking this quiescent snapshot. A fresh
database and separate object directory must reproduce data and authorization
before the browser is allowed to continue against them.
"""

import json
import os
import re
import shutil
import subprocess
from contextlib import contextmanager
from hashlib import sha256
from pathlib import Path
from uuid import UUID


def digest(body):
    return sha256(body).hexdigest()


def checked_work(work):
    work = Path(work)
    if (
        work != work.resolve()
        or work.parent != Path("/tmp")
        or not re.fullmatch(r"opengeo-integrated-studio-[A-Za-z0-9_-]+", work.name)
        or work.stat().st_uid != os.getuid()
    ):
        raise ValueError("Restore requires the owned local Studio directory")
    return work


def copy_objects(source, destination):
    """Copy exact version bytes, not arbitrary object-key paths or symlinks."""
    index_path = source / "objects.json"
    if index_path.is_symlink() or (source / "objects").is_symlink():
        raise ValueError("Object snapshot must contain regular local files")
    index_bytes = index_path.read_bytes()
    index = json.loads(index_bytes)
    if not isinstance(index, dict) or not 1 <= len(index) <= 256:
        raise ValueError("Object snapshot inventory is empty or exceeds its bound")
    records, total = [], 0
    for version, entry in index.items():
        if str(UUID(version)) != version or entry["version_id"] != version:
            raise ValueError("Object version identity changed")
        path = source / "objects" / version
        if path.is_symlink() or not path.is_file():
            raise ValueError("Object snapshot must contain regular local files")
        if not 0 <= path.stat().st_size <= 16_777_216:
            raise ValueError("Object snapshot size exceeds its bound")
        body = path.read_bytes()
        total += len(body)
        if total > 67_108_864:
            raise ValueError("Object snapshot exceeds its total byte bound")
        if len(body) != entry["size_bytes"] or digest(body) != entry["checksum_sha256"]:
            raise ValueError("Object bytes do not match the sealed version")
        records.append({"version": version, "sha256": digest(body), "bytes": len(body)})
    if sorted(path.name for path in (source / "objects").iterdir()) != sorted(index):
        raise ValueError("Object snapshot contains unindexed files")
    destination.mkdir(mode=0o700, exist_ok=False)
    (destination / "objects").mkdir(mode=0o700)
    for entry in records:
        shutil.copyfile(
            source / "objects" / entry["version"],
            destination / "objects" / entry["version"],
        )
    (destination / "objects.json").write_bytes(index_bytes)
    return {"indexSha256": digest(index_bytes), "objects": records, "bytes": total}


def database_fingerprint(database):
    from build_baseline import EXTENSION_QUERY, ROLE_QUERY, normalize_dump

    tables = json.loads(
        database.query("""
        SELECT json_agg(n.nspname || '.' || c.relname ORDER BY n.nspname, c.relname)
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('app', 'opengeo_deploy') AND c.relkind IN ('r', 'm')
    """)
    )
    if not tables or any(
        not re.fullmatch(r"(?:app|opengeo_deploy)\.[a-z_][a-z_0-9]*", name)
        for name in tables
    ):
        raise ValueError("Unexpected local database table inventory")
    queries = []
    for name in tables:
        row_hash = "encode(sha256(convert_to(to_jsonb(t)::text, 'UTF8')), 'hex')"
        queries.append(f"""SELECT '{name}' AS name, count(*) AS rows,
            encode(sha256(convert_to(coalesce(string_agg({row_hash}, '' ORDER BY {row_hash}), ''), 'UTF8')), 'hex') AS sha256
            FROM {name} t""")
    rows = json.loads(
        database.query(
            "SELECT json_agg(t ORDER BY name) FROM ("
            + " UNION ALL ".join(queries)
            + ") t"
        )
    )
    owners = database.query("""
        SELECT identity, owner FROM (
          SELECT 'class|' || c.oid::regclass::text AS identity, pg_get_userbyid(c.relowner) AS owner
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('app', 'opengeo_deploy')
          UNION ALL
          SELECT 'function|' || p.oid::regprocedure::text, pg_get_userbyid(p.proowner)
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app'
        ) t ORDER BY identity
    """)
    memberships = database.query("""
        SELECT pg_get_userbyid(roleid), pg_get_userbyid(member), pg_get_userbyid(grantor),
          admin_option, inherit_option, set_option FROM pg_auth_members
        ORDER BY 1, 2, 3
    """)
    return {
        "tables": rows,
        "schemaSha256": digest(normalize_dump(database.dump_app_schema()).encode()),
        "roles": database.query(ROLE_QUERY),
        "roleMemberships": memberships,
        "ownersSha256": digest(owners.encode()),
        "extensions": database.query(EXTENSION_QUERY),
    }


def dump_command(database, program, *arguments, body=None):
    if program not in {"pg_dump", "pg_dumpall", "pg_restore"}:
        raise ValueError("Only native database backup/restore commands are allowed")
    if not re.fullmatch(
        r"opengeo-baseline-integrated-studio(?:-restore)?-[0-9]+-[0-9a-f]{8}",
        database.name,
    ):
        raise ValueError("Refusing a non-test database target")
    result = subprocess.run(
        [
            "podman",
            "exec",
            "--interactive",
            database.name,
            program,
            "--username=postgres",
            *arguments,
        ],
        input=body,
        capture_output=True,
        check=True,
        timeout=90,
    )
    if len(result.stdout) > 67_108_864:
        raise ValueError("Local database dump exceeds its bound")
    return result.stdout


@contextmanager
def restored_checkpoint(database, work, pilot):
    from build_baseline import TemporaryDatabase

    work = checked_work(work)
    if json.loads((work / "queue.json").read_text()) != []:
        raise ValueError("Drain the synthetic queue before taking a restore checkpoint")
    snapshot = work / "recovery-snapshot"
    objects = copy_objects(work, snapshot)
    before = database_fingerprint(database)
    if not any(
        table["name"] == "app.maps" and table["rows"] > 0 for table in before["tables"]
    ):
        raise ValueError("Recovery must exercise populated project data")
    archive = dump_command(database, "pg_dump", "--dbname=opengeo", "--format=custom")
    roles = dump_command(database, "pg_dumpall", "--roles-only", "--no-role-passwords")
    # The fresh PostGIS container already owns its bootstrap postgres role.
    # Restore every application role and grant; never carry credential hashes.
    if roles.count(b"CREATE ROLE postgres;") != 1 or b" PASSWORD " in roles:
        raise ValueError("Unexpected role bootstrap or credential-bearing dump")
    roles = roles.replace(
        b"CREATE ROLE postgres;", b"-- Bootstrap postgres already exists."
    )
    (snapshot / "database.dump").write_bytes(archive)
    init = work / "restore-init"
    init.mkdir(mode=0o755)
    (init / "001-roles.sql").write_bytes(roles)
    init.chmod(0o755)
    (init / "001-roles.sql").chmod(0o444)
    destination = work / "restored"
    assert copy_objects(snapshot, destination) == objects
    (destination / "queue.json").write_text("[]\n")
    restored = TemporaryDatabase("podman", init, "integrated-studio-restore")
    volumes = []
    try:
        with restored:
            volumes = pilot.database_volumes(restored.name)
            dump_command(
                restored,
                "pg_restore",
                "--dbname=postgres",
                "--clean",
                "--if-exists",
                "--create",
                "--exit-on-error",
                body=archive,
            )
            after = database_fingerprint(restored)
            assert after == before, (
                "Restored rows, ownership, roles, grants or schema differ"
            )
            assert database_fingerprint(database) == before, (
                "The frozen source changed during backup"
            )
            proof = {
                "sourceDatabase": database.name,
                "restoredDatabase": restored.name,
                "databaseDumpSha256": digest(archive),
                "roleDumpSha256": digest(roles),
                "objects": objects,
                "database": before,
                "exactRestoreBeforeReads": True,
                "sourceApiStopped": True,
                "separateDatabaseAndObjectDirectory": True,
                "removedDatabaseVolumes": volumes,
            }
            (work / "restore-checkpoint-proof.json").write_text(
                json.dumps(proof, indent=2) + "\n"
            )
            yield restored, destination, proof
    finally:
        pilot.cleanup_resources([restored.name], volumes)

#!/usr/bin/env python3
"""Prove rating summaries survive overlapping PostgreSQL transactions.

This check is intentionally limited to a disposable loopback database whose
name starts with ``opengeo_community_concurrency``. It coordinates two rating
inserts so the second transaction is confirmed waiting on the first summary
row before the first is allowed to commit. A snapshot-wide recomputation loses
one rating in this schedule; the atomic delta trigger must retain both.
"""

from __future__ import annotations

import argparse
import json
import queue
import re
import threading
import time
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse
from uuid import UUID, uuid4

import psycopg

CONFIRMATION = "verify-local-rating-concurrency"
DATABASE_NAME = re.compile(r"^opengeo_community_concurrency(?:_[a-z0-9]+)?$")


class ConcurrencyCheckError(RuntimeError):
    """Raised when the disposable-database boundary or invariant fails."""


@dataclass(frozen=True, slots=True)
class Fixture:
    organization_id: UUID
    owner_id: UUID
    first_user_id: UUID
    second_user_id: UUID
    project_id: UUID
    resource_id: UUID
    version_id: UUID


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database-url", required=True)
    parser.add_argument("--confirm", required=True)
    return parser.parse_args(argv)


def validate_target(database_url: str, confirmation: str) -> None:
    if confirmation != CONFIRMATION:
        raise ConcurrencyCheckError(f"--confirm must equal {CONFIRMATION}")
    target = urlparse(database_url)
    if target.scheme not in {"postgres", "postgresql"}:
        raise ConcurrencyCheckError("database URL must use PostgreSQL")
    if target.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise ConcurrencyCheckError("concurrency check requires a loopback database")
    database_name = target.path.removeprefix("/")
    if not DATABASE_NAME.fullmatch(database_name):
        raise ConcurrencyCheckError(
            "disposable database name must start with opengeo_community_concurrency"
        )


def create_fixture(database_url: str) -> Fixture:
    fixture = Fixture(*(uuid4() for _ in range(7)))
    with psycopg.connect(database_url) as connection, connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO app.users (id, cognito_subject, email, display_name)
            VALUES
              (%s, %s, %s, 'Concurrency owner'),
              (%s, %s, %s, 'Concurrency first reader'),
              (%s, %s, %s, 'Concurrency second reader')
            """,
            (
                fixture.owner_id,
                f"rating-owner-{fixture.owner_id}",
                f"rating-owner-{fixture.owner_id}@example.test",
                fixture.first_user_id,
                f"rating-first-{fixture.first_user_id}",
                f"rating-first-{fixture.first_user_id}@example.test",
                fixture.second_user_id,
                f"rating-second-{fixture.second_user_id}",
                f"rating-second-{fixture.second_user_id}@example.test",
            ),
        )
        cursor.execute(
            """
            INSERT INTO app.organizations (id, name, slug, created_by)
            VALUES (%s, 'Rating concurrency', %s, %s)
            """,
            (
                fixture.organization_id,
                f"rating-concurrency-{fixture.organization_id.hex}",
                fixture.owner_id,
            ),
        )
        cursor.execute(
            """
            INSERT INTO app.organization_memberships
              (organization_id, user_id, role, invited_by)
            VALUES
              (%s, %s, 'admin', %s),
              (%s, %s, 'member', %s),
              (%s, %s, 'member', %s)
            """,
            (
                fixture.organization_id,
                fixture.owner_id,
                fixture.owner_id,
                fixture.organization_id,
                fixture.first_user_id,
                fixture.owner_id,
                fixture.organization_id,
                fixture.second_user_id,
                fixture.owner_id,
            ),
        )
        cursor.execute(
            """
            INSERT INTO app.projects (id, organization_id, name, created_by)
            VALUES (%s, %s, 'Rating concurrency project', %s)
            """,
            (fixture.project_id, fixture.organization_id, fixture.owner_id),
        )
        cursor.execute(
            """
            INSERT INTO app.project_memberships
              (organization_id, project_id, user_id, role)
            VALUES
              (%s, %s, %s, 'owner'),
              (%s, %s, %s, 'viewer'),
              (%s, %s, %s, 'viewer')
            """,
            (
                fixture.organization_id,
                fixture.project_id,
                fixture.owner_id,
                fixture.organization_id,
                fixture.project_id,
                fixture.first_user_id,
                fixture.organization_id,
                fixture.project_id,
                fixture.second_user_id,
            ),
        )
        cursor.execute("SET CONSTRAINTS ALL DEFERRED")
        cursor.execute(
            """
            INSERT INTO app.governed_resources
              (id, organization_id, project_id, kind, slug, visibility, state,
               current_version_id, owner_user_id, created_by, updated_by)
            VALUES
              (%s, %s, %s, 'dataset', 'rating-concurrency-dataset', 'public',
               'published', %s, %s, %s, %s)
            """,
            (
                fixture.resource_id,
                fixture.organization_id,
                fixture.project_id,
                fixture.version_id,
                fixture.owner_id,
                fixture.owner_id,
                fixture.owner_id,
            ),
        )
        cursor.execute(
            """
            INSERT INTO app.governed_resource_versions
              (id, organization_id, resource_id, version_number, title, created_by)
            VALUES (%s, %s, %s, 1, 'Rating concurrency dataset', %s)
            """,
            (
                fixture.version_id,
                fixture.organization_id,
                fixture.resource_id,
                fixture.owner_id,
            ),
        )
    return fixture


def set_tenant(cursor: psycopg.Cursor[Any], fixture: Fixture, user_id: UUID) -> int:
    cursor.execute("SET ROLE opengeo_runtime")
    cursor.execute(
        "SELECT set_config('app.organization_id', %s, true)",
        (str(fixture.organization_id),),
    )
    cursor.execute("SELECT set_config('app.user_id', %s, true)", (str(user_id),))
    cursor.execute("SELECT pg_backend_pid()")
    row = cursor.fetchone()
    if row is None:
        raise ConcurrencyCheckError("rating writer has no PostgreSQL backend")
    return int(row[0])


def insert_rating(
    database_url: str,
    fixture: Fixture,
    user_id: UUID,
    score: int,
    inserted: threading.Event,
    release: threading.Event | None,
    backend_pids: queue.Queue[int],
    failures: queue.Queue[BaseException],
) -> None:
    try:
        with psycopg.connect(database_url) as connection, connection.cursor() as cursor:
            backend_pids.put(set_tenant(cursor, fixture, user_id))
            cursor.execute(
                """
                INSERT INTO app.governed_resource_ratings
                  (organization_id, project_id, resource_id, user_id, score)
                VALUES (%s, %s, %s, %s, %s)
                """,
                (
                    fixture.organization_id,
                    fixture.project_id,
                    fixture.resource_id,
                    user_id,
                    score,
                ),
            )
            inserted.set()
            if release is not None and not release.wait(timeout=10):
                raise ConcurrencyCheckError("first rating transaction was not released")
    except Exception as error:  # noqa: BLE001  # pragma: no cover - cross-thread handoff
        failures.put(error)
        inserted.set()


def wait_for_lock(database_url: str, backend_pid: int) -> tuple[str, str]:
    deadline = time.monotonic() + 10
    with psycopg.connect(database_url, autocommit=True) as connection:
        while time.monotonic() < deadline:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT COALESCE(wait_event_type, ''), COALESCE(wait_event, '')
                    FROM pg_stat_activity WHERE pid = %s
                    """,
                    (backend_pid,),
                )
                row = cursor.fetchone()
            if row and row[0] == "Lock":
                return str(row[0]), str(row[1])
            time.sleep(0.02)
    raise ConcurrencyCheckError("second rating transaction never overlapped on a lock")


def verify_summary(database_url: str, fixture: Fixture) -> dict[str, object]:
    with psycopg.connect(database_url) as connection, connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT rating_count, rating_sum
            FROM app.governed_resource_rating_summaries
            WHERE organization_id = %s AND project_id = %s AND resource_id = %s
            """,
            (fixture.organization_id, fixture.project_id, fixture.resource_id),
        )
        summary = cursor.fetchone()
        cursor.execute(
            """
            SELECT count(*), sum(score), count(*) FILTER (WHERE score IS NOT NULL)
            FROM app.governed_resource_ratings
            WHERE organization_id = %s AND project_id = %s AND resource_id = %s
            """,
            (fixture.organization_id, fixture.project_id, fixture.resource_id),
        )
        source = cursor.fetchone()
        cursor.execute("SHOW transaction_isolation")
        isolation = cursor.fetchone()
    if summary != (2, 8) or source != (2, 8, 2):
        raise ConcurrencyCheckError(
            f"rating summary diverged after overlap: summary={summary}, source={source}"
        )
    return {
        "ratingCount": int(summary[0]),
        "ratingSum": int(summary[1]),
        "sourceRows": int(source[0]),
        "transactionIsolation": str(isolation[0]) if isolation else None,
    }


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    validate_target(args.database_url, args.confirm)
    fixture = create_fixture(args.database_url)
    release_first = threading.Event()
    first_inserted = threading.Event()
    second_inserted = threading.Event()
    backend_pids: queue.Queue[int] = queue.Queue()
    failures: queue.Queue[BaseException] = queue.Queue()

    first = threading.Thread(
        target=insert_rating,
        args=(
            args.database_url,
            fixture,
            fixture.first_user_id,
            5,
            first_inserted,
            release_first,
            backend_pids,
            failures,
        ),
        daemon=True,
    )
    first.start()
    if not first_inserted.wait(timeout=10):
        raise ConcurrencyCheckError(
            "first rating transaction did not reach its hold point"
        )
    first_pid = backend_pids.get(timeout=1)
    if not failures.empty():
        raise failures.get()

    second = threading.Thread(
        target=insert_rating,
        args=(
            args.database_url,
            fixture,
            fixture.second_user_id,
            3,
            second_inserted,
            None,
            backend_pids,
            failures,
        ),
        daemon=True,
    )
    second.start()
    second_pid = backend_pids.get(timeout=10)
    wait_type, wait_event = wait_for_lock(args.database_url, second_pid)
    release_first.set()
    first.join(timeout=10)
    second.join(timeout=10)
    if first.is_alive() or second.is_alive():
        raise ConcurrencyCheckError("rating transactions did not finish")
    if not failures.empty():
        raise failures.get()
    if not second_inserted.is_set():
        raise ConcurrencyCheckError("second rating transaction did not commit")

    result = verify_summary(args.database_url, fixture)
    print(
        json.dumps(
            {
                "status": "passed",
                "schedule": "second transaction blocked on first aggregate row",
                "firstBackendPid": first_pid,
                "secondBackendPid": second_pid,
                "observedWaitType": wait_type,
                "observedWaitEvent": wait_event,
                **result,
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ConcurrencyCheckError, psycopg.Error, queue.Empty) as error:
        print(f"rating concurrency check failed: {error}")
        raise SystemExit(1) from error

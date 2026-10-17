"""Private stdin transport for the existing local Studio publication coordinator.

Runs only inside the isolated API container. PostgreSQL keeps its coordinator
role and lease functions; object bodies use the same retained local store as API
source uploads. There is no HTTP endpoint or production authentication bypass.
"""

import base64
import asyncio
import importlib.util
import json
import re
import sys
from pathlib import Path
from uuid import UUID

SPEC = importlib.util.spec_from_file_location(
    "integrated_pilot", Path(__file__).with_name("run-integrated-pilot-local.py")
)
pilot = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pilot)

FUNCTIONS = {
    "claim_observable_build_runtime", "heartbeat_observable_build",
    "resolve_observable_build_data", "read_observable_artifact_lease",
    "complete_observable_build", "fail_observable_build",
    "release_observable_build", "admit_observable_page_cache",
}


def execute_sql(request):
    import psycopg
    from psycopg.types.json import Jsonb

    sql = request["sql"]
    calls = re.findall(r"app\.([a-z_]+)\(", sql)
    if not sql.lstrip().startswith("SELECT ") or len(calls) != 1 or calls[0] not in FUNCTIONS or ";" in sql:
        raise ValueError("Unsupported local coordinator statement")
    values = {}
    for parameter in request["parameters"]:
        value = parameter["value"]
        item = value.get("stringValue", value.get("longValue"))
        if parameter.get("typeHint") == "UUID":
            item = UUID(item)
        elif parameter.get("typeHint") == "JSON":
            item = Jsonb(json.loads(item))
        values[parameter["name"]] = item
    statement = re.sub(r":([a-z]+)\b", r"%(\1)s", sql)
    with psycopg.connect("postgresql://opengeo_observable_coordinator@127.0.0.1/opengeo?sslmode=disable") as connection:
        return connection.execute(statement, values).fetchall()


def operate(request):
    operation = request["operation"]
    if operation == "sql":
        return execute_sql(request)
    if operation == "configure-publication":
        return pilot.configure_local_publication(request["projectId"], request["sourceProjectId"])
    if operation in {"publish", "public-read"}:
        from local_framework_publication import publish_local_review, read_publication

        if operation == "publish":
            return asyncio.run(publish_local_review(pilot, UUID(request["reviewId"]), maximum_files=64))
        record = read_publication(pilot, request["path"], review_id=request.get("reviewId"))
        return None if record is None else {**record, "body": base64.b64encode(record["body"]).decode()}
    store = pilot.LocalObjects()
    if operation == "read":
        record, body = store.exact(request["bucket"], request["objectKey"], request["s3VersionId"])
        if len(body) > request["maximumBytes"]:
            raise ValueError("Local object exceeds the exact input bound")
        return {**record, "body": base64.b64encode(body).decode()}
    if operation == "write":
        if request["bucket"] != pilot.BUCKET:
            raise ValueError("Local object bucket mismatch")
        body = base64.b64decode(request["body"], validate=True)
        if not 0 < len(body) <= request.get("maximumBytes", 16_777_216) or pilot.digest(body) != request["checksumSha256"]:
            raise ValueError("Local output checksum or length mismatch")
        # Coordinator output is immutable. Retry reuses the exact retained
        # version; a changed output under the same identity fails closed.
        with pilot.local_state_lock("publication-output"):
            records = [r for r in pilot.read_json("objects.json", {}).values()
                       if r["key"] == request["objectKey"]]
            if records:
                if len(records) != 1:
                    raise ValueError("Ambiguous retained output")
                record, existing = store.exact(pilot.BUCKET, request["objectKey"], records[0]["version_id"])
                if existing != body or record["content_type"] != request["contentType"]:
                    raise ValueError("Retained publication output collision")
                return record
            return store.put(request["objectKey"], body, request["contentType"])
    queue_name = request.get("queue", "observable-builds")
    queue = pilot.LocalQueue(queue_name)
    if operation == "receive":
        messages = pilot.read_json(f"{queue_name}.json", [])
        return messages[0] if messages else None
    if operation == "acknowledge":
        queue.delete(request["id"])
        return True
    raise ValueError("Unknown local publication operation")


if __name__ == "__main__":
    if not __debug__ or pilot.ROOT != Path("/repo"):
        raise SystemExit("Use the isolated local Studio container")
    try:
        request = json.loads(sys.stdin.buffer.read(150_000_001))
        print(json.dumps(operate(request), default=str))
    except Exception:
        # Never echo SQL parameters, source bytes or capabilities on failure.
        raise SystemExit("Local publication transport failed") from None

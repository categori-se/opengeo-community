import asyncio
import json
from types import SimpleNamespace
from uuid import uuid4

import pytest

from opengeo_api.archive_manifest_records import ArchiveManifestRepository
from opengeo_api.ingestion import IngestionConflict


def test_manifest_records_keep_destinations_separate_and_commit_before_writes():
    destinations = [uuid4(), uuid4()]
    context = SimpleNamespace(organization_id=uuid4(), user_id=uuid4())
    session, project = uuid4(), uuid4()
    intents, calls = {}, []

    class Transaction:
        async def fetch_one(self, sql, params):
            if "SELECT state" in sql:
                return ("complete",)
            return intents[params[2]]

        async def fetch_all(self, sql, params):
            return [
                (
                    index,
                    f"root/{index}.json",
                    3,
                    0,
                    "a" * 64,
                    index,
                    {"version_id": str(index), "key": f"country-{index}/originals/{index}"},
                    destinations[index],
                    "bucket",
                    f"country-{index}/",
                    "123456789012",
                    True,
                )
                for index in range(2)
            ]

        async def execute(self, sql, params):
            if "INSERT INTO" in sql:
                intents.setdefault(params[3], (*params[5:10], None))
            else:
                destination = params[3]
                row = intents[destination]
                intents[destination] = (*row[:5], params[0].obj)

    class Ingestion:
        in_transaction = False

        async def _run(self, context, operation):
            self.in_transaction = True
            try:
                return await operation(Transaction())
            finally:
                self.in_transaction = False

    ingestion = Ingestion()

    async def authorize(*args):
        pass

    class Peer:
        def __init__(self, bucket, prefix, owner):
            self.prefix = prefix

        async def preserve_manifest(self, key, body):
            assert not ingestion.in_transaction and len(intents) == 2
            document = json.loads(body)
            assert len(document["files"]) == 1
            assert document["files"][0]["object"]["key"].startswith(self.prefix)
            assert key.startswith(self.prefix)
            calls.append(key)
            return {"key": key, "version_id": "verified"}

    repository = ArchiveManifestRepository(
        SimpleNamespace(ingestion=ingestion, _authorize=authorize), Peer
    )
    result = asyncio.run(repository.preserve_page(context, project, session))
    assert len(result["records"]) == len(calls) == 2 and result["next_after"] is None
    assert asyncio.run(repository.preserve_page(context, project, session)) == result
    assert len(calls) == 2
    with pytest.raises(IngestionConflict):
        asyncio.run(repository.preserve_page(context, project, session, 0))

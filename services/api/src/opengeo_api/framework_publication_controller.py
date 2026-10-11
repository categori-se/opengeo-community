"""ID-only SQS publication worker. Never execute authored code or rebuild output."""

import asyncio
import json
from typing import Any
from uuid import UUID

from psycopg.types.json import Jsonb

from opengeo_api.config import Settings
from opengeo_api.framework_publication_aws import (
    CloudFrontPublicationEdge,
    PublicationAws,
    S3PublicationStorage,
)
from opengeo_api.framework_publisher import PublicationConflict, publish_step
from opengeo_api.processing_dispatch import AwsSqsRenderDispatcher
from opengeo_api.publication_destinations import configured_destination_router
from opengeo_api.rds_data import RdsDataApiClient


class DataApiPublicationRepository:
    def __init__(self, client: RdsDataApiClient) -> None:
        self.client = client

    async def _value(self, sql: str, parameters: tuple[Any, ...]) -> Any:
        result = await self.client.execute(sql, parameters)
        if len(result.records) != 1 or len(result.records[0]) != 1:
            raise PublicationConflict("publication_database_response_invalid")
        return result.records[0][0]

    async def claim(self, review: UUID, token: UUID) -> dict[str, Any]:
        value = await self._value("SELECT app.claim_framework_publication(%s, %s)", (review, token))
        if isinstance(value, str):
            value = json.loads(value)
        if not isinstance(value, dict):
            raise PublicationConflict("publication_database_response_invalid")
        return value

    async def authorize(self, review: UUID, token: UUID) -> bool:
        return (
            await self._value("SELECT app.authorize_framework_publication(%s, %s)", (review, token))
            is True
        )

    async def save_plan(
        self, review: UUID, token: UUID, plan: dict[str, Any], edge: dict[str, Any]
    ) -> bool:
        return (
            await self._value(
                "SELECT app.seal_framework_publication_plan(%s, %s, %s::jsonb, %s::jsonb)",
                (review, token, Jsonb(plan), Jsonb(edge)),
            )
            is True
        )

    async def checkpoint(self, review: UUID, token: UUID, position: int) -> bool:
        return (
            await self._value(
                "SELECT app.checkpoint_framework_publication(%s, %s, %s::integer)",
                (review, token, position),
            )
            is True
        )

    async def activating(self, review: UUID, token: UUID) -> bool:
        return (
            await self._value("SELECT app.activate_framework_publication(%s, %s)", (review, token))
            is True
        )

    async def complete(self, review: UUID, token: UUID, receipt: dict[str, Any]) -> bool:
        return (
            await self._value(
                "SELECT app.complete_framework_publication(%s, %s, %s::jsonb)",
                (review, token, Jsonb(receipt)),
            )
            is True
        )

    async def attention(self, review: UUID, token: UUID, code: str) -> None:
        await self._value(
            "SELECT app.release_framework_publication(%s, %s, %s)", (review, token, code)
        )

    async def release(self, review: UUID, token: UUID) -> None:
        await self._value("SELECT app.release_framework_publication(%s, %s)", (review, token))


async def process_publication_queue(
    event: dict[str, Any],
    *,
    settings: Settings,
    repository: Any,
    storage: Any,
    edge: Any,
    queue: Any,
    destination_router: Any = None,
) -> dict[str, Any]:
    records = event.get("Records")
    if not isinstance(records, list) or len(records) != 1:
        raise ValueError("Publication queue requires batch size one")
    record = records[0]
    if (
        not isinstance(record, dict)
        or not isinstance(record.get("messageId"), str)
        or not isinstance(record.get("receiptHandle"), str)
        or not isinstance(record.get("body"), str)
        or len(record["body"]) > 512
    ):
        raise ValueError("Invalid publication command")
    try:
        command = json.loads(record["body"])
        if (
            set(command) != {"schema", "review_id"}
            or command["schema"] != "opengeo.framework-publication.command.1.0.0"
        ):
            raise ValueError("Invalid publication command")
        status = await publish_step(
            UUID(command["review_id"]),
            repository=repository,
            storage=storage,
            edge=edge,
            source_bucket=settings.application_bucket or "",
            public_bucket=settings.framework_publication_public_bucket or "",
            destination_router=destination_router,
        )
    except Exception:
        status = "retry"  # Do not log dependency bodies, signed headers or source locations.
    if status == "deployed":
        return {"batchItemFailures": []}
    # Needs-attention jobs retain their origin reservation. Put them in the DLQ
    # after bounded redelivery; explicit resume uses this exact approved review.
    await queue.change_visibility(record["receiptHandle"], 60 if status == "retry" else 300)
    return {"batchItemFailures": [{"itemIdentifier": record["messageId"]}]}


async def _production(event: dict[str, Any]) -> dict[str, Any]:
    settings = Settings()
    if not all(
        (
            settings.framework_publication_queue_url,
            settings.application_bucket,
            settings.framework_publication_public_bucket,
            settings.framework_publication_distribution_id,
            settings.aws_region,
        )
    ):
        raise ValueError("Framework publisher is not configured")
    aws = PublicationAws(settings.aws_region or "")
    destination_router = configured_destination_router(aws, settings)
    return await process_publication_queue(
        event,
        settings=settings,
        repository=DataApiPublicationRepository(RdsDataApiClient(settings)),
        storage=S3PublicationStorage(
            aws,
            settings.application_bucket or "",
            settings.framework_publication_public_bucket or "",
        ),
        edge=CloudFrontPublicationEdge(aws, settings.framework_publication_distribution_id or ""),
        queue=AwsSqsRenderDispatcher(settings, queue_url=settings.framework_publication_queue_url),
        destination_router=destination_router,
    )


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    del context
    return asyncio.run(_production(event))

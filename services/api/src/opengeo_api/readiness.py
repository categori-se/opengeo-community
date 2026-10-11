import asyncio
from typing import Any, Protocol

import psycopg

from opengeo_api.config import Settings
from opengeo_api.rds_data import RdsDataApiClient, RdsDataApiUnavailable


class ReadinessProbe(Protocol):
    async def check(self) -> None: ...


class DatabaseNotConfiguredError(RuntimeError):
    pass


class DatabaseReadinessProbe:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    async def check(self) -> None:
        connection_options = self._settings.database_connection_kwargs()
        if connection_options is None:
            raise DatabaseNotConfiguredError("database is not configured")

        conninfo = str(connection_options.pop("conninfo", ""))
        connection = await asyncio.wait_for(
            psycopg.AsyncConnection.connect(conninfo, **connection_options),
            timeout=self._settings.readiness_timeout_seconds,
        )
        try:
            async with connection.cursor() as cursor:
                await cursor.execute("SELECT 1")
                row: tuple[Any, ...] | None = await cursor.fetchone()
                if row != (1,):
                    raise RuntimeError("database readiness query returned an unexpected result")
        finally:
            await connection.close()


class RdsDataApiReadinessProbe:
    def __init__(self, settings: Settings, client: RdsDataApiClient | None = None) -> None:
        self._client = client or RdsDataApiClient(settings)

    async def check(self) -> None:
        try:
            result = await self._client.execute("SELECT 1")
        except RdsDataApiUnavailable as error:
            raise RuntimeError("database readiness query failed") from error
        if result.records != ((1,),):
            raise RuntimeError("database readiness query returned an unexpected result")

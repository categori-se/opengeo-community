"""Bounded Wikidata relationship projection; no spatial containment inference."""

import asyncio
import hashlib
import json
import re
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from copy import deepcopy
from datetime import UTC, datetime
from time import monotonic
from typing import Any

import httpx2

ENDPOINT = "https://www.wikidata.org/w/api.php"
PROPERTIES = ("P17", "P30", "P131")
ITEM = re.compile(r"Q[1-9][0-9]{0,15}\Z")
MAX_BYTES = 1_048_576


class PlaceContextUnavailable(RuntimeError):
    pass


async def fetch_wikidata(params: dict[str, str]) -> str:
    async with (
        httpx2.AsyncClient(timeout=5.0, follow_redirects=False, trust_env=False) as client,
        client.stream(
            "GET",
            ENDPOINT,
            params=params,
            headers={
                "User-Agent": "OpenGeo.tools/0.1 (https://opengeo.tools)",
                "Accept": "application/json",
            },
        ) as response,
    ):
        response.raise_for_status()
        chunks = bytearray()
        async for chunk in response.aiter_bytes():
            chunks.extend(chunk)
            if len(chunks) > MAX_BYTES:
                raise PlaceContextUnavailable("Provider response exceeds the local bound")
        return chunks.decode("utf-8")


async def fetch_entities(ids: list[str]) -> str:
    return await fetch_wikidata(
        {
            "action": "wbgetentities",
            "ids": "|".join(ids),
            "props": "labels|descriptions|claims|info",
            "languages": "en",
            "format": "json",
            "maxlag": "5",
        }
    )


async def fetch_search(query: str) -> str:
    return await fetch_wikidata(
        {
            "action": "wbsearchentities",
            "search": query,
            "language": "en",
            "type": "item",
            "limit": "10",
            "format": "json",
            "maxlag": "5",
        }
    )


class PlaceContextResolver:
    def __init__(
        self,
        fetch: Callable[[list[str]], Awaitable[str]] = fetch_entities,
        search_fetch: Callable[[str], Awaitable[str]] = fetch_search,
    ):
        self.fetch = fetch
        self.search_fetch = search_fetch
        self.cache: OrderedDict[str, tuple[float, dict[str, Any]]] = OrderedDict()
        self.lock = asyncio.Lock()
        self.retry_after = 0.0

    async def search(self, query: str) -> dict[str, Any]:
        query = query.strip()
        if not 2 <= len(query) <= 120 or any(ord(char) < 32 for char in query):
            raise ValueError("Enter a place name of 2-120 characters")
        key = "search:" + query
        async with self.lock:
            cached = self.cache.get(key)
            if cached and monotonic() - cached[0] < 3600:
                self.cache.move_to_end(key)
                return {**deepcopy(cached[1]), "cached": True}
            if monotonic() < self.retry_after:
                raise PlaceContextUnavailable("Provider lookup is cooling down")
            try:
                async with asyncio.timeout(8):
                    raw = await self.search_fetch(query)
                if len(raw.encode()) > MAX_BYTES:
                    raise ValueError("Provider response too large")
                payload = json.loads(raw)
                if "error" in payload or not isinstance(payload.get("search"), list):
                    raise ValueError("Missing provider search results")
                if len(payload["search"]) > 10:
                    raise ValueError("Too many provider candidates")
                candidates = []
                for record in payload["search"]:
                    identity, label = record.get("id"), record.get("label")
                    description = record.get("description", "")
                    if (
                        not isinstance(identity, str)
                        or not ITEM.fullmatch(identity)
                        or not isinstance(label, str)
                        or not 1 <= len(label) <= 200
                        or not isinstance(description, str)
                        or len(description) > 2000
                    ):
                        raise ValueError("Invalid provider candidate")
                    candidates.append(
                        {
                            "id": identity,
                            "label": label,
                            "description": description,
                            "uri": "http://www.wikidata.org/entity/" + identity,
                        }
                    )
                result = {
                    "provider": "Wikidata",
                    "query": query,
                    "candidates": candidates,
                    "moreAvailable": "search-continue" in payload,
                    "retrievedAt": datetime.now(UTC).isoformat(),
                    "cached": False,
                }
            except (
                httpx2.HTTPError,
                OSError,
                ValueError,
                TypeError,
                AttributeError,
                TimeoutError,
                PlaceContextUnavailable,
            ) as error:
                self.retry_after = monotonic() + 30
                raise PlaceContextUnavailable("Place search unavailable") from error
            self.cache[key] = (monotonic(), deepcopy(result))
            while len(self.cache) > 64:
                self.cache.popitem(last=False)
            return result

    async def resolve(self, item: str) -> dict[str, Any]:
        if not ITEM.fullmatch(item):
            raise ValueError("Expected a Wikidata item ID")
        async with self.lock:
            cached = self.cache.get(item)
            if cached and monotonic() - cached[0] < 86400:
                self.cache.move_to_end(item)
                return {**deepcopy(cached[1]), "cached": True}
            if monotonic() < self.retry_after:
                raise PlaceContextUnavailable(
                    "Provider lookup is cooling down; reuse saved context"
                )
            try:
                async with asyncio.timeout(18):
                    result = await self._resolve(item)
            except (
                httpx2.HTTPError,
                OSError,
                ValueError,
                KeyError,
                AttributeError,
                TypeError,
                TimeoutError,
                PlaceContextUnavailable,
            ) as error:
                self.retry_after = monotonic() + 30
                raise PlaceContextUnavailable(
                    "Place context could not be resolved within its bounds"
                ) from error
            self.cache[item] = (monotonic(), deepcopy(result))
            while len(self.cache) > 64:
                self.cache.popitem(last=False)
            return result

    async def _resolve(self, item: str) -> dict[str, Any]:
        pending = [item]
        entities: dict[str, Any] = {}
        responses = []
        edges = []
        missing = []
        for _depth in range(3):
            if not pending:
                break
            if len(entities) + len(pending) > 12:
                raise PlaceContextUnavailable(
                    "Too many related entities; no truncated snapshot retained"
                )
            raw = await self.fetch(pending)
            if len(raw.encode()) > MAX_BYTES:
                raise PlaceContextUnavailable("Provider response exceeds the local bound")
            payload = json.loads(raw)
            if "error" in payload or not isinstance(payload.get("entities"), dict):
                raise PlaceContextUnavailable("Provider returned no entity records")
            responses.append({"ids": pending, "sha256": hashlib.sha256(raw.encode()).hexdigest()})
            next_ids = set()
            for identity in pending:
                entity = payload["entities"].get(identity)
                if not isinstance(entity, dict) or "missing" in entity:
                    missing.append(identity)
                    continue
                if entity.get("id") != identity:
                    raise PlaceContextUnavailable("Provider returned a different identity")
                selected = {
                    key: deepcopy(entity[key])
                    for key in ("id", "lastrevid", "modified", "labels", "descriptions")
                    if key in entity
                }
                selected["claims"] = {
                    key: deepcopy(entity.get("claims", {}).get(key, [])) for key in PROPERTIES
                }
                entities[identity] = selected
                for prop, statements in selected["claims"].items():
                    for statement in statements:
                        snak = statement.get("mainsnak", {})
                        target = snak.get("datavalue", {}).get("value", {}).get("id")
                        # Qualified statements may be historical/disputed. Preserve them,
                        # but never flatten their constraints into an unqualified edge.
                        if (
                            statement.get("rank") not in {"normal", "preferred"}
                            or statement.get("qualifiers")
                            or snak.get("snaktype") != "value"
                            or not isinstance(target, str)
                            or not ITEM.fullmatch(target)
                        ):
                            continue
                        edges.append(
                            {
                                "subject": f"http://www.wikidata.org/entity/{identity}",
                                "property": f"http://www.wikidata.org/prop/direct/{prop}",
                                "object": f"http://www.wikidata.org/entity/{target}",
                                "statementId": statement.get("id"),
                                "rank": statement["rank"],
                            }
                        )
                        if len(edges) > 64:
                            raise PlaceContextUnavailable("Too many relationships")
                        if target not in entities and target not in missing:
                            next_ids.add(target)
            pending = sorted(next_ids - entities.keys())
        result = {
            "provider": "Wikidata",
            "item": item,
            "retrievedAt": datetime.now(UTC).isoformat(),
            "sourceUrl": ENDPOINT,
            "license": "https://creativecommons.org/publicdomain/zero/1.0/",
            "projection": (
                "Selected labels, descriptions and full P17/P30/P131 statements; "
                "not original response bytes"
            ),
            "entities": entities,
            "relationships": edges,
            "responses": responses,
            "unresolved": sorted(set(pending + missing)),
            "cached": False,
        }
        if len(json.dumps(result).encode()) > 32768:
            raise PlaceContextUnavailable(
                "Context exceeds the metadata budget; nothing was truncated"
            )
        return result

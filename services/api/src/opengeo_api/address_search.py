"""Explicit, bounded Photon/OSM geocoding; provider rank is not confidence."""

import asyncio
import hashlib
import json
import math
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from copy import deepcopy
from datetime import UTC, datetime
from time import monotonic
from typing import Any

ENDPOINT = "https://photon.komoot.io/api/"
MAX_BYTES = 1_048_576


class AddressSearchUnavailable(RuntimeError):
    pass


async def fetch_addresses(query: str) -> str:
    import httpx2

    async with (
        httpx2.AsyncClient(timeout=5.0, follow_redirects=False, trust_env=False) as client,
        client.stream(
            "GET",
            ENDPOINT,
            params={"q": query, "limit": "10", "lang": "en"},
            headers={
                "User-Agent": "OpenGeo.tools/0.1 (https://opengeo.tools)",
                "Accept": "application/json",
            },
        ) as response,
    ):
        response.raise_for_status()
        body = bytearray()
        async for chunk in response.aiter_bytes():
            body.extend(chunk)
            if len(body) > MAX_BYTES:
                raise AddressSearchUnavailable("Address response exceeds the local bound")
        return body.decode("utf-8")


def address_candidates(raw: str) -> list[dict[str, Any]]:
    if len(raw.encode("utf-8")) > MAX_BYTES:
        raise ValueError("Oversized address response")
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise ValueError("Invalid address response")
    features = payload.get("features")
    if not isinstance(features, list) or len(features) > 10:
        raise ValueError("Invalid address results")
    candidates: list[dict[str, Any]] = []
    for rank, feature in enumerate(features, 1):
        if not isinstance(feature, dict) or feature.get("type") != "Feature":
            raise ValueError("Invalid address feature")
        properties = feature["properties"]
        geometry = feature["geometry"]
        if not isinstance(properties, dict) or not isinstance(geometry, dict):
            raise ValueError("Invalid address fields")
        coordinates = geometry.get("coordinates")
        if (
            geometry.get("type") != "Point"
            or not isinstance(coordinates, list)
            or len(coordinates) != 2
        ):
            raise ValueError("Expected an address point")
        longitude, latitude = coordinates
        if (
            any(
                isinstance(n, bool) or not isinstance(n, (int, float)) or not math.isfinite(n)
                for n in coordinates
            )
            or not -180 <= longitude <= 180
            or not -90 <= latitude <= 90
        ):
            raise ValueError("Invalid address coordinates")
        kind, identity = properties.get("osm_type"), properties.get("osm_id")
        if kind not in {"N", "W", "R"} or type(identity) is not int or not 0 < identity < 2**63:
            raise ValueError("Invalid OpenStreetMap identity")
        parts = {}
        for name in (
            "name",
            "housenumber",
            "street",
            "district",
            "city",
            "county",
            "state",
            "postcode",
            "country",
        ):
            value = properties.get(name, "")
            if not isinstance(value, str) or len(value) > 1000:
                raise ValueError("Invalid address label")
            parts[name] = value.strip()
        address = " ".join(filter(None, (parts["housenumber"], parts["street"])))
        labels = [
            parts["name"],
            address,
            *(parts[k] for k in ("district", "city", "county", "state", "postcode", "country")),
        ]
        label = ", ".join(dict.fromkeys(filter(None, labels))) or f"OpenStreetMap {kind}{identity}"
        osm_kind = {"N": "node", "W": "way", "R": "relation"}[kind]
        candidates.append(
            {
                "id": f"{kind}{identity}",
                "label": label,
                "rank": rank,
                "latitude": latitude,
                "longitude": longitude,
                "uri": f"https://www.openstreetmap.org/{osm_kind}/{identity}",
                "sourceProperties": properties,
            }
        )
    return candidates


class AddressSearchResolver:
    def __init__(self, fetch: Callable[[str], Awaitable[str]] = fetch_addresses) -> None:
        self.fetch = fetch
        self.lock = asyncio.Lock()
        self.cache: OrderedDict[str, tuple[float, dict[str, Any]]] = OrderedDict()
        self.next_request_at = 0.0

    async def search(self, query: str) -> dict[str, Any]:
        query = query.strip()
        if not 2 <= len(query) <= 120 or any(ord(char) < 32 for char in query):
            raise ValueError("Enter an address of 2-120 characters")
        async with self.lock:
            cached = self.cache.get(query)
            if cached and monotonic() - cached[0] < 3600:
                self.cache.move_to_end(query)
                return {**deepcopy(cached[1]), "cached": True}
            if monotonic() < self.next_request_at:
                raise AddressSearchUnavailable("Address lookup is cooling down")
            self.next_request_at = monotonic() + 1
            try:
                async with asyncio.timeout(8):
                    raw = await self.fetch(query)
                candidates = address_candidates(raw)
            except Exception as error:
                self.next_request_at = monotonic() + 30
                raise AddressSearchUnavailable("Address search unavailable") from error
            result = {
                "provider": "Photon/OpenStreetMap",
                "query": query,
                "candidates": candidates,
                "retrievedAt": datetime.now(UTC).isoformat(),
                "sourceSha256": hashlib.sha256(raw.encode()).hexdigest(),
                "sourceRevision": None,
                "cached": False,
                "ranking": "Provider order; no confidence score is reported.",
                "attribution": "© OpenStreetMap contributors",
                "rightsUrl": "https://www.openstreetmap.org/copyright",
                "license": "ODbL-1.0",
            }
            self.cache[query] = (monotonic(), deepcopy(result))
            while len(self.cache) > 64:
                self.cache.popitem(last=False)
            return result

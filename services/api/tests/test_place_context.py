import asyncio
import json

import pytest

from opengeo_api.place_context import PlaceContextResolver, PlaceContextUnavailable


def statement(target, **extra):
    return {
        "id": f"example${target}",
        "rank": "normal",
        "mainsnak": {"snaktype": "value", "datavalue": {"value": {"id": target}}},
        **extra,
    }


def test_typed_membership_preserves_qualifiers_and_reuses_snapshot():
    async def run():
        calls = []
        records = {
            "Q3037": {
                "P17": [statement("Q837")],
                "P131": [statement("Q999", qualifiers={"P582": [{"snaktype": "somevalue"}]})],
            },
            "Q837": {"P30": [statement("Q48")], "P131": [statement("Q99", rank="deprecated")]},
            "Q48": {},
        }

        async def fetch(ids):
            calls.append(ids)
            return json.dumps(
                {
                    "entities": {
                        item: {"id": item, "lastrevid": 123, "claims": records[item]}
                        for item in ids
                    }
                }
            )

        resolver = PlaceContextResolver(fetch)
        result = await resolver.resolve("Q3037")
        assert calls == [["Q3037"], ["Q837"], ["Q48"]]
        assert [edge["property"].rsplit("/", 1)[-1] for edge in result["relationships"]] == [
            "P17",
            "P30",
        ]
        assert result["entities"]["Q3037"]["claims"]["P131"][0]["qualifiers"]
        assert result["entities"]["Q837"]["claims"]["P131"][0]["rank"] == "deprecated"
        assert result["unresolved"] == []
        result["entities"].clear()
        reused = await resolver.resolve("Q3037")
        assert reused["cached"] is True and len(reused["entities"]) == 3
        assert len(calls) == 3

    asyncio.run(run())


def test_invalid_and_oversized_provider_data_stops_without_retries():
    async def run():
        calls = []

        async def fetch(ids):
            calls.append(ids)
            return " " * 1_048_577

        resolver = PlaceContextResolver(fetch)
        with pytest.raises(ValueError):
            await resolver.resolve("https://private.invalid")
        assert not calls
        for _ in range(2):
            with pytest.raises(PlaceContextUnavailable):
                await resolver.resolve("Q3037")
        assert len(calls) == 1
        assert not resolver.cache

    asyncio.run(run())


def test_name_search_is_bounded_and_retains_disambiguation():
    async def run():
        calls = []

        async def fetch(query):
            calls.append(query)
            return json.dumps(
                {
                    "search": [
                        {"id": "Q3037", "label": "Kathmandu", "description": "city in Nepal"},
                        {"id": "Q999", "label": "Kathmandu", "description": "similarly named item"},
                    ],
                    "search-continue": 10,
                }
            )

        resolver = PlaceContextResolver(search_fetch=fetch)
        result = await resolver.search(" Kathmandu ")
        assert result["moreAvailable"] is True
        assert result["candidates"][1]["description"] == "similarly named item"
        assert (await resolver.search("Kathmandu"))["cached"] is True
        assert calls == ["Kathmandu"]
        with pytest.raises(ValueError):
            await resolver.search("  ")

    asyncio.run(run())

import asyncio
import json
import unittest

from opengeo_api.address_search import (
    AddressSearchResolver,
    AddressSearchUnavailable,
    address_candidates,
)


def response(**properties):
    return json.dumps(
        {
            "features": [
                {
                    "type": "Feature",
                    "properties": {
                        "osm_type": "W",
                        "osm_id": 123,
                        "name": "City Hall",
                        "housenumber": "1",
                        "street": "Main Street",
                        "city": "Boston",
                        **properties,
                    },
                    "geometry": {"type": "Point", "coordinates": [-71.06, 42.36]},
                }
            ]
        }
    )


class AddressSearchTests(unittest.IsolatedAsyncioTestCase):
    async def test_rank_identity_provenance_and_cached_copy_isolation(self):
        calls = []

        async def fetch(query):
            calls.append(query)
            return response()

        resolver = AddressSearchResolver(fetch)
        result = await resolver.search(" 1 Main Street Boston ")
        self.assertEqual(calls, ["1 Main Street Boston"])
        self.assertEqual(result["candidates"][0]["uri"], "https://www.openstreetmap.org/way/123")
        self.assertEqual(result["candidates"][0]["rank"], 1)
        self.assertEqual(result["candidates"][0]["longitude"], -71.06)
        self.assertEqual(result["license"], "ODbL-1.0")
        self.assertIsNone(result["sourceRevision"])
        self.assertEqual(len(result["sourceSha256"]), 64)
        result["candidates"][0]["sourceProperties"]["name"] = "changed"
        cached = await resolver.search("1 Main Street Boston")
        self.assertTrue(cached["cached"])
        self.assertEqual(cached["candidates"][0]["sourceProperties"]["name"], "City Hall")
        self.assertEqual(len(calls), 1)

    async def test_serialized_rate_limit_and_invalid_queries_make_no_extra_request(self):
        calls = []

        async def fetch(query):
            calls.append(query)
            await asyncio.sleep(0)
            return response()

        resolver = AddressSearchResolver(fetch)
        results = await asyncio.gather(
            resolver.search("Boston"), resolver.search("Berlin"), return_exceptions=True
        )
        self.assertEqual(calls, ["Boston"])
        self.assertIsInstance(results[1], AddressSearchUnavailable)
        for query in ("x", "x" * 121, "a\nb"):
            with self.assertRaises(ValueError):
                await resolver.search(query)
        self.assertEqual(len(calls), 1)

    async def test_failed_provider_cools_down_and_empty_results_are_cacheable(self):
        calls = []

        async def fetch(query):
            calls.append(query)
            return "invalid JSON"

        resolver = AddressSearchResolver(fetch)
        with self.assertRaises(AddressSearchUnavailable):
            await resolver.search("Boston")
        with self.assertRaises(AddressSearchUnavailable):
            await resolver.search("Boston")
        self.assertEqual(calls, ["Boston"])

        async def empty(query):
            return '{"features": []}'

        resolver = AddressSearchResolver(empty)
        self.assertEqual((await resolver.search("No known address"))["candidates"], [])
        self.assertTrue((await resolver.search("No known address"))["cached"])

    async def test_malformed_coordinates_identity_and_result_bounds_are_rejected(self):
        malformed = ["[]", '{"features": {}}', response(osm_type="X"), response(osm_id=True)]
        for coordinates in ([True, 42], [0, 91], [181, 0], [0, float("nan")], [0, 1, 2]):
            body = json.loads(response())
            body["features"][0]["geometry"]["coordinates"] = coordinates
            malformed.append(json.dumps(body))
        many = json.loads(response())
        many["features"] *= 11
        malformed.extend([json.dumps(many), " " * 1_048_577])
        for raw in malformed:
            with self.assertRaises(ValueError):
                address_candidates(raw)


if __name__ == "__main__":
    unittest.main()

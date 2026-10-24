"""Focused planner checks and opt-in checks against a disposable local PostGIS DB."""

import os
import unittest
from uuid import uuid4

from opengeo_api.vector_analysis import AnalysisRequest, analysis_statement


class BuildingReconciliationPlanTests(unittest.TestCase):
    def test_plan_keeps_both_generations_and_bounds_and_never_writes(self):
        source, target, organization = uuid4(), uuid4(), uuid4()
        sql, parameters = analysis_statement(
            organization, source, AnalysisRequest("building-reconcile", 3, target, 7)
        )
        self.assertEqual(sql.count("%s"), len(parameters))
        self.assertEqual(parameters[:4], (organization, source, organization, target))
        self.assertEqual(parameters[8:10], (3, 7))
        self.assertIn("source_count+target_count<=1000", sql)
        self.assertIn("ST_Intersection(a.geometry::geography,b.geometry::geography)", sql)
        self.assertIn("building_polygon_inputs", sql)
        self.assertNotIn("UPDATE ", sql)
        self.assertNotIn("INSERT ", sql)

    def test_same_inventory_and_missing_target_are_rejected_before_database(self):
        source = uuid4()
        for request in (
            AnalysisRequest("building-reconcile", 1, source, 1),
            AnalysisRequest("building-reconcile", 1),
            AnalysisRequest("building-reconcile", 1, uuid4(), 1, distance_meters=1),
        ):
            with self.subTest(request=request), self.assertRaises(ValueError):
                analysis_statement(uuid4(), source, request)


class BuildingPreviewRepositoryTests(unittest.IsolatedAsyncioTestCase):
    async def test_each_inventory_requires_read_authority_before_computation(self):
        from opengeo_api.features import FeatureAccessDenied, PostgresFeatureRepository
        from opengeo_api.tenant_database import TenantContext

        source, target, organization, project, user = (uuid4() for _ in range(5))
        context = TenantContext(user, organization)
        for denied in (source, target):
            transaction = BuildingPreviewTransaction(denied=denied)
            repository = PostgresFeatureRepository(BuildingPreviewExecutor(transaction))
            with self.subTest(denied=denied), self.assertRaises(FeatureAccessDenied):
                await repository.preview_analysis(
                    context, project, source, AnalysisRequest("building-reconcile", 3, target, 7)
                )
            self.assertEqual(transaction.computations, 0)

    async def test_receipt_declares_method_and_no_validated_count_under_existing_timeout(self):
        from opengeo_api.features import PostgresFeatureRepository
        from opengeo_api.tenant_database import TenantContext

        source, target, organization, project, user, preview = (uuid4() for _ in range(6))
        transaction = BuildingPreviewTransaction()
        repository = PostgresFeatureRepository(BuildingPreviewExecutor(transaction))
        result = await repository.preview_analysis(
            TenantContext(user, organization),
            project,
            source,
            AnalysisRequest("building-reconcile", 3, target, 7, preview_id=preview),
        )
        self.assertEqual(set(transaction.scopes), {source, target})
        receipt = result["opengeo:analysis"]
        self.assertEqual(receipt["previewId"], str(preview))
        self.assertEqual(receipt["buildingReconciliation"]["minimumIntersectionOverUnion"], 0.5)
        self.assertIsNone(receipt["buildingReconciliation"]["validatedCount"])
        self.assertFalse(receipt["persisted"])
        self.assertEqual(len(transaction.executed), 1)
        self.assertIn("5000ms", transaction.executed[0][0])
        self.assertIn("application_name", transaction.executed[0][0])


class BuildingPreviewTransaction:
    def __init__(self, denied=None):
        self.denied = denied
        self.scopes = []
        self.computations = 0
        self.executed = []

    async def fetch_one(self, statement, parameters):
        if "FROM app.organization_memberships" in statement:
            identity = parameters[2]
            self.scopes.append(identity)
            return (
                "member", None if identity == self.denied else "viewer", None,
                False, "active", "geojson",
            )
        self.computations += 1
        return (
            {"source_generation": 3, "target_generation": 7, "allowed": True},
            {"count": 0, "points": 0}, 0, [],
        )

    async def execute(self, statement, parameters):
        self.executed.append((statement, parameters))
        return 1


class BuildingPreviewExecutor:
    def __init__(self, transaction):
        self.transaction = transaction

    async def run(self, context, operation):
        return await operation(self.transaction)


@unittest.skipUnless(os.environ.get("OPENGEO_BUILDING_TEST_DSN"), "local PostGIS not selected")
class BuildingReconciliationPostgisTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import psycopg

        cls.connection = psycopg.connect(os.environ["OPENGEO_BUILDING_TEST_DSN"], autocommit=True)
        # This profile must never initialize an application or remote database.
        if (
            cls.connection.info.dbname != "opengeo_building_test"
            or not cls.connection.info.host.startswith("/tmp/")
        ):
            cls.connection.close()
            raise ValueError("use a disposable local opengeo_building_test database")
        cls.connection.execute("CREATE EXTENSION IF NOT EXISTS postgis")
        cls.connection.execute("CREATE SCHEMA app")
        cls.connection.execute(
            "CREATE TABLE app.dataset_features (id uuid,organization_id uuid,dataset_id uuid,"
            "geometry geometry(Geometry,4326),properties jsonb,deleted_at timestamptz)"
        )
        cls.connection.execute(
            "CREATE TABLE app.feature_collections "
            "(organization_id uuid,dataset_id uuid,generation bigint)"
        )
        cls.connection.execute("SET statement_timeout='5000ms'")

    @classmethod
    def tearDownClass(cls):
        cls.connection.close()

    def setUp(self):
        self.organization, self.source, self.target = uuid4(), uuid4(), uuid4()
        self.connection.execute(
            "INSERT INTO app.feature_collections VALUES (%s,%s,3),(%s,%s,7)",
            (self.organization, self.source, self.organization, self.target),
        )

    def add(self, side, wkt, properties=None):
        from psycopg.types.json import Jsonb

        identity = uuid4()
        self.connection.execute(
            "INSERT INTO app.dataset_features VALUES "
            "(%s,%s,%s,ST_GeomFromText(%s,4326),%s,NULL)",
            (
                identity,
                self.organization,
                self.source if side == "source" else self.target,
                wkt,
                Jsonb(properties or {"name": side}),
            ),
        )
        return str(identity)

    @staticmethod
    def square(west=0, south=0, east=0.001, north=0.001):
        return (
            f"POLYGON(({west} {south},{east} {south},{east} {north},"
            f"{west} {north},{west} {south}))"
        )

    def run_plan(self, source_generation=3):
        statement, parameters = analysis_statement(
            self.organization,
            self.source,
            AnalysisRequest("building-reconcile", source_generation, self.target, 7),
        )
        return self.connection.execute(statement, parameters).fetchone()

    def results(self):
        facts, output, size, features = self.run_plan()
        self.assertTrue(facts["allowed"])
        self.assertEqual(output["count"], len(features))
        self.assertLess(size, 2_097_152)
        return {feature["id"]: feature for feature in features}

    def test_identical_footprints_preserve_inputs_and_are_unreviewed_candidates(self):
        properties = {"name": "Baseline", "confidence": 0.97, "status": "source claim"}
        source = self.add("source", self.square(), properties)
        target = self.add("target", self.square())
        rows = self.results()
        self.assertEqual(len(rows), 2)
        row = rows[f"source:{source}"]
        self.assertEqual(row["properties"]["input"]["properties"], properties)
        self.assertEqual(row["geometry"]["coordinates"][0][1], [0.001, 0])
        for feature in rows.values():
            review = feature["properties"]["reconciliation"]
            self.assertEqual(review["status"], "one-to-one-candidate")
            self.assertEqual(review["reviewStatus"], "unreviewed")
            self.assertAlmostEqual(review["neighbors"][0]["intersectionOverUnion"], 1, places=7)
        self.assertEqual(
            row["properties"]["reconciliation"]["neighbors"][0]["featureId"], target
        )

    def test_unmatched_and_boundary_contacts_retain_both_inventories(self):
        self.add("source", self.square())
        self.add("target", self.square(0.001, 0, 0.002, 0.001))
        for row in self.results().values():
            self.assertEqual(row["properties"]["reconciliation"]["status"], "unmatched")
            self.assertEqual(row["properties"]["reconciliation"]["neighbors"], [])

    def test_real_low_overlap_is_boundary_disagreement(self):
        self.add("source", self.square())
        self.add("target", self.square(0.0007, 0, 0.0017, 0.001))
        for row in self.results().values():
            review = row["properties"]["reconciliation"]
            self.assertEqual(review["status"], "boundary-disagreement")
            self.assertAlmostEqual(review["neighbors"][0]["intersectionOverUnion"], 0.3 / 1.7, 6)

    def test_reconciliation_preserves_precision_beyond_nine_decimal_places(self):
        west, east = 0.00000000012345678, 0.00100000012345678
        source = self.add("source", self.square(west=west, east=east))
        self.add("target", self.square(west=west, east=east))
        ring = self.results()[f"source:{source}"]["geometry"]["coordinates"][0]
        self.assertEqual(ring[0][0], west)
        self.assertEqual(ring[1][0], east)

    def test_split_and_merge_neighbors_remain_ambiguous_including_low_iou(self):
        source = self.add("source", self.square())
        self.add("target", self.square(0, 0, 0.0005, 0.001))
        self.add("target", self.square(0.0005, 0, 0.001, 0.001))
        rows = self.results()
        self.assertEqual(len(rows), 3)
        for row in rows.values():
            self.assertEqual(row["properties"]["reconciliation"]["status"], "ambiguous")
        self.assertEqual(
            len(rows[f"source:{source}"]["properties"]["reconciliation"]["neighbors"]), 2
        )

    def test_holes_do_not_match_enclosed_footprints_and_multipart_is_retained(self):
        self.add(
            "source",
            "MULTIPOLYGON(((0 0,0.003 0,0.003 0.003,0 0.003,0 0),"
            "(0.001 0.001,0.002 0.001,0.002 0.002,0.001 0.002,0.001 0.001)))",
        )
        self.add("target", self.square(0.0012, 0.0012, 0.0018, 0.0018))
        rows = self.results()
        self.assertEqual(next(iter(rows.values()))["geometry"]["type"], "MultiPolygon")
        for row in rows.values():
            self.assertEqual(row["properties"]["reconciliation"]["status"], "unmatched")

    def test_nonpolygon_invalid_and_empty_inventories_are_not_analyzed(self):
        for wkt in ("POINT(0 0)", "POLYGON EMPTY", "POLYGON((0 0,1 1,1 0,0 1,0 0))"):
            with self.subTest(wkt=wkt):
                self.add("source", wkt)
                facts, output, _size, features = self.run_plan()
                self.assertFalse(facts["allowed"])
                self.assertEqual(output["count"], 0)
                self.assertEqual(features, [])
                self.connection.execute(
                    "DELETE FROM app.dataset_features WHERE organization_id=%s",
                    (self.organization,),
                )

    def test_geographic_profile_rejects_wide_and_polar_inputs(self):
        self.add("source", self.square())
        for west, south in ((7, 0), (0, 81), (179, 0)):
            with self.subTest(west=west, south=south):
                self.add("target", self.square(west, south, west + 0.001, south + 0.001))
                self.assertFalse(self.run_plan()[0]["allowed"])
                self.connection.execute(
                    "DELETE FROM app.dataset_features WHERE organization_id=%s AND dataset_id=%s",
                    (self.organization, self.target),
                )

    def test_combined_output_limit_does_not_silently_drop_input_footprints(self):
        self.connection.execute(
            "INSERT INTO app.dataset_features "
            "SELECT gen_random_uuid(),%s,%s,ST_GeomFromText(%s,4326),'{}'::jsonb,NULL "
            "FROM generate_series(1,1000)",
            (self.organization, self.source, self.square()),
        )
        self.add("target", self.square())
        facts, output, _size, features = self.run_plan()
        self.assertFalse(facts["allowed"])
        self.assertEqual(facts["source_count"], 1000)
        self.assertEqual(facts["target_count"], 1)
        self.assertEqual(output["count"], 0)
        self.assertEqual(features, [])

    def test_stale_generation_and_empty_inventory_remain_explicit(self):
        facts, output, _size, features = self.run_plan(source_generation=2)
        self.assertFalse(facts["allowed"])
        self.assertEqual(facts["source_generation"], 3)
        self.assertEqual(features, [])
        facts, output, _size, features = self.run_plan()
        self.assertTrue(facts["allowed"])
        self.assertEqual(output["count"], 0)
        self.assertEqual(features, [])


if __name__ == "__main__":
    unittest.main()

import asyncio
import traceback

import pytest

from opengeo_api.postgis_catalog import (
    CatalogFailure,
    CatalogLimits,
    build_postgis_preview_query,
    discover_postgis_catalog,
)


class Cursor:
    """No fetchall method: every bounded result is consumed one row at a time."""

    def __init__(self, relations=None, columns=None, *, read_only="on"):
        self.relations = relations if relations is not None else [(21, "gis", "roads", "r", False)]
        self.columns = columns if columns is not None else column_rows()
        self.read_only = read_only
        self.calls = []
        self.rows = iter(())

    async def execute(self, query, params=None):
        self.calls.append((query, params))
        if "transaction_read_only" in query:
            self.rows = iter([(self.read_only, "4000", "1000", "pg_catalog")])
        elif "pg_class" in query:
            self.rows = iter(self.relations[: params[-1]])
        else:
            self.rows = iter(self.columns[: params[-1]])

    async def fetchone(self):
        return next(self.rows, None)


def column_rows(*, key="id", geometry="geom"):
    return [
        (key, "pg_catalog", "int8", True, -1, None, None, True, True),
        (
            geometry,
            "spatial",
            "geometry",
            False,
            1107460,
            "spatial.geometry(Point,4326)",
            "spatial",
            False,
            False,
        ),
        ("password", "pg_catalog", "jsonb", False, -1, None, None, False, False),
    ]


def describe(cursor=None, **kwargs):
    return asyncio.run(
        discover_postgis_catalog(cursor or Cursor(), allowed_schemas=("gis",), **kwargs)
    )


def test_discovery_describes_exact_metadata_under_read_only_local_bounds():
    cursor = Cursor()
    result = describe(cursor)
    relation = result.relations[0]
    assert relation.stable_key == "id"
    assert relation.unsupported_reasons == ()
    assert relation.columns[1].geometry.geometry_type == "POINT"
    assert relation.columns[1].geometry.srid == 4326
    assert relation.columns[2].name == "password"
    assert relation.schema_fingerprint_sha256 == describe().relations[0].schema_fingerprint_sha256
    assert result.truncated is False
    assert cursor.calls[0][1] == ("4000", "1000")
    assert "set_config('search_path', 'pg_catalog', true)" in cursor.calls[0][0]
    assert cursor.calls[1][1] == (["gis"], 101)
    assert cursor.calls[2][1] == (21, 257)
    for check in ("indnkeyatts = 1", "indimmediate", "indexprs IS NULL", "indpred IS NULL"):
        assert check in cursor.calls[2][0]
    with pytest.raises(CatalogFailure, match="read_only_transaction_required"):
        describe(Cursor(read_only="off"))


def test_stable_keys_and_unsupported_relations_are_disclosed_without_guessing():
    for key_row, additional, expected in [
        (
            ("id", "pg_catalog", "int8", False, -1, None, None, True, False),
            [],
            "stable_key_unavailable",
        ),
        (
            ("id", "pg_catalog", "int8", True, -1, None, None, False, False),
            [],
            "stable_key_unavailable",
        ),
        (
            ("id", "pg_catalog", "int8", True, -1, None, None, True, False),
            [("other", "pg_catalog", "uuid", True, -1, None, None, True, False)],
            "stable_key_ambiguous",
        ),
    ]:
        columns = [key_row, *column_rows()[1:], *additional]
        relation = describe(Cursor(columns=columns)).relations[0]
        assert relation.stable_key is None
        assert expected in relation.unsupported_reasons
        with pytest.raises(CatalogFailure, match="relation_unsupported"):
            build_postgis_preview_query(
                relation, allowed_schemas=("gis",), geometry_column="geom", bbox=(1, 2, 3, 4)
            )
    for kind, inherited, expected in [
        ("v", False, "relation_kind_unsupported"),
        ("r", True, "inherited_relation_unsupported"),
    ]:
        relation = describe(Cursor(relations=[(21, "gis", "roads", kind, inherited)])).relations[0]
        assert expected in relation.unsupported_reasons


def test_query_builder_quotes_provider_identifiers_and_binds_all_values():
    relation_name = 'roads"; DROP TABLE private; --'
    key = 'i"d'
    geometry = 'g"eom'
    relation = describe(
        Cursor(
            relations=[(21, "gis", relation_name, "r", False)],
            columns=column_rows(key=key, geometry=geometry),
        )
    ).relations[0]
    plan = build_postgis_preview_query(
        relation, allowed_schemas=("gis",), geometry_column=geometry, bbox=(1, 2, 3, 4), max_rows=9
    )
    statement = plan.statement.as_string()
    assert 'FROM ONLY "gis"."roads""; DROP TABLE private; --"' in statement
    assert 'SELECT "i""d", "g""eom", "password"' in statement
    assert '"spatial"."st_intersects"("g""eom", "spatial"."st_makeenvelope"' in statement
    assert 'ORDER BY "i""d" LIMIT %s' in statement
    assert plan.parameters == (1, 2, 3, 4, 4326, 9)
    assert plan.columns == (key, geometry, "password")
    assert plan.stable_key == key
    assert plan.requires_bounded_executor is True


def test_allowlist_geometry_and_query_bounds_fail_closed():
    relation = describe().relations[0]
    dollar_schema = asyncio.run(
        discover_postgis_catalog(
            Cursor(relations=[(21, "g$is", "roads", "r", False)]), allowed_schemas=("g$is",)
        )
    )
    assert dollar_schema.relations[0].schema == "g$is"
    for bbox, rows in [
        ((float("nan"), 2, 3, 4), 10),
        ((3, 2, 1, 4), 10),
        ((-181, 2, 3, 4), 10),
        ((1, 2, 3, 91), 10),
        ((1, 2, 3, 4), 1001),
        ((1, 2, 3, 4), True),
    ]:
        with pytest.raises(CatalogFailure, match="preview_bounds_invalid"):
            build_postgis_preview_query(
                relation, allowed_schemas=("gis",), geometry_column="geom", bbox=bbox, max_rows=rows
            )
    with pytest.raises(CatalogFailure, match="schema_not_allowed"):
        build_postgis_preview_query(
            relation, allowed_schemas=("other",), geometry_column="geom", bbox=(1, 2, 3, 4)
        )
    with pytest.raises(CatalogFailure, match="schema_allowlist_invalid"):
        asyncio.run(discover_postgis_catalog(Cursor(), allowed_schemas=('gis"; SELECT 1',)))
    with pytest.raises(CatalogFailure, match="schema_not_allowed"):
        describe(Cursor(relations=[(21, "other", "roads", "r", False)]))
    for formatted in (
        "spatial.geometry(Point,3857)",
        "spatial.geometry(PointZ,4326)",
        "spatial.geometry",
    ):
        columns = column_rows()
        columns[1] = (*columns[1][:5], formatted, *columns[1][6:])
        unsupported = describe(Cursor(columns=columns)).relations[0]
        with pytest.raises(CatalogFailure, match="preview_geometry_unsupported"):
            build_postgis_preview_query(
                unsupported, allowed_schemas=("gis",), geometry_column="geom", bbox=(1, 2, 3, 4)
            )


def test_catalog_limits_errors_and_cancellation_do_not_expose_provider_text():
    result = describe(
        Cursor(relations=[(21, "gis", "a", "r", False), (22, "gis", "b", "r", False)]),
        limits=CatalogLimits(max_relations=1),
    )
    assert len(result.relations) == 1 and result.truncated is True
    truncated = describe(limits=CatalogLimits(max_columns=1)).relations[0]
    assert "column_limit_exceeded" in truncated.unsupported_reasons
    with pytest.raises(CatalogFailure, match="catalog_metadata_limit_exceeded"):
        describe(limits=CatalogLimits(max_metadata_bytes=10))

    class BrokenCursor(Cursor):
        async def execute(self, query, params=None):
            raise RuntimeError("password=private-secret host=private-host")

    with pytest.raises(CatalogFailure, match="catalog_description_failed") as caught:
        describe(BrokenCursor())
    assert "private-secret" not in "".join(traceback.format_exception(caught.value))

    class SlowCursor(Cursor):
        async def execute(self, query, params=None):
            await asyncio.sleep(1)

    with pytest.raises(CatalogFailure, match="catalog_timeout"):
        describe(SlowCursor(), limits=CatalogLimits(timeout_seconds=0.001))

    class CancelledCursor(Cursor):
        async def execute(self, query, params=None):
            raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        describe(CancelledCursor())

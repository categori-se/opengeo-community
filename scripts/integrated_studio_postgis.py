"""Explicit local development fixture; real SQL/processors, synthetic remote transport."""

import json
from contextlib import asynccontextmanager
from uuid import UUID, uuid4

import psycopg
from psycopg import sql
from pydantic import SecretStr

from opengeo_api.config import Settings
from opengeo_api.connection_verification import PostgreSqlCredentials
from opengeo_api.connections import PostgresExternalConnectionRepository, UnavailableConnectionSecretStore
from opengeo_api.postgis_catalog_runtime import (
    CatalogDiscoveryCommand, CatalogDiscoveryProcessor, PostgreSqlCatalogReader,
    RdsDataCatalogDiscoveryCoordinator,
)
from opengeo_api.postgis_catalog_store import PostgresCatalogDiscoveryRepository
from opengeo_api.postgis_layers import PostgresPostgisLayerRepository
from opengeo_api.postgis_preview_runtime import (
    PreviewCommand, PreviewProcessor, PostgreSqlPreviewReader, RdsDataPreviewCoordinator,
    error_response,
)
from opengeo_api.processing_dispatch import ProcessingDispatchUnavailable
from opengeo_api.rds_data import DataApiResult
from opengeo_api.tenant_database import PostgresTenantQueryExecutor
import opengeo_api.postgis_catalog_runtime as catalog_runtime
import opengeo_api.postgis_preview_runtime as preview_runtime

SCHEMA, RELATION = "native_fixture", 'Parcels "Study"'
KEY, GEOMETRY, NUMERIC = 'Record "ID"', 'Footprint "Geom"', 'Reading "Value"'
ROLE, HOST, ADDRESS = "opengeo_selected_fixture", "gis.example.test", "93.184.216.34"
READY, RESULT = "postgis-fixture-ready.json", "postgis-fixture-result.json"
TABLES = ("datasets", "external_sources", "external_source_revisions",
          "external_connection_source_bindings", "external_postgis_layer_registrations",
          "dataset_versions", "data_objects", "processing_jobs", "maps")


def _read(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"Missing or unsafe local fixture file: {path.name}")
    return json.loads(path.read_text())


async def _connect(user="postgres", *, autocommit=True):
    return await psycopg.AsyncConnection.connect(
        host="127.0.0.1", dbname="opengeo", user=user, sslmode="disable",
        connect_timeout=2, autocommit=autocommit,
        options="-c statement_timeout=4000 -c lock_timeout=1000",
    )


async def _counts():
    async with await _connect() as connection:
        return {table: (await (await connection.execute(
            sql.SQL("SELECT count(*) FROM {}").format(sql.Identifier("app", table))
        )).fetchone())[0] for table in TABLES}


async def _seed(pilot, ready):
    async with await _connect(autocommit=False) as connection:
        if ready is None:
            occupied = await (await connection.execute(
                "SELECT EXISTS(SELECT FROM pg_namespace WHERE nspname=%s), "
                "EXISTS(SELECT FROM pg_roles WHERE rolname=%s)", (SCHEMA, ROLE)
            )).fetchone()
            if any(occupied):
                raise ValueError("Local PostGIS fixture schema/role already exists without its owned receipt")
            identities = await (await connection.execute(
                "SELECT id,cognito_subject FROM app.users WHERE id=ANY(%s::uuid[])",
                ([pilot.OWNER, pilot.REVIEWER],),
            )).fetchall()
            if dict((str(row[0]), row[1]) for row in identities) != {
                pilot.OWNER: "local-pilot-owner", pilot.REVIEWER: "local-pilot-reviewer"
            }:
                raise ValueError("Local browser identities do not match this fixture")
            project, connection_id = uuid4(), uuid4()
            secret = (f"arn:aws:secretsmanager:us-east-1:000000000000:secret:"
                      f"opengeo/test/connections/{pilot.ORG}/{connection_id}-AbCd12")
            await connection.execute(
                "INSERT INTO app.organization_memberships(organization_id,user_id,role) "
                "VALUES(%s,%s,'member') ON CONFLICT DO NOTHING", (pilot.ORG, pilot.REVIEWER))
            await connection.execute(
                "INSERT INTO app.projects(id,organization_id,name,created_by) VALUES(%s,%s,%s,%s)",
                (project, pilot.ORG, "Local external PostGIS fixture", pilot.OWNER))
            for user, role in ((pilot.OWNER, "owner"), (pilot.REVIEWER, "viewer")):
                await connection.execute(
                    "INSERT INTO app.project_memberships(organization_id,project_id,user_id,role) "
                    "VALUES(%s,%s,%s,%s::app.project_role)", (pilot.ORG, project, user, role))
            await connection.execute(
                """INSERT INTO app.external_connections
                (id,organization_id,project_id,provider,display_name,endpoint_host,database_name,
                 allowed_schemas,secret_arn,configured_secret_fields,created_by,updated_by)
                VALUES(%s,%s,%s,'postgresql','Local PostGIS fixture',%s,'opengeo',ARRAY[%s],
                       %s,ARRAY['password','username'],%s,%s)""",
                (connection_id, pilot.ORG, project, HOST, SCHEMA, secret, pilot.OWNER, pilot.OWNER))
            await connection.execute(
                """INSERT INTO app.external_connection_revisions
                (organization_id,project_id,connection_id,revision_number,configuration,change_summary,created_by)
                SELECT organization_id,project_id,id,1,jsonb_build_object('provider',provider::text,
                  'endpointHost',endpoint_host,'endpointPort',endpoint_port,'databaseName',database_name,
                  'allowedSchemas',to_jsonb(allowed_schemas),'readOnly',read_only,
                  'tlsMode',tls_mode::text,'networkMode',network_mode::text),
                  'Synthetic verified local fixture; no remote TLS acceptance',%s
                FROM app.external_connections WHERE id=%s""", (pilot.OWNER, connection_id))
            await connection.execute(
                "UPDATE app.external_connections SET status='credentials_verified',"
                "last_verified_at=clock_timestamp() WHERE id=%s", (connection_id,))
            await connection.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(SCHEMA)))
            await connection.execute(sql.SQL(
                'CREATE TABLE {} ({} bigint PRIMARY KEY, {} numeric(38,12), "Title / note" text, '
                '{} public.geometry(Point,4326))').format(
                    sql.Identifier(SCHEMA, RELATION), sql.Identifier(KEY),
                    sql.Identifier(NUMERIC), sql.Identifier(GEOMETRY)))
            await connection.execute(sql.SQL(
                "INSERT INTO {} SELECT 9007199254740993::bigint+i, "
                "12345678901234567890.123450000000::numeric+i/1000000000000::numeric, "
                "'Niño Δ #'||i,public.ST_SetSRID(public.ST_Point(-73.5+i/10000.0,41.5),4326) "
                "FROM generate_series(0,122) i").format(sql.Identifier(SCHEMA, RELATION)))
            await connection.execute(sql.SQL("CREATE ROLE {} LOGIN").format(sql.Identifier(ROLE)))
            await connection.execute(sql.SQL("ALTER ROLE {} SET default_transaction_read_only=on").format(sql.Identifier(ROLE)))
            await connection.execute(sql.SQL("GRANT USAGE ON SCHEMA {},public TO {}").format(sql.Identifier(SCHEMA), sql.Identifier(ROLE)))
            await connection.execute(sql.SQL("GRANT SELECT ON {} TO {}").format(sql.Identifier(SCHEMA, RELATION), sql.Identifier(ROLE)))
            ready = {"schemaVersion": "opengeo.local-postgis-fixture-ready.1",
                     "organizationId": pilot.ORG, "ownerId": pilot.OWNER, "viewerId": pilot.REVIEWER,
                     "projectId": str(project), "connectionId": str(connection_id), "discoveryId": None,
                     "schemaName": SCHEMA, "relationName": RELATION, "geometryColumn": GEOMETRY,
                     "stableKey": KEY, "numericColumn": NUMERIC, "sourceRows": 123,
                     "expectedFirstId": "9007199254740993",
                     "expectedFirstNumeric": "12345678901234567890.123450000000", "bbox": [-74, 40, -70, 44]}
        else:
            if (ready.get("schemaVersion") != "opengeo.local-postgis-fixture-ready.1"
                    or ready.get("organizationId") != pilot.ORG
                    or ready.get("ownerId") != pilot.OWNER or ready.get("viewerId") != pilot.REVIEWER):
                raise ValueError("Retained local fixture identity changed")
            # Retained access is authoritative. Never reinsert a revoked membership.
            row = await (await connection.execute(
                "SELECT organization_id,project_id,endpoint_host,database_name,allowed_schemas "
                "FROM app.external_connections WHERE id=%s", (UUID(ready["connectionId"]),)
            )).fetchone()
            if row is None or (str(row[0]), str(row[1]), row[2], row[3], row[4]) != (
                    pilot.ORG, ready["projectId"], HOST, "opengeo", [SCHEMA]):
                raise ValueError("Retained local fixture connection changed")
        row = await (await connection.execute(sql.SQL(
            "SELECT count(*),min({})::text,max({})::text FROM {}"
        ).format(sql.Identifier(KEY), sql.Identifier(KEY), sql.Identifier(SCHEMA, RELATION)))).fetchone()
        if row != (123, "9007199254740993", "9007199254741115"):
            raise ValueError("Local PostGIS fixture rows changed")
    return ready


async def prepare_local_postgis(pilot):
    """Return (create_app overrides, async finalizer) for the explicit owned fixture."""
    marker = _read(pilot.WORK / "postgis-fixture.json")
    development = _read(pilot.WORK / "development-state.json")
    if marker != {"schemaVersion": "opengeo.local-postgis-fixture.1"} or development.get("schemaVersion") != "opengeo.community-development.1":
        raise ValueError("PostGIS fixture requires the explicit local development state")
    for name in (READY, RESULT):
        if (pilot.WORK / name).is_symlink():
            raise ValueError("Local fixture output must not be a symlink")
    retained = _read(pilot.WORK / READY) if (pilot.WORK / READY).exists() else None
    ready = await _seed(pilot, retained)
    stats = (_read(pilot.WORK / RESULT) if retained else {
        "schemaVersion": "opengeo.local-postgis-fixture-result.1", "projectId": ready["projectId"],
        "catalogExecutionCount": 0, "previewInvocationCount": 0, "featureExecutionCount": 0,
        "secretReadCount": 0, "catalogSecretReadCount": 0, "previewSecretReadCount": 0,
        "featureWireRows": 0, "namedCursors": 0, "featureReadSizes": [], "sourceRows": 123,
        "managedRowsBaseline": await _counts(),
        "substitutions": ["Synthetic verified connection and browser identity", "Synthetic secret and resolver",
                          "Closed loopback transport replaces external DNS/TLS and AWS Data API"],
    })
    if stats.get("schemaVersion") != "opengeo.local-postgis-fixture-result.1" or stats.get("projectId") != ready["projectId"]:
        raise ValueError("Retained local fixture counters changed identity")
    def persist():
        pilot.save_json(RESULT, stats)
    persist()
    pilot.save_json(READY, ready)
    secret = (f"arn:aws:secretsmanager:us-east-1:000000000000:secret:opengeo/test/connections/"
              f"{pilot.ORG}/{ready['connectionId']}-AbCd12")
    last_claim = None

    class LocalDataApi:
        async def execute(self, statement, parameters=(), transaction_id=None):
            nonlocal last_claim
            if transaction_id is not None:
                raise ValueError("Local connector uses single function calls")
            async with await _connect("opengeo_connector") as connection:
                cursor = await connection.execute(statement, parameters)
                rows = tuple(await cursor.fetchall())
                if "claim_" in statement:
                    last_claim = ("catalog" if "catalog_discovery" in statement else "preview", rows[0][0])
                return DataApiResult(rows, cursor.rowcount)

    class Secrets:
        async def load(self, reference):
            if reference != secret or last_claim is None or last_claim[1] != "claimed":
                raise ValueError("Local fixture secret requires its exact successful claim")
            stats["secretReadCount"] += 1
            stats[f"{last_claim[0]}SecretReadCount"] += 1
            persist()
            return PostgreSqlCredentials(ROLE, "synthetic-local-only")

    class Resolver:
        async def resolve(self, host, port):
            if host != HOST or port != 5432:
                raise ValueError("Only the explicit local fixture target is supported")
            return (ADDRESS,)

    class Cursor:
        def __init__(self, cursor, named):
            self.cursor, self.named, self.rows = cursor, named, 0
        async def __aenter__(self):
            await self.cursor.__aenter__()
            return self
        async def __aexit__(self, *args):
            if self.named:
                stats["featureReadSizes"].append(self.rows)
                persist()
            return await self.cursor.__aexit__(*args)
        async def execute(self, query, parameters=None):
            if self.named:
                stats["featureExecutionCount"] += 1
                persist()
            return await self.cursor.execute(query, parameters)
        async def fetchone(self):
            row = await self.cursor.fetchone()
            if self.named and row is not None:
                self.rows += 1
                stats["featureWireRows"] += 1
            return row

    @asynccontextmanager
    async def transport(target, credentials, address):
        if (target.host, target.port, target.database_name, target.tls_mode, target.network_mode,
                credentials.username, credentials.password, address) != (
                HOST, 5432, "opengeo", "verify_full", "public_internet", ROLE, "synthetic-local-only", ADDRESS):
            raise ValueError("Local PostGIS transport rejects every nonfixture target")
        async with await _connect(ROLE, autocommit=False) as connection:
            await connection.execute("BEGIN READ ONLY")
            def cursor(*args, **kwargs):
                named = bool(kwargs.get("name"))
                if named:
                    stats["namedCursors"] += 1
                return Cursor(connection.cursor(*args, **kwargs), named)
            try:
                yield type("LocalConnection", (), {"cursor": staticmethod(cursor)})()
            finally:
                await connection.rollback()

    catalog = CatalogDiscoveryProcessor(RdsDataCatalogDiscoveryCoordinator(LocalDataApi()), Secrets(), PostgreSqlCatalogReader(resolver=Resolver()))
    preview = PreviewProcessor(RdsDataPreviewCoordinator(LocalDataApi()), Secrets(), PostgreSqlPreviewReader(resolver=Resolver()))
    class Dispatcher:
        available, catalog_available = False, True
        async def dispatch_connection_catalog_discovery(self, discovery_id):
            if stats["catalogExecutionCount"] >= 1:
                raise ProcessingDispatchUnavailable("Local fixture catalog request limit")
            stats["catalogExecutionCount"] += 1
            persist()
            await catalog.process(CatalogDiscoveryCommand(discovery_id))
    class PreviewClient:
        available = True
        async def preview(self, preview_id, dataset, source_version, bbox):
            if stats["previewInvocationCount"] >= 2:
                return error_response(preview_id, "preview_unavailable")
            stats["previewInvocationCount"] += 1
            persist()
            return await preview.process(PreviewCommand(preview_id))

    class LocalSettings(Settings):
        def database_connection_kwargs(self):
            return {"conninfo": "postgresql://opengeo_runtime@127.0.0.1/opengeo", "sslmode": "disable"}
    executor = PostgresTenantQueryExecutor(LocalSettings(env="test", database_url=SecretStr("postgresql://opengeo_runtime@127.0.0.1/opengeo")))
    connections = PostgresExternalConnectionRepository(executor, UnavailableConnectionSecretStore())
    overrides = {"connection_repository": connections, "connection_catalog_repository": PostgresCatalogDiscoveryRepository(executor, connections),
                 "postgis_layer_repository": PostgresPostgisLayerRepository(executor, connections),
                 "connection_verification_dispatcher": Dispatcher(), "postgis_preview_client": PreviewClient()}
    originals = catalog_runtime.verified_postgresql_connection, preview_runtime.verified_postgresql_connection
    catalog_runtime.verified_postgresql_connection = preview_runtime.verified_postgresql_connection = transport
    async def cleanup():
        catalog_runtime.verified_postgresql_connection, preview_runtime.verified_postgresql_connection = originals
        stats["managedRowsAfter"] = await _counts()
        async with await _connect() as connection:
            stats["previewLeaseStates"] = [dict(zip(("state", "returned", "truncated"), row)) for row in
                await (await connection.execute(
                    "SELECT state::text,returned_count,truncated FROM app.external_postgis_previews "
                    "WHERE project_id=%s ORDER BY created_at", (UUID(ready["projectId"]),)
                )).fetchall()]
        stats["finalized"] = True
        persist()
    return overrides, cleanup

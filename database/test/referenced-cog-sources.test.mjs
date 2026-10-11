import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {test} from "node:test";
import {PGlite} from "@electric-sql/pglite";

test("forward COG source migration preserves managed rasters and accepts governed references without widening format matches", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE SCHEMA app;
      CREATE TYPE app.dataset_source_type AS ENUM ('upload','repository','xyz','wms','pmtiles','geojson','arcgis','wfs','imageserver','mapserver');
      CREATE TYPE app.dataset_format AS ENUM ('cog','geoparquet','xyz','wms','pmtiles','geojson','arcgis','wfs','imageserver','mapserver');
      CREATE TABLE app.datasets(id integer PRIMARY KEY,source_type app.dataset_source_type,format app.dataset_format,
        CONSTRAINT datasets_source_format_match CHECK (source_type IN ('upload','repository') OR source_type::text=format::text));
      CREATE TABLE app.external_sources(id integer PRIMARY KEY,source_type app.dataset_source_type,
        CONSTRAINT external_sources_supported_type CHECK (source_type NOT IN ('upload','repository')));
      INSERT INTO app.datasets VALUES(1,'upload','cog'),(2,'repository','cog'),(3,'mapserver','mapserver');
      INSERT INTO app.external_sources VALUES(3,'mapserver');`);
    const before = (await db.query("SELECT * FROM app.datasets ORDER BY id")).rows;
    await db.exec(await readFile(new URL("../migrations/0156_referenced_cog_sources.sql", import.meta.url), "utf8"));
    assert.deepEqual((await db.query("SELECT * FROM app.datasets ORDER BY id")).rows, before);
    await db.exec("INSERT INTO app.datasets VALUES(4,'cog','cog'); INSERT INTO app.external_sources VALUES(4,'cog');");
    assert.equal((await db.query("SELECT source_type::text FROM app.external_sources WHERE id=4")).rows[0].source_type, "cog");
    await assert.rejects(db.exec("INSERT INTO app.datasets VALUES(5,'cog','xyz')"), /datasets_source_format_match/);
    await assert.rejects(db.exec("INSERT INTO app.datasets VALUES(6,'upload','mapserver')"), /datasets_source_format_match/);
    await assert.rejects(db.exec("INSERT INTO app.external_sources VALUES(7,'upload')"), /external_sources_supported_type/);
  } finally {await db.close();}
});

test("COG metadata larger than the legacy source bound persists exactly while other sources and oversized COGs remain bounded", async () => {
  const db = new PGlite();
  try {
    const foundation = await readFile(new URL("../migrations/0006_governed_external_sources.sql", import.meta.url), "utf8");
    const definition = foundation.match(/CREATE TABLE app\.external_source_revisions \([\s\S]*?\n\);/)[0];
    await db.exec(`CREATE SCHEMA app;
      CREATE TYPE app.external_source_verification_state AS ENUM ('syntax_only');
      CREATE TABLE app.organizations(id uuid PRIMARY KEY);
      CREATE TABLE app.users(id uuid PRIMARY KEY);
      CREATE TABLE app.external_sources(organization_id uuid,dataset_id uuid,PRIMARY KEY(organization_id,dataset_id));
      INSERT INTO app.users VALUES('00000000-0000-4000-8000-000000000001');
      INSERT INTO app.organizations VALUES('00000000-0000-4000-8000-000000000002');
      INSERT INTO app.external_sources VALUES('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003');`);
    await db.exec(definition);
    const insert = configuration => db.query(`INSERT INTO app.external_source_revisions
      (organization_id,dataset_id,version_number,source_url,configuration,created_by)
      VALUES('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003',
        1,'https://example.org/original.tif',$1::jsonb,'00000000-0000-4000-8000-000000000001')`, [JSON.stringify(configuration)]);
    const metadata = {source: {assets: {visual: {href: "https://example.org/original.tif", license: "CC-BY-SA-3.0-IGO", description: "original provenance ".repeat(1000)}}}, normalized: {}, curated: {}, inferred: {}};
    const configuration = {service_kind: "cog", bands: [1, 2, 3], reference_metadata: metadata};
    assert(Buffer.byteLength(JSON.stringify(metadata)) > 16384);
    assert(Buffer.byteLength(JSON.stringify(metadata)) < 262144);
    await assert.rejects(insert(configuration), /external_source_revision_configuration_object/);
    await db.exec(await readFile(new URL("../migrations/0157_referenced_cog_configuration_bounds.sql", import.meta.url), "utf8"));
    await assert.rejects(insert({...configuration, service_kind: "wms"}), /external_source_revision_configuration_object/);
    await assert.rejects(insert({...configuration, reference_metadata: {description: "x".repeat(1048576)}}), /external_source_revision_configuration_object/);
    await assert.rejects(insert([]), /external_source_revision_configuration_object/);
    await insert(configuration);
    assert.deepEqual((await db.query("SELECT configuration FROM app.external_source_revisions")).rows[0].configuration, configuration);
  } finally {await db.close();}
});

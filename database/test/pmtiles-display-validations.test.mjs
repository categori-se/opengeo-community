import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, describe, it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

const id = n => `10000000-0169-4000-8000-${String(n).padStart(12, "0")}`;
const [org, foreignOrg, owner, editor, viewer, outsider, project, otherProject, dataset, version, source, token] =
  Array.from({length: 12}, (_, i) => id(i + 1));
const sha = n => String(n).repeat(64);
const read = name => readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
const options = {input_layer: null, extent: 4096, simplification: 1, simplification_max_zoom: 1,
  buffer: 80, max_size: 500000, max_features: 200000, attribute_names: null};
const imageDigest = `sha256:${"d".repeat(64)}`;
const software = {gdal: "3.13.1", workerBaseImage: "ghcr.io/osgeo/gdal:ubuntu-small-3.13.1@sha256:836d1646ff9ab30d7db947c7b9690de55f34c2fd7cc5af6086a0854ccb378f59",
  projNetwork: "disabled", versionOutput: "GDAL 3.13.1, test binary", runtimeImageDigest: imageDigest};
let db;

async function tenant(user, operation, organization = org) {
  await db.exec("BEGIN; SET LOCAL ROLE opengeo_runtime");
  try {
    await db.query("SELECT set_config('app.organization_id',$1,true),set_config('app.user_id',$2,true)", [organization, user]);
    const result = await operation();
    await db.exec("COMMIT");
    return result;
  } catch (error) {
    await db.exec("ROLLBACK");
    throw error;
  }
}

async function worker(operation) {
  await db.exec("SET ROLE opengeo_worker");
  try {return await operation();} finally {await db.exec("RESET ROLE");}
}

async function fixture(n, {size = 16384, fragments = 6, sidecar = false, unknown = false, conversionOptions = null, claim = true, scope = null} = {}) {
  const datasetId = scope?.dataset ?? dataset, versionId = scope?.version ?? version, sourceId = scope?.source ?? source;
  const projectId = scope?.project ?? project;
  const job = id(100 + n), output = id(200 + n), index = id(300 + n);
  await tenant(owner, () => db.query(`INSERT INTO app.pmtiles_derivative_jobs
    (id,organization_id,project_id,dataset_id,dataset_version_id,source_object_id,bounds,
      minimum_zoom,maximum_zoom,source_layer,request_checksum_sha256,idempotency_key,request_id,created_by,conversion_options,worker_image_digest)
    VALUES($1,$2,$3,$4,$5,$6,'[-1,-1,1,1]',0,8,'features',$7,$1,$8,$9,$10,$11)`,
  [job, org, projectId, datasetId, versionId, sourceId, n.toString(16).padStart(64, "0"), `pmtiles-${n}`, owner, conversionOptions, conversionOptions ? imageDigest : null]));
  if (claim) await worker(() => db.query(`SELECT * FROM app.${conversionOptions ? "claim_pmtiles_derivative_v2" : "claim_pmtiles_derivative"}($1,$2,900)`, [job, token]));
  const key = `organizations/${org}/projects/${projectId}/datasets/${datasetId}/versions/${versionId}/derivatives/tiles/custom/${job}.pmtiles`;
  const artifact = {id: output, role: "tile", bucket: "opengeo-geodata-test", object_key: key,
    s3_version_id: `output-${n}`, etag: "a".repeat(32), content_type: "application/vnd.pmtiles", size_bytes: size, checksum_sha256: sha(2)};
  const validation = {schema_version: "opengeo.pmtiles-display-validation.1", recipe: "gdal-pmtiles-v1",
    source_object_id: sourceId, source_checksum_sha256: sha(1), source_s3_version_id: "source-1",
    request_checksum_sha256: n.toString(16).padStart(64, "0"), output_checksum_sha256: sha(2), output_size_bytes: size,
    expected_owner: "123456789012", bounds: [-1, -1, 1, 1], min_zoom: 0, max_zoom: 8,
    output_layer: {name: "features", reported_fragment_count: fragments, geometry_type: unknown ? null : "MultiPolygon", crs: "EPSG:3857"},
    tile_layers: unknown ? [] : [{source_layer: "features", title: "features", geometry_type: "MultiPolygon", feature_count: fragments,
      geometry_method: "Quantized display; counts are tile fragments, not source records."}],
    count_semantics: "gdal-reported-tile-fragments-not-source-records",
    losses: {geometry: "quantized-clipped-simplified-display-not-analysis", attributes: "not-independently-verified-null-values-may-be-omitted",
      feature_ids: "not-guaranteed-to-retain-source-fids", source_record_count: null, preservation_verified: false}};
  if (conversionOptions) {
    Object.assign(validation, {recipe: "gdal-pmtiles-v2", options: conversionOptions, software, input_layer: "actual_input"});
    Object.assign(validation.losses, {adaptive_tile_limits: "Tile byte and feature limits may reduce precision or omit display features; source data remains preserved.", attribute_selection: conversionOptions.attribute_names});
  }
  const blocks = Math.ceil(size / 65536);
  if (sidecar) validation.block_index_artifact = {id: index, role: "derived", bucket: artifact.bucket,
    object_key: key.replace(/\.pmtiles$/, ".blocks.sha256"), s3_version_id: `index-${n}`, etag: "b".repeat(32),
    content_type: "application/octet-stream", size_bytes: blocks * 32, checksum_sha256: sha(3)};
  else validation.block_sha256 = Array(blocks).fill(sha(4));
  const complete = (value = validation, workerToken = token) => worker(() => db.query(
    "SELECT app.complete_pmtiles_derivative($1,$2,$3,$4) AS completed", [job, workerToken, artifact, value]));
  return {job, output, index, artifact, validation, complete};
}

async function review(job) {
  return tenant(editor, async () => (await db.query(
    "SELECT review_sha256,validation FROM app.pmtiles_display_validations WHERE pmtiles_job_id=$1", [job])).rows[0]);
}

async function admit(job, hash, {user = editor, organization = org, scope = project, saved = version, datasetId = dataset,
  title = "Reviewed tiled display", acknowledged = true, rights = "Source terms reviewed"} = {}) {
  return tenant(user, () => db.query(
    "SELECT app.admit_pmtiles_derivative_display($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS id",
    [organization, scope, datasetId, saved, job, hash, title, rights, "Offline source attribution", acknowledged]), organization);
}

async function preservedOriginal(n) {
  const target = {dataset: id(700 + n), version: id(800 + n), source: id(900 + n), upload: id(1000 + n)};
  const key = `organizations/${org}/projects/${project}/datasets/${target.dataset}/uploads/${target.upload}/original/uninspected.geojson`;
  await db.query(`INSERT INTO app.datasets(id,organization_id,name,classification,source_type,format,status,owner_user_id,created_by,updated_by)
    VALUES($1,$2,'Preserved original','internal','upload','geojson','draft',$3,$3,$3)`, [target.dataset,org,owner]);
  await db.query("INSERT INTO app.project_datasets(organization_id,project_id,dataset_id,linked_by) VALUES($1,$2,$3,$4)", [org,project,target.dataset,owner]);
  await db.query(`INSERT INTO app.upload_intents(id,organization_id,project_id,dataset_id,created_by,original_filename,
    content_type,expected_size_bytes,expected_sha256,bucket,object_key,expires_at,purpose)
    VALUES($1,$2,$3,$4,$5,'uninspected.geojson','application/geo+json',1024,$6,'opengeo-geodata-test',$7,clock_timestamp()+interval '15 minutes','pmtiles_original')`,
  [target.upload,org,project,target.dataset,owner,sha(1),key]);
  await db.query(`INSERT INTO app.data_objects(id,organization_id,dataset_id,role,bucket,object_key,s3_version_id,etag,content_type,size_bytes,checksum_sha256,created_by)
    VALUES($1,$2,$3,'original','opengeo-geodata-test',$4,'source-1',$5,'application/geo+json',1024,$6,$7)`, [target.source,org,target.dataset,key,"a".repeat(32),sha(1),owner]);
  await db.query(`INSERT INTO app.dataset_versions(id,organization_id,dataset_id,version_number,original_object_id,state,created_by)
    VALUES($1,$2,$3,1,$4,'preserved',$5)`, [target.version,org,target.dataset,target.source,owner]);
  await db.query("UPDATE app.upload_intents SET state='completed',completed_at=clock_timestamp(),completed_object_id=$1 WHERE id=$2", [target.source,target.upload]);
  await db.query("UPDATE app.datasets SET current_version_id=$1 WHERE id=$2", [target.version,target.dataset]);
  return target;
}

describe("0169 completed PMTiles validation and deliberate display admission", () => {
  before(async () => {
    db = new PGlite();
    for (const name of ["0001_platform_foundation.sql", "0002_membership_invitations.sql", "0003_managed_ingestion_foundation.sql",
      "0004_worker_execution_boundary.sql", "0005_catalog_access.sql", "0006_governed_external_sources.sql", "0007_governed_pmtiles_sources.sql"]) {
      await db.exec((await read(name)).replace(/^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm, ""));
    }
    await db.exec("CREATE ROLE opengeo_connector; CREATE ROLE opengeo_observable_coordinator; CREATE ROLE opengeo_dataset_verifier;");
    await db.exec("ALTER TYPE app.dataset_format ADD VALUE IF NOT EXISTS 'png'");
    for (const name of ["0050_team_project_access.sql", "0054_reusable_project_datasets.sql", "0055_project_dataset_detach_lock.sql", "0058_durable_data_preservation.sql"]) await db.exec(await read(name));
    // Reuse the receipt suite's coverage-only prerequisite; PMTiles uses real 0058/0059 functions.
    await db.exec(`CREATE TABLE app.spatial_service_coverages(id uuid PRIMARY KEY,organization_id uuid,data_object_id uuid,UNIQUE(organization_id,id));
      CREATE TABLE app.spatial_coverage_derivative_jobs(id uuid PRIMARY KEY,organization_id uuid,project_id uuid,
        coverage_id uuid,request_checksum_sha256 text,output_object_id uuid,output_checksum_sha256 text,
        state text,created_by uuid,finished_at timestamptz,UNIQUE(organization_id,id));
      CREATE FUNCTION app.complete_spatial_coverage_derivative(uuid,uuid,jsonb,jsonb) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;`);
    // Reuse the actual operator-owned control table/denials, without unrelated controller job fixtures.
    await db.exec((await read("0151_worker_runtime_control.sql")).split("CREATE FUNCTION app.claim_worker_runtime")[0] + "COMMIT;");
    for (const name of ["0059_processing_execution_receipts.sql", "0135_layer_archive_distributions.sql", "0136_archive_unknown_capture_time.sql",
      "0138_managed_layer_displays.sql", "0169_pmtiles_display_validations.sql", "0172_pmtiles_conversion_options.sql",
      "0141_staged_upload_intents.sql", "0150_upload_intent_renewal.sql", "0154_account_recovery_inventory.sql",
      "0173_preserved_pmtiles_originals.sql"]) await db.exec(await read(name));
    await db.exec(`INSERT INTO app.users(id,cognito_subject,email,display_name) VALUES
      ('${owner}','pm169-owner','owner@169.test','Owner'),('${editor}','pm169-editor','editor@169.test','Editor'),
      ('${viewer}','pm169-viewer','viewer@169.test','Viewer'),('${outsider}','pm169-other','other@169.test','Other');
      INSERT INTO app.organizations(id,name,slug,created_by) VALUES
      ('${org}','PM169','pm169','${owner}'),('${foreignOrg}','Other169','other169','${outsider}');
      INSERT INTO app.organization_memberships(organization_id,user_id,role,invited_by) VALUES
      ('${org}','${owner}','admin','${owner}'),('${org}','${editor}','member','${owner}'),
      ('${org}','${viewer}','member','${owner}'),('${foreignOrg}','${outsider}','admin','${outsider}');
      INSERT INTO app.projects(id,organization_id,name,created_by) VALUES
      ('${project}','${org}','PM169','${owner}'),('${otherProject}','${org}','Other','${owner}');
      INSERT INTO app.project_memberships(organization_id,project_id,user_id,role) VALUES
      ('${org}','${project}','${owner}','owner'),('${org}','${project}','${editor}','editor'),('${org}','${project}','${viewer}','viewer');
      INSERT INTO app.datasets(id,organization_id,name,classification,source_type,format,status,owner_user_id,created_by,updated_by)
      VALUES('${dataset}','${org}','Vectors','internal','upload','geojson','active','${owner}','${owner}','${owner}');
      INSERT INTO app.project_datasets(organization_id,project_id,dataset_id,linked_by) VALUES('${org}','${project}','${dataset}','${owner}');
      INSERT INTO app.data_objects(id,organization_id,dataset_id,role,bucket,object_key,s3_version_id,etag,content_type,size_bytes,checksum_sha256,created_by)
      VALUES('${source}','${org}','${dataset}','original','opengeo-geodata-test','private/source.geojson','source-1','${"a".repeat(32)}','application/geo+json',1024,'${sha(1)}','${owner}');
      INSERT INTO app.dataset_versions(id,organization_id,dataset_id,version_number,original_object_id,state,created_by)
      VALUES('${version}','${org}','${dataset}',1,'${source}','active','${owner}');
      UPDATE app.datasets SET current_version_id='${version}' WHERE id='${dataset}';`);
  });
  after(async () => {await db.close();});

  it("retains validated output atomically without admitting it and preserves legacy completion receipts", async () => {
    const f = await fixture(1);
    assert.deepEqual((await f.complete()).rows, [{completed: true}]);
    assert.deepEqual((await f.complete()).rows, [{completed: false}]);
    assert.deepEqual((await db.query("SELECT (SELECT count(*)::int FROM app.processing_execution_receipts) receipts,(SELECT count(*)::int FROM app.layer_archive_distributions) displays")).rows, [{receipts: 1, displays: 0}]);
    assert.deepEqual((await review(f.job)).validation.losses, f.validation.losses);
    const legacy = await fixture(2);
    assert.equal((await worker(() => db.query("SELECT app.complete_pmtiles_derivative($1,$2,$3) AS value", [legacy.job, token, legacy.artifact]))).rows[0].value, true);
    assert.equal(await review(legacy.job), undefined);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM app.processing_execution_receipts")).rows[0].n, 2);
    await assert.rejects(admit(legacy.job, sha(1)), /review is missing/);
  });

  it("rejects mismatched worker facts and incomplete blocks with the entire completion rolled back", async () => {
    const f = await fixture(3);
    for (const bad of [{...f.validation, source_object_id: id(999)}, {...f.validation, output_size_bytes: 999},
      {...f.validation, block_sha256: []}, {...f.validation, losses: {...f.validation.losses, preservation_verified: true}}]) {
      await assert.rejects(f.complete(bad), /invalid PMTiles/);
      assert.equal((await db.query("SELECT state FROM app.pmtiles_derivative_jobs WHERE id=$1", [f.job])).rows[0].state, "running");
      assert.equal((await db.query("SELECT count(*)::int AS n FROM app.data_objects WHERE id=$1", [f.output])).rows[0].n, 0);
    }
    assert.equal((await f.complete(f.validation, id(998))).rows[0].completed, false);
    assert.equal((await f.complete(f.validation, null)).rows[0].completed, false);
    assert.equal((await f.complete()).rows[0].completed, true);
  });

  it("derives an exact descriptor only after fresh review and returns the same admission on retry", async () => {
    const f = await fixture(4);await f.complete();const receipt = await review(f.job);
    await assert.rejects(admit(f.job, sha(9)), /review is missing, stale/);
    await assert.rejects(admit(f.job, receipt.review_sha256, {acknowledged: false}), /review is missing/);
    assert.equal((await admit(f.job, receipt.review_sha256)).rows[0].id, f.job);
    assert.equal((await admit(f.job, receipt.review_sha256)).rows[0].id, f.job);
    await assert.rejects(admit(f.job, receipt.review_sha256, {title: "Changed review"}),
      error => error.code === "23514" && /conflicts with the existing review/.test(error.message));
    const row = (await tenant(viewer, () => db.query("SELECT * FROM app.layer_archive_distributions WHERE id=$1", [f.job]))).rows[0];
    assert.equal(row.captured_at, null);
    assert.equal(row.descriptor.objects[0].key, f.artifact.object_key);
    assert.equal(row.descriptor.objects[0].version_id, f.artifact.s3_version_id);
    assert.equal(row.descriptor.objects[0].expected_owner, "123456789012");
    assert.deepEqual(row.descriptor.provenance.losses, f.validation.losses);
    assert.equal(row.descriptor.provenance.count_semantics, "gdal-reported-tile-fragments-not-source-records");
    assert.equal(row.dataset_version_id, version);
    assert.equal(row.source_version, null);
  });

  it("retains exact versioned sidecars and unknown geometry without granting admission", async () => {
    const f = await fixture(5, {size: 67108865, fragments: 100001, sidecar: true});
    await f.complete();const receipt = await review(f.job);await admit(f.job, receipt.review_sha256);
    const descriptor = (await db.query("SELECT descriptor FROM app.layer_archive_distributions WHERE id=$1", [f.job])).rows[0].descriptor;
    assert.deepEqual(descriptor.objects[0].block_index, {key: f.validation.block_index_artifact.object_key,
      version_id: "index-5", size_bytes: 32800, sha256: sha(3)});
    assert.equal((await db.query("SELECT count(*)::int AS n FROM app.dataset_version_objects WHERE data_object_id=$1", [f.index])).rows[0].n, 1);
    const unknown = await fixture(6, {unknown: true});await unknown.complete();
    await assert.rejects(admit(unknown.job, (await review(unknown.job)).review_sha256), /incompatible/);
    const broken = await fixture(7, {sidecar: true});
    await assert.rejects(broken.complete({...broken.validation, block_index_artifact: {...broken.validation.block_index_artifact,
      object_key: "private/arbitrary.sha256"}}), /invalid PMTiles block index/);
    await worker(() => db.query("SELECT app.fail_pmtiles_derivative($1,$2,'validation_rejected')", [broken.job, token]));
    const overLimit = await fixture(9, {fragments: 10000001, unknown: true, sidecar: true});
    await overLimit.complete();
    await assert.rejects(admit(overLimit.job, (await review(overLimit.job)).review_sha256), /incompatible/);
  });

  it("seals v2 options and actual runtime while keeping legacy claims and drain observation isolated", async () => {
    const legacy = await fixture(10, {claim: false});
    const f = await fixture(11, {conversionOptions: options, claim: false});
    assert.equal((await worker(() => db.query("SELECT claim_status FROM app.claim_pmtiles_derivative_v2($1,$2,900)", [legacy.job, token]))).rows[0].claim_status, "not_ready");
    assert.equal((await worker(() => db.query("SELECT claim_status FROM app.claim_pmtiles_derivative($1,$2,900)", [f.job, token]))).rows[0].claim_status, "not_ready");
    assert.equal((await db.query("SELECT attempt_count FROM app.pmtiles_derivative_jobs WHERE id=$1", [f.job])).rows[0].attempt_count, 0);
    assert.deepEqual((await worker(() => db.query("SELECT app.worker_runtime_unfinished_pmtiles_v2() AS counts"))).rows[0].counts, {pmtiles: 1});
    await assert.rejects(db.query("UPDATE app.pmtiles_derivative_jobs SET conversion_options=$2 WHERE id=$1", [f.job, {...options, extent: 8192}]), /immutable/);
    await assert.rejects(db.query("UPDATE app.pmtiles_derivative_jobs SET worker_image_digest=$2 WHERE id=$1", [f.job, `sha256:${"e".repeat(64)}`]), /immutable/);
    const claimed = (await worker(() => db.query("SELECT * FROM app.claim_pmtiles_derivative_v2($1,$2,900)", [f.job, token]))).rows[0];
    assert.deepEqual(claimed.conversion_options, options);
    assert.equal(claimed.worker_image_digest, imageDigest);
    await assert.rejects(worker(() => db.query("SELECT app.complete_pmtiles_derivative($1,$2,$3)", [f.job, token, f.artifact])), /requires validated completion/);
    for (const bad of [{...f.validation, options: {...options, buffer: 10}}, {...f.validation, software: {...software, gdal: "3.13.0"}},
      {...f.validation, software: {...software, runtimeImageDigest: `sha256:${"e".repeat(64)}`}}]) {
      await assert.rejects(f.complete(bad), /invalid PMTiles v2/);
      assert.equal((await db.query("SELECT state FROM app.pmtiles_derivative_jobs WHERE id=$1", [f.job])).rows[0].state, "running");
      assert.equal((await db.query("SELECT count(*)::int AS n FROM app.data_objects WHERE id=$1", [f.output])).rows[0].n, 0);
    }
    assert.equal((await f.complete()).rows[0].completed, true);
    const receipt = (await db.query("SELECT tool_version,software FROM app.processing_execution_receipts WHERE pmtiles_job_id=$1", [f.job])).rows[0];
    assert.equal(receipt.tool_version, "1.1.0");assert.deepEqual(receipt.software, software);
    assert.equal((await db.query("SELECT recipe FROM app.dataset_version_derivative_lineage WHERE pmtiles_job_id=$1", [f.job])).rows[0].recipe, "gdal-pmtiles-v2");
    await admit(f.job, (await review(f.job)).review_sha256);
    assert.equal((await db.query("SELECT descriptor FROM app.layer_archive_distributions WHERE id=$1", [f.job])).rows[0].descriptor.provenance.recipe, "gdal-pmtiles-v2");
    assert.deepEqual((await worker(() => db.query("SELECT app.worker_runtime_unfinished_pmtiles_v2() AS counts"))).rows[0].counts, {pmtiles: 0});
    await worker(() => db.query("SELECT * FROM app.claim_pmtiles_derivative($1,$2,900)", [legacy.job, token]));
    await legacy.complete();
  });

  it("admits only a fresh operator-ready v2 window without reserving or changing the control ledger", async () => {
    const queue = "https://sqs.us-east-1.amazonaws.com/111111111111/pmtiles-v2";
    const config = {enabled: true, pmtilesV2Ready: true, pmtilesWorkerImageDigest: imageDigest, pmtilesQueueUrl: queue,
      windowSeconds: 900, cleanupSeconds: 300, dailyWindows: 1, totalWindows: 2,
      scopeHash: sha(5), endpointHash: sha(6), workerHash: sha(7)};
    const configure = async changes => db.query("UPDATE app.worker_runtime_control SET configuration=$1,window_state=NULL,budget_day=NULL,starts_today=0,total_windows=0 WHERE singleton", [{...config, ...changes}]);
    const readStatus = (lock = false, digest = imageDigest, url = queue) => tenant(owner, async () =>
      (await db.query("SELECT app.pmtiles_v2_admission($1,$2,$3) AS value", [digest, url, lock])).rows[0].value);
    const ledger = async () => (await db.query("SELECT to_jsonb(control) AS value FROM app.worker_runtime_control control")).rows[0].value;
    await configure({});
    const before = await ledger();assert.deepEqual(await readStatus(true), {ready: true, reason: "ready"});assert.deepEqual(await ledger(), before);
    for (const [changes, reason] of [[{enabled: false}, "runtime_disabled"], [{pmtilesV2Ready: false}, "runtime_not_ready"],
      [{pmtilesWorkerImageDigest: `sha256:${"e".repeat(64)}`}, "runtime_binding_changed"],
      [{pmtilesQueueUrl: queue + "-different"}, "runtime_binding_changed"],
      [{windowSeconds: "900"}, "runtime_limits_invalid"], [{dailyWindows: 9}, "runtime_limits_invalid"],
      [{workerHash: "unbound"}, "runtime_limits_invalid"]]) {
      await configure(changes);const previous = await ledger();
      assert.deepEqual(await readStatus(true), {ready: false, reason});assert.deepEqual(await ledger(), previous);
    }
    await configure({});await db.exec("UPDATE app.worker_runtime_control SET window_state='{}' WHERE singleton");
    assert.equal((await readStatus()).reason, "runtime_window_active");
    await configure({});await db.exec("UPDATE app.worker_runtime_control SET total_windows=2 WHERE singleton");
    assert.equal((await readStatus()).reason, "runtime_budget_exhausted");
    await configure({});await db.exec("UPDATE app.worker_runtime_control SET budget_day=(clock_timestamp() AT TIME ZONE 'UTC')::date,starts_today=1 WHERE singleton");
    assert.equal((await readStatus()).reason, "runtime_budget_exhausted");
    await db.exec("UPDATE app.worker_runtime_control SET budget_day=(clock_timestamp() AT TIME ZONE 'UTC')::date-1 WHERE singleton");
    assert.equal((await readStatus()).ready, true);
    await configure({});const pending = await fixture(12, {conversionOptions: options, claim: false});
    assert.equal((await readStatus(true)).reason, "runtime_job_pending");
    await worker(() => db.query("SELECT * FROM app.claim_pmtiles_derivative_v2($1,$2,900)", [pending.job, token]));
    await worker(() => db.query("SELECT app.fail_pmtiles_derivative($1,$2,'fixture_finished')", [pending.job, token]));
    assert.deepEqual(await readStatus(), {ready: true, reason: "ready"});
    assert.equal((await readStatus(false, null)).reason, "runtime_not_configured");
    await assert.rejects(tenant(owner, () => db.exec("SELECT * FROM app.worker_runtime_control")), /permission denied/);
    await assert.rejects(worker(() => db.query("SELECT app.pmtiles_v2_admission($1,$2,true)", [imageDigest, queue])), /permission denied/);
  });

  it("rechecks account, workspace, version, source and current management authority even after admission", async () => {
    const f = await fixture(8);await f.complete();const hash = (await review(f.job)).review_sha256;
    for (const options of [{user: viewer}, {user: outsider, organization: foreignOrg}, {scope: otherProject}, {saved: id(997)}]) {
      await assert.rejects(admit(f.job, hash, options), /authority|current exact/);
    }
    await admit(f.job, hash);
    await db.query("UPDATE app.project_memberships SET role='viewer' WHERE project_id=$1 AND user_id=$2", [project, editor]);
    await assert.rejects(admit(f.job, hash), /authority/);
    await db.query("UPDATE app.project_memberships SET role='editor' WHERE project_id=$1 AND user_id=$2", [project, editor]);
    await db.query("UPDATE app.dataset_versions SET state='failed' WHERE id=$1", [version]);
    await assert.rejects(admit(f.job, hash), /current exact/);
    await db.query("UPDATE app.dataset_versions SET state='active' WHERE id=$1", [version]);
    await db.query("DELETE FROM app.project_datasets WHERE project_id=$1 AND dataset_id=$2", [project, dataset]);
    await assert.rejects(admit(f.job, hash), /current exact/);
  });

  it("keeps validations immutable and runtime/worker writes separated under forced workspace RLS", async () => {
    await assert.rejects(db.exec("UPDATE app.pmtiles_display_validations SET validation='{}'"), /immutable/);
    await assert.rejects(db.exec("DELETE FROM app.pmtiles_display_validations"), /immutable/);
    await assert.rejects(tenant(owner, () => db.exec("UPDATE app.layer_archive_distributions SET enabled=true")), /permission denied/);
    await assert.rejects(tenant(owner, () => db.exec("DELETE FROM app.pmtiles_display_validations")), /permission denied/);
    await assert.rejects(worker(() => db.exec("SELECT * FROM app.pmtiles_display_validations")), /permission denied/);
    await assert.rejects(worker(() => db.query("SELECT app.admit_pmtiles_derivative_display($1,$2,$3,$4,$5,$6,$7,$8,$9,true)",
      [org, project, dataset, version, id(104), sha(1), "Denied", "Terms", "Attribution"])), /permission denied/);
    assert.equal((await tenant(outsider, () => db.query("SELECT * FROM app.pmtiles_display_validations"), foreignOrg)).rows.length, 0);
    assert.deepEqual((await db.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='app.pmtiles_display_validations'::regclass")).rows,
      [{relrowsecurity: true, relforcerowsecurity: true}]);
  });

  it("converts only purpose-sealed preserved originals through v2 without activating their source", async () => {
    const p = await preservedOriginal(51);
    const eligible = () => tenant(owner, () => db.query("SELECT app.pmtiles_preserved_original_eligible($1,$2,$3,$4,$5) AS eligible", [org,project,p.dataset,p.version,p.source]));
    assert.equal((await eligible()).rows[0].eligible, true);
    await assert.rejects(fixture(51, {scope: p}), /exact active/);
    const f = await fixture(52, {scope: p, conversionOptions: options});
    assert.equal((await f.complete()).rows[0].completed, true);
    const hash = (await review(f.job)).review_sha256;
    assert.equal((await admit(f.job,hash,{datasetId:p.dataset,saved:p.version})).rows[0].id,f.job);
    // Execute the application's actual batched save predicate under runtime RLS.
    // The source remains uninspected; only the reviewed display can be saved.
    const workspaceSource = await readFile(new URL("../../services/api/src/opengeo_api/workspaces.py", import.meta.url), "utf8");
    const saveSql = workspaceSource.match(/"""(\s+SELECT requested.dataset_id, requested.dataset_version_id,\s+requested.dataset_version_number, requested.managed_display_id,[\s\S]*?)"""/)[1];
    let parameter = 0;
    const query = saveSql.replace(/%s/g, () => `$${++parameter}`);
    const requested = {dataset_id:p.dataset,dataset_version_id:p.version,dataset_version_number:1,managed_display_id:f.job};
    const saved = (changes = {}, user = viewer, organization = org, projectId = project) => tenant(user,
      () => db.query(query, [[{...requested,...changes}],organization,projectId,user]), organization);
    assert.equal((await saved()).rows.length,1);
    for (const changes of [{dataset_id:dataset},{dataset_version_id:version},
      {dataset_version_number:2},{managed_display_id:id(9999)}]) assert.equal((await saved(changes)).rows.length,0);
    assert.equal((await saved({},outsider,foreignOrg)).rows.length,0);
    assert.equal((await saved({},viewer,org,otherProject)).rows.length,0);
    const display = (await db.query("SELECT descriptor FROM app.layer_archive_distributions WHERE id=$1",[f.job])).rows[0].descriptor;
    const descriptor = value => db.query("UPDATE app.layer_archive_distributions SET descriptor=$1 WHERE id=$2",[value,f.job]);
    for (const changed of [
      {...display,provenance:{...display.provenance,review_sha256:sha(9)}},
      {...display,provenance:{...display.provenance,recipe:"gdal-pmtiles-v1"}},
      {...display,objects:[{...display.objects[0],version_id:"wrong-output-version"}]}
    ]) {
      await descriptor(changed);assert.equal((await saved()).rows.length,0);
    }
    await descriptor(display);
    await db.query("UPDATE app.layer_archive_distributions SET enabled=false WHERE id=$1",[f.job]);
    assert.equal((await saved()).rows.length,0);
    await db.query("UPDATE app.layer_archive_distributions SET enabled=true WHERE id=$1",[f.job]);
    await db.query("DELETE FROM app.project_memberships WHERE project_id=$1 AND user_id=$2",[project,viewer]);
    assert.equal((await saved()).rows.length,0);
    await db.query("INSERT INTO app.project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,'viewer')",[org,project,viewer]);
    assert.equal((await saved()).rows.length,1);
    const rawSql = workspaceSource.match(/"""(\s+SELECT requested.dataset_id, requested.dataset_version_id,\s+requested.dataset_version_number\s+FROM jsonb_to_recordset[\s\S]*?)"""/)[1];
    parameter = 0;
    assert.equal((await tenant(viewer,()=>db.query(rawSql.replace(/%s/g,()=>`$${++parameter}`),[[requested],org]))).rows.length,0);
    assert.deepEqual((await db.query(`SELECT dataset.status, dataset.current_version_id, version.state,
      version.feature_count,version.extent,version.crs,version.geometry_type,version.schema_definition,version.quality_results
      FROM app.datasets dataset JOIN app.dataset_versions version ON version.id=dataset.current_version_id
      WHERE dataset.id=$1`, [p.dataset])).rows, [{status:"draft",current_version_id:p.version,state:"preserved",
      feature_count:null,extent:null,crs:null,geometry_type:null,schema_definition:{},quality_results:{}}]);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM app.processing_jobs WHERE dataset_id=$1",[p.dataset])).rows[0].n,0);
    assert.equal((await db.query("SELECT current_version_id FROM app.datasets WHERE id=$1",[dataset])).rows[0].current_version_id,version);
  });

  it("keeps preserved purpose, metadata and head immutable and forbids fake ingest work", async () => {
    const p=await preservedOriginal(53);
    await assert.rejects(db.query("UPDATE app.upload_intents SET purpose='ingest' WHERE id=$1",[p.upload]),/purpose is immutable/);
    for (const change of ["state='active'","feature_count=1","schema_definition='{\"fields\":[]}'","quality_results='{\"inspected\":true}'"]) {
      await assert.rejects(db.query(`UPDATE app.dataset_versions SET ${change} WHERE id=$1`,[p.version]),/preserved original version is immutable/);
    }
    await assert.rejects(db.query("UPDATE app.datasets SET status='active' WHERE id=$1",[p.dataset]),/cannot be activated/);
    await assert.rejects(db.query("UPDATE app.datasets SET current_version_id=NULL WHERE id=$1",[p.dataset]),/cannot be activated/);
    await assert.rejects(db.query(`INSERT INTO app.processing_jobs(id,organization_id,project_id,dataset_id,dataset_version_id,job_type,created_by)
      VALUES($1,$2,$3,$4,$5,'dataset.ingest',$6)`,[id(1500),org,project,p.dataset,p.version,owner]),/no dataset ingestion job/);
  });

  it("revalidates a preserved source association at claim and retains tenant and recovery boundaries", async () => {
    const p=await preservedOriginal(54),f=await fixture(54,{scope:p,conversionOptions:options,claim:false});
    assert.equal((await tenant(outsider,()=>db.query("SELECT app.pmtiles_preserved_original_eligible($1,$2,$3,$4,$5) AS eligible",[org,project,p.dataset,p.version,p.source]),foreignOrg)).rows[0].eligible,false);
    await assert.rejects(worker(()=>db.query("SELECT app.pmtiles_preserved_original_eligible($1,$2,$3,$4,$5)",[org,project,p.dataset,p.version,p.source])),/permission denied/);
    await db.query("DELETE FROM app.dataset_version_objects WHERE dataset_version_id=$1 AND data_object_id=$2",[p.version,p.source]);
    assert.equal((await worker(()=>db.query("SELECT * FROM app.claim_pmtiles_derivative_v2($1,$2,900)",[f.job,token]))).rows[0].claim_status,"not_ready");
    assert.deepEqual((await db.query("SELECT state,attempt_count FROM app.pmtiles_derivative_jobs WHERE id=$1",[f.job])).rows,[{state:"queued",attempt_count:0}]);
    const definition=(await db.query("SELECT pg_get_functiondef('app.capture_account_recovery_inventory()'::regprocedure) AS definition")).rows[0].definition;
    assert.match(definition,/"upload_intents": \[[^\n]+"purpose"/);
  });

  it("reuses the same preserved original through a separately linked Project without changing upload custody", async () => {
    const p=await preservedOriginal(55);
    assert.equal((await tenant(owner,()=>db.query("SELECT app.pmtiles_preserved_original_eligible($1,$2,$3,$4,$5) AS eligible",[org,otherProject,p.dataset,p.version,p.source]))).rows[0].eligible,false);
    await db.query("INSERT INTO app.project_datasets(organization_id,project_id,dataset_id,linked_by) VALUES($1,$2,$3,$4)",[org,otherProject,p.dataset,owner]);
    await db.query("INSERT INTO app.project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,'owner')",[org,otherProject,owner]);
    assert.equal((await tenant(owner,()=>db.query("SELECT app.pmtiles_preserved_original_eligible($1,$2,$3,$4,$5) AS eligible",[org,otherProject,p.dataset,p.version,p.source]))).rows[0].eligible,true);
    const f=await fixture(55,{scope:{...p,project:otherProject},conversionOptions:options});
    assert.equal((await f.complete()).rows[0].completed,true);
    const hash=(await db.query("SELECT review_sha256 FROM app.pmtiles_display_validations WHERE pmtiles_job_id=$1",[f.job])).rows[0].review_sha256;
    assert.equal((await admit(f.job,hash,{user:owner,scope:otherProject,datasetId:p.dataset,saved:p.version})).rows[0].id,f.job);
    assert.equal((await db.query("SELECT project_id FROM app.upload_intents WHERE id=$1",[p.upload])).rows[0].project_id,project);
  });
});

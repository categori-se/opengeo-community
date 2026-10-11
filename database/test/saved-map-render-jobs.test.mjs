import assert from "node:assert/strict";
import {createHash, randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {after, afterEach, before, beforeEach, describe, it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

const org = randomUUID(), otherOrg = randomUUID(), actor = randomUUID(), otherActor = randomUUID();
const project = randomUUID(), otherProject = randomUUID();
const digest = "a".repeat(64), recipeDigest = "b".repeat(64);
let db, map, resource, resourceVersion, sources, sequence;

async function source() {
  const dataset = randomUUID(), version = randomUUID(), original = randomUUID();
  const preview = `f0000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
  const sourceResource = randomUUID(), sourceVersion = randomUUID();
  await db.query(`INSERT INTO app.datasets
    (id, organization_id, name, source_type, format, status, owner_user_id, created_by, updated_by)
    VALUES ($1,$2,'Exact map source','upload','geojson','active',$3,$3,$3)`, [dataset, org, actor]);
  await db.query(`INSERT INTO app.project_datasets (organization_id,project_id,dataset_id,linked_by)
    VALUES ($1,$2,$3,$4)`, [org, project, dataset, actor]);
  await db.query(`INSERT INTO app.data_objects
    (id,organization_id,dataset_id,role,bucket,object_key,s3_version_id,etag,content_type,size_bytes,checksum_sha256,created_by)
    VALUES ($1,$2,$3,'original','original-only.invalid',$4,'original-v1','original-etag','application/geo+json',100,$5,$6)`,
  [original, org, dataset, `original/${original}`, digest, actor]);
  await db.query(`INSERT INTO app.dataset_versions
    (id,organization_id,dataset_id,version_number,original_object_id,state,created_by)
    VALUES ($1,$2,$3,1,$4,'active',$5)`, [version, org, dataset, original, actor]);
  await db.query(`INSERT INTO app.data_objects
    (id,organization_id,dataset_id,role,bucket,object_key,s3_version_id,etag,content_type,size_bytes,checksum_sha256,created_by)
    VALUES ($1,$2,$3,'derived','pinned-preview.invalid',$4,'preview-v1','preview-etag','application/geo+json',128,$5,$6)`,
  [preview, org, dataset, `source/${dataset}/derivatives/preview/preview.geojson`, digest, actor]);
  await db.query(`INSERT INTO app.dataset_version_objects
    (organization_id,dataset_id,dataset_version_id,data_object_id) VALUES ($1,$2,$3,$4)`,
  [org, dataset, version, preview]);
  await db.query(`INSERT INTO app.governed_resources
    (id,organization_id,project_id,kind,slug,dataset_id,current_version_id,owner_user_id,created_by,updated_by)
    VALUES ($1,$2,$3,'dataset',$4,$5,$6,$7,$7,$7)`,
  [sourceResource, org, project, `source-${sourceResource}`, dataset, sourceVersion, actor]);
  await db.query(`INSERT INTO app.governed_resource_versions
    (id,organization_id,resource_id,version_number,title,created_by) VALUES ($1,$2,$3,1,'Exact source',$4)`,
  [sourceVersion, org, sourceResource, actor]);
  return {dataset, version, original, preview, sourceResource, sourceVersion};
}

async function profile(input, target = resource, targetVersion = resourceVersion) {
  const style = randomUUID(), styleVersion = randomUUID(), id = randomUUID(), version = randomUUID();
  await db.query(`INSERT INTO app.governed_resource_styles
    (id,organization_id,project_id,resource_id,slug,format,current_version_id,created_by,updated_by)
    VALUES ($1,$2,$3,$4,$5,'maplibre',$6,$7,$7)`,
  [style, org, project, target, `style-${style}`, styleVersion, actor]);
  await db.query(`INSERT INTO app.governed_resource_style_versions
    (id,organization_id,style_id,version_number,title,media_type,definition,checksum_sha256,created_by)
    VALUES ($1,$2,$3,1,'Saved style','application/json','{}',$4,$5)`, [styleVersion, org, style, digest, actor]);
  await db.query(`INSERT INTO app.map_render_profiles
    (id,organization_id,project_id,resource_id,slug,current_version_id,created_by,updated_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`, [id, org, project, target, `profile-${id}`, version, actor]);
  await db.query(`INSERT INTO app.map_render_profile_versions
    (id,organization_id,profile_id,resource_id,resource_version_id,dataset_id,dataset_version_id,
     style_id,style_version_id,version_number,title,configuration,checksum_sha256,created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,'Saved pass','{}',$10,$11)`,
  [version, org, id, target, targetVersion, input.dataset, input.version, style, styleVersion, digest, actor]);
  return {id, version, resource: target};
}

async function job(profiles, {binding = true, sealed = false, idempotencyKey = randomUUID()} = {}) {
  const id = randomUUID(), anchor = profiles[0];
  await db.query(`INSERT INTO app.map_render_jobs
    (id,organization_id,project_id,resource_id,profile_id,profile_version_id,idempotency_key,
     bbox,width,height,format,request_checksum_sha256,composition_sealed,created_by,request_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'[-1,-1,1,1]',256,256,'png',$8,$9,$10,'saved-map-test')`,
  [id, org, project, anchor.resource, anchor.id, anchor.version, idempotencyKey, digest, sealed, actor]);
  if (binding) await db.query(`INSERT INTO app.map_render_job_bindings
    (organization_id,render_job_id,resource_id,resource_version_id,recipe,recipe_checksum_sha256,definition_checksum_sha256)
    VALUES ($1,$2,$3,$4,'{"schemaVersion":"saved-map-test"}',$5,$6)`,
  [org, id, resource, resourceVersion, recipeDigest, digest]);
  for (let index = 1; index < profiles.length; index++) await db.query(`INSERT INTO app.map_render_job_layers
    (organization_id,render_job_id,position,resource_id,profile_id,profile_version_id) VALUES ($1,$2,$3,$4,$5,$6)`,
  [org, id, index + 1, profiles[index].resource, profiles[index].id, profiles[index].version]);
  return id;
}

async function pin(id, position, input, overrides = {}) {
  const p = {sourceResource: input.sourceResource, sourceVersion: input.sourceVersion,
    dataset: input.dataset, version: input.version, object: input.preview,
    storageVersion: "preview-v1", checksum: digest, ...overrides};
  return db.query(`INSERT INTO app.map_render_job_source_pins
    (organization_id,render_job_id,position,source_resource_id,source_resource_version_id,dataset_id,
     dataset_version_id,source_object_id,source_s3_version_id,source_checksum_sha256)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
  [org, id, position, p.sourceResource, p.sourceVersion, p.dataset, p.version, p.object, p.storageVersion, p.checksum]);
}

async function seal(id) {
  return (await db.query("SELECT app.seal_map_render_composition($1) AS sealed", [id])).rows[0].sealed;
}

async function reusableStyle({corruptBytes = false} = {}) {
  const input = {...sources[0], styleResource: randomUUID()}, style = randomUUID(), version = randomUUID();
  const definition = '{"version":8,"sources":{},"layers":[]}';
  const checksum = createHash("sha256").update(definition).digest("hex");
  await db.exec("SET LOCAL ROLE NONE");
  await db.query(`INSERT INTO app.organization_memberships (organization_id,user_id,role)
    VALUES ($1,$2,'member')`, [org, actor]);
  const styleResourceVersion = randomUUID();
  await db.query(`INSERT INTO app.governed_resources
    (id,organization_id,project_id,kind,slug,dataset_id,current_version_id,owner_user_id,created_by,updated_by)
    VALUES ($1,$2,$3,'dataset','shared-style-source',$4,$5,$6,$6,$6)`,
  [input.styleResource, org, project, input.dataset, styleResourceVersion, otherActor]);
  await db.query(`INSERT INTO app.governed_resource_versions
    (id,organization_id,resource_id,version_number,title,created_by) VALUES ($1,$2,$3,1,'Style Layer',$4)`,
  [styleResourceVersion, org, input.styleResource, otherActor]);
  await db.query(`INSERT INTO app.governed_resource_permissions (organization_id,resource_id,user_id,role,granted_by)
    VALUES ($1,$2,$3,'view',$3)`, [org, input.styleResource, actor]);
  await db.query(`INSERT INTO app.governed_resource_styles
    (id,organization_id,project_id,resource_id,slug,format,current_version_id,created_by,updated_by)
    VALUES ($1,$2,$3,$4,'reusable-style','maplibre',$5,$6,$6)`,
  [style, org, project, input.styleResource, version, actor]);
  await db.query(`INSERT INTO app.governed_resource_style_versions
    (id,organization_id,style_id,version_number,title,media_type,definition,checksum_sha256,created_by)
    VALUES ($1,$2,$3,1,'Original shared style','application/json',$4,$5,$6)`,
  [version, org, style, corruptBytes ? `${definition}\n` : definition, checksum, actor]);
  resourceVersion = randomUUID();
  const reference = {projectId: project, resourceId: input.styleResource, styleId: style,
    versionNumber: 1, checksumSha256: checksum, format: "maplibre"};
  await db.query(`INSERT INTO app.map_versions (organization_id,map_id,version,definition,created_by)
    VALUES ($1,$2,2,$3,$4)`, [org, map, {layers: [{layerId: "shared", datasetId: input.dataset, styleReference: reference}]}, actor]);
  await db.query(`INSERT INTO app.governed_resource_versions
    (id,organization_id,resource_id,version_number,title,created_by) VALUES ($1,$2,$3,2,'Shared Style map',$4)`,
  [resourceVersion, org, resource, actor]);
  await db.query("UPDATE app.governed_resources SET current_version_id=$1 WHERE id=$2", [resourceVersion, resource]);
  await db.query("UPDATE app.maps SET version=2 WHERE id=$1", [map]);
  assert.equal((await db.query("SELECT app.bind_map_resource_version($1,$2,2) AS ok", [resource, resourceVersion])).rows[0].ok, true);
  assert.equal((await db.query("SELECT map_version FROM app.map_resource_version_bindings WHERE resource_version_id=$1", [resourceVersion])).rows[0].map_version, 2);
  await db.exec("SET LOCAL ROLE opengeo_runtime");
  return {input, style, version, checksum};
}

async function revokeStyle(input) {
  await db.exec("SET LOCAL ROLE NONE");
  await db.query("DELETE FROM app.governed_resource_permissions WHERE resource_id=$1 AND user_id=$2", [input.styleResource, actor]);
  await db.exec("SET LOCAL ROLE opengeo_runtime");
}

function artifactFor(id, claim) {
  return {id: randomUUID(), role: "derived", bucket: claim.source_bucket,
    object_key: `${claim.output_prefix}renders/${id}.png`, s3_version_id: "render-v1",
    etag: "render-etag", content_type: "image/png", size_bytes: 512, checksum_sha256: digest};
}

async function worker(operation) {
  await db.exec("SET LOCAL ROLE opengeo_worker");
  try { return await operation(); }
  finally { await db.exec("SET LOCAL ROLE opengeo_runtime"); }
}

async function rejects(operation, pattern = /permission denied/, privileged = false) {
  await db.exec("SAVEPOINT rejected");
  try {
    if (privileged) await db.exec("SET LOCAL ROLE NONE");
    await assert.rejects(operation(), pattern);
  } finally {
    await db.exec("ROLLBACK TO SAVEPOINT rejected; RELEASE SAVEPOINT rejected");
  }
}

function sourceRevocations(input) {
  return [
    async () => {
      for (const state of ["review", "published", "archived"]) {
        await db.query("UPDATE app.governed_resources SET state=$1 WHERE id=$2", [state, input.sourceResource]);
      }
    },
    () => db.query("UPDATE app.datasets SET status='archived' WHERE id=$1", [input.dataset]),
    () => db.query("UPDATE app.dataset_versions SET state='failed' WHERE id=$1", [input.version]),
  ];
}

describe("0085 exact saved-map render jobs", () => {
  before(async () => {
    db = new PGlite();
    // Same nonparticipating role setup as the existing team-project runner.
    await db.exec("CREATE ROLE opengeo_connector; CREATE ROLE opengeo_observable_coordinator;");
    for (const file of [
      "0001_platform_foundation.sql", "0002_membership_invitations.sql",
      "0003_managed_ingestion_foundation.sql", "0004_worker_execution_boundary.sql",
      "0005_catalog_access.sql", "0006_governed_external_sources.sql",
      "0007_governed_pmtiles_sources.sql", "0008_recoverable_project_imports.sql",
      "0009_governed_resources.sql", "0010_resource_governance.sql",
      "0011_governed_rendering.sql", "0012_raster_reprojection.sql",
      "0013_wms_basic_presentation.sql", "0014_ordered_map_compositions.sql",
      "0050_team_project_access.sql", "0070_repeated_map_composition_layers.sql", "0084_map_resource_version_bindings.sql",
      "0085_saved_map_render_jobs.sql", "0107_project_artifacts.sql", "0108_saved_map_render_reuse.sql", "0109_portable_project_artifacts.sql", "0110_portable_artifact_upload_intents.sql", "0111_portable_cleanup_receipts.sql", "0152_saved_map_style_worker_access.sql"
    ]) {
      const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8");
      await db.exec(sql.replace(/^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm, ""));
    }
    await db.exec(`
      INSERT INTO app.users (id,cognito_subject,email,display_name) VALUES
        ('${actor}','saved-map-render','render@local.invalid','Render owner'),
        ('${otherActor}','saved-map-other','other@local.invalid','Other actor');
      INSERT INTO app.organizations (id,name,slug,created_by) VALUES
        ('${org}','Saved map render','saved-map-render','${actor}'),
        ('${otherOrg}','Other render','other-render','${actor}');
      INSERT INTO app.projects (id,organization_id,name,created_by) VALUES
        ('${project}','${org}','Saved map project','${actor}'),
        ('${otherProject}','${org}','Other map project','${actor}');
    `);
  });
  beforeEach(async () => {
    await db.exec("BEGIN");
    await db.query("SELECT set_config('app.organization_id',$1,true),set_config('app.user_id',$2,true)", [org, actor]);
    sequence = 0; map = randomUUID(); resource = randomUUID(); resourceVersion = randomUUID();
    sources = [await source(), await source()];
    await db.query(`INSERT INTO app.maps (id,organization_id,project_id,name,created_by,updated_by)
      VALUES ($1,$2,$3,'Saved map',$4,$4)`, [map, org, project, actor]);
    await db.query(`INSERT INTO app.map_versions (organization_id,map_id,version,definition,created_by)
      VALUES ($1,$2,1,'{"layers":[]}',$3)`, [org, map, actor]);
    await db.query(`INSERT INTO app.governed_resources
      (id,organization_id,project_id,kind,slug,map_id,current_version_id,owner_user_id,created_by,updated_by)
      VALUES ($1,$2,$3,'map','saved-map',$4,$5,$6,$6,$6)`, [resource, org, project, map, resourceVersion, actor]);
    await db.query(`INSERT INTO app.governed_resource_versions
      (id,organization_id,resource_id,version_number,title,created_by) VALUES ($1,$2,$3,1,'Saved map',$4)`,
    [resourceVersion, org, resource, actor]);
    await db.query("SELECT app.bind_map_resource_version($1,$2)", [resource, resourceVersion]);
    await db.exec("SET LOCAL ROLE opengeo_runtime");
  });
  afterEach(async () => { await db.exec("ROLLBACK; RESET ROLE"); });
  after(async () => { await db.close(); });

  it("cancels queued renders after original reusable Style access is revoked", async () => {
    const {input} = await reusableStyle();
    const id = await job([await profile(input)]);
    await pin(id, 1, input); await seal(id);
    await revokeStyle(input);
    const claim = (await worker(() => db.query("SELECT * FROM app.claim_map_render($1,$2,900)", [id, randomUUID()]))).rows[0];
    assert.equal(claim.claim_status, "already_cancelled");
    const stored = (await db.query("SELECT state::text,error_code,worker_token,output_object_id FROM app.map_render_jobs WHERE id=$1", [id])).rows[0];
    assert.deepEqual(stored, {state: "cancelled", error_code: "saved_map_style_unavailable", worker_token: null, output_object_id: null});
  });

  it("keeps the original Style pin after a newer version and checks the job actor without worker tenant settings", async () => {
    const {input, style} = await reusableStyle();
    const id = await job([await profile(input)]);
    await pin(id, 1, input); await seal(id);
    const next = randomUUID(), definition = '{"version":8,"sources":{},"layers":[],"name":"Newer"}';
    await db.query(`INSERT INTO app.governed_resource_style_versions
      (id,organization_id,style_id,version_number,title,media_type,definition,checksum_sha256,created_by)
      VALUES ($1,$2,$3,2,'Newer shared Style','application/json',$4,$5,$6)`,
    [next, org, style, definition, createHash("sha256").update(definition).digest("hex"), actor]);
    await db.query("UPDATE app.governed_resource_styles SET current_version_id=$1 WHERE id=$2", [next, style]);
    const token = randomUUID();
    await db.query("SELECT set_config('app.organization_id','',true),set_config('app.user_id','',true)");
    const claim = (await worker(() => db.query("SELECT * FROM app.claim_map_render($1,$2,900)", [id, token]))).rows[0];
    assert.equal(claim.claim_status, "claimed");
    assert.equal((await worker(() => db.query("SELECT app.heartbeat_map_render($1,$2,900) AS ok", [id, token]))).rows[0].ok, true);
    assert.equal((await worker(() => db.query("SELECT app.complete_map_render($1,$2,$3) AS ok", [id, token, artifactFor(id, claim)]))).rows[0].ok, true);
  });

  it("denies layer reads and cancels the matching running lease when original Style access is revoked", async () => {
    const {input} = await reusableStyle();
    const id = await job([await profile(input)]);
    await pin(id, 1, input); await seal(id);
    const token = randomUUID();
    assert.equal((await worker(() => db.query("SELECT * FROM app.claim_map_render($1,$2,900)", [id, token]))).rows[0].claim_status, "claimed");
    await revokeStyle(input);
    assert.deepEqual((await worker(() => db.query("SELECT * FROM app.get_map_render_layers($1,$2)", [id, token]))).rows, []);
    assert.equal((await worker(() => db.query("SELECT app.heartbeat_map_render($1,$2,900) AS ok", [id, randomUUID()]))).rows[0].ok, false);
    assert.equal((await db.query("SELECT state::text FROM app.map_render_jobs WHERE id=$1", [id])).rows[0].state, "running");
    assert.equal((await worker(() => db.query("SELECT app.heartbeat_map_render($1,$2,900) AS ok", [id, token]))).rows[0].ok, false);
    assert.equal((await db.query("SELECT state::text FROM app.map_render_jobs WHERE id=$1", [id])).rows[0].state, "cancelled");
  });

  it("cancels completion before recording an output after team-derived Style access ends", async () => {
    const {input} = await reusableStyle();
    await revokeStyle(input);
    const team = randomUUID();
    await db.query(`INSERT INTO app.teams (id,organization_id,name,created_by) VALUES ($1,$2,'Style readers',$3)`, [team, org, actor]);
    await db.query(`INSERT INTO app.team_memberships (organization_id,team_id,user_id,role,created_by)
      VALUES ($1,$2,$3,'member',$3)`, [org, team, actor]);
    await db.query(`INSERT INTO app.project_team_grants (organization_id,project_id,team_id,role,created_by)
      VALUES ($1,$2,$3,'viewer',$4)`, [org, project, team, actor]);
    const id = await job([await profile(input)]);
    await pin(id, 1, input); await seal(id);
    const token = randomUUID();
    const claim = (await worker(() => db.query("SELECT * FROM app.claim_map_render($1,$2,900)", [id, token]))).rows[0];
    assert.equal(claim.claim_status, "claimed");
    await db.query("UPDATE app.teams SET status='archived' WHERE id=$1", [team]);
    const artifact = artifactFor(id, claim);
    assert.equal((await worker(() => db.query("SELECT app.complete_map_render($1,$2,$3) AS ok", [id, token, artifact]))).rows[0].ok, false);
    assert.deepEqual((await db.query("SELECT id FROM app.data_objects WHERE id=$1", [artifact.id])).rows, []);
    assert.equal((await db.query("SELECT state::text FROM app.map_render_jobs WHERE id=$1", [id])).rows[0].state, "cancelled");
  });

  it("keeps original Style helpers unavailable to application and worker roles", async () => {
    await rejects(() => db.query("SELECT app.map_render_job_styles_available($1)", [randomUUID()]));
    await db.exec("SET LOCAL ROLE opengeo_worker");
    await rejects(() => db.query("SELECT app.cancel_map_render_for_unavailable_style($1)", [randomUUID()]));
    await db.exec("SET LOCAL ROLE opengeo_runtime");
  });

  it("refuses sealing when retained original Style bytes do not match the pinned checksum", async () => {
    const {input} = await reusableStyle({corruptBytes: true});
    const id = await job([await profile(input)]);
    await pin(id, 1, input);
    await rejects(() => seal(id), /saved map render sources are incomplete/);
    assert.equal((await worker(() => db.query("SELECT * FROM app.claim_map_render($1,$2,900)", [id, randomUUID()]))).rows[0].claim_status, "not_ready");
  });

  it("seals and completes one map-owned pass using exactly the pinned source and bucket", async () => {
    const id = await job([await profile(sources[0])]);
    await pin(id, 1, sources[0]);
    assert.equal(await seal(id), true);
    const token = randomUUID();
    const claim = (await worker(() => db.query("SELECT * FROM app.claim_map_render($1,$2,900)", [id, token]))).rows[0];
    assert.equal(claim.claim_status, "claimed");
    assert.equal(claim.resource_id, resource);
    assert.equal(claim.source_object_id, sources[0].preview);
    assert.equal(claim.source_bucket, "pinned-preview.invalid");
    const layers = (await worker(() => db.query("SELECT * FROM app.get_map_render_layers($1,$2)", [id, token]))).rows;
    assert.equal(layers.length, 1);
    assert.equal(layers[0].source_object_id, claim.source_object_id);
    assert.equal(layers[0].source_checksum_sha256, claim.source_checksum_sha256);
    const artifact = artifactFor(id, claim);
    const completed = await worker(() => db.query("SELECT app.complete_map_render($1,$2,$3) AS completed", [id, token, artifact]));
    assert.equal(completed.rows[0].completed, true);
    const stored = (await db.query("SELECT resource_id,output_object_id FROM app.map_render_jobs WHERE id=$1", [id])).rows[0];
    assert.deepEqual(stored, {resource_id: resource, output_object_id: artifact.id});
    assert.deepEqual((await db.query("SELECT * FROM app.dataset_version_objects WHERE data_object_id=$1", [artifact.id])).rows, []);
    await db.exec("SET LOCAL ROLE NONE");
    assert.equal((await db.query("SELECT app.render_cache_output_is_referenced($1,$2,$3) AS retained", [org, id, artifact.id])).rows[0].retained, true);
    await db.exec("SET LOCAL ROLE opengeo_runtime");
  });

  it("retains immutable Artifact editions and constrains the current pointer within its tenant and identity", async () => {
    const profiles = [await profile(sources[0])];
    const id = await job(profiles);
    await pin(id, 1, sources[0]); await seal(id);
    const token = randomUUID();
    const claim = (await worker(() => db.query("SELECT * FROM app.claim_map_render($1,$2,900)", [id, token]))).rows[0];
    await worker(() => db.query("SELECT app.complete_map_render($1,$2,$3)", [id, token, artifactFor(id, claim)]));
    const retryKey = randomUUID();
    await db.query(`INSERT INTO app.saved_map_render_reuse
      (organization_id,idempotency_key,render_job_id,created_by) VALUES ($1,$2,$3,$4)`,
      [org, retryKey, id, actor]);
    await rejects(() => job(profiles, {idempotencyKey: retryKey}), /already retained/);
    const queued = await job(profiles);
    await rejects(() => db.query(`INSERT INTO app.saved_map_render_reuse
      (organization_id,idempotency_key,render_job_id,created_by) VALUES ($1,$2,$3,$4)`,
      [org, randomUUID(), queued, actor]), /only completed/);
    const originalKey = (await db.query("SELECT idempotency_key FROM app.map_render_jobs WHERE id=$1", [id])).rows[0].idempotency_key;
    await rejects(() => db.query(`INSERT INTO app.saved_map_render_reuse
      (organization_id,idempotency_key,render_job_id,created_by) VALUES ($1,$2,$3,$4)`,
      [org, originalKey, id, actor]), /already used/);
    await rejects(() => db.query("DELETE FROM app.saved_map_render_reuse WHERE idempotency_key=$1", [retryKey]));
    await rejects(() => db.query("UPDATE app.saved_map_render_reuse SET render_job_id=$1 WHERE idempotency_key=$2", [id, retryKey]), /immutable/, true);
    const artifact = randomUUID();
    await db.query(`INSERT INTO app.project_artifacts
      (organization_id,id,resource_id,map_id,representation,created_by)
      VALUES ($1,$2,$3,$4,'saved-map-image',$5)`, [org, artifact, resource, map, actor]);
    const manifest = {schemaVersion: "opengeo.project-artifact.1.0.0", artifactId: id,
      project: {id: map}, manifestChecksumSha256: digest};
    await db.query(`INSERT INTO app.project_artifact_versions
      (organization_id,artifact_id,version_number,render_job_id,manifest,manifest_checksum_sha256,created_by)
      VALUES ($1,$2,1,$3,$4,$5,$6)`, [org, artifact, id, manifest, digest, actor]);
    const head = () => db.query("SELECT revision,current_version_number FROM app.project_artifacts WHERE id=$1", [artifact]);
    assert.deepEqual((await head()).rows[0], {revision: 0, current_version_number: null});
    await rejects(() => db.query("UPDATE app.project_artifacts SET current_version_number=2 WHERE id=$1", [artifact]), /foreign key/);
    await db.query("UPDATE app.project_artifacts SET current_version_number=1,revision=1 WHERE id=$1", [artifact]);
    assert.deepEqual((await head()).rows[0], {revision: 1, current_version_number: 1});
    await rejects(() => db.query("DELETE FROM app.project_artifact_versions WHERE artifact_id=$1", [artifact]));
    await rejects(() => db.query("UPDATE app.project_artifact_versions SET version_number=2 WHERE artifact_id=$1", [artifact]), /immutable/, true);
    await rejects(() => db.query("UPDATE app.project_artifacts SET map_id=$1 WHERE id=$2", [randomUUID(), artifact]));
    await db.query("SELECT set_config('app.organization_id',$1,true)", [otherOrg]);
    assert.deepEqual((await head()).rows, []);
    assert.deepEqual((await db.query("SELECT * FROM app.project_artifact_versions")).rows, []);
  });

  it("retains portable output independently of datasets with immutable exact-version bindings", async () => {
    const artifact = randomUUID(), output = randomUUID();
    await db.query(`INSERT INTO app.project_artifacts
      (organization_id,id,resource_id,map_id,representation,created_by)
      VALUES ($1,$2,$3,$4,'portable-map-html',$5)`, [org,artifact,resource,map,actor]);
    await db.query(`INSERT INTO app.project_artifact_objects
      (organization_id,artifact_id,id,bucket,object_key,s3_version_id,etag,content_type,size_bytes,checksum_sha256,created_by)
      VALUES ($1,$2,$3,'local.invalid','portable/map.html','v1','etag','text/html',123,$4,$5)`,
      [org,artifact,output,digest,actor]);
    const manifest = {schemaVersion:'opengeo.project-artifact.1.0.0',representation:'portable-map-html',
      canonicalization:'opengeo-codepoint-decimal-v1',artifactId:'sha256:'+digest,project:null,
      build:{inputScope:'reviewed-browser-snapshot'},
      provenance:{originatingProject:{id:map,version:1},authoritativeBuild:false},
      output:{checksumSha256:digest,sizeBytes:123,mediaType:'text/html'},manifestChecksumSha256:digest};
    const insert = (document=manifest,version=1) => db.query(`INSERT INTO app.project_artifact_versions
      (organization_id,artifact_id,version_number,portable_object_id,origin_map_id,origin_map_version,
       manifest,manifest_checksum_sha256,created_by) VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8)`,
      [org,artifact,output,map,version,document,digest,actor]);
    await rejects(()=>insert({...manifest,output:{...manifest.output,sizeBytes:124}}),/portable edition/);
    await rejects(()=>insert(manifest,null),/portable edition|check constraint/);
    await rejects(()=>insert({...manifest,provenance:{...manifest.provenance,originatingProject:{id:map,version:2}}},2),/foreign key/);
    await insert();
    const upload = randomUUID();
    await db.query(`INSERT INTO app.project_artifact_upload_intents
      (organization_id,artifact_id,id,manifest,expected_revision,expected_size_bytes,expected_sha256,
       bucket,object_key,created_by,expires_at)
      VALUES ($1,$2,$3,$4,0,123,$5,'local.invalid','portable/map.html',$6,clock_timestamp()+interval '10 minutes')`,
      [org,artifact,upload,manifest,digest,actor]);
    await rejects(()=>db.query('UPDATE app.project_artifact_upload_intents SET expected_size_bytes=124 WHERE id=$1',[upload]));
    await rejects(()=>db.query('UPDATE app.project_artifact_upload_intents SET completed_object_id=$1,completed_at=clock_timestamp() WHERE id=$2',[randomUUID(),upload]),/does not match/);
    await db.query('UPDATE app.project_artifact_upload_intents SET completed_object_id=$1,completed_at=clock_timestamp() WHERE id=$2',[output,upload]);
    await rejects(()=>db.query('UPDATE app.project_artifact_upload_intents SET completed_at=clock_timestamp() WHERE id=$1',[upload]),/does not match/);
    const attempt = randomUUID();
    await db.query(`INSERT INTO app.project_artifact_cleanup_attempts
      (organization_id,id,upload_id,created_by) VALUES ($1,$2,$3,$4)`,[org,attempt,upload,actor]);
    await db.query(`UPDATE app.project_artifact_cleanup_attempts SET state='failed',deleted_versions=1,
      error_code='storage_delete_unconfirmed',finished_at=clock_timestamp() WHERE id=$1`,[attempt]);
    await rejects(()=>db.query("UPDATE app.project_artifact_cleanup_attempts SET deleted_versions=2 WHERE id=$1",[attempt]),/cannot be changed/);
    await rejects(()=>db.query("DELETE FROM app.project_artifact_cleanup_attempts WHERE id=$1",[attempt]));
    await db.query('UPDATE app.project_artifacts SET current_version_number=1 WHERE id=$1',[artifact]);
    await rejects(()=>db.query('UPDATE app.project_artifact_objects SET size_bytes=124 WHERE id=$1',[output]));
    await rejects(()=>db.query('DELETE FROM app.project_artifact_objects WHERE id=$1',[output]),/immutable/,true);
    await db.exec('SET LOCAL ROLE opengeo_worker');
    await rejects(()=>db.query('SELECT * FROM app.project_artifact_objects'));
    await db.exec('SET LOCAL ROLE opengeo_runtime');
    await db.query("SELECT set_config('app.organization_id',$1,true)",[otherOrg]);
    assert.deepEqual((await db.query('SELECT * FROM app.project_artifact_objects')).rows,[]);
    assert.deepEqual((await db.query('SELECT * FROM app.project_artifact_versions')).rows,[]);
  });

  it("keeps per-position object pins when a smaller preview identity appears after sealing", async () => {
    const profiles = [await profile(sources[0]), await profile(sources[1])];
    const id = await job(profiles);
    await pin(id, 1, sources[0]); await pin(id, 2, sources[1]);
    assert.equal(await seal(id), true);
    await db.exec("SET LOCAL ROLE NONE");
    const earlier = "00000000-0000-4000-8000-000000000085";
    await db.query(`INSERT INTO app.data_objects
      (id,organization_id,dataset_id,role,bucket,object_key,s3_version_id,etag,content_type,size_bytes,checksum_sha256,created_by)
      VALUES ($1,$2,$3,'derived','later-preview.invalid',$4,'later-v2','later-etag','application/geo+json',128,$5,$6)`,
    [earlier, org, sources[0].dataset, "later/derivatives/preview/preview.geojson", recipeDigest, actor]);
    await db.query(`INSERT INTO app.dataset_version_objects
      (organization_id,dataset_id,dataset_version_id,data_object_id) VALUES ($1,$2,$3,$4)`,
    [org, sources[0].dataset, sources[0].version, earlier]);
    await db.exec("SET LOCAL ROLE opengeo_runtime");
    const token = randomUUID();
    const claimed = (await worker(() => db.query("SELECT * FROM app.claim_map_render($1,$2,900)", [id, token]))).rows[0];
    assert.equal(claimed.source_object_id, sources[0].preview);
    const layers = (await worker(() => db.query("SELECT * FROM app.get_map_render_layers($1,$2)", [id, token]))).rows;
    assert.deepEqual(layers.map(row => row.source_object_id), sources.map(item => item.preview));
    assert.deepEqual(layers.map(row => row.layer_position), [1, 2]);
  });

  it("does not expose a composed private source through the public anchor dataset inventory", async () => {
    await db.exec("SET LOCAL ROLE NONE");
    await db.query("UPDATE app.datasets SET classification='public' WHERE id=$1", [sources[0].dataset]);
    await db.query("UPDATE app.datasets SET classification='restricted' WHERE id=$1", [sources[1].dataset]);
    await db.exec("SET LOCAL ROLE opengeo_runtime");
    const id = await job([await profile(sources[0]), await profile(sources[1])]), token = randomUUID();
    await pin(id, 1, sources[0]); await pin(id, 2, sources[1]); await seal(id);
    const claim = (await worker(() => db.query("SELECT * FROM app.claim_map_render($1,$2,900)", [id, token]))).rows[0];
    assert.equal(claim.claim_status, "claimed");
    const artifact = artifactFor(id, claim);
    assert.equal((await worker(() => db.query("SELECT app.complete_map_render($1,$2,$3) AS completed", [id, token, artifact]))).rows[0].completed, true);
    const output = (await db.query(`SELECT object.id FROM app.map_render_jobs job
      JOIN app.data_objects object ON object.organization_id=job.organization_id AND object.id=job.output_object_id
      WHERE job.id=$1 AND job.resource_id=$2`, [id, resource])).rows;
    assert.deepEqual(output, [{id: artifact.id}]);
    // Both dataset downloads and generic site asset selection require this link.
    assert.deepEqual((await db.query(`SELECT object.id FROM app.data_objects object
      JOIN app.dataset_version_objects link ON link.organization_id=object.organization_id
        AND link.dataset_id=object.dataset_id AND link.data_object_id=object.id
      WHERE object.id=$1`, [artifact.id])).rows, []);
  });

  it("refuses missing bindings, incomplete source sets and wrong-lease reads", async () => {
    const lone = await job([await profile(sources[0])], {binding: false, sealed: true});
    assert.equal((await worker(() => db.query("SELECT claim_status FROM app.claim_map_render($1,$2,900)", [lone, randomUUID()]))).rows[0].claim_status, "not_ready");
    const id = await job([await profile(sources[0]), await profile(sources[1])]);
    await pin(id, 1, sources[0]);
    await rejects(() => seal(id), /sources are incomplete/);
    assert.equal((await worker(() => db.query("SELECT claim_status FROM app.claim_map_render($1,$2,900)", [id, randomUUID()]))).rows[0].claim_status, "not_ready");
    await pin(id, 2, sources[1]); await seal(id);
    const token = randomUUID();
    await worker(() => db.query("SELECT * FROM app.claim_map_render($1,$2,900)", [id, token]));
    assert.deepEqual((await worker(() => db.query("SELECT * FROM app.get_map_render_layers($1,$2)", [id, randomUUID()]))).rows, []);
  });

  it("rejects forged object, checksum, provider, canonical-resource and dataset identities", async () => {
    const id = await job([await profile(sources[0])]);
    for (const override of [{object: sources[0].original}, {checksum: recipeDigest},
      {storageVersion: "wrong-v1"}, {sourceResource: sources[1].sourceResource},
      {sourceVersion: sources[1].sourceVersion}, {dataset: sources[1].dataset}]) {
      await rejects(() => pin(id, 1, sources[0], override), /source pin/);
    }
    await db.query("SELECT set_config('app.user_id',$1,true)", [otherActor]);
    await rejects(() => pin(id, 1, sources[0]), /source pin/);
  });

  it("requires a bound map profile and forbids late pins or mutable bindings", async () => {
    const legacy = await profile(sources[0], sources[0].sourceResource, sources[0].sourceVersion);
    await rejects(() => job([legacy]), /saved map render binding/);
    const id = await job([await profile(sources[0])]);
    await pin(id, 1, sources[0]); await seal(id);
    await rejects(() => pin(id, 1, sources[0]), /source pin/);
    for (const table of ["map_render_job_bindings", "map_render_job_source_pins"]) {
      await rejects(() => db.query(`DELETE FROM app.${table}`));
      await rejects(() => db.query(`UPDATE app.${table} SET render_job_id=render_job_id`));
      await rejects(() => db.query(`DELETE FROM app.${table}`), /history is immutable/, true);
    }
    await rejects(() => db.query("UPDATE app.map_render_jobs SET composition_sealed=false WHERE id=$1", [id]), /cannot be reopened/, true);
  });

  it("rejects pins for archived or inactive canonical sources", async () => {
    const id = await job([await profile(sources[0])]);
    for (const revoke of sourceRevocations(sources[0])) {
      await db.exec("SAVEPOINT revoke_source; SET LOCAL ROLE NONE");
      await revoke();
      await db.exec("SET LOCAL ROLE opengeo_runtime");
      await rejects(() => pin(id, 1, sources[0]), /canonical dataset preview/);
      await db.exec("ROLLBACK TO SAVEPOINT revoke_source; RELEASE SAVEPOINT revoke_source");
    }
    await pin(id, 1, sources[0]);
    assert.equal(await seal(id), true);
  });

  it("stops claim, layer reads and completion when any sealed source is revoked", async () => {
    const profiles = [await profile(sources[0]), await profile(sources[1])];
    const queued = await job(profiles), running = await job(profiles), token = randomUUID();
    for (const id of [queued, running]) {
      await pin(id, 1, sources[0]); await pin(id, 2, sources[1]);
      assert.equal(await seal(id), true);
    }
    await rejects(() => db.query("DELETE FROM app.project_datasets WHERE project_id=$1 AND dataset_id=$2", [project, sources[1].dataset]), /foreign key constraint/, true);
    assert.equal((await worker(() => db.query("SELECT claim_status FROM app.claim_map_render($1,$2,900)", [running, token]))).rows[0].claim_status, "claimed");
    for (const revoke of sourceRevocations(sources[1])) {
      await db.exec("SAVEPOINT revoke_source; SET LOCAL ROLE NONE");
      await revoke();
      await db.exec("SET LOCAL ROLE opengeo_runtime");
      assert.equal((await worker(() => db.query("SELECT claim_status FROM app.claim_map_render($1,$2,900)", [queued, randomUUID()]))).rows[0].claim_status, "not_ready");
      assert.deepEqual((await worker(() => db.query("SELECT * FROM app.get_map_render_layers($1,$2)", [running, token]))).rows, []);
      assert.equal((await worker(() => db.query("SELECT app.complete_map_render($1,$2,'{}') AS completed", [running, token]))).rows[0].completed, false);
      await db.exec("ROLLBACK TO SAVEPOINT revoke_source; RELEASE SAVEPOINT revoke_source");
    }
    assert.equal((await worker(() => db.query("SELECT claim_status FROM app.claim_map_render($1,$2,900)", [queued, randomUUID()]))).rows[0].claim_status, "claimed");
  });

  it("keeps bindings tenant-private and worker access restricted to lease functions", async () => {
    const id = await job([await profile(sources[0])]);
    await pin(id, 1, sources[0]);
    await db.query("SELECT set_config('app.organization_id',$1,true)", [otherOrg]);
    assert.deepEqual((await db.query("SELECT * FROM app.map_render_job_bindings")).rows, []);
    assert.deepEqual((await db.query("SELECT * FROM app.map_render_job_source_pins")).rows, []);
    await rejects(() => pin(id, 1, sources[0]), /source pin/);
    await db.query("SELECT set_config('app.organization_id',$1,true)", [org]);
    await worker(async () => {
      await rejects(() => db.query("SELECT * FROM app.map_render_job_bindings"));
      await rejects(() => db.query("SELECT * FROM app.map_render_job_source_pins"));
      await rejects(() => db.query("SELECT * FROM app.resolve_map_render_job_source($1,1::smallint)", [id]));
    });
  });

  it("retains ordinary dataset renders and their existing two-layer sealing rule", async () => {
    const legacy = await profile(sources[0], sources[0].sourceResource, sources[0].sourceVersion);
    const id = await job([legacy], {binding: false, sealed: true});
    const token = randomUUID();
    const claimed = (await worker(() => db.query("SELECT * FROM app.claim_map_render($1,$2,900)", [id, token]))).rows[0];
    assert.equal(claimed.claim_status, "claimed");
    assert.equal(claimed.resource_id, sources[0].sourceResource);
    const artifact = artifactFor(id, claimed);
    assert.equal((await worker(() => db.query("SELECT app.complete_map_render($1,$2,$3) AS completed", [id, token, artifact]))).rows[0].completed, true);
    assert.deepEqual((await db.query(`SELECT dataset_id,dataset_version_id FROM app.dataset_version_objects
      WHERE data_object_id=$1`, [artifact.id])).rows,
    [{dataset_id: sources[0].dataset, dataset_version_id: sources[0].version}]);
    const open = await job([legacy], {binding: false});
    await rejects(() => seal(open), /composition is incomplete/);
  });
});

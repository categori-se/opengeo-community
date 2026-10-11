import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, describe, it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

const IDS = {
  organization: "10000000-0000-4000-8000-000000000067",
  otherOrganization: "10000000-0000-4000-8000-000000000168",
  owner: "20000000-0000-4000-8000-000000000067",
  viewer: "20000000-0000-4000-8000-000000000068",
  otherOwner: "20000000-0000-4000-8000-000000000168",
  project: "50000000-0000-4000-8000-000000000067",
  secondProject: "50000000-0000-4000-8000-000000000068",
  otherProject: "50000000-0000-4000-8000-000000000168",
  source: "60000000-0000-4000-8000-000000000067",
  secondSource: "60000000-0000-4000-8000-000000000068",
  firstJob: "70000000-0000-4000-8000-000000000067",
  unchangedJob: "70000000-0000-4000-8000-000000000068",
  changedJob: "70000000-0000-4000-8000-000000000069",
  emptyJob: "70000000-0000-4000-8000-000000000070",
  invalidSnapshotJob: "70000000-0000-4000-8000-000000000075",
  collisionJob: "70000000-0000-4000-8000-000000000071",
  localCollisionJob: "70000000-0000-4000-8000-000000000072",
  cancelJob: "70000000-0000-4000-8000-000000000073",
  disableJob: "70000000-0000-4000-8000-000000000074",
  token: "80000000-0000-4000-8000-000000000067",
  otherToken: "80000000-0000-4000-8000-000000000068",
  governedResource: "90000000-0000-4000-8000-000000000067",
  governedVersion: "91000000-0000-4000-8000-000000000067"
};

const ZERO_SHA = "0".repeat(64);
const ROAD_ID = "11111111-1111-4111-8111-111111111111";
const STORY_ID = "22222222-2222-4222-8222-222222222222";
const LOCAL_ID = "33333333-3333-4333-8333-333333333333";
const SOURCE_URL = "https://catalog.example.test/geonode";
const SECOND_SOURCE_URL = "https://second.example.test/geonode";
const GEONODE_COMMIT = "a1db97e81dfc26c16bb4ee1a5d2b408877af66c9";

let db;

async function load(name) {
  return readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
}

async function inTenant(organizationId, userId, operation) {
  await db.exec("BEGIN");
  try {
    await db.exec("SET LOCAL ROLE opengeo_runtime");
    await db.query("SELECT set_config('app.organization_id', $1, true)", [organizationId]);
    await db.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const result = await operation();
    await db.exec("COMMIT");
    return result;
  } catch (error) {
    await db.exec("ROLLBACK");
    throw error;
  }
}

async function asArchiver(operation) {
  await db.exec("RESET ROLE; SET ROLE opengeo_source_archiver");
  try {
    return await operation();
  } finally {
    await db.exec("RESET ROLE");
  }
}

async function insertSource({
  id = IDS.source,
  projectId = IDS.project,
  name = "Research catalog",
  remoteUrl = SOURCE_URL
} = {}) {
  return db.query(
    `INSERT INTO app.geonode_federation_sources
       (id, organization_id, project_id, display_name, remote_url,
        source_fingerprint_sha256, scheduling_enabled, refresh_interval_minutes,
        maximum_resources, credential_mode, configuration_checksum_sha256, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, false, 1440, 100, 'anonymous', $6, $7)`,
    [id, IDS.organization, projectId, name, remoteUrl, ZERO_SHA, IDS.owner]
  );
}

async function insertJob({id, sourceId = IDS.source, projectId = IDS.project}) {
  return db.query(
    `INSERT INTO app.geonode_harvest_jobs
       (id, organization_id, project_id, source_id,
        source_configuration_checksum_sha256, request_checksum_sha256,
        idempotency_key, request_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8)`,
    [
      id,
      IDS.organization,
      projectId,
      sourceId,
      ZERO_SHA,
      id.replace(/^7/, "a"),
      `geonode-harvest-${id}`,
      IDS.owner
    ]
  );
}

function resource(identifier, title, checksum, resourceType = "dataset") {
  return {
    remote_identifier: identifier,
    resource_type: resourceType,
    title,
    remote_modified_at: "2026-08-20T12:00:00+00:00",
    payload_sha256: checksum,
    payload: {uuid: identifier, resource_type: resourceType, title}
  };
}

function snapshot({
  sourceUrl = SOURCE_URL,
  observedAt = "2026-08-25T12:00:00+00:00",
  resources = [
    resource(ROAD_ID, "Road network", "a".repeat(64)),
    resource(STORY_ID, "Road access story", "b".repeat(64), "geoapp")
  ],
  remoteTotal = resources.length,
  checksum = "f".repeat(64)
} = {}) {
  const observed = new Date(observedAt);
  const fresh = new Date(observed.getTime() + 24 * 60 * 60 * 1000);
  return {
    schema_version: "opengeo.geonode-harvest-snapshot.1.0.0",
    source: {
      product: "geonode",
      version: "5.1.0",
      commit: GEONODE_COMMIT,
      url: sourceUrl,
      fingerprint_sha256: ZERO_SHA
    },
    observed_at: observed.toISOString(),
    fresh_until: fresh.toISOString(),
    remote_total: remoteTotal,
    truncated: remoteTotal > resources.length,
    resources,
    snapshot_sha256: checksum
  };
}

async function claim(jobId, token = IDS.token) {
  return asArchiver(() => db.query(
    "SELECT * FROM app.claim_geonode_harvest($1, $2, 60)",
    [jobId, token]
  ));
}

async function complete(jobId, result, token = IDS.token) {
  return asArchiver(() => db.query(
    "SELECT app.complete_geonode_harvest($1, $2, $3) AS value",
    [jobId, token, result]
  ));
}

describe("0067 bounded GeoNode federation harvesting", () => {
  before(async () => {
    db = new PGlite();
    for (const file of [
      "0001_platform_foundation.sql",
      "0002_membership_invitations.sql",
      "0003_managed_ingestion_foundation.sql",
      "0004_worker_execution_boundary.sql",
      "0005_catalog_access.sql",
      "0006_governed_external_sources.sql",
      "0007_governed_pmtiles_sources.sql",
      "0008_recoverable_project_imports.sql",
      "0009_governed_resources.sql"
    ]) {
      const sql = await load(file);
      await db.exec(sql.replace(/^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm, ""));
    }
    await db.exec(
      "CREATE ROLE opengeo_connector; CREATE ROLE opengeo_dataset_verifier; " +
      "CREATE ROLE opengeo_observable_coordinator; CREATE ROLE opengeo_source_archiver;"
    );
    await db.exec(await load("0050_team_project_access.sql"));
    // PGlite does not bundle pgcrypto. The baseline-chain verifier exercises
    // real digest(); this deterministic stand-in isolates lifecycle/RLS behavior.
    await db.exec(`
      CREATE FUNCTION public.digest(bytea, text) RETURNS bytea
      LANGUAGE sql IMMUTABLE AS $$ SELECT decode(repeat('00', 32), 'hex') $$;
    `);
    await db.exec(await load("0067_geonode_federation_harvests.sql"));
    await db.exec(`
      INSERT INTO app.users (id, cognito_subject, email, display_name) VALUES
        ('${IDS.owner}', 'federation-owner', 'owner@example.test', 'Owner'),
        ('${IDS.viewer}', 'federation-viewer', 'viewer@example.test', 'Viewer'),
        ('${IDS.otherOwner}', 'federation-other', 'other@example.test', 'Other');
      INSERT INTO app.organizations (id, name, slug, created_by) VALUES
        ('${IDS.organization}', 'Federation', 'federation', '${IDS.owner}'),
        ('${IDS.otherOrganization}', 'Other federation', 'other-federation', '${IDS.otherOwner}');
      INSERT INTO app.organization_memberships
        (organization_id, user_id, role, invited_by) VALUES
        ('${IDS.organization}', '${IDS.owner}', 'admin', '${IDS.owner}'),
        ('${IDS.organization}', '${IDS.viewer}', 'member', '${IDS.owner}'),
        ('${IDS.otherOrganization}', '${IDS.otherOwner}', 'admin', '${IDS.otherOwner}');
      INSERT INTO app.projects (id, organization_id, name, created_by) VALUES
        ('${IDS.project}', '${IDS.organization}', 'Primary catalog', '${IDS.owner}'),
        ('${IDS.secondProject}', '${IDS.organization}', 'Second catalog', '${IDS.owner}'),
        ('${IDS.otherProject}', '${IDS.otherOrganization}', 'Hidden catalog', '${IDS.otherOwner}');
      INSERT INTO app.project_memberships
        (organization_id, project_id, user_id, role) VALUES
        ('${IDS.organization}', '${IDS.project}', '${IDS.owner}', 'owner'),
        ('${IDS.organization}', '${IDS.project}', '${IDS.viewer}', 'viewer'),
        ('${IDS.organization}', '${IDS.secondProject}', '${IDS.owner}', 'owner'),
        ('${IDS.otherOrganization}', '${IDS.otherProject}', '${IDS.otherOwner}', 'owner');
    `);
    await inTenant(IDS.organization, IDS.owner, () => insertSource());
  });

  after(async () => {
    await db.exec("RESET ROLE");
    await db.close();
  });

  it("keeps sources tenant-scoped, anonymous, exact-versioned, and function-only", async () => {
    const hidden = await inTenant(IDS.otherOrganization, IDS.otherOwner, () => db.query(
      "SELECT id FROM app.geonode_federation_sources"
    ));
    assert.deepEqual(hidden.rows, []);
    const grants = await db.query(`
      SELECT
        has_table_privilege('opengeo_source_archiver',
          'app.geonode_harvest_jobs', 'SELECT') AS table_read,
        has_function_privilege('opengeo_source_archiver',
          'app.claim_geonode_harvest(uuid,uuid,integer)', 'EXECUTE') AS claim,
        has_function_privilege('opengeo_worker',
          'app.claim_geonode_harvest(uuid,uuid,integer)', 'EXECUTE') AS worker_claim
    `);
    assert.deepEqual(grants.rows, [{table_read: false, claim: true, worker_claim: false}]);
    const source = await inTenant(IDS.organization, IDS.owner, () => db.query(
      `SELECT source_version, credential_mode, scheduling_enabled,
              refresh_interval_minutes, maximum_resources
       FROM app.geonode_federation_sources WHERE id = $1`,
      [IDS.source]
    ));
    assert.deepEqual(source.rows, [{
      source_version: "5.1.0",
      credential_mode: "anonymous",
      scheduling_enabled: false,
      refresh_interval_minutes: 1440,
      maximum_resources: 100
    }]);
    const event = await inTenant(IDS.organization, IDS.owner, () => db.query(
      `SELECT event_type, payload->>'credential_mode' AS credential_mode
       FROM app.activity_events WHERE resource_id = $1`,
      [IDS.source]
    ));
    assert.deepEqual(event.rows, [{
      event_type: "federation.geonode.source.registered",
      credential_mode: "anonymous"
    }]);
  });

  it("denies viewer registration and malformed or credential-bearing source state", async () => {
    await assert.rejects(
      inTenant(IDS.organization, IDS.viewer, () => insertSource({
        id: "60000000-0000-4000-8000-000000000069",
        projectId: IDS.project,
        name: "Viewer source",
        remoteUrl: "https://viewer.example.test/geonode"
      })),
      /row-level security|edit access/
    );
    await assert.rejects(
      inTenant(IDS.organization, IDS.owner, () => db.query(
        `INSERT INTO app.geonode_federation_sources
           (organization_id, project_id, display_name, remote_url,
            source_fingerprint_sha256, credential_mode,
            configuration_checksum_sha256, created_by)
         VALUES ($1, $2, 'Unsafe', 'https://user:secret@example.test/geonode',
                 $3, 'anonymous', $3, $4)`,
        [IDS.organization, IDS.project, ZERO_SHA, IDS.owner]
      )),
      /check constraint|violates check/i
    );
  });

  it("claims only the bounded no-secret request and atomically adds two identities", async () => {
    await inTenant(IDS.organization, IDS.owner, () => insertJob({id: IDS.firstJob}));
    const claimed = await claim(IDS.firstJob);
    assert.deepEqual(claimed.rows, [{
      claim_status: "claimed",
      job_id: IDS.firstJob,
      display_name: "Research catalog",
      remote_url: SOURCE_URL,
      source_fingerprint_sha256: ZERO_SHA,
      source_version: "5.1.0",
      scheduling_enabled: false,
      refresh_interval_minutes: 1440,
      maximum_resources: 100,
      credential_mode: "anonymous",
      attempt_count: 1
    }]);
    const completed = await complete(IDS.firstJob, snapshot());
    assert.deepEqual(completed.rows, [{value: true}]);
    const state = await inTenant(IDS.organization, IDS.owner, () => db.query(
      `SELECT job.state::text, job.result->'reconciliation' AS reconciliation,
              (SELECT count(*)::integer FROM app.geonode_federated_identities
               WHERE source_id = $2) AS identities,
              (SELECT count(*)::integer FROM app.geonode_federated_identity_versions
               WHERE source_id = $2) AS versions
       FROM app.geonode_harvest_jobs job WHERE job.id = $1`,
      [IDS.firstJob, IDS.source]
    ));
    assert.deepEqual(state.rows, [{
      state: "completed",
      reconciliation: {added: 2, updated: 0, unchanged: 0, withdrawn: 0},
      identities: 2,
      versions: 2
    }]);
  });

  it("replays unchanged state without duplicate versions", async () => {
    await inTenant(IDS.organization, IDS.owner, () => insertJob({id: IDS.unchangedJob}));
    await claim(IDS.unchangedJob);
    await complete(IDS.unchangedJob, snapshot({
      observedAt: "2026-08-26T12:00:00+00:00",
      checksum: "e".repeat(64)
    }));
    const state = await inTenant(IDS.organization, IDS.owner, () => db.query(
      `SELECT result->'reconciliation' AS reconciliation,
              (SELECT count(*)::integer FROM app.geonode_federated_identity_versions
               WHERE source_id = $2) AS versions,
              min(last_refreshed_at)::text AS first_refresh,
              max(last_refreshed_at)::text AS last_refresh
       FROM app.geonode_harvest_jobs job
       CROSS JOIN app.geonode_federated_identities identity
       WHERE job.id = $1 AND identity.source_id = $2 GROUP BY job.result`,
      [IDS.unchangedJob, IDS.source]
    ));
    assert.equal(state.rows[0].versions, 2);
    assert.deepEqual(state.rows[0].reconciliation,
      {added: 0, updated: 0, unchanged: 2, withdrawn: 0});
    assert.equal(state.rows[0].first_refresh, state.rows[0].last_refresh);
    assert.equal(
      new Date(state.rows[0].last_refresh).toISOString(),
      "2026-08-26T12:00:00.000Z"
    );
  });

  it("rejects an incomplete source seal before reconciliation", async () => {
    await inTenant(IDS.organization, IDS.owner, () => insertJob({id: IDS.invalidSnapshotJob}));
    await claim(IDS.invalidSnapshotJob);
    const invalidSnapshot = snapshot({checksum: "7".repeat(64)});
    delete invalidSnapshot.source.product;
    await assert.rejects(
      complete(IDS.invalidSnapshotJob, invalidSnapshot),
      /invalid GeoNode harvest snapshot/
    );
    const state = await inTenant(IDS.organization, IDS.owner, () => db.query(
      `SELECT state::text, result FROM app.geonode_harvest_jobs WHERE id = $1`,
      [IDS.invalidSnapshotJob]
    ));
    assert.deepEqual(state.rows, [{state: "running", result: null}]);
  });

  it("updates one identity, withdraws another, and accepts an empty final catalog", async () => {
    await inTenant(IDS.organization, IDS.owner, () => insertJob({id: IDS.changedJob}));
    await claim(IDS.changedJob);
    await complete(IDS.changedJob, snapshot({
      observedAt: "2026-08-27T12:00:00+00:00",
      resources: [resource(ROAD_ID, "Updated road network", "c".repeat(64))],
      checksum: "d".repeat(64)
    }));
    await inTenant(IDS.organization, IDS.owner, () => insertJob({id: IDS.emptyJob}));
    await claim(IDS.emptyJob);
    await complete(IDS.emptyJob, snapshot({
      observedAt: "2026-08-28T12:00:00+00:00",
      resources: [],
      checksum: "c".repeat(64)
    }));
    const state = await inTenant(IDS.organization, IDS.owner, () => db.query(
      `SELECT job.id, job.result->'reconciliation' AS reconciliation
       FROM app.geonode_harvest_jobs job
       WHERE job.id IN ($1, $2) ORDER BY job.created_at, job.id`,
      [IDS.changedJob, IDS.emptyJob]
    ));
    assert.deepEqual(state.rows.map(({reconciliation}) => reconciliation), [
      {added: 0, updated: 1, unchanged: 0, withdrawn: 1},
      {added: 0, updated: 0, unchanged: 0, withdrawn: 1}
    ]);
    const identities = await inTenant(IDS.organization, IDS.owner, () => db.query(
      `SELECT remote_identifier, status, current_version_number
       FROM app.geonode_federated_identities WHERE source_id = $1
       ORDER BY remote_identifier`,
      [IDS.source]
    ));
    assert.deepEqual(identities.rows, [
      {remote_identifier: ROAD_ID, status: "withdrawn", current_version_number: 3},
      {remote_identifier: STORY_ID, status: "withdrawn", current_version_number: 2}
    ]);
  });

  it("rejects both remote-source and governed-local identity collisions atomically", async () => {
    await inTenant(IDS.organization, IDS.owner, () => insertSource({
      id: IDS.secondSource,
      projectId: IDS.secondProject,
      name: "Second catalog",
      remoteUrl: SECOND_SOURCE_URL
    }));
    await inTenant(IDS.organization, IDS.owner, () => insertJob({
      id: IDS.collisionJob,
      sourceId: IDS.secondSource,
      projectId: IDS.secondProject
    }));
    await claim(IDS.collisionJob);
    await assert.rejects(
      complete(IDS.collisionJob, snapshot({sourceUrl: SECOND_SOURCE_URL})),
      /source identity collision/
    );
    await asArchiver(() => db.query(
      "SELECT app.fail_geonode_harvest($1, $2, 'geonode_harvest_identity_collision')",
      [IDS.collisionJob, IDS.token]
    ));

    await inTenant(IDS.organization, IDS.owner, async () => {
      await db.query(
        `INSERT INTO app.governed_resources
           (id, organization_id, project_id, kind, slug, current_version_id,
            owner_user_id, created_by, updated_by)
         VALUES ($1, $2, $3, 'document', 'local-binding', $4, $5, $5, $5)`,
        [IDS.governedResource, IDS.organization, IDS.project, IDS.governedVersion, IDS.owner]
      );
      await db.query(
        `INSERT INTO app.governed_resource_versions
           (id, organization_id, resource_id, version_number, title, content, created_by)
         VALUES ($1, $2, $3, 1, 'Local binding', '{"blocks":[]}', $4)`,
        [IDS.governedVersion, IDS.organization, IDS.governedResource, IDS.owner]
      );
      await db.query(
        `INSERT INTO app.governed_resource_external_identifiers
           (organization_id, resource_id, namespace, identifier, source_url,
            source_version, source_payload_sha256, imported_by)
         VALUES ($1, $2, 'geonode', $3, 'https://local.example.test',
                 '5.1.0', $4, $5)`,
        [IDS.organization, IDS.governedResource, LOCAL_ID, "9".repeat(64), IDS.owner]
      );
      await insertJob({id: IDS.localCollisionJob});
    });
    await claim(IDS.localCollisionJob);
    await assert.rejects(
      complete(IDS.localCollisionJob, snapshot({
        observedAt: "2026-08-29T12:00:00+00:00",
        resources: [resource(LOCAL_ID, "Conflicting resource", "8".repeat(64))]
      })),
      /local identity collision/
    );
    await asArchiver(() => db.query(
      "SELECT app.fail_geonode_harvest($1, $2, 'geonode_harvest_local_identity_collision')",
      [IDS.localCollisionJob, IDS.token]
    ));
    const states = await inTenant(IDS.organization, IDS.owner, () => db.query(
      `SELECT id, state::text, error_code FROM app.geonode_harvest_jobs
       WHERE id IN ($1, $2) ORDER BY id`,
      [IDS.collisionJob, IDS.localCollisionJob]
    ));
    assert.deepEqual(states.rows.map(({state, error_code}) => ({state, error_code})), [
      {state: "failed", error_code: "geonode_harvest_identity_collision"},
      {state: "failed", error_code: "geonode_harvest_local_identity_collision"}
    ]);
  });

  it("cancels running work and disables a source idempotently with audit evidence", async () => {
    await inTenant(IDS.organization, IDS.owner, () => insertJob({id: IDS.cancelJob}));
    await claim(IDS.cancelJob);
    const cancelled = await inTenant(IDS.organization, IDS.owner, () => db.query(
      "SELECT app.cancel_geonode_harvest($1,$2,$3,$4,$5) AS value",
      [IDS.organization, IDS.project, IDS.cancelJob, IDS.owner, "cancel-geonode-67"]
    ));
    assert.deepEqual(cancelled.rows, [{value: true}]);
    assert.deepEqual((await complete(IDS.cancelJob, snapshot())).rows, [{value: false}]);

    await inTenant(IDS.organization, IDS.owner, () => insertJob({id: IDS.disableJob}));
    const first = await inTenant(IDS.organization, IDS.owner, () => db.query(
      "SELECT app.disable_geonode_federation_source($1,$2,$3,$4,$5) AS value",
      [IDS.organization, IDS.project, IDS.source, IDS.owner, "disable-geonode-67"]
    ));
    const replay = await inTenant(IDS.organization, IDS.owner, () => db.query(
      "SELECT app.disable_geonode_federation_source($1,$2,$3,$4,$5) AS value",
      [IDS.organization, IDS.project, IDS.source, IDS.owner, "disable-geonode-67-replay"]
    ));
    assert.deepEqual(first.rows, [{value: true}]);
    assert.deepEqual(replay.rows, [{value: true}]);
    const state = await inTenant(IDS.organization, IDS.owner, () => db.query(
      `SELECT source.status, job.state::text AS job_state, job.error_code,
              (SELECT count(*)::integer FROM app.activity_events
               WHERE event_type = 'federation.geonode.source.disabled'
                 AND resource_id = source.id) AS disable_events
       FROM app.geonode_federation_sources source
       JOIN app.geonode_harvest_jobs job ON job.source_id = source.id
       WHERE source.id = $1 AND job.id = $2`,
      [IDS.source, IDS.disableJob]
    ));
    assert.deepEqual(state.rows, [{
      status: "disabled",
      job_state: "cancelled",
      error_code: "cancelled_by_user",
      disable_events: 1
    }]);
  });
});

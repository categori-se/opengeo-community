import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, describe, it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

const ID = {
  organization: "10000000-0000-4000-8000-000000000481",
  otherOrganization: "10000000-0000-4000-8000-000000000482",
  owner: "20000000-0000-4000-8000-000000000481",
  editor: "20000000-0000-4000-8000-000000000482",
  project: "50000000-0000-4000-8000-000000000481",
  connection: "70000000-0000-4000-8000-000000000481",
  revision: "71000000-0000-4000-8000-000000000481",
  workerToken: "80000000-0000-4000-8000-000000000481"
};

const secretArn =
  "arn:aws:secretsmanager:us-east-1:111111111111:secret:opengeo/test/connections/" +
  `${ID.organization}/${ID.connection}-AbCd12`;

let db;

async function tenant(userId, operation) {
  await db.exec("BEGIN");
  try {
    await db.query("SELECT set_config('app.organization_id', $1, true)", [ID.organization]);
    await db.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const result = await operation();
    await db.exec("COMMIT");
    return result;
  } catch (error) {
    await db.exec("ROLLBACK");
    throw error;
  }
}

async function requestVerification(userId, requestId = "request-verify-1") {
  return tenant(userId, () =>
    db.query(
      `SELECT * FROM app.request_external_connection_verification($1, $2, $3, $4, $5)`,
      [ID.organization, ID.project, ID.connection, userId, requestId]
    )
  );
}

describe("0048 isolated external connection verification boundary", {concurrency: false}, () => {
  before(async () => {
    db = new PGlite();
    for (const file of [
      "0001_platform_foundation.sql",
      "0002_membership_invitations.sql",
      "0003_managed_ingestion_foundation.sql",
      "0004_worker_execution_boundary.sql",
      "0047_governed_external_connections.sql",
      "0048_external_connection_verification.sql"
    ]) {
      let sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8");
      sql = sql.replace(/^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm, "");
      await db.exec(sql);
    }
    await db.exec(`
      INSERT INTO app.users (id, cognito_subject, email, display_name)
      VALUES
        ('${ID.owner}', 'connection-verification-owner', 'owner@example.test', 'Owner'),
        ('${ID.editor}', 'connection-verification-editor', 'editor@example.test', 'Editor');
      INSERT INTO app.organizations (id, name, slug, created_by)
      VALUES ('${ID.organization}', 'Verification', 'verification', '${ID.owner}');
      INSERT INTO app.organization_memberships (organization_id, user_id, role, invited_by)
      VALUES
        ('${ID.organization}', '${ID.owner}', 'member', '${ID.owner}'),
        ('${ID.organization}', '${ID.editor}', 'member', '${ID.owner}');
      INSERT INTO app.projects (id, organization_id, name, created_by)
      VALUES ('${ID.project}', '${ID.organization}', 'Verifier project', '${ID.owner}');
      INSERT INTO app.project_memberships (organization_id, project_id, user_id, role)
      VALUES
        ('${ID.organization}', '${ID.project}', '${ID.owner}', 'owner'),
        ('${ID.organization}', '${ID.project}', '${ID.editor}', 'editor');
      INSERT INTO app.external_connections
        (id, organization_id, project_id, provider, display_name,
         endpoint_host, endpoint_port, database_name, allowed_schemas,
         secret_arn, configured_secret_fields, created_by, updated_by)
      VALUES
        ('${ID.connection}', '${ID.organization}', '${ID.project}', 'postgresql',
         'Research warehouse', 'gis.example.test', 5432, 'research', ARRAY['public'],
         '${secretArn}', ARRAY['password', 'username'], '${ID.owner}', '${ID.owner}');
      INSERT INTO app.external_connection_revisions
        (id, organization_id, project_id, connection_id, revision_number,
         configuration, change_summary, created_by)
      VALUES
        ('${ID.revision}', '${ID.organization}', '${ID.project}', '${ID.connection}', 1,
         '{"provider":"postgresql","endpointHost":"gis.example.test","endpointPort":5432,"databaseName":"research","allowedSchemas":["public"],"readOnly":true,"tlsMode":"verify_full","networkMode":"public_internet"}',
         'Initial connection registration', '${ID.owner}');
      SET ROLE opengeo_runtime;
    `);
  });

  after(async () => {
    await db.exec("RESET ROLE");
    await db.close();
  });

  it("allows only a project owner to queue one active identity-only attempt", async () => {
    await assert.rejects(requestVerification(ID.editor), /requires project owner/);

    const first = await requestVerification(ID.owner);
    assert.equal(first.rows[0].created, true);
    const second = await requestVerification(ID.owner, "request-verify-2");
    assert.deepEqual(second.rows[0], {
      verification_id: first.rows[0].verification_id,
      created: false
    });

    const visible = await tenant(ID.owner, () =>
      db.query(
        `SELECT state::text, attempt_count, sanitized_error_code
         FROM app.external_connection_verifications WHERE id = $1`,
        [first.rows[0].verification_id]
      )
    );
    assert.deepEqual(visible.rows[0], {
      state: "queued",
      attempt_count: 0,
      sanitized_error_code: null
    });
    await assert.rejects(
      tenant(ID.owner, () =>
        db.query(
          "SELECT secret_arn FROM app.external_connection_verifications WHERE id = $1",
          [first.rows[0].verification_id]
        )
      ),
      /column .* does not exist/
    );
  });

  it("discloses the secret reference only through a leased connector claim", async () => {
    const queued = await tenant(ID.owner, () =>
      db.query(
        "SELECT id FROM app.external_connection_verifications WHERE state = 'queued' LIMIT 1"
      )
    );
    const verificationId = queued.rows[0].id;

    await assert.rejects(
      tenant(ID.owner, () =>
        db.query(
          "SELECT * FROM app.claim_external_connection_verification($1, $2, 20)",
          [verificationId, ID.workerToken]
        )
      ),
      /permission denied/
    );
    await db.exec("RESET ROLE; SET ROLE opengeo_worker");
    await assert.rejects(
      db.query(
        "SELECT * FROM app.claim_external_connection_verification($1, $2, 20)",
        [verificationId, ID.workerToken]
      ),
      /permission denied/
    );

    await db.exec("RESET ROLE; SET ROLE opengeo_connector");
    await assert.rejects(
      db.query("SELECT secret_arn FROM app.external_connections WHERE id = $1", [ID.connection]),
      /permission denied/
    );
    const claim = await db.query(
      "SELECT * FROM app.claim_external_connection_verification($1, $2, 20)",
      [verificationId, ID.workerToken]
    );
    assert.equal(claim.rows[0].claim_status, "claimed");
    assert.equal(claim.rows[0].secret_arn, secretArn);
    assert.equal(claim.rows[0].endpoint_host, "gis.example.test");
    assert.equal(claim.rows[0].attempt_count, 1);

    const completed = await db.query(
      `SELECT app.complete_external_connection_verification(
        $1, $2, true, true, true, true, NULL, 37
      ) AS completed`,
      [verificationId, ID.workerToken]
    );
    assert.equal(completed.rows[0].completed, true);
    assert.equal(
      (await db.query(
        `SELECT app.complete_external_connection_verification(
          $1, $2, true, true, true, true, NULL, 37
        ) AS completed`,
        [verificationId, ID.workerToken]
      )).rows[0].completed,
      false
    );

    await db.exec("RESET ROLE; SET ROLE opengeo_runtime");
    const result = await tenant(ID.owner, () =>
      db.query(
        `SELECT verification.state::text, verification.network_reachable,
                verification.tls_verified, verification.credentials_verified,
                verification.postgis_verified, verification.duration_ms,
                connection.status::text AS connection_status,
                connection.last_verified_at IS NOT NULL AS verified_at_set,
                connection.sanitized_error_code
         FROM app.external_connection_verifications verification
         JOIN app.external_connections connection
           ON connection.organization_id = verification.organization_id
          AND connection.id = verification.connection_id
         WHERE verification.id = $1`,
        [verificationId]
      )
    );
    assert.deepEqual(result.rows[0], {
      state: "succeeded",
      network_reachable: true,
      tls_verified: true,
      credentials_verified: true,
      postgis_verified: true,
      duration_ms: 37,
      connection_status: "credentials_verified",
      verified_at_set: true,
      sanitized_error_code: null
    });
  });

  it("persists only allowlisted failure codes and secret-free audit facts", async () => {
    const queued = await requestVerification(ID.owner, "request-verify-failure");
    const verificationId = queued.rows[0].verification_id;
    await db.exec("RESET ROLE; SET ROLE opengeo_connector");
    await db.query(
      "SELECT * FROM app.claim_external_connection_verification($1, $2, 20)",
      [verificationId, ID.workerToken]
    );
    await assert.rejects(
      db.query(
        `SELECT app.complete_external_connection_verification(
          $1, $2, false, false, false, false, 'password=leak', 5
        )`,
        [verificationId, ID.workerToken]
      ),
      /invalid connection verification result/
    );
    const completed = await db.query(
      `SELECT app.complete_external_connection_verification(
        $1, $2, false, false, false, false, 'unsafe_network_target', 5
      ) AS completed`,
      [verificationId, ID.workerToken]
    );
    assert.equal(completed.rows[0].completed, true);

    await db.exec("RESET ROLE; SET ROLE opengeo_runtime");
    const audit = await tenant(ID.owner, () =>
      db.query(
        `SELECT payload FROM app.activity_events
         WHERE event_type = 'connection.verification.failed'
         ORDER BY occurred_at DESC LIMIT 1`
      )
    );
    const serialized = JSON.stringify(audit.rows[0].payload);
    assert.match(serialized, /unsafe_network_target/);
    assert.doesNotMatch(serialized, /secret_arn|gis\.example\.test|password/i);
  });

  it("lets the owner cancel active work and makes a stale completion lose its lease", async () => {
    const queued = await requestVerification(ID.owner, "request-verify-cancel");
    const verificationId = queued.rows[0].verification_id;
    await db.exec("RESET ROLE; SET ROLE opengeo_connector");
    await db.query(
      "SELECT * FROM app.claim_external_connection_verification($1, $2, 20)",
      [verificationId, ID.workerToken]
    );
    await db.exec("RESET ROLE; SET ROLE opengeo_runtime");
    const cancelled = await tenant(ID.owner, () =>
      db.query(
        `SELECT app.cancel_external_connection_verification($1, $2, $3, $4, $5, $6)
          AS cancelled`,
        [
          ID.organization,
          ID.project,
          ID.connection,
          verificationId,
          ID.owner,
          "request-cancel-1"
        ]
      )
    );
    assert.equal(cancelled.rows[0].cancelled, true);

    await db.exec("RESET ROLE; SET ROLE opengeo_connector");
    const stale = await db.query(
      `SELECT app.complete_external_connection_verification(
        $1, $2, true, true, true, true, NULL, 10
      ) AS completed`,
      [verificationId, ID.workerToken]
    );
    assert.equal(stale.rows[0].completed, false);
    await db.exec("RESET ROLE; SET ROLE opengeo_runtime");
  });

  it("requeues dependency failures twice and seals the third without orphaning a lease", async () => {
    const queued = await requestVerification(ID.owner, "request-verify-retry");
    const verificationId = queued.rows[0].verification_id;
    await db.exec("RESET ROLE; SET ROLE opengeo_connector");
    for (const expected of ["queued", "queued", "failed"]) {
      const claim = await db.query(
        "SELECT * FROM app.claim_external_connection_verification($1, $2, 20)",
        [verificationId, ID.workerToken]
      );
      assert.equal(claim.rows[0].claim_status, "claimed");
      const released = await db.query(
        "SELECT app.release_external_connection_verification($1, $2, 3) AS state",
        [verificationId, ID.workerToken]
      );
      assert.equal(released.rows[0].state, expected);
    }
    await db.exec("RESET ROLE; SET ROLE opengeo_runtime");
    const result = await tenant(ID.owner, () =>
      db.query(
        `SELECT verification.state::text, verification.attempt_count,
                verification.worker_token, verification.lease_expires_at,
                verification.sanitized_error_code,
                connection.status::text AS connection_status
         FROM app.external_connection_verifications verification
         JOIN app.external_connections connection
           ON connection.organization_id = verification.organization_id
          AND connection.id = verification.connection_id
         WHERE verification.id = $1`,
        [verificationId]
      )
    );
    assert.deepEqual(result.rows[0], {
      state: "failed",
      attempt_count: 3,
      worker_token: null,
      lease_expires_at: null,
      sanitized_error_code: "verification_failed",
      connection_status: "degraded"
    });
  });

  it("seals an expired third lease with the same degraded audit outcome", async () => {
    const queued = await requestVerification(ID.owner, "request-verify-expired-retry");
    const verificationId = queued.rows[0].verification_id;
    await db.exec("RESET ROLE; SET ROLE opengeo_connector");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const claim = await db.query(
        "SELECT * FROM app.claim_external_connection_verification($1, $2, 20)",
        [verificationId, ID.workerToken]
      );
      assert.equal(claim.rows[0].claim_status, "claimed");
      if (attempt < 2) {
        const released = await db.query(
          "SELECT app.release_external_connection_verification($1, $2, 3) AS state",
          [verificationId, ID.workerToken]
        );
        assert.equal(released.rows[0].state, "queued");
      }
    }
    await db.exec("RESET ROLE");
    await db.query(
      `UPDATE app.external_connection_verifications
       SET lease_expires_at = clock_timestamp() - interval '1 second'
       WHERE id = $1`,
      [verificationId]
    );
    await db.exec("SET ROLE opengeo_connector");
    const exhausted = await db.query(
      "SELECT * FROM app.claim_external_connection_verification($1, $2, 20)",
      [verificationId, "80000000-0000-4000-8000-000000000488"]
    );
    assert.equal(exhausted.rows[0].claim_status, "attempts_exhausted");
    await db.exec("RESET ROLE; SET ROLE opengeo_runtime");
    const result = await tenant(ID.owner, () =>
      db.query(
        `SELECT verification.state::text, verification.worker_token,
                verification.lease_expires_at,
                verification.sanitized_error_code,
                connection.status::text AS connection_status,
                event.event_type
         FROM app.external_connection_verifications verification
         JOIN app.external_connections connection
           ON connection.organization_id = verification.organization_id
          AND connection.id = verification.connection_id
         JOIN app.activity_events event
           ON event.organization_id = verification.organization_id
          AND event.request_id = 'connector:' || verification.id::text
         WHERE verification.id = $1`,
        [verificationId]
      )
    );
    assert.deepEqual(result.rows[0], {
      state: "failed",
      worker_token: null,
      lease_expires_at: null,
      sanitized_error_code: "verification_failed",
      connection_status: "degraded",
      event_type: "connection.verification.failed"
    });
  });
});

import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, describe, it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

const IDS = {
  organizationA: "10000000-0000-4000-8000-000000000001",
  organizationB: "10000000-0000-4000-8000-000000000002",
  adminA: "20000000-0000-4000-8000-000000000001",
  adminB: "20000000-0000-4000-8000-000000000002",
  projectA: "50000000-0000-4000-8000-000000000001",
  projectB: "50000000-0000-4000-8000-000000000002",
  invitation: "70000000-0000-4000-8000-000000000001",
  expiredInvitation: "70000000-0000-4000-8000-000000000002",
  rollbackInvitation: "70000000-0000-4000-8000-000000000003"
};

let db;

async function inContext(organizationId, userId, operation) {
  await db.exec("BEGIN");
  try {
    if (organizationId) {
      await db.query("SELECT set_config('app.organization_id', $1, true)", [organizationId]);
    }
    await db.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const result = await operation();
    await db.exec("COMMIT");
    return result;
  } catch (error) {
    await db.exec("ROLLBACK");
    throw error;
  }
}

async function provision(subject, email, displayName = "Invited User") {
  const result = await inContext(IDS.organizationA, IDS.adminA, () =>
    db.query("SELECT app.provision_invited_user($1, $2, $3) AS id", [
      subject,
      email,
      displayName
    ])
  );
  return result.rows[0].id;
}

async function createInvitation({
  id,
  userId,
  email,
  expiresAt,
  createdAt = null,
  project = true
}) {
  return inContext(IDS.organizationA, IDS.adminA, () =>
    db.query(
      `INSERT INTO app.membership_invitations
         (id, organization_id, invitee_user_id, email, organization_role,
          project_id, project_role, invited_by, expires_at, created_at)
       VALUES ($1, $2, $3, $4, 'guest', $5, $6, $7, $8,
               COALESCE($9::timestamptz, clock_timestamp()))`,
      [
        id,
        IDS.organizationA,
        userId,
        email,
        project ? IDS.projectA : null,
        project ? "viewer" : null,
        IDS.adminA,
        expiresAt,
        createdAt
      ]
    )
  );
}

describe("0002 membership invitations migration", () => {
  before(async () => {
    db = new PGlite();
    for (const file of ["0001_platform_foundation.sql", "0002_membership_invitations.sql"]) {
      const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8");
      await db.exec(sql.replace(/^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm, ""));
    }

    await db.exec(`
      INSERT INTO app.users (id, cognito_subject, email, display_name)
      VALUES
        ('${IDS.adminA}', 'admin-a', 'admin-a@example.test', 'Admin A'),
        ('${IDS.adminB}', 'admin-b', 'admin-b@example.test', 'Admin B');
      INSERT INTO app.organizations (id, name, slug, created_by)
      VALUES
        ('${IDS.organizationA}', 'Organization A', 'organization-a', '${IDS.adminA}'),
        ('${IDS.organizationB}', 'Organization B', 'organization-b', '${IDS.adminB}');
      INSERT INTO app.organization_memberships (organization_id, user_id, role, invited_by)
      VALUES
        ('${IDS.organizationA}', '${IDS.adminA}', 'admin', '${IDS.adminA}'),
        ('${IDS.organizationB}', '${IDS.adminB}', 'admin', '${IDS.adminB}');
      INSERT INTO app.projects (id, organization_id, name, created_by)
      VALUES
        ('${IDS.projectA}', '${IDS.organizationA}', 'Project A', '${IDS.adminA}'),
        ('${IDS.projectB}', '${IDS.organizationB}', 'Project B', '${IDS.adminB}');
      SET ROLE opengeo_runtime;
    `);
  });

  after(async () => {
    await db.exec("RESET ROLE");
    await db.close();
  });

  it("gates identity provisioning to an organization administrator", async () => {
    const invitedId = await provision("invited-subject", "invited@example.test");
    assert.match(invitedId, /^[0-9a-f-]{36}$/);

    await assert.rejects(
      inContext(IDS.organizationA, invitedId, () =>
        db.query("SELECT app.provision_invited_user('other-subject', 'other@example.test', 'Other')")
      ),
      /organization administrator required/
    );
    assert.equal(
      await provision("invited-subject", "invited@example.test", "Ignored Rename"),
      invitedId
    );
  });

  it("isolates invitation rows and rejects cross-tenant scope", async () => {
    const invited = await db.query(
      "SELECT user_id FROM app.resolve_principal('invited-subject')"
    );
    const invitedId = invited.rows[0].user_id;
    await createInvitation({
      id: IDS.invitation,
      userId: invitedId,
      email: "invited@example.test",
      expiresAt: "2099-01-01T00:00:00Z"
    });

    const visible = await inContext(IDS.organizationA, IDS.adminA, () =>
      db.query("SELECT id FROM app.membership_invitations")
    );
    const hidden = await inContext(IDS.organizationB, IDS.adminB, () =>
      db.query("SELECT id FROM app.membership_invitations")
    );
    assert.deepEqual(visible.rows, [{id: IDS.invitation}]);
    assert.deepEqual(hidden.rows, []);

    await assert.rejects(
      inContext(IDS.organizationA, IDS.adminA, () =>
        db.query(
          `INSERT INTO app.membership_invitations
             (organization_id, invitee_user_id, email, organization_role,
              project_id, project_role, invited_by, expires_at)
           VALUES ($1, $2, 'invited@example.test', 'guest', $3, 'viewer', $4,
                   '2099-01-01T00:00:00Z')`,
          [IDS.organizationA, invitedId, IDS.projectB, IDS.adminA]
        )
      ),
      /foreign key|row-level security/
    );
  });

  it("accepts once for the bound user and grants both scopes atomically", async () => {
    const principal = await db.query("SELECT user_id FROM app.resolve_principal('invited-subject')");
    const invitedId = principal.rows[0].user_id;
    const discovered = await inContext(null, invitedId, () =>
      db.query("SELECT invitation_id, organization_name, project_name FROM app.list_pending_membership_invitations()")
    );
    const hidden = await inContext(null, IDS.adminB, () =>
      db.query("SELECT invitation_id FROM app.list_pending_membership_invitations()")
    );
    assert.deepEqual(discovered.rows, [{
      invitation_id: IDS.invitation,
      organization_name: "Organization A",
      project_name: "Project A"
    }]);
    assert.deepEqual(hidden.rows, []);
    const accepted = await inContext(null, invitedId, () =>
      db.query("SELECT * FROM app.accept_membership_invitation($1, 'accept-1')", [
        IDS.invitation
      ])
    );
    assert.equal(accepted.rows[0].result_code, "accepted");

    const access = await inContext(IDS.organizationA, invitedId, async () => ({
      organization: await db.query(
        "SELECT role::text FROM app.organization_memberships WHERE user_id = $1",
        [invitedId]
      ),
      project: await db.query(
        "SELECT role::text FROM app.project_memberships WHERE user_id = $1",
        [invitedId]
      ),
      activity: await db.query(
        "SELECT event_type, request_id FROM app.activity_events WHERE resource_id = $1",
        [IDS.invitation]
      )
    }));
    assert.deepEqual(access.organization.rows, [{role: "guest"}]);
    assert.deepEqual(access.project.rows, [{role: "viewer"}]);
    assert.deepEqual(access.activity.rows, [
      {event_type: "membership.invitation.accepted", request_id: "accept-1"}
    ]);

    const replay = await inContext(null, invitedId, () =>
      db.query("SELECT result_code FROM app.accept_membership_invitation($1, 'accept-2')", [
        IDS.invitation
      ])
    );
    assert.deepEqual(replay.rows, [{result_code: "already_accepted"}]);

    const wrongUser = await inContext(null, IDS.adminB, () =>
      db.query("SELECT result_code FROM app.accept_membership_invitation($1, 'forged')", [
        IDS.invitation
      ])
    );
    assert.deepEqual(wrongUser.rows, [{result_code: "not_found"}]);
  });

  it("reports expiry without granting access", async () => {
    const userId = await provision("expired-subject", "expired@example.test");
    await createInvitation({
      id: IDS.expiredInvitation,
      userId,
      email: "expired@example.test",
      expiresAt: "2026-01-01T00:00:00Z",
      createdAt: "2025-01-01T00:00:00Z",
      project: false
    });

    const result = await inContext(null, userId, () =>
      db.query("SELECT result_code FROM app.accept_membership_invitation($1, 'expired')", [
        IDS.expiredInvitation
      ])
    );
    assert.deepEqual(result.rows, [{result_code: "expired"}]);
    const resolved = await db.query("SELECT organization_id FROM app.resolve_principal('expired-subject')");
    assert.deepEqual(resolved.rows, [{organization_id: null}]);
  });

  it("rolls back grants and transition when activity insertion fails", async () => {
    const userId = await provision("rollback-subject", "rollback@example.test");
    await createInvitation({
      id: IDS.rollbackInvitation,
      userId,
      email: "rollback@example.test",
      expiresAt: "2099-01-01T00:00:00Z",
      project: false
    });

    await db.exec(`
      RESET ROLE;
      CREATE FUNCTION app.reject_rollback_test_event() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.request_id = 'force-rollback' THEN
          RAISE EXCEPTION 'forced activity failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER activity_reject_rollback_test
      BEFORE INSERT ON app.activity_events
      FOR EACH ROW EXECUTE FUNCTION app.reject_rollback_test_event();
      SET ROLE opengeo_runtime;
    `);

    await assert.rejects(
      inContext(null, userId, () =>
        db.query(
          "SELECT * FROM app.accept_membership_invitation($1, 'force-rollback')",
          [IDS.rollbackInvitation]
        )
      ),
      /forced activity failure/
    );

    const invitation = await inContext(IDS.organizationA, IDS.adminA, () =>
      db.query("SELECT state::text FROM app.membership_invitations WHERE id = $1", [
        IDS.rollbackInvitation
      ])
    );
    assert.deepEqual(invitation.rows, [{state: "pending"}]);
    const resolved = await db.query("SELECT organization_id FROM app.resolve_principal('rollback-subject')");
    assert.deepEqual(resolved.rows, [{organization_id: null}]);
  });

  it("denies deletes and enforces forward-only immutable transitions", async () => {
    await assert.rejects(
      inContext(IDS.organizationA, IDS.adminA, () =>
        db.query("DELETE FROM app.membership_invitations WHERE id = $1", [IDS.invitation])
      ),
      /permission denied/
    );
    await assert.rejects(
      inContext(IDS.organizationA, IDS.adminA, () =>
        db.query(
          "UPDATE app.membership_invitations SET email = 'changed@example.test' WHERE id = $1",
          [IDS.invitation]
        )
      ),
      /immutable|forward-only/
    );
  });
});

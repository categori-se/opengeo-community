import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, describe, it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

const IDS = {
  organizationA: "10000000-0000-4000-8000-000000000001",
  organizationB: "10000000-0000-4000-8000-000000000002",
  owner: "20000000-0000-4000-8000-000000000001",
  member: "20000000-0000-4000-8000-000000000002",
  outsider: "20000000-0000-4000-8000-000000000003",
  otherTenant: "20000000-0000-4000-8000-000000000004",
  projectA: "50000000-0000-4000-8000-000000000001",
  projectB: "50000000-0000-4000-8000-000000000002",
  teamA: "90000000-0000-4000-8000-000000000001",
  teamB: "90000000-0000-4000-8000-000000000002",
  grantA: "91000000-0000-4000-8000-000000000001"
};

let db;
let migration;

async function inTenant(organizationId, userId, operation) {
  await db.exec("BEGIN");
  try {
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

describe("0050 team project access migration", () => {
  before(async () => {
    db = new PGlite();
    const foundation = await readFile(
      new URL("../migrations/0001_platform_foundation.sql", import.meta.url),
      "utf8"
    );
    migration = await readFile(
      new URL("../migrations/0050_team_project_access.sql", import.meta.url),
      "utf8"
    );
    await db.exec(foundation.replace(/^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm, ""));
    await db.exec("CREATE ROLE opengeo_worker; CREATE ROLE opengeo_connector; CREATE ROLE opengeo_observable_coordinator;");
    await db.exec(migration);
    await db.exec(`
      INSERT INTO app.users (id, cognito_subject, email, display_name)
      VALUES
        ('${IDS.owner}', 'owner', 'owner@example.test', 'Owner'),
        ('${IDS.member}', 'member', 'member@example.test', 'Member'),
        ('${IDS.outsider}', 'outsider', 'outsider@example.test', 'Outsider'),
        ('${IDS.otherTenant}', 'other', 'other@example.test', 'Other');
      INSERT INTO app.organizations (id, name, slug, created_by)
      VALUES
        ('${IDS.organizationA}', 'Organization A', 'organization-a', '${IDS.owner}'),
        ('${IDS.organizationB}', 'Organization B', 'organization-b', '${IDS.otherTenant}');
      INSERT INTO app.organization_memberships (organization_id, user_id, role, invited_by)
      VALUES
        ('${IDS.organizationA}', '${IDS.owner}', 'admin', '${IDS.owner}'),
        ('${IDS.organizationA}', '${IDS.member}', 'member', '${IDS.owner}'),
        ('${IDS.organizationA}', '${IDS.outsider}', 'member', '${IDS.owner}'),
        ('${IDS.organizationB}', '${IDS.otherTenant}', 'admin', '${IDS.otherTenant}');
      INSERT INTO app.projects (id, organization_id, name, created_by)
      VALUES
        ('${IDS.projectA}', '${IDS.organizationA}', 'Project A', '${IDS.owner}'),
        ('${IDS.projectB}', '${IDS.organizationB}', 'Project B', '${IDS.otherTenant}');
      INSERT INTO app.project_memberships (organization_id, project_id, user_id, role)
      VALUES ('${IDS.organizationA}', '${IDS.projectA}', '${IDS.owner}', 'owner');
      INSERT INTO app.teams (id, organization_id, name, created_by)
      VALUES
        ('${IDS.teamA}', '${IDS.organizationA}', 'Field team', '${IDS.owner}'),
        ('${IDS.teamB}', '${IDS.organizationB}', 'Other team', '${IDS.otherTenant}');
      INSERT INTO app.team_memberships (organization_id, team_id, user_id, role, created_by)
      VALUES ('${IDS.organizationA}', '${IDS.teamA}', '${IDS.member}', 'member', '${IDS.owner}');
      INSERT INTO app.project_team_grants
        (id, organization_id, project_id, team_id, role, created_by)
      VALUES
        ('${IDS.grantA}', '${IDS.organizationA}', '${IDS.projectA}', '${IDS.teamA}', 'editor', '${IDS.owner}');
      SET ROLE opengeo_runtime;
    `);
  });

  after(async () => {
    await db.exec("RESET ROLE");
    await db.close();
  });

  it("resolves the strongest direct or active-team role without making membership implicit", async () => {
    const result = await inTenant(IDS.organizationA, IDS.member, async () => ({
      inherited: (await db.query("SELECT app.effective_project_role($1) AS role", [IDS.projectA])).rows[0].role,
      directRows: (await db.query(
        "SELECT role::text FROM app.project_memberships WHERE project_id = $1 AND user_id = $2",
        [IDS.projectA, IDS.member]
      )).rows
    }));
    assert.deepEqual(result, {inherited: "editor", directRows: []});
  });

  it("uses the strongest grant and drops inherited access when the team is archived", async () => {
    await inTenant(IDS.organizationA, IDS.owner, () => db.query(
      "INSERT INTO app.project_memberships (organization_id, project_id, user_id, role) VALUES ($1, $2, $3, 'viewer')",
      [IDS.organizationA, IDS.projectA, IDS.member]
    ));
    const strongest = await inTenant(IDS.organizationA, IDS.member, () =>
      db.query("SELECT app.effective_project_role($1) AS role", [IDS.projectA])
    );
    assert.equal(strongest.rows[0].role, "editor");

    await inTenant(IDS.organizationA, IDS.owner, () =>
      db.query("UPDATE app.teams SET status = 'archived' WHERE id = $1", [IDS.teamA])
    );
    const direct = await inTenant(IDS.organizationA, IDS.member, () =>
      db.query("SELECT app.effective_project_role($1) AS role", [IDS.projectA])
    );
    assert.equal(direct.rows[0].role, "viewer");
  });

  it("keeps team and grant rows tenant-isolated", async () => {
    const visible = await inTenant(IDS.organizationA, IDS.owner, async () => ({
      teams: (await db.query("SELECT id FROM app.teams ORDER BY id")).rows,
      grants: (await db.query("SELECT id FROM app.project_team_grants ORDER BY id")).rows
    }));
    assert.deepEqual(visible, {
      teams: [{id: IDS.teamA}],
      grants: [{id: IDS.grantA}]
    });
    await assert.rejects(
      inTenant(IDS.organizationA, IDS.owner, () => db.query(
        "INSERT INTO app.project_team_grants (organization_id, project_id, team_id, role, created_by) VALUES ($1, $2, $3, 'viewer', $4)",
        [IDS.organizationB, IDS.projectB, IDS.teamB, IDS.owner]
      )),
      /row-level security policy|violates foreign key constraint/
    );
  });

  it("keeps the team tables unavailable to non-API runtime roles", () => {
    assert.match(migration, /FORCE ROW LEVEL SECURITY/g);
    assert.match(migration, /membership alone grants no project access/i);
    assert.match(
      migration,
      /REVOKE ALL ON\s+app\.teams,\s+app\.team_memberships,\s+app\.project_team_grants\s+FROM opengeo_worker, opengeo_connector, opengeo_observable_coordinator/
    );
  });
});

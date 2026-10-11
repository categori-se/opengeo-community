import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, describe, it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

const IDS = {
  organization: "10000000-0000-4000-8000-000000000063",
  user: "20000000-0000-4000-8000-000000000063",
  project: "50000000-0000-4000-8000-000000000063"
};

let db;

async function inTenant(operation) {
  await db.exec("BEGIN");
  try {
    await db.query("SELECT set_config('app.organization_id', $1, true)", [IDS.organization]);
    await db.query("SELECT set_config('app.user_id', $1, true)", [IDS.user]);
    const result = await operation();
    await db.exec("COMMIT");
    return result;
  } catch (error) {
    await db.exec("ROLLBACK");
    throw error;
  }
}

describe("0063 project publication visibility migration", () => {
  before(async () => {
    db = new PGlite();
    for (const name of ["0001_platform_foundation.sql", "0063_project_publication_visibility.sql"]) {
      const source = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
      await db.exec(source.replace(/^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm, ""));
    }
    await db.exec(`
      INSERT INTO app.users (id, cognito_subject, email, display_name)
      VALUES ('${IDS.user}', 'project-publication-user', 'owner@example.test', 'Owner');
      SET ROLE opengeo_runtime;
    `);
    await inTenant(async () => {
      await db.query(
        "INSERT INTO app.organizations (id, name, slug, created_by) VALUES ($1, 'Demo site', 'demo-site', $2)",
        [IDS.organization, IDS.user]
      );
      await db.query(
        "INSERT INTO app.organization_memberships (organization_id, user_id, role, invited_by) VALUES ($1, $2, 'admin', $2)",
        [IDS.organization, IDS.user]
      );
      await db.query(
        "INSERT INTO app.projects (id, organization_id, name, project_code, created_by) VALUES ($1, $2, 'Starter', 'STARTER', $3)",
        [IDS.project, IDS.organization, IDS.user]
      );
    });
  });

  after(async () => {
    await db.exec("RESET ROLE");
    await db.close();
  });

  it("starts internal and records a verified publisher when marked published", async () => {
    const initial = await inTenant(() => db.query(
      "SELECT visibility::text, published_at, published_by FROM app.projects WHERE id = $1",
      [IDS.project]
    ));
    assert.deepEqual(initial.rows, [{visibility: "internal", published_at: null, published_by: null}]);

    const published = await inTenant(() => db.query(
      `UPDATE app.projects
       SET visibility = 'published', published_at = clock_timestamp(), published_by = $2
       WHERE id = $1
       RETURNING visibility::text, published_at IS NOT NULL AS timestamped, published_by`,
      [IDS.project, IDS.user]
    ));
    assert.deepEqual(published.rows, [{visibility: "published", timestamped: true, published_by: IDS.user}]);
  });

  it("rejects a published label without publication attribution", async () => {
    await assert.rejects(
      inTenant(() => db.query(
        "UPDATE app.projects SET visibility = 'published', published_at = NULL, published_by = NULL WHERE id = $1",
        [IDS.project]
      )),
      /projects_publication_state_consistent/
    );
  });
});

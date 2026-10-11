import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, describe, it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

const IDS = {
  organizationA: "10000000-0000-4000-8000-000000000001",
  organizationB: "10000000-0000-4000-8000-000000000002",
  userA: "20000000-0000-4000-8000-000000000001",
  userB: "20000000-0000-4000-8000-000000000002",
  clientA: "30000000-0000-4000-8000-000000000001",
  clientB: "30000000-0000-4000-8000-000000000002",
  projectA: "50000000-0000-4000-8000-000000000001",
  projectB: "50000000-0000-4000-8000-000000000002",
  mapA: "60000000-0000-4000-8000-000000000001",
  mapB: "60000000-0000-4000-8000-000000000002",
  eventA: "40000000-0000-4000-8000-000000000001"
};

let db;
let migrationSql;

async function inTenant(organizationId, userId, operation) {
  await db.exec("BEGIN");
  try {
    await db.query("SELECT set_config('app.organization_id', $1, true)", [
      organizationId
    ]);
    await db.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const result = await operation();
    await db.exec("COMMIT");
    return result;
  } catch (error) {
    await db.exec("ROLLBACK");
    throw error;
  }
}

describe("0001 platform foundation migration", () => {
  before(async () => {
    db = new PGlite();
    const migrationUrl = new URL(
      "../migrations/0001_platform_foundation.sql",
      import.meta.url
    );
    migrationSql = await readFile(migrationUrl, "utf8");
    const pgliteCompatibleMigration = migrationSql.replace(
      /^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm,
      ""
    );

    // PGlite executes real PostgreSQL for schema/RLS tests but does not bundle
    // PostGIS. RDS extension availability is checked separately at deployment.
    await db.exec(pgliteCompatibleMigration);
    await db.exec(`
      INSERT INTO app.users (id, cognito_subject, email, display_name)
      VALUES
        ('${IDS.userA}', 'cognito-a', 'ada@example.test', 'Ada'),
        ('${IDS.userB}', 'cognito-b', 'ben@example.test', 'Ben');

      SET ROLE opengeo_runtime;
    `);

    await inTenant(IDS.organizationA, IDS.userA, () =>
      db.query(
        `INSERT INTO app.organizations (id, name, slug, created_by)
         VALUES ($1, 'Organization A', 'organization-a', $2)`,
        [IDS.organizationA, IDS.userA]
      )
    );
    await inTenant(IDS.organizationB, IDS.userB, () =>
      db.query(
        `INSERT INTO app.organizations (id, name, slug, created_by)
         VALUES ($1, 'Organization B', 'organization-b', $2)`,
        [IDS.organizationB, IDS.userB]
      )
    );
    await inTenant(IDS.organizationA, IDS.userA, () =>
      db.query(
        `INSERT INTO app.organization_memberships
           (organization_id, user_id, role, invited_by)
         VALUES ($1, $2, 'admin', $2)`,
        [IDS.organizationA, IDS.userA]
      )
    );
    await inTenant(IDS.organizationB, IDS.userB, () =>
      db.query(
        `INSERT INTO app.organization_memberships
           (organization_id, user_id, role, invited_by)
         VALUES ($1, $2, 'admin', $2)`,
        [IDS.organizationB, IDS.userB]
      )
    );
    await inTenant(IDS.organizationA, IDS.userA, () =>
      db.query(
        `INSERT INTO app.clients
           (id, organization_id, name, client_code, created_by)
         VALUES ($1, $2, 'Client A', 'A', $3)`,
        [IDS.clientA, IDS.organizationA, IDS.userA]
      )
    );
    await inTenant(IDS.organizationB, IDS.userB, () =>
      db.query(
        `INSERT INTO app.clients
           (id, organization_id, name, client_code, created_by)
         VALUES ($1, $2, 'Client B', 'B', $3)`,
        [IDS.clientB, IDS.organizationB, IDS.userB]
      )
    );
    await inTenant(IDS.organizationA, IDS.userA, () =>
      db.query(
        `INSERT INTO app.projects
           (id, organization_id, client_id, name, project_code, created_by)
         VALUES ($1, $2, $3, 'Project A', 'PA', $4)`,
        [IDS.projectA, IDS.organizationA, IDS.clientA, IDS.userA]
      )
    );
    await inTenant(IDS.organizationB, IDS.userB, () =>
      db.query(
        `INSERT INTO app.projects
           (id, organization_id, client_id, name, project_code, created_by)
         VALUES ($1, $2, $3, 'Project B', 'PB', $4)`,
        [IDS.projectB, IDS.organizationB, IDS.clientB, IDS.userB]
      )
    );
    await inTenant(IDS.organizationA, IDS.userA, () =>
      db.query(
        `INSERT INTO app.maps
           (id, organization_id, project_id, name, created_by, updated_by)
         VALUES ($1, $2, $3, 'Map A', $4, $4)`,
        [IDS.mapA, IDS.organizationA, IDS.projectA, IDS.userA]
      )
    );
    await inTenant(IDS.organizationB, IDS.userB, () =>
      db.query(
        `INSERT INTO app.maps
           (id, organization_id, project_id, name, created_by, updated_by)
         VALUES ($1, $2, $3, 'Map B', $4, $4)`,
        [IDS.mapB, IDS.organizationB, IDS.projectB, IDS.userB]
      )
    );
  });

  after(async () => {
    await db.exec("RESET ROLE");
    await db.close();
  });

  it("installs the expected base tables", async () => {
    const result = await db.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'app'
      ORDER BY table_name
    `);

    assert.deepEqual(
      result.rows.map(({table_name}) => table_name),
      [
        "activity_events",
        "client_memberships",
        "clients",
        "map_versions",
        "maps",
        "organization_memberships",
        "organizations",
        "project_memberships",
        "projects",
        "users"
      ]
    );
  });

  it("only exposes organization, client, project, and map rows from the active tenant", async () => {
    const result = await inTenant(IDS.organizationA, IDS.userA, async () => ({
      organizations: (await db.query("SELECT id FROM app.organizations ORDER BY id")).rows,
      clients: (await db.query("SELECT id FROM app.clients ORDER BY id")).rows,
      projects: (await db.query("SELECT id FROM app.projects ORDER BY id")).rows,
      maps: (await db.query("SELECT id FROM app.maps ORDER BY id")).rows
    }));

    assert.deepEqual(result, {
      organizations: [{id: IDS.organizationA}],
      clients: [{id: IDS.clientA}],
      projects: [{id: IDS.projectA}],
      maps: [{id: IDS.mapA}]
    });
  });

  it("cannot address cross-tenant records directly", async () => {
    const result = await inTenant(IDS.organizationA, IDS.userA, async () => ({
      organization: (
        await db.query("SELECT id FROM app.organizations WHERE id = $1", [
          IDS.organizationB
        ])
      ).rows,
      client: (
        await db.query("SELECT id FROM app.clients WHERE id = $1", [IDS.clientB])
      ).rows,
      project: (
        await db.query("SELECT id FROM app.projects WHERE id = $1", [IDS.projectB])
      ).rows,
      map: (await db.query("SELECT id FROM app.maps WHERE id = $1", [IDS.mapB])).rows
    }));

    assert.deepEqual(result, {
      organization: [],
      client: [],
      project: [],
      map: []
    });
  });

  it("fails closed without a valid tenant context", async () => {
    const withoutContext = await Promise.all(
      ["organizations", "clients", "projects", "maps"].map((table) =>
        db.query(`SELECT id FROM app.${table}`)
      )
    );
    assert.deepEqual(
      withoutContext.map(({rows}) => rows),
      [[], [], [], []]
    );

    await assert.rejects(
      inTenant("not-a-uuid", IDS.userA, () => db.query("SELECT id FROM app.clients")),
      /invalid input syntax for type uuid/
    );
  });

  it("only exposes user profiles in the active organization", async () => {
    const result = await inTenant(IDS.organizationA, IDS.userA, () =>
      db.query("SELECT id, display_name FROM app.users ORDER BY id")
    );

    assert.deepEqual(result.rows, [{id: IDS.userA, display_name: "Ada"}]);
  });

  it("resolves memberships only through the verified-subject function", async () => {
    const directUsers = await db.query("SELECT id FROM app.users");
    const directMemberships = await db.query(
      "SELECT organization_id FROM app.organization_memberships"
    );
    const resolved = await db.query(
      "SELECT * FROM app.resolve_principal('cognito-a')"
    );
    const unknown = await db.query(
      "SELECT * FROM app.resolve_principal('unknown-subject')"
    );

    assert.deepEqual(directUsers.rows, []);
    assert.deepEqual(directMemberships.rows, []);
    assert.deepEqual(resolved.rows, [
      {
        user_id: IDS.userA,
        email: "ada@example.test",
        display_name: "Ada",
        organization_id: IDS.organizationA,
        organization_role: "admin",
      },
    ]);
    assert.deepEqual(unknown.rows, []);
  });

  it("keeps runtime grants explicit and future objects private", async () => {
    const grants = await db.query(`
      SELECT
        has_function_privilege(
          'opengeo_runtime',
          'app.resolve_principal(text)',
          'EXECUTE'
        ) AS can_resolve_principal,
        has_function_privilege(
          'opengeo_runtime',
          'app.set_updated_at()',
          'EXECUTE'
        ) AS can_call_internal_trigger,
        has_table_privilege(
          'opengeo_runtime',
          'app.activity_events',
          'UPDATE'
        ) AS can_update_activity,
        has_column_privilege(
          'opengeo_runtime',
          'app.users',
          'cognito_subject',
          'UPDATE'
        ) AS can_change_subject,
        has_column_privilege(
          'opengeo_runtime',
          'app.users',
          'display_name',
          'UPDATE'
        ) AS can_change_display_name
    `);

    assert.deepEqual(grants.rows, [
      {
        can_resolve_principal: true,
        can_call_internal_trigger: false,
        can_update_activity: false,
        can_change_subject: false,
        can_change_display_name: true
      }
    ]);

    assert.match(
      migrationSql,
      /ALTER DEFAULT PRIVILEGES IN SCHEMA app\s+REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC/
    );
    assert.match(
      migrationSql,
      /ALTER DEFAULT PRIVILEGES IN SCHEMA app\s+REVOKE ALL ON TABLES FROM opengeo_runtime/
    );

    await db.exec("RESET ROLE");
    await db.exec("CREATE TABLE app.future_private_table (id integer PRIMARY KEY)");
    await db.exec("SET ROLE opengeo_runtime");
    await assert.rejects(
      db.query("SELECT * FROM app.future_private_table"),
      /permission denied/
    );
  });

  it("rejects writes that claim another organization", async () => {
    await assert.rejects(
      inTenant(IDS.organizationA, IDS.userA, () =>
        db.query(
          `INSERT INTO app.clients
             (organization_id, name, client_code, created_by)
           VALUES ($1, 'Tenant escape', 'ESCAPE', $2)`,
          [IDS.organizationB, IDS.userA]
        )
      ),
      /row-level security policy/
    );
  });

  it("keeps activity events append-only", async () => {
    await inTenant(IDS.organizationA, IDS.userA, () =>
      db.query(
        `INSERT INTO app.activity_events
           (id, organization_id, actor_user_id, event_type, resource_type,
            resource_id, request_id)
         VALUES ($1, $2, $3, 'client.created', 'client', $4, 'request-1')`,
        [IDS.eventA, IDS.organizationA, IDS.userA, IDS.clientA]
      )
    );

    await assert.rejects(
      inTenant(IDS.organizationA, IDS.userA, () =>
        db.query(
          "UPDATE app.activity_events SET payload = '{\"changed\": true}' WHERE id = $1",
          [IDS.eventA]
        )
      ),
      /permission denied|activity events are append-only/
    );
  });

  it("commits map compare-and-swap, history, and activity as one tenant transaction", async () => {
    const eventId = "40000000-0000-4000-8000-000000000002";
    const result = await inTenant(IDS.organizationA, IDS.userA, async () => {
      const updated = await db.query(
        `UPDATE app.maps
         SET name = 'Map A revised', version = version + 1, updated_by = $1
         WHERE organization_id = $2 AND project_id = $3 AND id = $4 AND version = 1
         RETURNING version, definition`,
        [IDS.userA, IDS.organizationA, IDS.projectA, IDS.mapA]
      );
      assert.equal(updated.rows.length, 1);

      await db.query(
        `INSERT INTO app.map_versions
           (organization_id, map_id, version, definition, change_message, created_by)
         VALUES ($1, $2, $3, $4, 'Rename map', $5)`,
        [
          IDS.organizationA,
          IDS.mapA,
          updated.rows[0].version,
          updated.rows[0].definition,
          IDS.userA
        ]
      );
      await db.query(
        `INSERT INTO app.activity_events
           (id, organization_id, actor_user_id, project_id, event_type,
            resource_type, resource_id, request_id, payload)
         VALUES ($1, $2, $3, $4, 'map.updated', 'map', $5,
                 'request-map-update', $6)`,
        [
          eventId,
          IDS.organizationA,
          IDS.userA,
          IDS.projectA,
          IDS.mapA,
          JSON.stringify({version: 2})
        ]
      );
      return updated.rows[0];
    });

    assert.equal(result.version, 2);
    const committed = await inTenant(IDS.organizationA, IDS.userA, async () => ({
      map: (
        await db.query("SELECT name, version FROM app.maps WHERE id = $1", [IDS.mapA])
      ).rows,
      versions: (
        await db.query(
          "SELECT version, change_message FROM app.map_versions WHERE map_id = $1",
          [IDS.mapA]
        )
      ).rows,
      events: (
        await db.query(
          "SELECT event_type, payload FROM app.activity_events WHERE id = $1",
          [eventId]
        )
      ).rows
    }));
    assert.deepEqual(committed, {
      map: [{name: "Map A revised", version: 2}],
      versions: [{version: 2, change_message: "Rename map"}],
      events: [{event_type: "map.updated", payload: {version: 2}}]
    });

    const stale = await inTenant(IDS.organizationA, IDS.userA, () =>
      db.query(
        `UPDATE app.maps
         SET version = version + 1
         WHERE organization_id = $1 AND id = $2 AND version = 1
         RETURNING version`,
        [IDS.organizationA, IDS.mapA]
      )
    );
    assert.deepEqual(stale.rows, []);
  });

  it("rolls back a map update and version when its activity insert fails", async () => {
    await assert.rejects(
      inTenant(IDS.organizationA, IDS.userA, async () => {
        const updated = await db.query(
          `UPDATE app.maps
           SET name = 'Must roll back', version = version + 1, updated_by = $1
           WHERE organization_id = $2 AND id = $3 AND version = 2
           RETURNING version, definition`,
          [IDS.userA, IDS.organizationA, IDS.mapA]
        );
        await db.query(
          `INSERT INTO app.map_versions
             (organization_id, map_id, version, definition, created_by)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            IDS.organizationA,
            IDS.mapA,
            updated.rows[0].version,
            updated.rows[0].definition,
            IDS.userA
          ]
        );
        await db.query(
          `INSERT INTO app.activity_events
             (organization_id, actor_user_id, project_id, event_type,
              resource_type, resource_id, request_id)
           VALUES ($1, $2, $3, 'INVALID EVENT', 'map', $4, 'request-must-rollback')`,
          [IDS.organizationA, IDS.userA, IDS.projectA, IDS.mapA]
        );
      }),
      /activity_event_type_format|violates check constraint/
    );

    const afterRollback = await inTenant(IDS.organizationA, IDS.userA, async () => ({
      map: (
        await db.query("SELECT name, version FROM app.maps WHERE id = $1", [IDS.mapA])
      ).rows,
      versionThree: (
        await db.query(
          "SELECT version FROM app.map_versions WHERE map_id = $1 AND version = 3",
          [IDS.mapA]
        )
      ).rows,
      failedEvent: (
        await db.query(
          "SELECT id FROM app.activity_events WHERE request_id = 'request-must-rollback'"
        )
      ).rows
    }));
    assert.deepEqual(afterRollback, {
      map: [{name: "Map A revised", version: 2}],
      versionThree: [],
      failedEvent: []
    });
  });

  it("returns large map definitions only as bounded UTF-8 byte chunks", async () => {
    const definition = {
      layers: [{id: "multibyte-style", style: "界".repeat(30_000)}],
      bookmarks: []
    };
    const metadata = await inTenant(IDS.organizationA, IDS.userA, () =>
      db.query(
        `UPDATE app.maps
         SET definition = $1::jsonb, updated_by = $2
         WHERE organization_id = $3 AND project_id = $4 AND id = $5
         RETURNING octet_length(definition::text) AS definition_bytes`,
        [
          JSON.stringify(definition),
          IDS.userA,
          IDS.organizationA,
          IDS.projectA,
          IDS.mapA
        ]
      )
    );
    const definitionBytes = metadata.rows[0].definition_bytes;
    assert.ok(definitionBytes > 65_536);

    const chunkSize = 24_576;
    const chunkCount = Math.ceil(definitionBytes / chunkSize);
    const chunks = await inTenant(IDS.organizationA, IDS.userA, () =>
      db.query(
        `SELECT map.id, chunk.chunk_index,
                substring(
                  convert_to(map.definition::text, 'UTF8')
                  FROM chunk.chunk_index * $1 + 1
                  FOR $1
                ) AS definition_chunk
         FROM app.maps map
         CROSS JOIN LATERAL generate_series(
           0,
           (octet_length(map.definition::text) - 1) / $1
         ) AS chunk(chunk_index)
         WHERE map.organization_id = $2
           AND map.project_id = $3
           AND map.id IN (
             SELECT value::uuid
             FROM jsonb_array_elements_text($4::jsonb) requested(value)
           )
         ORDER BY map.id, chunk.chunk_index`,
        [
          chunkSize,
          IDS.organizationA,
          IDS.projectA,
          JSON.stringify([IDS.mapA])
        ]
      )
    );

    assert.equal(chunks.rows.length, chunkCount);
    assert.ok(chunks.rows.every(({id}) => id === IDS.mapA));
    assert.deepEqual(
      chunks.rows.map(({chunk_index}) => chunk_index),
      Array.from({length: chunkCount}, (_, index) => index)
    );
    assert.ok(
      chunks.rows.every(
        ({definition_chunk}) => Buffer.from(definition_chunk).byteLength <= chunkSize
      )
    );
    const reconstructed = Buffer.concat(
      chunks.rows.map(({definition_chunk}) => Buffer.from(definition_chunk))
    );
    assert.equal(reconstructed.byteLength, definitionBytes);
    assert.deepEqual(JSON.parse(reconstructed.toString("utf8")), definition);

    const hidden = await inTenant(IDS.organizationB, IDS.userB, () =>
      db.query(
        `SELECT substring(convert_to(definition::text, 'UTF8') FROM 1 FOR $1)
         FROM app.maps
         WHERE organization_id = $2 AND id = $3`,
        [chunkSize, IDS.organizationA, IDS.mapA]
      )
    );
    assert.deepEqual(hidden.rows, []);
  });
});

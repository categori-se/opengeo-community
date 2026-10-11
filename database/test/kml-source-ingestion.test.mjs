import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, describe, it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

const IDS = {
  organization: "10000000-0000-4000-8000-000000000031",
  user: "20000000-0000-4000-8000-000000000031",
  project: "50000000-0000-4000-8000-000000000031"
};

let db;

describe("0128 KML source format compatibility", () => {
  before(async () => {
    db = new PGlite();
    for (const file of [
      "0001_platform_foundation.sql",
      "0002_membership_invitations.sql",
      "0003_managed_ingestion_foundation.sql",
      "0026_general_media_ingestion.sql",
      "0029_governed_pdf_documents.sql",
      "0031_governed_odf_text_documents.sql",
      "0128_kml_source_ingestion.sql"
    ]) {
      const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8");
      await db.exec(sql.replace(/^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm, ""));
    }
    await db.exec(`
      INSERT INTO app.users (id, cognito_subject, email, display_name)
      VALUES ('${IDS.user}', 'odf-user', 'odf@example.test', 'ODF User');
      INSERT INTO app.organizations (id, name, slug, created_by)
      VALUES ('${IDS.organization}', 'Open documents', 'open-documents', '${IDS.user}');
      INSERT INTO app.organization_memberships (organization_id, user_id, role, invited_by)
      VALUES ('${IDS.organization}', '${IDS.user}', 'admin', '${IDS.user}');
      INSERT INTO app.projects (id, organization_id, name, created_by)
      VALUES ('${IDS.project}', '${IDS.organization}', 'ODF project', '${IDS.user}');
    `);
  });

  after(async () => {
    await db.close();
  });

  it("adds KML while retaining existing ODT datasets", async () => {
    const formats = await db.query(`
      SELECT enumlabel
      FROM pg_enum
      JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
      JOIN pg_namespace ON pg_namespace.oid = pg_type.typnamespace
      WHERE pg_namespace.nspname = 'app' AND pg_type.typname = 'dataset_format'
      ORDER BY enumsortorder
    `);
    assert.equal(formats.rows.at(-1).enumlabel, "kml");

    await db.query(
      `INSERT INTO app.datasets
         (organization_id, name, classification, source_type, format,
          owner_user_id, created_by, updated_by)
       VALUES ($1, 'Field report', 'internal', 'upload', 'odt', $2, $2, $2),
              ($1, 'Survey source', 'internal', 'upload', 'kml', $2, $2, $2)`,
      [IDS.organization, IDS.user]
    );
    const records = await db.query(
      "SELECT source_type::text, format::text FROM app.datasets ORDER BY format::text"
    );
    assert.deepEqual(records.rows, [{source_type: "upload", format: "kml"}, {source_type: "upload", format: "odt"}]);
  });
});

import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, describe, it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

const ID = {
  organization: "10000000-0000-4000-8000-000000000251",
  otherOrganization: "10000000-0000-4000-8000-000000000252",
  user: "20000000-0000-4000-8000-000000000251",
  otherUser: "20000000-0000-4000-8000-000000000252",
  project: "50000000-0000-4000-8000-000000000251",
  resource: "a0000000-0000-4000-8000-000000000251",
  resourceVersion: "a1000000-0000-4000-8000-000000000251",
  site: "b0000000-0000-4000-8000-000000000251",
  siteVersion: "b1000000-0000-4000-8000-000000000251",
  nextSiteVersion: "b1000000-0000-4000-8000-000000000252",
  page: "b2000000-0000-4000-8000-000000000251",
  nextPage: "b2000000-0000-4000-8000-000000000252",
  reviewEvent: "b3000000-0000-4000-8000-000000000251",
  publishEvent: "b3000000-0000-4000-8000-000000000252",
  edition: "b4000000-0000-4000-8000-000000000251",
  documentResource: "a0000000-0000-4000-8000-000000000253",
  documentResourceVersion: "a1000000-0000-4000-8000-000000000253",
  documentSite: "b0000000-0000-4000-8000-000000000253",
  documentSiteVersion: "b1000000-0000-4000-8000-000000000253",
  documentPage: "b2000000-0000-4000-8000-000000000253",
  documentReviewEvent: "b3000000-0000-4000-8000-000000000253",
  documentEdition: "b4000000-0000-4000-8000-000000000253",
  documentDataset: "80000000-0000-4000-8000-000000000253",
  documentDatasetVersion: "81000000-0000-4000-8000-000000000253",
  documentOriginalObject: "82000000-0000-4000-8000-000000000253",
  documentPreviewObject: "83000000-0000-4000-8000-000000000253",
  pdfResource: "a0000000-0000-4000-8000-000000000254",
  pdfResourceVersion: "a1000000-0000-4000-8000-000000000254",
  pdfSite: "b0000000-0000-4000-8000-000000000254",
  pdfSiteVersion: "b1000000-0000-4000-8000-000000000254",
  pdfPage: "b2000000-0000-4000-8000-000000000254",
  pdfReviewEvent: "b3000000-0000-4000-8000-000000000254",
  pdfEdition: "b4000000-0000-4000-8000-000000000254",
  pdfDataset: "80000000-0000-4000-8000-000000000254",
  pdfDatasetVersion: "81000000-0000-4000-8000-000000000254",
  pdfOriginalObject: "82000000-0000-4000-8000-000000000254",
  pdfPreviewObject: "83000000-0000-4000-8000-000000000254"
};

const migrations = Array.from(
  {length: 35},
  (_, index) => `${String(index + 1).padStart(4, "0")}_${[
    "platform_foundation",
    "membership_invitations",
    "managed_ingestion_foundation",
    "worker_execution_boundary",
    "catalog_access",
    "governed_external_sources",
    "governed_pmtiles_sources",
    "recoverable_project_imports",
    "governed_resources",
    "resource_governance",
    "governed_rendering",
    "raster_reprojection",
    "wms_basic_presentation",
    "ordered_map_compositions",
    "governed_wms_publications",
    "public_wms_services",
    "metadata_governance",
    "metadata_source_documents",
    "multilingual_metadata",
    "extended_metadata_exchange",
    "governed_feature_editing",
    "field_capture",
    "spatial_service_catalog",
    "durable_tile_cache",
    "portable_site_publications",
    "general_media_ingestion",
    "print_layout_publications",
    "positioned_site_print_layouts",
    "governed_pdf_documents",
    "rich_positioned_print_layouts",
    "governed_odf_text_documents",
    "public_odf_text_documents",
    "public_pdf_semantic_documents",
    "public_pdf_visual_presentations",
    "public_pdf_ocr_documents"
  ][index]}.sql`
);

let db;
let productionMigration;
let printLayoutMigration;
let positionedLayoutMigration;
let richPositionedLayoutMigration;
let publicOdfDocumentMigration;
let publicPdfSemanticMigration;
let publicPdfVisualMigration;
let publicPdfOcrMigration;

async function tenant(organizationId, userId, operation) {
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

function pgliteSpatialMigration(sql) {
  return sql
    .replaceAll("geometry geometry(Geometry, 4326) NOT NULL", "geometry jsonb NOT NULL")
    .replace(
      /bbox double precision\[\] GENERATED ALWAYS AS \(\s*ARRAY\[\s*ST_XMin\(Box3D\(geometry\)\),\s*ST_YMin\(Box3D\(geometry\)\),\s*ST_XMax\(Box3D\(geometry\)\),\s*ST_YMax\(Box3D\(geometry\)\)\s*\]\s*\) STORED/s,
      "bbox double precision[] NOT NULL"
    )
    .replace(
      /,\s*CONSTRAINT dataset_features_geometry_type_match CHECK \(.*?\)\s*,\s*CONSTRAINT dataset_features_geometry_safe CHECK \(.*?\)\s*,/s,
      ","
    )
    .replace(
      /,\s*CONSTRAINT dataset_feature_revisions_geometry_type_match CHECK \(.*?\)\s*,\s*CONSTRAINT dataset_feature_revisions_geometry_safe CHECK \(.*?\)\s*,/s,
      ","
    )
    .replace(
      /,\s*CONSTRAINT field_submissions_geometry_type_match CHECK \(.*?\)\s*,\s*CONSTRAINT field_submissions_geometry_safe CHECK \(.*?\)\s*,/s,
      ","
    )
    .replace(
      /CREATE INDEX dataset_features_geometry_idx\s+ON app\.dataset_features USING gist \(geometry\)\s+WHERE deleted_at IS NULL;/s,
      ""
    )
    .replaceAll("ST_Equals(revision.geometry, NEW.geometry)", "revision.geometry = NEW.geometry")
    .replaceAll(
      "NOT ST_Equals(OLD.geometry, NEW.geometry)",
      "OLD.geometry IS DISTINCT FROM NEW.geometry"
    );
}

function documentManifest(schemaVersion, checksum = "e".repeat(64)) {
  return {
    schemaVersion,
    organizationId: ID.organization,
    projectId: ID.project,
    siteId: ID.documentSite,
    siteVersionId: ID.documentSiteVersion,
    siteVersionNumber: 1,
    editionId: ID.documentEdition,
    editionNumber: 1,
    themeOptions: {},
    printLayout: {schemaVersion: "opengeo.print-layout.1.1.0", pages: []},
    pages: [{
      slug: "report",
      navigationLabel: "Report",
      position: 0,
      home: true,
      resourceId: ID.documentResource,
      resourceVersionId: ID.documentResourceVersion,
      resourceVersionNumber: 1
    }],
    references: [],
    assets: [{
      kind: "document",
      datasetId: ID.documentDataset,
      datasetVersionId: ID.documentDatasetVersion,
      objectId: ID.documentPreviewObject,
      storageVersionId: "odt-preview-v1",
      contentType: "application/json",
      sizeBytes: 2048,
      checksumSha256: checksum,
      filename: "accessible-preview.json"
    }]
  };
}

function pdfDocumentManifest(checksum = "a".repeat(64)) {
  const manifest = documentManifest("opengeo.site-edition.1.4.0", checksum);
  manifest.siteId = ID.pdfSite;
  manifest.siteVersionId = ID.pdfSiteVersion;
  manifest.editionId = ID.pdfEdition;
  manifest.pages[0].slug = "pdf-report";
  manifest.pages[0].navigationLabel = "PDF report";
  manifest.pages[0].resourceId = ID.pdfResource;
  manifest.pages[0].resourceVersionId = ID.pdfResourceVersion;
  manifest.assets[0] = {
    kind: "document",
    datasetId: ID.pdfDataset,
    datasetVersionId: ID.pdfDatasetVersion,
    objectId: ID.pdfPreviewObject,
    storageVersionId: "pdf-visual-presentation-v1",
    contentType: "application/json",
    sizeBytes: 1000000,
    checksumSha256: checksum,
    filename: "visual-presentation.json"
  };
  return manifest;
}

describe("0025 portable site publications", () => {
  before(async () => {
    db = new PGlite();
    for (const file of migrations) {
      let sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8");
      sql = sql.replace(/^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm, "");
      if (["0021_governed_feature_editing.sql", "0022_field_capture.sql"].includes(file)) {
        sql = pgliteSpatialMigration(sql);
      }
      if (file === "0025_portable_site_publications.sql") productionMigration = sql;
      if (file === "0027_print_layout_publications.sql") printLayoutMigration = sql;
      if (file === "0028_positioned_site_print_layouts.sql") positionedLayoutMigration = sql;
      if (file === "0030_rich_positioned_print_layouts.sql") richPositionedLayoutMigration = sql;
      if (file === "0032_public_odf_text_documents.sql") publicOdfDocumentMigration = sql;
      if (file === "0033_public_pdf_semantic_documents.sql") publicPdfSemanticMigration = sql;
      if (file === "0034_public_pdf_visual_presentations.sql") publicPdfVisualMigration = sql;
      if (file === "0035_public_pdf_ocr_documents.sql") publicPdfOcrMigration = sql;
      await db.exec(sql);
    }
    await db.exec(`
      INSERT INTO app.users (id, cognito_subject, email, display_name)
      VALUES
        ('${ID.user}', 'publisher', 'publisher@example.test', 'Publisher'),
        ('${ID.otherUser}', 'outsider', 'outsider@example.test', 'Outsider');
      INSERT INTO app.organizations (id, name, slug, created_by)
      VALUES
        ('${ID.organization}', 'Publishing', 'publishing', '${ID.user}'),
        ('${ID.otherOrganization}', 'Other', 'other-publishing', '${ID.otherUser}');
      INSERT INTO app.organization_memberships (organization_id, user_id, role, invited_by)
      VALUES
        ('${ID.organization}', '${ID.user}', 'admin', '${ID.user}'),
        ('${ID.otherOrganization}', '${ID.otherUser}', 'admin', '${ID.otherUser}');
      INSERT INTO app.projects (id, organization_id, name, created_by)
      VALUES ('${ID.project}', '${ID.organization}', 'Reporting project', '${ID.user}');
    `);
    await tenant(ID.organization, ID.user, async () => {
      await db.exec("SET CONSTRAINTS ALL DEFERRED");
      await db.query(
        `INSERT INTO app.governed_resources
           (id, organization_id, project_id, kind, slug, visibility, state,
            current_version_id, owner_user_id, created_by, updated_by)
         VALUES ($1,$2,$3,'story','field-report','public','published',$4,$5,$5,$5)`,
        [ID.resource, ID.organization, ID.project, ID.resourceVersion, ID.user]
      );
      await db.query(
        `INSERT INTO app.governed_resource_versions
           (id, organization_id, resource_id, version_number, title, content, created_by)
         VALUES ($1,$2,$3,1,'Field report',
                 '{"blocks":[{"id":"intro","type":"markdown","markdown":"# Findings"}]}',
                 $4)`,
        [ID.resourceVersion, ID.organization, ID.resource, ID.user]
      );
      await db.query(
        `INSERT INTO app.governed_resources
           (id, organization_id, project_id, kind, slug, visibility, state,
            current_version_id, owner_user_id, created_by, updated_by)
         VALUES ($1,$2,$3,'story','odt-report','public','published',$4,$5,$5,$5)`,
        [
          ID.documentResource,
          ID.organization,
          ID.project,
          ID.documentResourceVersion,
          ID.user
        ]
      );
      await db.query(
        `INSERT INTO app.governed_resource_versions
           (id, organization_id, resource_id, version_number, title, content, created_by)
         VALUES ($1,$2,$3,1,'ODT field report',$4::jsonb,$5)`,
        [
          ID.documentResourceVersion,
          ID.organization,
          ID.documentResource,
          JSON.stringify({blocks: [{
            id: "field-report-document",
            type: "document",
            dataset_id: ID.documentDataset,
            dataset_version_id: ID.documentDatasetVersion,
            object_id: ID.documentPreviewObject,
            label: "Read the field report"
          }]}),
          ID.user
        ]
      );
      await db.query(
        `INSERT INTO app.datasets
           (id, organization_id, name, classification, source_type, format, status,
            owner_user_id, created_by, updated_by)
         VALUES ($1,$2,'ODT field report','public','upload','odt','active',$3,$3,$3)`,
        [ID.documentDataset, ID.organization, ID.user]
      );
      for (const [objectId, role, key, version, contentType, size, checksum] of [
        [ID.documentOriginalObject, "original", "original/report.odt", "odt-source-v1",
          "application/vnd.oasis.opendocument.text", 4096, "d".repeat(64)],
        [ID.documentPreviewObject, "derived", "document/accessible-preview.json",
          "odt-preview-v1", "application/json", 2048, "e".repeat(64)]
      ]) {
        await db.query(
          `INSERT INTO app.data_objects
             (id, organization_id, dataset_id, role, bucket, object_key, s3_version_id,
              etag, content_type, size_bytes, checksum_sha256, created_by)
           VALUES ($1,$2,$3,$4,'opengeo-test-geodata',$5,$6,'etag',$7,$8,$9,$10)`,
          [
            objectId,
            ID.organization,
            ID.documentDataset,
            role,
            `organizations/${ID.organization}/datasets/${ID.documentDataset}/${key}`,
            version,
            contentType,
            size,
            checksum,
            ID.user
          ]
        );
      }
      await db.query(
        `INSERT INTO app.dataset_versions
           (id, organization_id, dataset_id, version_number, original_object_id, state,
            geometry_type, schema_definition, quality_results, created_by)
         VALUES ($1,$2,$3,1,$4,'active','document',$5::jsonb,$6::jsonb,$7)`,
        [
          ID.documentDatasetVersion,
          ID.organization,
          ID.documentDataset,
          ID.documentOriginalObject,
          JSON.stringify({document: {
            kind: "odf_text",
            source_format: "odt",
            accessible_preview_schema: "opengeo.document-preview.1.0.0"
          }}),
          JSON.stringify({safety_scan: {
            status: "passed",
            engine: "ClamAV",
            engine_version: "1.4.3",
            signature_version: 27900,
            comprehensive_malware_scan: true
          }}),
          ID.user
        ]
      );
      for (const objectId of [ID.documentPreviewObject]) {
        await db.query(
          `INSERT INTO app.dataset_version_objects
             (organization_id, dataset_id, dataset_version_id, data_object_id)
           VALUES ($1,$2,$3,$4)`,
          [
            ID.organization,
            ID.documentDataset,
            ID.documentDatasetVersion,
            objectId
          ]
        );
      }
      await db.query(
        "UPDATE app.datasets SET current_version_id=$1 WHERE id=$2",
        [ID.documentDatasetVersion, ID.documentDataset]
      );
      await db.query(
        `INSERT INTO app.project_datasets
           (organization_id, project_id, dataset_id, linked_by)
         VALUES ($1,$2,$3,$4)`,
        [ID.organization, ID.project, ID.documentDataset, ID.user]
      );
      await db.query(
        `INSERT INTO app.governed_resources
           (id, organization_id, project_id, kind, slug, visibility, state,
            current_version_id, owner_user_id, created_by, updated_by)
         VALUES ($1,$2,$3,'story','pdf-report','public','published',$4,$5,$5,$5)`,
        [ID.pdfResource, ID.organization, ID.project, ID.pdfResourceVersion, ID.user]
      );
      await db.query(
        `INSERT INTO app.governed_resource_versions
           (id, organization_id, resource_id, version_number, title, content, created_by)
         VALUES ($1,$2,$3,1,'PDF investigation report',$4::jsonb,$5)`,
        [
          ID.pdfResourceVersion,
          ID.organization,
          ID.pdfResource,
          JSON.stringify({blocks: [{
            id: "investigation-pdf-document",
            type: "document",
            dataset_id: ID.pdfDataset,
            dataset_version_id: ID.pdfDatasetVersion,
            object_id: ID.pdfPreviewObject,
            label: "Read the PDF investigation"
          }]}),
          ID.user
        ]
      );
      await db.query(
        `INSERT INTO app.datasets
           (id, organization_id, name, classification, source_type, format, status,
            owner_user_id, created_by, updated_by)
         VALUES ($1,$2,'PDF investigation','public','upload','pdf','active',$3,$3,$3)`,
        [ID.pdfDataset, ID.organization, ID.user]
      );
      for (const [objectId, role, key, version, contentType, size, checksum] of [
        [ID.pdfOriginalObject, "original", "original/report.pdf", "pdf-source-v1",
          "application/pdf", 8192, "9".repeat(64)],
        [ID.pdfPreviewObject, "derived", "document/visual-presentation.json",
          "pdf-visual-presentation-v1", "application/json", 1000000, "a".repeat(64)]
      ]) {
        await db.query(
          `INSERT INTO app.data_objects
             (id, organization_id, dataset_id, role, bucket, object_key, s3_version_id,
              etag, content_type, size_bytes, checksum_sha256, created_by)
           VALUES ($1,$2,$3,$4,'opengeo-test-geodata',$5,$6,'etag',$7,$8,$9,$10)`,
          [
            objectId,
            ID.organization,
            ID.pdfDataset,
            role,
            `organizations/${ID.organization}/datasets/${ID.pdfDataset}/${key}`,
            version,
            contentType,
            size,
            checksum,
            ID.user
          ]
        );
      }
      await db.query(
        `INSERT INTO app.dataset_versions
           (id, organization_id, dataset_id, version_number, original_object_id, state,
            geometry_type, schema_definition, quality_results, created_by)
         VALUES ($1,$2,$3,1,$4,'active','document',$5::jsonb,$6::jsonb,$7)`,
        [
          ID.pdfDatasetVersion,
          ID.organization,
          ID.pdfDataset,
          ID.pdfOriginalObject,
          JSON.stringify({document: {
            kind: "pdf",
            source_format: "pdf",
            pdf_version: "1.7",
            page_count: 2,
            accessible_preview_schema: "opengeo.document-preview.2.0.0",
            text_extraction: "poppler_pdftotext",
            reading_order: "heuristic",
            ocr_performed: false,
            tagged: true,
            text_available: true,
            text_block_count: 4,
            text_characters: 1024,
            visual_presentation_schema: "opengeo.pdf-visual-presentation.1.0.0",
            visual_renderer: "poppler_pdftoppm",
            visual_media_type: "image/jpeg",
            visual_annotations_hidden: true,
            visual_page_count: 2,
            visual_target_max_dimension: 1000,
            visual_total_pixels: 1200000,
            visual_total_image_bytes: 700000
          }}),
          JSON.stringify({safety_scan: {
            status: "passed",
            engine: "ClamAV",
            engine_version: "1.4.3",
            signature_version: 27900,
            comprehensive_malware_scan: true
          }}),
          ID.user
        ]
      );
      await db.query(
        `INSERT INTO app.dataset_version_objects
           (organization_id, dataset_id, dataset_version_id, data_object_id)
         VALUES ($1,$2,$3,$4)`,
        [ID.organization, ID.pdfDataset, ID.pdfDatasetVersion, ID.pdfPreviewObject]
      );
      await db.query(
        "UPDATE app.datasets SET current_version_id=$1 WHERE id=$2",
        [ID.pdfDatasetVersion, ID.pdfDataset]
      );
      await db.query(
        `INSERT INTO app.project_datasets
           (organization_id, project_id, dataset_id, linked_by)
         VALUES ($1,$2,$3,$4)`,
        [ID.organization, ID.project, ID.pdfDataset, ID.user]
      );
      await db.query(
        `INSERT INTO app.project_sites
           (id, organization_id, project_id, slug, current_version_id,
            current_version_number, created_by, updated_by)
         VALUES ($1,$2,$3,'investigation',$4,1,$5,$5)`,
        [ID.site, ID.organization, ID.project, ID.siteVersion, ID.user]
      );
      await db.query(
        `INSERT INTO app.project_site_versions
           (id, organization_id, project_id, site_id, version_number,
            title, description, theme, created_by)
         VALUES ($1,$2,$3,$4,1,'Investigation','An evidence-led report','paper',$5)`,
        [ID.siteVersion, ID.organization, ID.project, ID.site, ID.user]
      );
      await db.query(
        `INSERT INTO app.project_sites
           (id, organization_id, project_id, slug, current_version_id,
            current_version_number, created_by, updated_by)
         VALUES ($1,$2,$3,'odt-report',$4,1,$5,$5)`,
        [ID.documentSite, ID.organization, ID.project, ID.documentSiteVersion, ID.user]
      );
      await db.query(
        `INSERT INTO app.project_site_versions
           (id, organization_id, project_id, site_id, version_number,
            title, description, theme, created_by)
         VALUES ($1,$2,$3,$4,1,'ODT report','A semantic document','paper',$5)`,
        [ID.documentSiteVersion, ID.organization, ID.project, ID.documentSite, ID.user]
      );
      await db.query(
        `INSERT INTO app.project_sites
           (id, organization_id, project_id, slug, current_version_id,
            current_version_number, created_by, updated_by)
         VALUES ($1,$2,$3,'pdf-report',$4,1,$5,$5)`,
        [ID.pdfSite, ID.organization, ID.project, ID.pdfSiteVersion, ID.user]
      );
      await db.query(
        `INSERT INTO app.project_site_versions
           (id, organization_id, project_id, site_id, version_number,
            title, description, theme, created_by)
         VALUES ($1,$2,$3,$4,1,'PDF report','An all-page text presentation','paper',$5)`,
        [ID.pdfSiteVersion, ID.organization, ID.project, ID.pdfSite, ID.user]
      );
      await db.query(
        `INSERT INTO app.project_site_pages
           (id, organization_id, project_id, site_id, site_version_id,
            site_version_number, page_slug, navigation_label, position, is_home,
            resource_id, resource_version_id, resource_version_number, created_by)
         VALUES ($1,$2,$3,$4,$5,1,'findings','Findings',0,true,$6,$7,1,$8)`,
        [
          ID.page,
          ID.organization,
          ID.project,
          ID.site,
          ID.siteVersion,
          ID.resource,
          ID.resourceVersion,
          ID.user
        ]
      );
      await db.query(
        `INSERT INTO app.project_site_pages
           (id, organization_id, project_id, site_id, site_version_id,
            site_version_number, page_slug, navigation_label, position, is_home,
            resource_id, resource_version_id, resource_version_number, created_by)
         VALUES ($1,$2,$3,$4,$5,1,'pdf-report','PDF report',0,true,$6,$7,1,$8)`,
        [
          ID.pdfPage,
          ID.organization,
          ID.project,
          ID.pdfSite,
          ID.pdfSiteVersion,
          ID.pdfResource,
          ID.pdfResourceVersion,
          ID.user
        ]
      );
      await db.query(
        `INSERT INTO app.project_site_pages
           (id, organization_id, project_id, site_id, site_version_id,
            site_version_number, page_slug, navigation_label, position, is_home,
            resource_id, resource_version_id, resource_version_number, created_by)
         VALUES ($1,$2,$3,$4,$5,1,'report','Report',0,true,$6,$7,1,$8)`,
        [
          ID.documentPage,
          ID.organization,
          ID.project,
          ID.documentSite,
          ID.documentSiteVersion,
          ID.documentResource,
          ID.documentResourceVersion,
          ID.user
        ]
      );
    });
    await db.exec("SET ROLE opengeo_runtime");
  });

  after(async () => db.close());

  it("defines forced tenant isolation, immutable revisions, revocation, and no worker path", () => {
    assert.match(productionMigration, /ALTER TABLE app\.project_site_editions FORCE ROW LEVEL SECURITY/);
    assert.match(productionMigration, /project_site_versions_are_immutable/);
    assert.match(productionMigration, /project_site_editions_one_active_idx/);
    assert.match(productionMigration, /jsonb_array_length\(manifest->'references'\) <= 128/);
    assert.match(productionMigration, /REVOKE ALL ON[\s\S]*app\.project_site_editions[\s\S]*FROM opengeo_worker/);
    assert.match(productionMigration, /ordinary object storage or any CDN/);
    assert.match(printLayoutMigration, /project_site_versions_theme_options_contract/);
    assert.match(printLayoutMigration, /opengeo\.site-edition\.1\.3\.0/);
    assert.match(printLayoutMigration, /IS DISTINCT FROM sealed_theme_options/);
    assert.match(positionedLayoutMigration, /project_site_versions_print_layout_contract/);
    assert.match(positionedLayoutMigration, /1000 by 1000 top-left coordinate space/);
    assert.match(positionedLayoutMigration, /IS DISTINCT FROM sealed_print_layout/);
    assert.match(positionedLayoutMigration, /print layout snapshot seal mismatch/);
    assert.match(richPositionedLayoutMigration, /project_site_editions_rich_print_layout_seal/);
    assert.match(richPositionedLayoutMigration, /style legend seal mismatch/);
    assert.match(richPositionedLayoutMigration, /image frame seal mismatch/);
    assert.match(publicOdfDocumentMigration, /opengeo\.site-edition\.1\.4\.0/);
    assert.match(publicOdfDocumentMigration, /accessible_preview_schema/);
    assert.match(publicOdfDocumentMigration, /ClamAV/);
    assert.match(publicOdfDocumentMigration, /content asset seal mismatch/);
    assert.match(publicPdfSemanticMigration, /opengeo\.document-preview\.2\.0\.0/);
    assert.match(publicPdfSemanticMigration, /poppler_pdftotext/);
    assert.match(publicPdfSemanticMigration, /ocr_performed/);
    assert.match(publicPdfSemanticMigration, /text_characters/);
    assert.match(publicPdfVisualMigration, /opengeo\.pdf-visual-presentation\.1\.0\.0/);
    assert.match(publicPdfVisualMigration, /visual_total_pixels/);
    assert.match(publicPdfVisualMigration, /visual_total_image_bytes/);
    assert.match(publicPdfVisualMigration, /visual_annotations_hidden/);
    assert.match(publicPdfOcrMigration, /opengeo\.document-preview\.3\.0\.0/);
    assert.match(publicPdfOcrMigration, /opengeo\.pdf-visual-presentation\.2\.0\.0/);
    assert.match(publicPdfOcrMigration, /pdf_document_publication_facts_valid_v1/);
    assert.match(publicPdfOcrMigration, /ocr_page_limit/);
    assert.match(publicPdfOcrMigration, /ocr_total_pixels/);
  });

  it("accepts only closed bounded PDF OCR publication facts", async () => {
    const facts = {
      kind: "pdf",
      source_format: "pdf",
      accessible_preview_schema: "opengeo.document-preview.3.0.0",
      text_extraction: "poppler_pdftotext_tesseract",
      reading_order: "heuristic",
      ocr_performed: true,
      ocr_engine: "tesseract",
      ocr_engine_version: "5.3.4",
      ocr_model: "Arabic",
      ocr_page_limit: 32,
      ocr_page_count: 2,
      ocr_pages: [2, 4],
      ocr_pixel_limit: 32000000,
      ocr_maximum_dimension: 1600,
      ocr_total_pixels: 2560000,
      ocr_truncated: false,
      tagged: false,
      text_available: true,
      text_block_count: 3,
      text_characters: 420,
      page_count: 4,
      visual_presentation_schema: "opengeo.pdf-visual-presentation.2.0.0",
      visual_renderer: "poppler_pdftoppm",
      visual_media_type: "image/jpeg",
      visual_annotations_hidden: true,
      visual_page_count: 4,
      visual_target_max_dimension: 1000,
      visual_total_pixels: 2400000,
      visual_total_image_bytes: 900000
    };
    const valid = async (document, key = "x/document/accessible-preview.json") => {
      const result = await db.query(
        `SELECT app.pdf_document_publication_facts_valid_v1(
           $1::jsonb, $2::text, $3::bigint
         ) AS valid`,
        [JSON.stringify({document}), key, key.endsWith("visual-presentation.json") ? 900000 : 8192]
      );
      return result.rows[0].valid;
    };

    assert.equal(await valid(facts), true);
    assert.equal(await valid(facts, "x/document/visual-presentation.json"), true);
    assert.equal(await valid({...facts, ocr_page_limit: 33}), false);
    assert.equal(await valid({...facts, ocr_pages: [4, 2]}), false);
    assert.equal(await valid({...facts, ocr_pages: [2, 2]}), false);
    assert.equal(await valid({...facts, ocr_model: "attacker/model"}), false);
    assert.equal(await valid({...facts, ocr_truncated: true}), false);
    assert.equal(await valid({
      ...facts,
      visual_presentation_schema: "opengeo.pdf-visual-presentation.1.0.0"
    }, "x/document/visual-presentation.json"), false);
  });

  it("keeps tenant rows invisible outside their organization", async () => {
    const visible = await tenant(ID.organization, ID.user, () =>
      db.query("SELECT slug FROM app.project_sites")
    );
    const hidden = await tenant(ID.otherOrganization, ID.otherUser, () =>
      db.query("SELECT slug FROM app.project_sites")
    );
    assert.equal(visible.rows.length, 3);
    assert.equal(hidden.rows.length, 0);
  });

  it("enforces the closed immutable print option contract", async () => {
    const valid = await db.query(
      `SELECT app.project_site_theme_options_valid(
         '{"printPageSize":"a3","printOrientation":"portrait",
           "printLayout":"map-sheet","printLegend":"true",
           "printNorthArrow":"false","printScaleBar":"true"}'::jsonb
       ) AS accepted`
    );
    assert.equal(valid.rows[0].accepted, true);
    await assert.rejects(
      tenant(ID.organization, ID.user, () => db.query(
        `INSERT INTO app.project_site_versions
           (id, organization_id, project_id, site_id, version_number,
            title, theme, theme_options, created_by)
         VALUES ($1,$2,$3,$4,2,'Unsafe print','paper',
                 '{"printPageSize":"wall","remoteScript":"https://bad.example"}', $5)`,
        [ID.nextSiteVersion, ID.organization, ID.project, ID.site, ID.user]
      )),
      /project_site_versions_theme_options_contract/
    );
  });

  it("enforces bounded positioned pages and frame-local furniture references", async () => {
    const valid = await db.query(
      `SELECT app.project_site_print_layout_valid($1::jsonb) AS accepted`,
      [JSON.stringify({
        schemaVersion: "opengeo.print-layout.1.0.0",
        pages: [{
          sitePageSlug: "findings",
          elements: [
            {id: "map_1", type: "map_frame", x: 20, y: 100, width: 700, height: 700, resourceId: ID.resource},
            {id: "north", type: "north_arrow", x: 780, y: 100, width: 80, height: 100, mapFrameId: "map_1"}
          ]
        }]
      })]
    );
    assert.equal(valid.rows[0].accepted, true);
    const invalid = await db.query(
      `SELECT app.project_site_print_layout_valid($1::jsonb) AS accepted`,
      [JSON.stringify({
        schemaVersion: "opengeo.print-layout.1.0.0",
        pages: [{
          sitePageSlug: "findings",
          elements: [
            {id: "north", type: "north_arrow", x: 950, y: 950, width: 100, height: 100, mapFrameId: "missing", remoteUrl: "https://bad.example"}
          ]
        }]
      })]
    );
    assert.equal(invalid.rows[0].accepted, false);
  });

  it("accepts rich exact-edition frames and rejects injected or unbounded values", async () => {
    const layout = {
      schemaVersion: "opengeo.print-layout.1.1.0",
      pages: [{
        sitePageSlug: "findings",
        elements: [
          {id: "map_1", type: "map_frame", x: 20, y: 100, width: 620, height: 700,
            rotation: -12, clip: true, resourceId: ID.resource, fit: "cover"},
          {id: "legend", type: "legend_frame", x: 670, y: 100, width: 290, height: 240,
            rotation: 0, clip: true, mapFrameId: "map_1"},
          {id: "photo", type: "image_frame", x: 670, y: 370, width: 290, height: 220,
            rotation: 8, clip: false, blockId: "field_photo", fit: "contain"},
          {id: "results", type: "table_frame", x: 20, y: 830, width: 450, height: 130,
            rotation: 0, clip: true, blockId: "result_table"},
          {id: "trend", type: "chart_frame", x: 510, y: 830, width: 450, height: 130,
            rotation: 0, clip: true, blockId: "trend_chart"}
        ]
      }]
    };
    const accepted = await db.query(
      "SELECT app.project_site_print_layout_valid($1::jsonb) AS accepted",
      [JSON.stringify(layout)]
    );
    assert.equal(accepted.rows[0].accepted, true);

    for (const invalid of [
      {...layout, remoteUrl: "https://bad.example"},
      {...layout, pages: [{...layout.pages[0], elements: [
        {...layout.pages[0].elements[0], rotation: 181}
      ]}]},
      {...layout, pages: [{...layout.pages[0], elements: [
        {...layout.pages[0].elements[0], fit: "url(https://bad.example)"}
      ]}]},
      {...layout, pages: [{...layout.pages[0], elements: [
        {...layout.pages[0].elements[1], mapFrameId: "missing"}
      ]}]}
    ]) {
      const rejected = await db.query(
        "SELECT app.project_site_print_layout_valid($1::jsonb) AS accepted",
        [JSON.stringify(invalid)]
      );
      assert.equal(rejected.rows[0].accepted, false);
    }
  });

  it("seals only the exact post-scan ODT semantic preview under edition schema 1.4", async () => {
    await tenant(ID.organization, ID.user, async () => {
      await db.query(
        `UPDATE app.project_sites
         SET state='review', updated_by=$1, updated_at=updated_at + interval '1 millisecond'
         WHERE id=$2`,
        [ID.user, ID.documentSite]
      );
      await db.query(
        `INSERT INTO app.project_site_workflow_events
           (id, organization_id, project_id, site_id, site_version_id,
            site_version_number, source_state, target_state, actor_user_id)
         VALUES ($1,$2,$3,$4,$5,1,'draft','review',$6)`,
        [
          ID.documentReviewEvent,
          ID.organization,
          ID.project,
          ID.documentSite,
          ID.documentSiteVersion,
          ID.user
        ]
      );
    });
    const insertEdition = (manifest) => tenant(ID.organization, ID.user, () => db.query(
      `INSERT INTO app.project_site_editions
         (id, organization_id, project_id, site_id, site_version_id,
          site_version_number, edition_number, manifest,
          manifest_checksum_sha256, published_by)
       VALUES ($1,$2,$3,$4,$5,1,1,$6::jsonb,$7,$8)`,
      [
        ID.documentEdition,
        ID.organization,
        ID.project,
        ID.documentSite,
        ID.documentSiteVersion,
        JSON.stringify(manifest),
        "f".repeat(64),
        ID.user
      ]
    ));

    await assert.rejects(
      insertEdition(documentManifest("opengeo.site-edition.1.3.0")),
      /document blocks require site edition schema 1.4/
    );
    await assert.rejects(
      insertEdition(documentManifest("opengeo.site-edition.1.4.0", "a".repeat(64))),
      /governed asset is invalid/
    );
    await insertEdition(documentManifest("opengeo.site-edition.1.4.0"));

    const sealed = await tenant(ID.organization, ID.user, () => db.query(
      `SELECT manifest->>'schemaVersion' AS schema_version,
              manifest->'assets'->0->>'storageVersionId' AS storage_version
       FROM app.project_site_editions WHERE id=$1`,
      [ID.documentEdition]
    ));
    assert.deepEqual(sealed.rows[0], {
      schema_version: "opengeo.site-edition.1.4.0",
      storage_version: "odt-preview-v1"
    });
  });

  it("seals a bounded all-page PDF semantic derivative and rejects checksum drift", async () => {
    await tenant(ID.organization, ID.user, async () => {
      await db.query(
        `UPDATE app.project_sites
         SET state='review', updated_by=$1, updated_at=updated_at + interval '1 millisecond'
         WHERE id=$2`,
        [ID.user, ID.pdfSite]
      );
      await db.query(
        `INSERT INTO app.project_site_workflow_events
           (id, organization_id, project_id, site_id, site_version_id,
            site_version_number, source_state, target_state, actor_user_id)
         VALUES ($1,$2,$3,$4,$5,1,'draft','review',$6)`,
        [
          ID.pdfReviewEvent,
          ID.organization,
          ID.project,
          ID.pdfSite,
          ID.pdfSiteVersion,
          ID.user
        ]
      );
    });
    const insertEdition = (manifest) => tenant(ID.organization, ID.user, () => db.query(
      `INSERT INTO app.project_site_editions
         (id, organization_id, project_id, site_id, site_version_id,
          site_version_number, edition_number, manifest,
          manifest_checksum_sha256, published_by)
       VALUES ($1,$2,$3,$4,$5,1,1,$6::jsonb,$7,$8)`,
      [
        ID.pdfEdition,
        ID.organization,
        ID.project,
        ID.pdfSite,
        ID.pdfSiteVersion,
        JSON.stringify(manifest),
        "b".repeat(64),
        ID.user
      ]
    ));

    await db.exec("RESET ROLE");
    await db.query(
      `UPDATE app.dataset_versions
       SET schema_definition=jsonb_set(
         schema_definition, '{document,ocr_performed}', 'true'::jsonb
       )
       WHERE id=$1`,
      [ID.pdfDatasetVersion]
    );
    await db.exec("SET ROLE opengeo_runtime");
    await assert.rejects(
      insertEdition(pdfDocumentManifest()),
      /governed asset is invalid/
    );
    await db.exec("RESET ROLE");
    await db.query(
      `UPDATE app.dataset_versions
       SET schema_definition=jsonb_set(
         schema_definition, '{document,ocr_performed}', 'false'::jsonb
       )
       WHERE id=$1`,
      [ID.pdfDatasetVersion]
    );
    await db.exec("SET ROLE opengeo_runtime");
    await assert.rejects(
      insertEdition(pdfDocumentManifest("c".repeat(64))),
      /governed asset is invalid/
    );
    await db.exec("RESET ROLE");
    await db.query(
      `UPDATE app.dataset_versions
       SET schema_definition=jsonb_set(
         schema_definition, '{document,visual_total_pixels}', '20000001'::jsonb
       )
       WHERE id=$1`,
      [ID.pdfDatasetVersion]
    );
    await db.exec("SET ROLE opengeo_runtime");
    await assert.rejects(
      insertEdition(pdfDocumentManifest()),
      /governed asset is invalid/
    );
    await db.exec("RESET ROLE");
    await db.query(
      `UPDATE app.dataset_versions
       SET schema_definition=jsonb_set(
         schema_definition, '{document,visual_total_pixels}', '1200000'::jsonb
       )
       WHERE id=$1`,
      [ID.pdfDatasetVersion]
    );
    await db.exec("SET ROLE opengeo_runtime");
    await insertEdition(pdfDocumentManifest());

    const sealed = await tenant(ID.organization, ID.user, () => db.query(
      `SELECT manifest->'assets'->0->>'storageVersionId' AS storage_version
       FROM app.project_site_editions WHERE id=$1`,
      [ID.pdfEdition]
    ));
    assert.equal(sealed.rows[0].storage_version, "pdf-visual-presentation-v1");
  });

  it("publishes only a reviewed public page set and records the exact edition", async () => {
    await tenant(ID.organization, ID.user, async () => {
      const manifest = {
        schemaVersion: "opengeo.site-edition.1.3.0",
        organizationId: ID.organization,
        projectId: ID.project,
        siteId: ID.site,
        siteVersionId: ID.siteVersion,
        siteVersionNumber: 1,
        editionId: ID.edition,
        editionNumber: 1,
        themeOptions: {},
        printLayout: {schemaVersion: "opengeo.print-layout.1.1.0", pages: []},
        pages: [{
          slug: "findings",
          navigationLabel: "Findings",
          position: 0,
          home: true,
          resourceId: ID.resource,
          resourceVersionId: ID.resourceVersion,
          resourceVersionNumber: 1
        }],
        references: []
      };
      await db.query(
        `UPDATE app.project_sites
         SET state='review', updated_by=$1, updated_at=updated_at + interval '1 millisecond'
         WHERE id=$2`,
        [ID.user, ID.site]
      );
      await db.query(
        `INSERT INTO app.project_site_workflow_events
           (id, organization_id, project_id, site_id, site_version_id,
            site_version_number, source_state, target_state, actor_user_id)
         VALUES ($1,$2,$3,$4,$5,1,'draft','review',$6)`,
        [ID.reviewEvent, ID.organization, ID.project, ID.site, ID.siteVersion, ID.user]
      );
      await db.query(
        `INSERT INTO app.project_site_editions
           (id, organization_id, project_id, site_id, site_version_id,
            site_version_number, edition_number, manifest,
            manifest_checksum_sha256, published_by)
         VALUES ($1,$2,$3,$4,$5,1,1,$6::jsonb,$7,$8)`,
        [
          ID.edition,
          ID.organization,
          ID.project,
          ID.site,
          ID.siteVersion,
          JSON.stringify(manifest),
          "a".repeat(64),
          ID.user
        ]
      );
      await db.query(
        `UPDATE app.project_sites
         SET state='published', updated_by=$1, updated_at=updated_at + interval '1 millisecond'
         WHERE id=$2`,
        [ID.user, ID.site]
      );
      await db.query(
        `INSERT INTO app.project_site_workflow_events
           (id, organization_id, project_id, site_id, site_version_id,
            site_version_number, source_state, target_state, actor_user_id)
         VALUES ($1,$2,$3,$4,$5,1,'review','published',$6)`,
        [ID.publishEvent, ID.organization, ID.project, ID.site, ID.siteVersion, ID.user]
      );
    });
    const edition = await tenant(ID.organization, ID.user, () =>
      db.query(
        `SELECT edition_number, site_version_number, revoked_at
         FROM app.project_site_editions WHERE id=$1`,
        [ID.edition]
      )
    );
    assert.deepEqual(edition.rows[0], {
      edition_number: 1,
      site_version_number: 1,
      revoked_at: null
    });
  });

  it("starts a new immutable draft while the prior edition remains active", async () => {
    await tenant(ID.organization, ID.user, async () => {
      await db.query(
        `INSERT INTO app.project_site_versions
           (id, organization_id, project_id, site_id, version_number,
            title, description, theme, change_message, created_by)
         VALUES ($1,$2,$3,$4,2,'Investigation','Corrected report','atlas',
                 'Clarify methods',$5)`,
        [ID.nextSiteVersion, ID.organization, ID.project, ID.site, ID.user]
      );
      await db.query(
        `INSERT INTO app.project_site_pages
           (id, organization_id, project_id, site_id, site_version_id,
            site_version_number, page_slug, navigation_label, position, is_home,
            resource_id, resource_version_id, resource_version_number, created_by)
         VALUES ($1,$2,$3,$4,$5,2,'findings','Findings',0,true,$6,$7,1,$8)`,
        [
          ID.nextPage,
          ID.organization,
          ID.project,
          ID.site,
          ID.nextSiteVersion,
          ID.resource,
          ID.resourceVersion,
          ID.user
        ]
      );
      await db.query(
        `UPDATE app.project_sites
         SET current_version_id=$1, current_version_number=2, state='draft',
             updated_by=$2, updated_at=updated_at + interval '1 millisecond'
         WHERE id=$3`,
        [ID.nextSiteVersion, ID.user, ID.site]
      );
    });
    const result = await tenant(ID.organization, ID.user, () =>
      db.query(
        `SELECT site.state, site.current_version_number,
                count(edition.id) FILTER (WHERE edition.revoked_at IS NULL) AS active_editions
         FROM app.project_sites site
         LEFT JOIN app.project_site_editions edition ON edition.site_id=site.id
         WHERE site.id=$1
         GROUP BY site.state, site.current_version_number`,
        [ID.site]
      )
    );
    assert.equal(result.rows[0].state, "draft");
    assert.equal(result.rows[0].current_version_number, 2);
    assert.equal(result.rows[0].active_editions, 1);
  });

  it("revokes an edition one-way and preserves its immutable manifest", async () => {
    await tenant(ID.organization, ID.user, () =>
      db.query(
        `UPDATE app.project_site_editions
         SET revoked_by=$1, revoked_at=clock_timestamp()
         WHERE id=$2`,
        [ID.user, ID.edition]
      )
    );
    await assert.rejects(
      tenant(ID.organization, ID.user, () =>
        db.query(
          `UPDATE app.project_site_editions SET revoked_by=NULL, revoked_at=NULL WHERE id=$1`,
          [ID.edition]
        )
      ),
      /project site edition revocation is one-way/
    );
    await assert.rejects(
      tenant(ID.organization, ID.user, () =>
        db.query(
          `UPDATE app.project_site_versions SET title='Rewritten' WHERE id=$1`,
          [ID.siteVersion]
        )
      ),
      /permission denied|governed resource history is immutable/
    );
  });
});

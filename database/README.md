# OpenGeo Studio PostgreSQL/PostGIS Schema

The PostgreSQL/PostGIS model keeps resource identities, spatial data, immutable
versions, membership, permissions and job history durable across application
releases. Tenant isolation and operation-specific roles protect these records;
forward migrations preserve existing data and working references.

Read the [resource and compatibility overview](../docs/community-architecture.md#resources-and-compatibility)
first. Use the [connected development guide](../docs/community-development.md)
for local PostGIS or the [AWS guide](../docs/community-aws.md) for initialization,
backup and upgrades. Detailed migration notes below retain their stated local,
hosted and production acceptance limits.

## Tenant Boundary

Every tenant-owned primary or child table carries `organization_id`, including join tables and history. Composite foreign keys prevent a client, project, map, dataset, upload, object, logical version, or job from referencing a parent in another organization.

The migration creates `opengeo_runtime` as a non-owner, non-inheriting role that does not have `BYPASSRLS`. The API must use that role and wrap every request in a transaction that establishes the verified context before application queries:

```sql
BEGIN;
SET LOCAL app.organization_id = '00000000-0000-0000-0000-000000000001';
SET LOCAL app.user_id = '00000000-0000-0000-0000-000000000002';
-- permission check and application queries
COMMIT;
```

After applying migrations, set the runtime role password from the separately generated Secrets Manager value without printing it:

```bash
OPEN_GEO_RUNTIME_PASSWORD='<secret>' psql --file scripts/configure-runtime-role.sql
```

The deployment pipeline retrieves the value at runtime; it must not place the password in command arguments, logs, environment files, or CDK context.

Row-level security is a defense-in-depth organization boundary. It does not replace project/dataset role checks in the API. The migration owner and roles with `BYPASSRLS` must never be used by the runtime service.

M1 writes re-read organization/project roles after the transaction context is set. Client/project/map mutation, map compare-and-swap, map-version insertion, and the actor/request-attributed activity event then commit together. A stale version, denied role, constraint error, or activity failure rolls the transaction back; no caller may create an unaudited partial write.

Runtime grants are explicit and least-privilege: internal trigger functions are not callable, audit events cannot be updated or deleted, and future tables or functions receive no automatic runtime privileges. Each forward migration must enable and test its tenant policy before granting the exact operations its API handler needs.

Organization discovery is a separate trusted authentication query: first map the verified Cognito subject to `app.users`, then return only that user's membership rows. Once an organization is selected, all normal API work uses the transaction context above.

`app.resolve_principal(subject)` is the sole RLS-bypassing lookup. It is a `SECURITY DEFINER` function owned by the migration role, has a fixed search path, returns only identity/membership columns for one verified subject, and is not executable by `PUBLIC`. The API must never pass an unverified JWT claim to it.

## Migrations

Migrations are forward-only and run exactly once. Production rollback restores application compatibility or applies a corrective migration; it does not edit an already-applied file.

### Migration history

Migrations define the authoritative production model. The initial migration creates identities, organizations, client accounts, projects, maps, immutable map revisions, memberships, and activity events. Migration `0002` adds tenant-isolated, non-deletable membership invitations plus restricted identity reconciliation and single-use acceptance functions. Migration `0003` adds the managed dataset, project link, tag, exact upload intent/object, logical version, and idempotent processing-job foundation. Migration `0004` adds the worker's function-only execution boundary. Migration `0005` adds dataset grants, explicit logical-version/object associations, and indexed catalog search. Migration `0006` adds tenant-scoped XYZ/WMS source identities and append-only source revisions without granting the processing worker table access. Migration `0007` extends that same boundary to governed PMTiles. Migration `0008` adds recoverable project-import plans, exact candidate bindings, and forward-only completion. Migration `0009` adds first-class governed resources, immutable metadata/content versions, external identifiers, and typed relationships. Migration `0010` adds one-time staged data/map binding, native resource grants, immutable portable style revisions, and append-only editorial workflow decisions. Migration `0011` adds immutable governed render profiles and exact-version render jobs behind a function-only worker boundary. Migration `0012` adds PNG output, explicit `CRS:84`/`EPSG:3857` identity, and format-specific exact finalization. Migration `0013` adds request background/transparency identity, lowers the bounded dimension minimum to one pixel, and exposes presentation fields only through a lease-token-checked worker function. Migration `0014` adds sealed, append-only, bottom-to-top layer compositions with exact profile-version snapshots and a lease-token-checked ordered worker read. Migration `0015` adds stable, exact-case WMS layer publications for published dataset/service resources, with case-folded name reservation, one active publication per resource, irreversible withdrawal, forced RLS, and no worker authority. Migration `0016` adds an explicit opaque public-WMS service identity per project. It can be created only after an active exact-name publication targets a published resource whose visibility is `public`; identity is immutable, disablement is actor-bound and irreversible, runtime has no delete grant, and the worker has no table authority. The service record is a revocable read boundary, not permission to create render work. Migration `0017` adds organization-owned metadata profile identities and immutable, checksummed profile revisions. Governed resource revisions may bind one exact profile revision and its bounded validation snapshot through composite tenant foreign keys. Profile history cannot be updated or deleted, runtime deletion is denied, forced RLS applies, and the worker has no authority. Migration `0018` adds immutable DCAT 3/STAC 1.1 canonical source documents, checksums, and bounded conversion reports bound by composite tenant foreign key to the exact imported governed-resource revision. The exact canonical UTF-8 source is stored as at most 49,152 bytes of text and read separately from its 16-KiB report to stay below the Data API row boundary. Format/namespace/identifier is unique per organization, runtime can only select/insert, forced RLS applies, and the worker has no authority. Migration `0019` adds a 16-KiB bounded `localized_metadata` JSON object to every immutable governed-resource revision and rebuilds the stored full-text vector with all nested string values. The application further limits this object to eight normalized BCP 47 language keys and title/abstract/attribution/keyword fields. No table, service, or worker authority is added. Migration `0020` atomically expands the immutable source-format enum to ISO 19115-3:2023, schema.org Dataset 30.0, DataCite 4.7, and GeoDCAT-AP 3.1.0. Canonical JSON remains bounded at 49,152 bytes; ISO XML uses the same bound but is stored byte-for-byte with a raw UTF-8 checksum. The database accepts raw XML only for the ISO format and still requires a JSON object for every JSON format. No table, index, daemon, or worker authority is added.

### Fresh databases and upgrades

A fresh database can start directly at the current release. The checked [`0089_opengeo_schema.sql`](baselines/0089_opengeo_schema.sql) baseline creates the release-89 schema and records the exact checksums of migrations `0001` through `0089` in `opengeo_deploy.schema_migrations`. It contains schema, roles, grants, functions, policies, and extension declarations; it contains no user or application data. Existing databases use checksum-verified forward migrations, not a baseline restore.

Migration `0089_imageserver_sources.sql` adds a distinct `imageserver` service/dataset type and preserves the existing upload/repository format restrictions. Registration supports bounded public display requests; it does not capture original imagery, certify TIFFs as COGs, or enable archival fallback. Its enum additions commit before the updated constraints use them. The release-89 baseline was restored and compared with the sequential migration chain locally; this is not a production upgrade.

Migration `0086_observable_data_attachments.sql` adds an immutable attachment library for Framework source projects. Each record pins an existing same-project dataset version and object, with version identity, checksum, media type and size derived from archive facts. Registration requires source-management access and active linked data, is idempotent for the same exact object, and is limited to 128 records per source project. It copies no bytes and grants no download authority. Adding a library record does not modify an existing source manifest or build.

Migration `0087_observable_revision_data_bindings.sql` seals selected archive references and safe data paths into version-2 source manifests. It validates exact archive facts, active project linkage, source-management access, compatible media, path collisions, a combined 128-file count and a separate 64 MiB referenced-data bound. Version-1 revisions remain unchanged.

Migration `0088_observable_archive_preview_staging.sql` permits version-2 private previews, resolves archive storage facts only under a live coordinator lease and reauthorizes the job's original requester at completion. Release candidates with archive bindings remain denied. Version-2 output files may use the unchanged 32 MiB total-output budget; version-1 keeps its 16 MiB per-file limit. Recording a binding is not compilation or publication, and local schema verification is not a deployed upgrade.

Migration `0177_observable_archive_tiff_preview_output.sql` permits request-1 private
previews of version-2 sources to retain an exact Catalog TIFF in their output.
The existing archive checksum/size/extension predicate, lease, access, output-size
limits and completion function grants remain in force. The migration changes no
source, job or object records and accepts reapplication of its exact correction.

Migration `0083_user_dataset_connection_revision_read.sql` grants the API runtime `SELECT (target_revision)` on reusable dataset connections so its connection lists, project bindings, and write responses can read the revision introduced in `0052`. The grant is column-scoped; secret references remain unreadable, revision updates remain trigger-maintained, and existing tenant policies and function-only worker privileges still apply. Existing databases apply this forward migration without rewriting the immutable release-82 baseline or application rows.

Migration `0084_map_resource_version_bindings.sql` gives each governed map resource version an immutable, tenant-qualified reference to one saved map revision. The API inserts its new resource version and calls `app.bind_map_resource_version` in the same transaction before advancing the resource head. The function requires the newest version and its current-user attribution. Without an expected map version it inherits the nearest previous binding; only resource version one may select the current map implicitly. An explicit expected map version must match the current same-project saved map while a shared row lock prevents a concurrent save. Missing legacy bindings on later resource versions require that explicit selection; the migration does not infer history or read client-authored provenance. Runtime can read bindings but cannot write them directly, and background roles have no binding authority. Saved map history also becomes append-only: runtime update/delete grants are revoked and immutable triggers protect both history tables.

Migration `0085_saved_map_render_jobs.sql` binds a saved-map render job and its map-owned profiles to that exact resource version, with an immutable compiled recipe and definition/recipe checksums. Every render position pins a canonical dataset resource/version and the exact preview object, provider version, and checksum. The API inserts the unsealed job, binding, layers, and complete source pins in one transaction, then seals it; map jobs allow one through sixteen positions while ordinary compositions retain their existing two-position minimum. Claim, composition read, and completion share the same pinned-source resolver, so later preview objects cannot change inputs. That resolver also rechecks that every canonical source remains unarchived, project-linked, and backed by an active dataset and version. Runtime can insert and read tenant-scoped bindings but cannot change or delete them; workers use only the existing lease functions. Bound output artifacts are retained by the cache reference guard. Source rights and publication remain independent API checks over these immutable identities, not properties inferred from the recipe.

Saved-map completion records the output object on the map job without adding it to the anchor dataset's object inventory. A composed image can contain independently restricted sources, so it must not become downloadable or publishable as a generic asset under only the first dataset's authorization. Ordinary dataset/service renders retain their existing dataset-version output link.

The deployment runner selects this direct baseline only when both the `app` schema and migration ledger are absent. An existing managed database continues from its ledger through later forward migrations. A partial state—one present without the other—fails closed for operator review. To inspect the plan without using AWS:

```bash
python3 database/scripts/apply_migrations.py
```

To independently regenerate and compare the baseline, use Docker or Podman. The generator applies all migrations in one network-isolated PostGIS container, normalizes the dump through a second, and proves a stable restore in a third:

```bash
python3 database/scripts/build_baseline.py --runtime podman
```

Maintainers use `--write` only when intentionally publishing a new baseline after its migration chain and tests pass. The digest-pinned generator image, migration checksums, baseline checksum, PostgreSQL/PostGIS release, and no-user-data declaration are recorded in the adjacent manifest.

`0001_platform_foundation.sql` requires PostgreSQL 15+ and enables the `pgcrypto` and `postgis` extensions available on Amazon RDS for PostgreSQL.

`0002_membership_invitations.sql` is forward-only. Invitation identity, scope, role, and expiry are immutable; only pending→accepted/revoked updates are valid, and the runtime role has no `DELETE` grant. Its `app.provision_invited_user` function rechecks organization-admin context, while `app.accept_membership_invitation` binds lookup to `app.current_user_id()` and atomically grants memberships, advances state, and records activity. Public execution is revoked and only the exact runtime signatures are granted. `app.list_pending_membership_invitations()` is the only pre-membership discovery path: it accepts no caller-supplied identity or tenant and returns only unexpired pending rows bound to `app.current_user_id()`.

`0003_managed_ingestion_foundation.sql` is forward-only and forces RLS on all eight new tables. Upload expectations and storage coordinates are immutable; an intent can only advance pending→completed and has no runtime delete grant. `data_objects` records one exact S3 bucket/key/version/checksum fact, while `dataset_versions` owns the independent logical version number. The unique `(organization_id, dataset_version_id, job_type)` constraint supplies the worker's replay key. Completion writes the object, version, dataset pointer, intent transition, `dataset.ingest` job, and attributed activity in one API transaction.

`0004_worker_execution_boundary.sql` is forward-only. `opengeo_worker` has no table grants and may execute only the fixed claim, heartbeat, complete, fail, and release functions. Lease tokens, exact version reconciliation, bounded attempts, deterministic artifact ids, and atomic finalization prevent event replay from creating or partially exposing catalog state.

`0048_external_connection_verification.sql` creates the distinct `opengeo_connector` login and gives it no table privileges. It may execute only the leased claim, bounded completion, and dependency-release functions for external-connection verification. Configure its separately generated password with `scripts/configure-connector-role.sql` only immediately before the isolated runtime is enabled; until then leave the login without a usable password. Never reuse either the API runtime or GIS worker credential. The API and GIS worker cannot claim verification work, and the connector cannot directly select the connection or attempt tables. Release requeues the first two matching leases and terminally records a sanitized failure on the third, preventing an abandoned `running` row after a dependency failure.

`0049_observable_coordinator_runtime.sql` creates the separate `opengeo_observable_coordinator` login. It has no table, sequence, preview, publication, GIS-worker, or tenant-API authority and may execute only the runtime claim, heartbeat, complete, fail, and release boundaries. The runtime claim seals an expired third lease as `build_retry_exhausted` before a fourth compiler execution. Configure its separately generated password with `scripts/configure-observable-coordinator-role.sql` only for the isolated host; never reuse the API, worker, connector, or administrator credential.

`0005_catalog_access.sql` is forward-only. `dataset_permissions` grants one same-organization member `manage`, `edit`, `view`, or `download` on one dataset. `dataset_version_objects` is the authoritative relation from logical history to immutable originals and derivatives. Runtime can read but cannot forge those associations; protected triggers link originals and validated completed-job artifacts atomically. A stored `tsvector`/GIN index supports initial PostgreSQL name/description search, with normalized tags and scalar catalog filters handled relationally.

`0006_governed_external_sources.sql` is forward-only. `external_sources` binds one supported `xyz` or `wms` identity to a matching catalog dataset. `external_source_revisions` stores bounded HTTPS URL/configuration snapshots as append-only source revision numbers. Both tables force tenant RLS; runtime may select and insert but cannot update or delete either table, and `opengeo_worker` has no access. The API serializes revision allocation by locking the parent dataset and records source create/update activity in the same transaction.

`0007_governed_pmtiles_sources.sql` extends the external-source discriminator and type-matching constraints to `pmtiles`. It does not broaden runtime or worker authority; uploaded PMTiles remains a managed object rather than an external source revision.

`0060_governed_geojson_archives.sql` extends the same append-only source model to a public immutable GeoJSON object. The source revision pins compressed and decoded checksums and sizes, feature and geometry facts, bounds, source and rights links, license, and attribution. The application database stores these facts and the map definitions; it does not store the GeoJSON feature body.

`0061_bounded_feature_source_archives.sql` admits reviewed, anonymous ArcGIS FeatureServer/MapServer layers and WFS 2.0 collections as append-only external sources. A protected-copy request seals a WGS84 extent, selected fields, stable identity or sort field, page size, feature limit, exact request count, output byte limit, and rights statement before the outbound-only source archiver can retrieve canonical GeoJSON. Each completed copy becomes a normal managed dataset version with exact source-revision lineage. The database continues to store source and presentation facts rather than remote feature bodies.

### Private publication-import access bootstrap

`bootstrap_private_projects.py` prepares the reviewed Observable import inventory's
private legacy access containers (`app.projects`) and owner memberships. It creates
zero product Projects (`app.maps`); importing a publication source does not imply a
map composition. Existing compositions and publications are preserved. Runtime
verification counts owned access containers without joining maps, so empty containers
and containers with several authored Projects are both valid. The historical
`catalogProjects`/`createdProjects` output fields remain compatibility labels for access
containers; `accessContainers` makes that meaning explicit. Historical generated empty
maps require a separate reviewed consolidation and are never removed by this bootstrap.

### Reviewed MassGIS project bootstrap

The MassGIS bootstrap is plan-only by default. It validates the checked-in MassEnviroScreen source, rights, archive, style, and presentation inventory and prints the intended record counts without contacting AWS:

```bash
python3 database/scripts/bootstrap_massgis_project.py \
  --subject 00000000-0000-4000-8000-000000000000
```

After migration 0060 is present, an authorized operator may add `--apply`, the exact confirmation phrase printed by `--help`, an expected AWS account, and the reviewed admin/runtime Data API ARNs. Apply creates or reuses one legacy access container, one dataset, one append-only archive revision, and one combined showcase Project containing all 33 styled layers. The 31 indicator/combined presets remain in the reviewed configuration for previews; they do not each create a saved Project. Runtime readback verifies the combined showcase by its stable bootstrap marker, so unrelated or historical maps do not inflate acceptance counts. Existing maps are preserved, including archived maps; consolidation of historical presets is a separate reviewed operation. A rerun upgrades the combined map only when it still has the untouched version-one bootstrap definition and history. Later versions are preserved as user work.

### Managed demo starter bootstrap

`bootstrap_demo_starter.py` is the corresponding plan/apply command for the small OpenGeo Studio starter project. Plan mode verifies the exact five-feature CC0 asset, digest, size, immutable Studio asset URL, governed source definition, and current map schema without contacting AWS:

```bash
python3 database/scripts/bootstrap_demo_starter.py \
  --subject 00000000-0000-4000-8000-000000000000
```

An authorized apply targets the isolated `opengeo-demo` organization, requires the exact account and Data API ARNs plus confirmation `seed-opengeo-demo-starter`, and creates or reuses one published project, owner membership, source revision, dataset, and populated map. It preserves existing map edits and verifies the owner role, publication state, map count, and layer count through the runtime role before reporting success.

`0058_durable_data_preservation.sql` adds short-lived bounded copy estimates, rights-confirmed protected-copy jobs, vector-to-PMTiles derivative jobs, and immutable exact-revision lineage. The outbound-only `opengeo_source_archiver` can claim one bounded WMS image or one exact public PMTiles object through fixed functions and has no table or conversion authority. The existing private `opengeo_worker` can claim only PMTiles conversion and receives no external-source URL or archiver authority. Configure the archiver's separate password with `scripts/configure-source-archiver-role.sql` only for the isolated runtime; never reuse an API, worker, connector, or administrator credential. Both job families use server-generated object keys, lease tokens, bounded attempts, four-active-job limits, exact source/object/version checks, explicit queued-job cancellation, forced tenant RLS, and immutable lineage. Protected copies are capped at 512 MiB from estimate through archiver claim so every completed archive remains inside the ordinary managed-ingestion limit. The separate no-egress PMTiles conversion may produce a larger bounded tile artifact; that output never re-enters the upload-ingestion path.

`0066_repository_object_protected_copies.sql` gives an exact registered S3 version its own reviewed custody path. The request runtime seals a one-request, 512-MiB estimate and records rights, attribution, idempotency, bounded daily quotas, and a separate draft destination dataset. The dedicated `opengeo_repository_copier` role has no table access and can use only fixed claim, lease, completion, failure, release, and completed-artifact functions. Configure its independent password with `scripts/configure-repository-copier-role.sql`; never reuse the API, source archiver, worker, connector, verifier, or administrator credential. Completion atomically creates the managed object/version and immutable exact-source lineage, after which ordinary managed ingestion validates the preserved bytes.

`0067_geonode_federation_harvests.sql` adds project-scoped exact GeoNode 5.1.0 anonymous catalog registrations, idempotent bounded harvest jobs, current or withdrawn remote identities, append-only identity versions, freshness, source and payload seals, collision guards, forced tenant RLS, and attributed registration/completion/cancellation/disable events. The existing isolated `opengeo_source_archiver` receives only fixed claim/complete/fail/release functions and no table access. One harvest is capped at one JSON page, 2 MiB, 100 resources, 128 KiB per preserved payload, and three attempts. Scheduling is recorded configuration only; this migration creates no timer or compute.

`0068_spatial_catalog_administration.sql` adds immutable service-metadata revisions, bounded managed/external/verified-PostgreSQL stores, ordered versioned layer groups, and exact governed-style bindings. Existing services and collections receive a managed store, initial metadata revision, and default style binding. Cross-project targets, stale style/source/connection revisions, duplicate group members, and disabling an in-use store fail closed; every new table uses forced organization RLS and least-privilege grants.

`0069_spatial_catalog_render_profiles.sql` binds each active service-catalog style to the exact current render-profile revision that consumes its exact governed-style revision. Default bindings must be directly renderable, stale style or profile heads fail closed, and published style names can be replaced without deleting immutable binding history. The API advances any associated tile cache to a new immutable generation when the default binding changes.

`0008_recoverable_project_imports.sql` stores an immutable source product/version/hash, deterministic idempotency key, canonical plan digest, target map/version, candidate items, and bounded report. Item dataset ids are single-assignment, operation state is forward-only, and runtime receives no delete authority. Finalization can therefore require every candidate binding before map history, map CAS, activity, and operation completion commit together.

`0009_governed_resources.sql` gives datasets, maps, documents, stories, dashboards, and services stable project-scoped identities with a forward-only publication state and current immutable version. Versions carry bounded core metadata, EPSG:4326 and temporal extents, namespaced extensions, typed content, and provenance. Collision-safe external identifiers retain migration source facts; relationship foreign keys require both endpoints to remain in the same tenant and project. Runtime may read, create, append a version, or advance state, but cannot update/delete history; the worker receives no access.

`0010_resource_governance.sql` lets an unbound imported dataset/service or map receive exactly one same-project dataset/map binding without making established bindings mutable. It adds per-member `manage`, `edit`, `publish`, and `view` resource grants; stable MapLibre, GeoStyler, SLD 1.0/1.1, and detached MapServer style identities with checksummed immutable revisions; and append-only draft→review→published→archived decisions. Direct lifecycle jumps and rollback are rejected. Every new table forces tenant RLS, style/workflow history cannot be changed or deleted, and the worker receives no access.

`0031_governed_odf_text_documents.sql` adds ODT to the existing upload-only dataset-format enum without adding a remote source type or new table. Private originals, immutable logical versions, activation-only processing, exact derived-object links, scan evidence, tenant RLS, and worker finalization remain governed by the existing ingestion schema. `0032_public_odf_text_documents.sql` lets manifest 1.4 document blocks reference only an exact bounded ODT semantic JSON derivative whose public active dataset, project link, successful comprehensive ClamAV evidence, storage version, media, length, checksum, schema, and extraction facts match the complete page graph. Legacy manifests cannot contain document blocks and source ODT bytes remain private. `0033_public_pdf_semantic_documents.sql` extends the same closed publication seal to a PDF semantic derivative using schema `opengeo.document-preview.2.0.0`. It requires Poppler `pdftotext` layout-mode, heuristic reading order, explicit no-OCR/tagged/text-availability facts, bounded page/block/character counts, successful comprehensive ClamAV evidence, and an exact at-most-512-KiB JSON object. The source PDF's existing attachment-only publication contract is unchanged. `0034_public_pdf_visual_presentations.sql` preserves that semantic-only path and also seals an exact `opengeo.pdf-visual-presentation.1.0.0` derivative at the closed visual-presentation path. It requires matching semantic facts plus fixed Poppler JPEG/RGB/annotation policy, one-to-200 page parity, a 64–1,000-pixel adaptive target, at most 20 million decoded pixels, 2.4 MB of page images, and a 4 MiB JSON object. No table, service, or second object authority is added. `0035_public_pdf_ocr_documents.sql` preserves both legacy PDF paths and adds the closed `opengeo.document-preview.3.0.0` / `opengeo.pdf-visual-presentation.2.0.0` pair for text-empty-page OCR. Its immutable helper validates Tesseract 5 version syntax, one of fourteen packaged models, an ordered unique one-to-32-page list, the exact 32-page/32-million-pixel policy, 300–1,600-pixel rendering, truncation, text counts, and the existing visual/object limits before the complete manifest seal accepts the derivative. It adds one pure validation function and no table, service, or object authority.

`0036_spatial_coverage_services.sql` adds one immutable `spatial_service_coverages` catalog row for each published current validated COG original. It freezes exact tenant/project/service/dataset/version/object/storage and raster facts, permanently reserves the case-folded coverage name, permits only actor-bound one-way withdrawal, forces RLS, denies runtime deletion, and gives `opengeo_worker` no access. Insert validation requires the current active dataset version, TIFF original, matching CRS/extent/grid/bands, and successful `valid` plus `cog_layout_verified` quality. The table is publication metadata, not a second raster store or processing queue.

`0037_coverage_derivatives.sql` permanently unifies case-folded feature and coverage collection identifiers, failing the migration on any historical cross-kind collision. It adds forced-RLS immutable coverage derivative jobs for explicit within-source 2D subset, bounded target grid, EPSG reprojection, and nearest/bilinear/cubic resampling. Runtime can insert/read but cannot update or delete. The table-denied worker uses only exact lease-token claim, heartbeat, complete, fail, and release functions. Requests seal a canonical SHA-256 and the source coverage; completion atomically links an exact derived object and seals its tenant key, storage version, KMS, media/size/checksum, COG layout, target extent/grid/CRS, and bands. Terminal rows are immutable and ordinary coverage reads create no job.

`0038_coverage_range_scaling_lifecycle.sql` preserves schema-one jobs and adds schema-two sorted one-based source-band selection plus explicit-size or source- CRS-resolution scaling. The request identity seals both; dimensions from resolution are `ceil(subset span / resolution)`. A coverage-row lock makes the 64-retained/four-active quotas race-safe. Runtime receives only an audited queued-job cancellation function and still cannot delete rows; running and terminal jobs remain immutable. Physical row/object reclamation remains a separate future worker operation.

`0011_governed_rendering.sql` snapshots the exact governed resource, dataset, dataset version, style, style version, bounded compiled configuration, and configuration checksum in each immutable render-profile version. Render jobs add an idempotency key, ordered CRS-bounded extent, explicit CRS, bounded SVG/PNG dimensions and format, request checksum, lease state, exact output object, and safe terminal error. Runtime may create/read jobs but cannot rewrite job state or forge output associations. The `opengeo_worker` role still has no table privileges and receives only the exact claim, heartbeat, complete, fail, and release functions. Completion validates the derivative object/version/checksum facts, links it to the source dataset version, advances the job, and records activity atomically. `0012_raster_reprojection.sql` shifts the claim contract to return CRS and accepts only `.svg`/`image/svg+xml` or `.png`/`image/png` completion facts that match the immutable job. `0013_wms_basic_presentation.sql` preserves the 4,194,304-pixel ceiling while accepting 1–2,048-pixel sides, stores a validated optional `#rrggbb` background and required transparency flag, and grants the table-denied worker only a security-definer presentation read bound to the active job lease token. `0014_ordered_map_compositions.sql` backfills every existing job as a sealed one-layer composition and permits new jobs to open only while queued. The runtime may append positions 2–16, but sealing requires a contiguous list and cannot be reversed; layer rows cannot be updated or deleted. Every layer stores an exact resource/profile/profile-version relation, and the worker can obtain the ordered exact source/configuration set only for its active lease token. `0015_governed_wms_publications.sql` separates protocol names from resource UUIDs. An exact bounded name such as `cite:Lakes` can identify one published governed dataset or service and its default profile. Exact case is retained for WMS responses, while the case-folded spelling is reserved permanently inside the project so withdrawal cannot make an old name point at a different resource. Publication identity cannot change, withdrawal is actor-bound and one-way, and the runtime has no delete grant. `0016_public_wms_services.sql` separates public protocol reachability from both resource visibility and publication identity. One opaque service UUID can be active per project only after at least one active publication targets a published/public resource. The service title and tenant/project identity cannot change; disablement is one-way and actor-bound. Runtime can select, insert, and disable but cannot delete; the worker receives no access. Anonymous API reads still apply explicit active-service, active-publication, published-state, and public-visibility predicates on every catalog/job/output check.

Run `npm install` and `npm test` in this directory to execute the schema and its row-level-security tests against embedded PostgreSQL. Fixtures cover organization, client, project, and map isolation, direct cross-tenant ids, missing/malformed context, principal discovery, rejected writes, and immutable activity. It also proves map compare-and-swap/history/activity commit atomically and roll back together on failure. Invitation fixtures additionally prove admin-gated identity reconciliation, tenant isolation, exact-user discovery, single-use acceptance, expiry, replay denial, forward-only/no-delete semantics, and rollback on activity failure. Managed-ingestion fixtures additionally prove cross-tenant isolation, logical/S3 version separation, unique jobs, normalized tenant tags, forward-only/no-delete behavior, and full rollback when activity insertion fails. Worker fixtures cover the function-only claim/lease/finalization contract. Catalog fixtures additionally prove full-text indexing, original/derivative association, same-tenant grant constraints, RLS, and runtime inability to forge version-object links. External-source fixtures additionally prove type matching, immutable revision history, cross-tenant invisibility, and worker denial. PMTiles fixtures prove the extended type contract. Import fixtures prove immutable plans, one-time candidate binding, forward-only completion, cross-tenant hiding, runtime grants, and worker denial. Governed-resource fixtures add every resource kind, immutable version history, external identifier collisions, typed relationships, cross-project/tenant hiding, forward-only state, runtime restrictions, and worker denial. Resource- governance fixtures add one-time bindings, same-organization grants, portable style history, exact editorial transitions, cross-tenant hiding, and worker denial. Governed-rendering fixtures add immutable resource/dataset/style snapshots, idempotent requests, forced RLS, runtime state-transition denial, function-only worker leases and exact output completion, terminal replay, and cross-tenant hiding. The same suite verifies one-pixel presentation jobs and denies presentation reads made with the wrong worker token. Ordered-composition fixtures additionally prove automatic anchor snapshots, contiguous sealing, post-seal immutability, exact two-layer worker claims, and terminal handling. WMS-publication fixtures additionally prove published-target enforcement, exact-case names, case-insensitive collision denial, immutable identity, irreversible withdrawal, creator attribution, tenant hiding, runtime delete denial, and worker denial. Coverage-publication fixtures additionally prove current validated COG enforcement, exact storage/raster seals, forged version/checksum rejection, immutable identity, actor-bound irreversible withdrawal, tenant hiding, runtime delete denial, worker denial, and no read-triggered processing authority. Metadata-governance fixtures additionally prove exact profile/resource-version binding, immutable definition and slug history, validation report shape/bounds, cross-profile and cross-tenant denial, runtime no-delete grants, and worker denial. The test omits only the `CREATE EXTENSION postgis` statement because the embedded build does not ship the extension; the remaining migrations run unchanged.

### Dataset knowledge revisions

Migration `0105_dataset_knowledge.sql` adds append-only metadata history keyed by
organization and reusable dataset UUID. Apply it before releasing the canonical
metadata API. It does not backfill claims, update data/map versions, or change
project references. Preserve its records during application rollback. See the
[metadata and custody overview](../docs/community-architecture.md#metadata-and-source-custody).

Migration `0106_discovery_metadata.sql` adds immutable discovery response documents
and dataset registration links. The new function wraps existing completion in one
transaction, retaining the seven-field normalized result contract and old-worker
compatibility. It checks exact body length/checksum for bodies up to 32 KiB; larger
responses retain an explicit omission descriptor. Apply before the new API/worker;
rollback application code may ignore these tables but must retain history. No
existing metadata is backfilled and no provider request is made by this migration.

## Project Artifact editions

Migration `0107_project_artifacts.sql` adds stable compiled-image Artifact identities,
immutable numbered edition manifests (48 KiB maximum) and same-Artifact current
pointers. Existing render jobs remain the byte owners; registering editions performs
no copies or jobs. Tenant-qualified foreign keys and forced RLS protect both tables;
a binding trigger requires completed sealed output of the same saved map/resource.
Runtime may select/insert history and update only head revision/current/actor/time.
History updates/deletes and worker access are denied. Apply this forward migration
before enabling the edition API. See [Project Artifacts](../docs/community-architecture.md#artifacts-and-release-recovery).

Migration `0108_saved_map_render_reuse.sql` adds immutable tenant-scoped retry aliases
for completed saved-map jobs and an index for completed-input lookup. Triggers share
the original render request-key namespace, reject cross-table key collisions and
refuse aliases to incomplete/unsealed output. API source equality and authorization
remain required; alias rows confer no access and create no jobs. Runtime render-job
update permissions are unchanged.

Migration `0127_artifact_release_creation_keys.sql` adds optional immutable release
creation keys, unique per organization and creator. It preserves existing release
rows, RLS, grants and revocation rules. Exact-input retries recheck permissions in the
API before returning the original active identity; see [release recovery](../docs/community-architecture.md#artifacts-and-release-recovery).


Migration `0129_mapserver_sources.sql` adds a distinct live ArcGIS MapServer display
identity, preserving prior source/format constraints. Enum values commit before
use in constraints. The full 129-migration chain and repeat application of 0129
passed in a temporary local PostGIS container; this is not production migration
or runtime-role source/map persistence acceptance. See
[the public source-custody overview](../docs/community-architecture.md#metadata-and-source-custody).

Migration `0147_feature_field_comparisons.sql` admits immutable feature and field-form schema 1.3.0 while retaining versions 1.0–1.2. It changes only the two schema-document CHECK constraints; existing rows, history, roles and grants remain unchanged. Typed operators and same-record earlier-field operands are validated by the API.

Migration `0148_calculated_feature_fields.sql` admits immutable schema 1.4.0 for collections and field-form snapshots, retaining every prior version. Formula validation and recomputation remain in the shared API normalizer; roles, grants and existing rows are unchanged. Local built-Studio save/reopen/update acceptance applies this migration; production application is not claimed.

Migration `0149_feature_attachment_references.sql` admits immutable schema 1.5.0 for attachment reference fields in collections and field-form snapshots. Earlier schemas, roles, grants and existing rows remain unchanged. Local PostgreSQL acceptance includes reference save/reopen and authorized resolution; production application is not claimed.

Referenced COGs use the existing source identity/revision and tenant boundaries.
Migration0156 adds the source enum and compatible dataset/source checks. Migration0157
keeps configuration objects bounded to1MiB of JSONB text for `service_kind=cog`,
accommodating the API's256KiB original metadata limit plus serialization overhead;
other source types retain16KiB. Neither migration changes rows, grants, RLS or worker
privileges. Existing configurations/revisions stay exact; never truncate provenance
when rolling back a consumer.

# Export STAC metadata for CKAN

Generate a CKAN `package_create` payload from a STAC Collection 1.1.0 without
connecting to a portal. The exporter uses the maintained metadata importer for
the normalized core fields and retains the submitted JSON, source checksum and
import report. Its JSON envelope contains `payload`, `source`, `importReport`
and the export `report`. Only `payload` describes the proposed CKAN dataset.

With the [locked API development environment](../../services/api/README.md#local-checks)
installed, run from the repository root:

```bash
services/api/.venv/bin/python services/api/scripts/export_stac_ckan.py \
  --input docs/api/fixtures/stac-ckan-collection.json \
  --namespace example.synthetic --output /tmp/opengeo-stac-ckan.json
cmp docs/api/evidence/stac-ckan-export.json /tmp/opengeo-stac-ckan.json
```

Omit `--output` to print the envelope. Export is always a dry run; there is no
remote-write option. Use a stable namespace for each source authority. The CKAN
name hashes that namespace and the STAC identifier, so metadata changes alter
the checksum without changing identity. The original file checksum and the
importer's canonical JSON checksum have separate fields: whitespace is retained
by the input fixture, while the envelope preserves parsed JSON values rather
than claiming byte-for-byte JSON syntax preservation.

| Source knowledge | Proposed CKAN field |
| --- | --- |
| Normalized title, description and keywords | `title`, `notes`, `tags` |
| One declared `self` link | `url` |
| Declared `enclosure` links | `resources` with reference URLs, optional title and media type |
| Publisher-role providers from retained STAC | JSON-valued `opengeo:publishers` extra |
| Known normalized bounding rectangle and time bounds | `opengeo:spatial_extent`, `opengeo:temporal_start`, `opengeo:temporal_end` extras |
| All declared links, including relations | JSON-valued `opengeo:stac_links` extra |
| Source namespace, identifier, version and checksum | JSON-valued `opengeo:source` extra |
| Declared dataset license | `opengeo:declared_license` extra; no CKAN license identifier asserted |

Publisher and link supplementation happens explicitly during export; the global
STAC importer is unchanged. Extras are custom metadata strings. CKAN core does
not interpret them as publisher, spatial search, temporal search or license
semantics. Non-publisher providers and every unmapped top-level field appear in
the export report and remain in the retained source. The separate import report
also records defaults and any union of multiple spatial or temporal partitions.
Unused nested extent properties remain only in the retained source; `unmapped`
enumerates top-level fields and non-publisher provider records. Core text uses
the importer's surrounding-whitespace normalization, including the stable source
identifier. Parsed dates are formatted as ISO 8601. Original text and date values
remain in the source document and these transformations appear in `losses`.
No world extent, time, download capability or distribution license is invented.

The admitted subset has at most 32 links/providers and 64 tags. Tags must have
2–100 Unicode word characters, spaces, hyphens or dots; unsupported tags reject
instead of being renamed. References must be bounded absolute HTTPS URLs without
credentials, queries or fragments. The maintained importer rejects credential-like
keys, oversized metadata and unsupported Collection shapes. The exporter also
rejects declared private/sensitive metadata and non-public sensitivity or
classification labels. These are bounded checks, not classification of arbitrary
prose or personal information. Rejected CLI input produces no payload and a
sanitized error; duplicate JSON keys and invalid JSON are refused.

`id`, `owner_org`, `private`, `state`, `license_id`, groups and permissions remain
absent. Source metadata cannot select destination access. An operator must review
destination ownership, visibility, authorization and name uniqueness separately.
Only creation is supported: CKAN `package_update` may delete omitted values and
requires a distinct reviewed merge workflow.

The [pinned primary reference](evidence/ckan-2.11.6-reference.json) identifies CKAN
2.11.6 commit `a22d24505d1a5f75820d43cc3b0656c2c6b925a2`, upstream file checksums
and relevant schema/validator sections. Local checks are independently derived
structural checks for this subset, not CKAN NAVL execution, an official JSON
Schema or server conformance. No CKAN instance was available in the local image
cache; dataset creation/readback, harvesting, synchronization and live portal
integration remain unverified.

The [input](fixtures/stac-ckan-collection.json) and
[selected output with both reports](evidence/stac-ckan-export.json) use synthetic,
redistributable metadata and example domains. No authentication or provider
requests participate in conversion. The focused tests also use mocked providers
for unchanged inbound CKAN behavior. Run them from `services/api`:

```bash
.venv/bin/python -m pytest tests/test_ckan_export.py tests/test_ckan.py tests/test_ckan_routes.py
```

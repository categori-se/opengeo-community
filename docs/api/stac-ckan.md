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
Schema or general server conformance. The separate disposable server check below
exercises CKAN's real creation and readback path for the supplied fixture.

The [input](fixtures/stac-ckan-collection.json) and
[selected output with both reports](evidence/stac-ckan-export.json) use synthetic,
redistributable metadata and example domains. No authentication or provider
requests participate in conversion. The focused tests also use mocked providers
for unchanged inbound CKAN behavior. Run them from `services/api`:

```bash
.venv/bin/python -m pytest tests/test_ckan_export.py tests/test_ckan.py tests/test_ckan_routes.py
```

## Disposable server check

With Podman and the locked API environment installed, the local runner creates
one synthetic dataset in CKAN 2.11.6, reads it back, deletes and purges it, checks
the resulting HTTP 404, then removes its four containers, anonymous volumes and
internal network. CKAN alone exposes a random loopback port. It uses real
PostgreSQL, Solr and Redis, with digest-pinned images and unchanged CKAN validation.
It configures the five core INI settings through CKAN's `config-tool` before the
official startup script initializes the database.

The runner requires the pinned PostgreSQL image to be cached first. For an
independent setup, run these commands from the repository root:

```bash
podman pull docker.io/postgis/postgis@sha256:8828b03e9a95269f808abe62aa83215b22a2d3710f54a55e8040327b7b5f9932
services/api/.venv/bin/python services/api/scripts/check_stac_ckan_local.py \
  --allow-pull --output .opengeo/ckan-roundtrip.json
```

`--allow-pull` permits only the three pinned CKAN/Solr/Redis images to be fetched
if missing; their manifest-declared compressed layers total 1,045,111,215 bytes.
The default performs no pulls, so omit that option when all four images are
cached. No image is built. The default 600-second budget includes cleanup;
`--budget-seconds` may reduce it. Downloaded images remain in the local cache.

Authentication uses a generated disposable local CKAN sysadmin and a real CKAN
token, kept inside the process. The destination explicitly enables
`create_unowned_dataset` and uses only the `envvars` plugin. These are local test
settings, not grants derived from STAC. The exporter leaves ownership, visibility,
license ID and grants absent; CKAN chooses its own defaults. This check does not
exercise destination permission policy for ordinary users.

The [selected server receipt](evidence/stac-ckan-roundtrip-local.json) records the
source commit and dirty diff, exact commands, image identities, earlier failed
attempts, all 12 assertions and synthetic readback. The verified run preserved
the payload's name, title, notes, tags, self URL, reference resource fields and
every namespaced provenance/publisher/extent/license/link extra. CKAN generated
its own IDs and selected `private=false`, `state=active`, and null owner/license
IDs. The raw fixture and canonical source checksums remained unchanged.

This establishes a local Action API roundtrip for one fixture. CKAN UI,
harvesting, synchronization, remote reference access and cloud acceptance remain
unverified. Reference URLs were not fetched, and no provider was mocked in this
server check.

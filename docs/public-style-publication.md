# Exact public Style publication

A public dataset's license does not license a reusable Style. Publishing a map
or Artifact requires separate rights for each pinned Style. A curator may record
those rights in the existing **Metadata and rights → Extended catalog metadata**
JSON editor while the parent resource is draft/review, then use its ordinary
authorized publishing workflow. This does not publish any resource automatically.

The extension key is `opengeo.style-publications`. Its value has exactly
`schemaVersion: "opengeo.public-style-publications.1.0.0"` and `styles`, an array
of 1–64 entries, within 8 KiB total. Each entry has exactly `styleId`,
`versionNumber`, `checksumSha256`, `format`, `license`, and `attribution`.
The first four fields copy the exact canonical Style reference; format is one
of `maplibre`, `geostyler`, `sld`, or `mapserver`. The separate license is
`CC-BY-4.0`, `CC0-1.0`, or `PDDL-1.0`; attribution is nonblank and at most 2,000
characters. This is an explicit curated rights assertion, not a provider fact
or an inference from the dataset's terms. Duplicate pins and unknown fields fail.

Anonymous resolution requires the same organization and exact dataset association,
the current parent resource to be published/public, an unarchived Style, exact
version/format/checksum and recomputed definition checksum, and a matching rights
entry. Requesting-user read permission supplies none of this public authority.
The read seal includes the current metadata revision, state, visibility, pin and
separate terms; public readers compare that seal before and after an object read.
Removing the entry, archiving the Style or restricting the resource revokes access.

The credential-free WMS publication profile preserves the browser's exact
EPSG:3857 GetMap URL for versions 1.3.0/1.1.1. Source revision, configuration,
manifest dependencies, network origins, public classification and published
metadata must match; WMS terms use the same three public licenses and require
attribution. URLs with credentials, secrets, private destinations or altered query
parameters remain rejected. This publishes a reference and never fetches or
copies provider imagery while opening the Catalog.

# Native publication and private previews

Build an exact saved source revision, inspect its private preview, then review
and publish it to a configured destination. Source, build output, preview access
and public editions have separate identities and permissions.

Start with the [publication workflow](../community-workflow.md),
[development setup](../community-development.md) and
[destination guide](../community-publication-destinations.md).

## Author, preview and publish

1. Import or edit the Publication's source files and save a source revision.
2. Connect eligible Catalog files by exact version/object binding. A retained
   saved-map Artifact can accompany the data; its reviewed browser-snapshot
   provenance remains explicit (`authoritativeBuild: false`).
3. Request a build with the configured isolated compiler. Reopen completed output
   from Build history instead of rebuilding unchanged inputs.
4. Open the signed private preview and inspect the map, tables, narrative and
   source credits. Previewing does not publish the work.
5. Select a configured destination, review rights and the proposed release, then
   approve publication through the Publish controls.

Earlier editions remain distinct from the current address. Inspect the selected
delivery adapter before relying on a permanent edition URL. Broader Notebook and
input combinations require their own supported profile; see the
[capability guide](../community-capabilities.md).

The [facilities exercise](../community-examples.md#use-the-registered-layer-in-a-publication)
provides fictional CC0 data and reader code for Catalog-file reuse. The
[Berkshire study](../../examples/berkshires-acecs/README.md) provides a larger
source example with its own rights and provenance.

## Enable local native publication

Use the existing [development runner](../../scripts/run-integrated-studio-local.py)
with `--development --state-directory <private-directory>` and
`--publication-compiler-digest sha256:<exact-cached-digest>`. Set
`--publication-preview-port <port>` when a separate port is needed. The runner
checks the cached compiler and creates or reuses private signing keys; this
option does not pull an image. Use Node.js `>=24.19.0 <25` and the API/worker
prerequisites in the development guide.

**Process queued local jobs** uses the existing coordinator and canonical
publisher. Each click handles a publisher step per queued review and leaves
incomplete work available for deliberate continuation. Processing does not
approve rights or create publication reviews. Starting development without the
compiler option leaves this publication profile disabled.

Local development uses synthetic sign-in and separate loopback origins. It does
not establish an independently configured identity provider, DNS, TLS or CDN.

## Configure private previews

For an independent HTTPS installation, configure the API with
`OPEN_GEO_OBSERVABLE_PREVIEW_ORIGIN` and
`OPEN_GEO_OBSERVABLE_PUBLIC_MAPS_PREVIEW_ORIGIN`. Add the matching pair to the
installation's same-origin `auth-config.json`:

```json
{
  "previewOrigins": {
    "local_only": "https://preview.example.org",
    "public_maps_v1": "https://maps-preview.example.org"
  }
}
```

Both origins must differ from each other and from Studio/API. HTTPS is required
outside explicit local development. A capability response cannot add a trusted
origin. Configure delivery, signing keys and authorization for that installation.

Private preview requests check current membership and consume a one-time
capability atomically. Missing, replayed or cross-build capabilities/cookies are
denied. Issued private cookies are bearer grants checked by signature, path and
expiry; delivery does not recheck membership on every read. Removing membership
therefore does not immediately revoke an already issued cookie. Capability and
cookie expiry are separate boundaries.

## Withdraw an edition

In Publish, choose **Withdraw this public edition**, confirm the exact edition
and select **Request withdrawal**. The request remains `pending`, with
`revoked: false`, until the publisher acknowledges the exact review, release
prefix and destination. Failed transport reports `needs_attention` and preserves
the reservation for recovery of the same request.

Use **Refresh withdrawal status** or **Reload publication reviews** to read
durable state. These controls do not poll automatically, rebuild source or
republish an earlier review. The
[withdrawal migration](../../database/migrations/0179_framework_publication_revocation.sql)
keeps requests immutable and tenant-scoped; runtime callers cannot acknowledge
delivery on behalf of the publisher.

The [local adapter](../../scripts/local_framework_publication.py) denies the
withdrawn edition and returns 404 with `Cache-Control: no-store`. It preserves
retained bytes, other editions, builds, rights and approvals. Withdrawing the
current edition also denies its current alias without substituting another
edition. Downloaded or printed copies cannot be recalled. Private preview grants
keep their independent expiry and access rules.

## Delivery status and limits

The connected local profile covers saved revisions, Catalog-file and saved-map
inputs, isolated builds, retained private previews, reviewed publication and
exact-edition withdrawal. Independent installation and configured production
identity/HTTPS delivery remain separate verification requirements.

The static/CDN delivery candidate restricts retained edition links to eligible
compiler-sealed HTML keys; it does not expose a general release prefix. General
assets, aliases and older receipts retain their stated current-address behavior.
Its application caps of 25 cache behaviors and five origins are conservative
admission limits, not AWS quota claims.

Production withdrawal is disabled by default. Its candidate transport requires
versioned `opengeo-withdrawn=true` S3 tags, reviewed bucket-policy denies and
publisher-only tag authority, followed by CloudFront invalidation before
acknowledgment. Unknown tags or policy fail closed. Policy ownership remains
with the infrastructure stack. Configure and verify that transport before
offering it to users.

Local fixture checks and the [public CI workflow](../../.github/workflows/api-contract.yml)
do not certify a fresh independent installation. Before inviting users, verify
the chosen installation's sign-in, viewer access, preview expiry, delivery and
withdrawal behavior through its actual configured services.

# Native publication: local readiness

The connected local Studio journey now passes for two native publication
editions. An author imports the existing CC0 fictional-facilities study, saves
approved source, builds it with the isolated native compiler, opens the signed
private preview, and prepares and approves a release through the Publish controls.
Repeating that workflow creates a second edition. Build history reopens the first
private edition, and anonymous readers can retrieve the earlier public edition
while the second remains current. Earlier missing-adapter findings describe
historical source and do not establish the current workflow's acceptance.

An additional local journey connects the registered facilities GeoJSON through
**Data files → Connect a Catalog file**, saves its exact version/object binding,
and compiles one private preview. It executes FileAttachment to display all five
names and Public access: 4/5. The unchanged authored source object is reused.
This verifies archived Catalog input; it does not establish saved-map Artifact
presentation, Notebook execution or independent deployment. The existing
[exercise](../community-examples.md#use-the-registered-layer-in-a-publication)
provides the input and reader code.

The retained facilities map also passes the local native path. Its existing map
resource, portable edition and pinned reference feed the same Publication as its
Catalog GeoJSON. The actual preview renders all five points with the saved color,
opacity, outlines and camera. The shared coordinator now loads Artifact authority
for current v3 requests combining data and maps. One native compile is reused;
no public release or production deployment is implied. The map retains reviewed
browser snapshot provenance (`authoritativeBuild: false`).

Ordinary development now processes approved publication jobs through its existing
local action. The real Berkshire study compiles, renders all 16 polygons and both
calculated tables privately, and publishes through normal review and approval.
Original source objects and revision 1 remain retained. Its anonymous edition now
also renders all 16 polygons and tables of five and eleven rows. Canonical custody
and checksum checks remain per file, fenced by the activation lock, with valid
siblings preserved after an individual read failure. The compiled
theme's remote Google font is blocked by the unchanged CSP and uses fallback
typography. Independent installation and production delivery remain open.

| Boundary | Implemented and accepted locally | Remaining acceptance |
| --- | --- | --- |
| Saved authored source | Actual Studio/API saves two approved revisions with retained input bytes and checksums. The local API supplies exact source storage, compiler identity and durable dispatch. | One archived GeoJSON input and one retained saved-map Artifact are accepted locally. Independent operator installation and broader selected-input round trips remain. |
| Native build and retained output | The existing coordinator, real SQL leases and exact-version object store execute the isolated native compiler twice. Completed output survives reopening and is reused without replaying builds. | The current default compiler image builds and passes its isolated compilation fixture. Independent installation and deployment remain open. |
| Authorized private preview | Separate-origin signed previews display both builds; Build history reopens the earlier edition. Missing/cross-build cookies and capability replay are denied. The connected local viewer workflow verifies opening, revoked grants, real 60-second capability expiry and signed-cookie expiry with a qualified local verifier clock. Installation-specific origins are validated. | Independent installation, configured production identity/delivery and production activation. Immediate revocation of issued cookies is not implemented. |
| Publication and earlier editions | Actual review, acknowledgment and approval controls dispatch the existing canonical publisher. Its restricted SQL role, separate public custody and atomic prefix activation publish both editions. Both public links open and permit anonymous reads; the previous public edition remains readable after replacement. | Independent HTTPS/DNS/CDN delivery and production release. |

The [source repository](../../services/api/src/opengeo_api/observable_sources.py)
issues a capability for 60 seconds. It can be exchanged once. Project and input
authority are checked when issuing and exchanging it; the
[database exchange function](../../database/migrations/0046_observable_preview_capabilities.sql)
checks current membership and consumes the capability atomically. A successful
exchange grants signed cookies for the exact build-output path for 15 minutes.

In the current local/native preview path, issued cookies are bearer grants
verified by signature, path and expiry; delivery does not check current membership
on each request. Removing a user's effective project access prevents new grants
and exchanges, but an already issued cookie remains valid until its signed
expiry. Immediate cookie revocation is not implemented. The
[local delivery verifier](../../services/observable-preview/src/local-server.mjs)
uses the same signature, path and expiry boundaries. Connected local browser
checks verify viewer opening, refusal of new and unused grants after access
removal, and refusal of a capability after its real 60-second expiry. The cookie
expiry check sends the unchanged issued cookies while advancing only the local
verifier clock; it does not claim a real 15-minute wait or CloudFront acceptance.

Offboarding preserves capability audit records, invitation history, retained
editions and unrelated grants. Production activation, identity and delivery
acceptance remain open.

This check uses cached images, synthetic sign-in and three separate loopback
origins. The canonical local hostname is explicitly mapped to an anonymous HTTP
server by the browser check. It does not prove DNS, TLS or CloudFront delivery.
The publisher uses the same seven existing security-definer functions; its local
bootstrap enables login only for the isolated development role. Production role
grants and migrations are unchanged. Private objects are never used as an
anonymous fallback, and staged public objects are unavailable until activation.

Activation is explicit through the existing
[development runner](../../scripts/run-integrated-studio-local.py): use
`--development --state-directory <private-directory>` with
`--publication-compiler-digest sha256:<exact-cached-digest>` and optionally
`--publication-preview-port <port>`. It checks the cached compiler and creates or
reuses private signing keys; it does not pull an image. Use Node.js
`>=24.19.0 <25`, the existing API/worker prerequisites and a separate preview port.
The [application harness](../../app/scripts/check-integrated-studio.mjs) starts
the preview server and connects **Process queued local jobs** to the coordinator
and canonical publisher. Ordinary development also provides an explicit local
destination form for one owned source. Normal review and approval remain required;
processing neither approves rights nor creates reviews. Each click handles one
publisher step per queued review, retaining incomplete work for deliberate
continuation. Ordinary startup without the compiler option leaves this publication
profile disabled.

For an independent HTTPS installation, set the matching API origins with
`OPEN_GEO_OBSERVABLE_PREVIEW_ORIGIN` and
`OPEN_GEO_OBSERVABLE_PUBLIC_MAPS_PREVIEW_ORIGIN`, then add the same pair to the
installation's same-origin `auth-config.json`:

```json
{
  "previewOrigins": {
    "local_only": "https://preview.example.org",
    "public_maps_v1": "https://maps-preview.example.org"
  }
}
```

This is an optional field within the existing auth configuration. The two preview
origins must differ from one another and from Studio/API. HTTPS remains required
outside explicit local development; a capability response cannot add a trusted
origin. Separate delivery, signing keys and authorization still need configuration.

The [public CI workflow](../../.github/workflows/api-contract.yml) now includes
local publisher/custody, coordinator/preview and API preview-origin, signing and route tests,
alongside Catalog save, exact map reopen, query authority and publication-draft
checks. These checks use bounded fixtures; they do not execute this complete
native compiler/browser journey or establish a fresh installation. The connected
local journey above runs separately through the existing runner.

Reuse the existing [community facilities study](../community-examples.md#try-it-community-facilities):
five fictional **CC0-1.0** facilities, with four marked publicly accessible and
retained source/rights metadata. Carry its inspected Layer and saved map into a
native publication, then revise and reopen the result. It is an inspection and
publishing exercise, not evidence about real facilities. The existing two-page
watershed pilot separately verifies static ZIP delivery and revocation; that
result does not establish native compilation.

Next, reproduce the accepted local workflow on a clean independent installation
and verify configured identity, HTTPS delivery, expiry and viewer-access
revocation. The
fresh-account AWS publication journey remains unfinished. This update makes no
production deployment claim.

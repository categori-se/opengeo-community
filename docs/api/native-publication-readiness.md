# Native publication: local readiness

The local storage, build coordination and isolated-preview connections are now
implemented. The complete saved-source → native compiler → authorized private
preview journey has **not yet been accepted in the standalone environment**.
A connected local Studio check imports the CC0 reference study, saves its first
source revision and creates/leases the build job. It finds a local storage adapter
return-shape mismatch before the compiler starts. That narrow correction passes
the existing production read contract offline; native compilation and the two-revision preview journey still need acceptance.
The [earlier inspection receipt](evidence/task-5.json) remains historical evidence;
its missing-adapter findings describe the source inspected then.

| Boundary | Implemented local connection | Acceptance still required |
| --- | --- | --- |
| Saved authored source | The [local API profile](../../scripts/run-integrated-pilot-local.py) supplies source upload/download storage, exact compiler identity and durable Observable build dispatch. | First source revision saved through the actual local Studio/API. Additional selected-input and revision round trips remain. |
| Native build and retained output | The [local coordinator adapters](../../services/observable-coordinator/src/local-adapters.mjs) bridge the existing SQL job leases and exact-version local object store to the real isolated compiler runner. | Compile that saved revision, retain the exact output manifest, reopen it and compile a deliberate second revision without substituting an in-memory job. |
| Authorized private preview | The [local preview server](../../services/observable-preview/src/local-server.mjs) exchanges one-time capabilities through the API and enforces signed cookies and exact output identity on a separate loopback origin. API settings also admit explicitly configured canonical HTTPS origins for independent installations. | Open the retained result in a real browser; verify denied access, capability replay, expiry and revocation through the actual API/database path. |

Activation is explicit through the existing
[development runner](../../scripts/run-integrated-studio-local.py): use
`--development --state-directory <private-directory>` with
`--publication-compiler-digest sha256:<exact-cached-digest>` and optionally
`--publication-preview-port <port>`. It checks the cached compiler and creates or
reuses private signing keys; it does not pull an image. Use Node.js
`>=24.19.0 <25`, the existing API/worker prerequisites and a separate preview port.
The [application harness](../../app/scripts/check-integrated-studio.mjs) starts
the preview server and connects **Process queued local jobs** to the coordinator. Ordinary
startup without the compiler option leaves this publication profile disabled.

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
local coordinator/preview checks and API preview-origin, signing and route tests,
alongside Catalog save, exact map reopen, query authority and publication-draft
checks. These checks use bounded fixtures; they do not execute this complete
native compiler/browser journey or establish a fresh installation.

Reuse the existing [community facilities study](../community-examples.md#try-it-community-facilities):
five fictional **CC0-1.0** facilities, with four marked publicly accessible and
retained source/rights metadata. Carry its inspected Layer and saved map into a
native publication, then revise and reopen the result. It is an inspection and
publishing exercise, not evidence about real facilities. The existing two-page
watershed pilot separately verifies static ZIP delivery and revocation; that
result does not establish native compilation.

The next local acceptance step is the saved-revision build and browser preview
above, followed by its second revision and access-denial checks. Independent
clean-install acceptance and the fresh-account AWS publication journey remain
separate, unfinished requirements. This update makes no deployment claim.

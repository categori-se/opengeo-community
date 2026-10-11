# Native publication: local readiness

The saved-source → native compiler → authorized private-preview journey remains
unverified in the standalone local environment. A read-only inspection found a
cached compiler, but completing this journey requires maintained local storage,
coordination and preview-delivery adapters beyond a small configuration change.
The [readiness evidence](evidence/task-5.json) records the inspected source and
image identities and the assertions that were not run.

| Boundary | Current local path | Missing connection |
| --- | --- | --- |
| Saved authored source | The [local application](../../scripts/run-integrated-pilot-local.py#L356) supplies dataset storage and GIS dispatch substitutes. | It does not configure application/source storage, the compiler pin or Observable build dispatch. The [API](../../services/api/src/opengeo_api/app.py#L384) otherwise selects its unavailable source-storage adapters. |
| Build coordination and retained output | The [host entry](../../services/observable-coordinator/scripts/run-host.mjs#L1) selects [production dependencies](../../services/observable-coordinator/src/runtime.mjs#L210). | That path uses AWS Data API, S3 and SQS. The local PostGIS and object store are not connected to its job-lease, exact revision/input and output-completion interfaces. |
| Authorized private preview | The [API preview exchange](../../services/api/src/opengeo_api/observable_source_routes.py#L1502) issues path-scoped CloudFront cookies; the [preview shell](../../services/observable-preview/README.md) navigates to the exact output. | The local runner has no configured preview origin/signer or maintained local server that enforces this output-access boundary. |

The cached compiler is Linux/amd64 with container UID/GID `10001:10001`; its exact
image ID and digest are in the evidence. It was inspected, not executed. The host
reported Node.js `24.18.0`, below the builder and coordinator packages' declared
`>=24.19.0 <25` requirement. Updating Node alone would not supply the missing
connections above.

The existing [pipeline diagnostic](../../services/observable-coordinator/scripts/check-local-pipeline.mjs#L92)
constructs a synthetic source claim and uses an in-memory repository and storage.
Its real compiler adapter [removes its temporary output tree](../../services/observable-coordinator/src/podman-runner.mjs#L66)
after collecting bytes. That diagnostic does not save authored source through the
API or serve a retained authorized preview, so it was not used as acceptance for
this journey.

These commands reproduce the relevant read-only inspection from the repository root:

```bash
node --version
podman image inspect e6825d9f73a3bc0ac1514363a4778cd304c61f6a53ed841bd1f4b14a790be0d7 --format '{{json .ID}} {{json .Digest}} {{json .Architecture}} {{json .Config.User}}'
nl -ba scripts/run-integrated-pilot-local.py | sed -n '352,420p'
nl -ba services/observable-coordinator/src/runtime.mjs | sed -n '210,244p'
nl -ba services/api/src/opengeo_api/observable_source_routes.py | sed -n '1495,1610p'
```

No source revision was saved, compiler or coordinator executed, output manifest
retained, authorized preview opened, second revision compiled, or preview
revocation/expiry exercised for this task. No authentication substitute, mocked
build result, cloud call, image pull or external publication was used. Native
build/private-preview acceptance and the complete cloud publication journey remain
open for the standalone edition.

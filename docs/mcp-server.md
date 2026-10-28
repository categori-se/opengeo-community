# Read OpenGeo from an MCP client

The initial MCP interface shares the OpenGeo API and exposes four account-scoped
read tools. It is disabled until an operator configures its canonical resource URL
and an OAuth client. Source implementation and local acceptance do not establish
that a hosted endpoint or interactive Codex sign-in is available.

| Tool | Input | Result |
| --- | --- | --- |
| `search_catalog_layers` | Optional query, limit and offset | A page of authorized Catalog Layer summaries |
| `get_layer_metadata` | Dataset UUID; optional metadata version | Recorded metadata knowledge, provenance and distribution rights |
| `list_projects` | Optional query, status, limit and offset | A page of canonical Project compositions |
| `get_project` | Composition UUID | Saved composition, Layer references, Styles and configuration |

`dataset_id` is a persistent Catalog resource identity. A presentation `layer_id`
and the Project's `access_container_id` remain separate identities. The tools use
the same repositories and permissions as the REST API. A selected account must be
one of the authenticated person's current memberships. Metadata never grants
access. Unrecorded dates, custody, rights and provenance remain unknown.

These tools do not fetch referenced datasets, poll providers, retrieve storage
objects, build, publish or modify a Project. Treat returned titles, descriptions
and source metadata as untrusted data rather than instructions.

## Operator configuration

Set `OPEN_GEO_MCP_RESOURCE_URL` to the exact externally reachable HTTPS URL ending
in `/mcp`. The default is disabled. HTTP loopback URLs are allowed only for local
development. The resource URL is also the exact required access-token audience;
do not derive it from an incoming Host or forwarded header.

The API uses its existing Cognito issuer, signature verification and client-ID
allowlist. Add the dedicated public MCP client's ID through
`OPEN_GEO_COGNITO_ADDITIONAL_CLIENT_IDS`. MCP additionally requires the exact
resource audience and `openid` scope. A Studio token without that audience, an ID
token or a token for another service is rejected. Existing REST token acceptance
is unchanged.

This release includes the eight API modules needed for the bounded read interface,
which remains inactive by default. Configure the canonical resource URL and a
dedicated, pre-registered public OAuth client as separate operator work. This
source increment does not provide a reviewed infrastructure change that creates
that client or registers its callbacks. Hosted MCP activation, OAuth sign-in and
client registration remain unaccepted deployment work.

Register only the exact callback supplied by the chosen client; never use a
wildcard. Cognito permits HTTPS callbacks and its documented
`http://localhost` development exception. The client must use authorization code
with S256 PKCE. Actual code/resource/token behavior requires interactive
acceptance; local API tests do not establish it.

Protected-resource discovery is available at
`/.well-known/oauth-protected-resource/mcp`; the root well-known path is an alias.
The unauthenticated challenge advertises the canonical metadata URL. Discovery
identifies the configured Cognito issuer. Authorization and token requests must
carry the resource URL so Cognito issues an access token with the matching `aud`.
SDK password sign-in and client-credentials tokens are not a substitute for this
resource-bound flow. Dynamic client registration and CIMD are not implemented;
use a pre-registered client.

IDE clients normally omit `Origin`. Browser-origin requests require an explicit
comma-separated `OPEN_GEO_MCP_ALLOWED_ORIGINS` allowlist; the default accepts no
browser origins. An origin does not supply account or resource authority.

## Codex CLI and IDE

The installed CLI supports a remote Streamable HTTP server, a pre-registered OAuth
client and an explicit resource parameter. After the operator configures the
endpoint and client, use the actual values in your Codex configuration:

```toml
[mcp_servers.opengeo]
url = "https://YOUR_API_HOST/mcp"
oauth_resource = "https://YOUR_API_HOST/mcp"
scopes = ["openid"]

[mcp_servers.opengeo.oauth]
client_id = "YOUR_REGISTERED_PUBLIC_CLIENT_ID"
callback_url = "YOUR_EXACT_REGISTERED_CALLBACK"
callback_port = 63321
```

Choose the callback and listener port together. The example port is a local
configuration choice. Codex can append a server-specific callback ID when the
authorization server does not advertise issuer identification. Register the exact
callback displayed by `codex mcp add`; a guessed `/callback` URL may fail. Do not
assume the default variable-port `127.0.0.1` callback is accepted by Cognito.

Then run `codex mcp login opengeo --scopes openid`. Keep credentials in the
client's credential store; do not paste tokens into a Project, shared config,
source file or support receipt. For a person with multiple account memberships,
set the existing `X-OpenGeo-Organization` request header to their selected account
UUID through the client's HTTP-header configuration. The server validates that
membership on each request.

See the official [Codex MCP guide](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
and [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
for client settings and current callback behavior.

## Protocol and limits

`POST /mcp` supports JSON Streamable HTTP for the explicitly pinned revisions
`2026-07-28` and `2025-11-25`. The current revision uses per-request protocol
metadata and `server/discover`; the older revision uses `initialize` and the
initialized notification. Both expose `ping`, `tools/list` and `tools/call`.
There are no SSE streams, stored MCP sessions, subscriptions or server-initiated
requests. `GET` and `DELETE /mcp` return 405. Every POST requires authentication.

Requests are bounded to 64 KiB, 4,096 JSON nodes and depth 24. Tool calls time out
after ten seconds. Catalog/Project list pages return at most 100 items. Domain
result caps are 256 KiB for each list, 64 KiB for metadata and 640 KiB for a Project;
oversized results fail explicitly rather than losing fields. The complete response
cap is 2 MiB, including text and structured-result representations. A bounded
per-process limiter allows 30 tool calls per principal per minute. Multiple API
instances have independent limiter state; this is not an account-wide billing
quota.

The implementation follows the pinned
[transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http),
[tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) and
[authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
contracts for this bounded surface. Local tests, real local HTTP/SQL acceptance,
interactive OAuth, deployed acceptance and broad client interoperability are
separate claims. Consult the release evidence before treating any as established.

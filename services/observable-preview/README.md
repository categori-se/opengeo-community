# OpenGeo Studio Observable Preview Bootstrap

This static entry page exchanges a one-time capability for access to an exact
private publication build. In the maintainers' deployment it serves
`preview.studio.opengeo.tools`; an independent installation configures its own
origin. Preview access does not publish the build or create a sign-in session.

Read the [private-preview architecture](../../docs/community-architecture.md#publication-builds-and-private-previews)
and [AWS guide](../../docs/community-aws.md) for the authority boundary and current
standalone deployment limits.

The authenticated API returns a one-time capability only in `/authorize/#cap=…`. `preview-shell.js` validates and removes that fragment before making any request, exchanges it in a no-store same-origin POST body, accepts only the exact storage-free entry-path response, and navigates to the immutable build output. The API response sets path-scoped CloudFront signed cookies; the shell never reads them.

The HTML CSP meta element is defense in depth. The authoritative `frame-ancestors`, CSP, no-referrer, no-store, permissions and isolation headers are set by [the preview edge configuration](../../infrastructure/lib/observable-preview-edge.ts); S3 alone is not a supported serving configuration. The CDK asset deployment infers the JavaScript MIME type from the `.js` object name, and no bucket is exposed as a website.

Run the local parser/request contract with:

```bash
npm test
```

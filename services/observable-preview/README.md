# OpenGeo Observable Preview Bootstrap

This package is the public, static bootstrap for the otherwise private `preview.studio.opengeo.tools` origin. It is not a compiler, publication site or authentication session.

The authenticated API returns a one-time capability only in `/authorize/#cap=…`. `preview-shell.js` validates and removes that fragment before making any request, exchanges it in a no-store same-origin POST body, accepts only the exact storage-free entry-path response, and navigates to the immutable build output. The API response sets path-scoped CloudFront signed cookies; the shell never reads them.

The HTML CSP meta element is defense in depth. The authoritative `frame-ancestors`, CSP, no-referrer, no-store, permissions and isolation headers are set by `infrastructure/lib/observable-preview-edge.ts`; S3 alone is not a supported serving configuration. The CDK asset deployment infers the JavaScript MIME type from the `.js` object name, and no bucket is exposed as a website.

Run the local parser/request contract with:

```bash
npm test
```

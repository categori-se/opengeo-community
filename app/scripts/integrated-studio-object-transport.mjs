import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {join} from "node:path";

// This is an offline substitute for object transport, never a general proxy.
export function localObjectDownload({work, url, method, headers = {}, now = Date.now()}) {
  assert.equal(method, "GET");
  assert.equal(headers.authorization, undefined);
  assert.equal(headers.cookie, undefined);
  const issued = JSON.parse(readFileSync(join(work, "issued-downloads.json"), "utf8"));
  const record = Object.hasOwn(issued, url) ? issued[url] : null;
  if (!record || Date.parse(record.expires_at) <= now || !Number.isFinite(Date.parse(record.expires_at))) {
    return {status: 403, body: "Unissued or expired local download"};
  }
  assert.match(record.version_id, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
  const body = readFileSync(join(work, "objects", record.version_id));
  assert.equal(body.length, record.size_bytes);
  assert.equal(createHash("sha256").update(body).digest("hex"), record.checksum_sha256);
  return {status: 200, contentType: record.content_type, body};
}

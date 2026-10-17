import assert from "node:assert/strict";
import {test} from "node:test";
import {createHash, generateKeyPairSync, sign} from "node:crypto";
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Readable} from "node:stream";
import {createLocalPreviewHandler} from "../src/local-server.mjs";

const origin = "http://127.0.0.1:42001", studioOrigin = "http://127.0.0.1:42002";
const id = "11111111-1111-4111-8111-111111111111", version = "22222222-2222-4222-8222-222222222222";
const prefix = `/organizations/${id}/projects/${id}/source-projects/${id}/builds/${id}/output/`;
const path = prefix + "index.html", now = 1_800_000_000_000;
const {privateKey, publicKey} = generateKeyPairSync("rsa", {modulusLength: 2048});
const encode = value => value.toString("base64").replaceAll("+", "-").replaceAll("=", "_").replaceAll("/", "~");
function cookies(resource = origin + prefix + "*", expiry = now / 1000 + 300) {
  const policy = Buffer.from(JSON.stringify({Statement: [{Resource: resource, Condition: {DateLessThan: {"AWS:EpochTime": expiry}}}]}));
  return {"CloudFront-Policy": encode(policy), "CloudFront-Signature": encode(sign("RSA-SHA1", policy, privateKey)), "CloudFront-Key-Pair-Id": "LOCALPREVIEW123"};
}
const cookieHeader = values => Object.entries(values).map(([name, value]) => `${name}=${value}`).join("; ");
function fixture(t, apiRequest = async () => assert.fail("No API request allowed")) {
  const work = mkdtempSync(join(tmpdir(), "opengeo-local-preview-"));t.after(() => rmSync(work, {recursive: true, force: true}));
  mkdirSync(join(work, "objects"));
  writeFileSync(join(work, "publication-preview-public.pem"), publicKey.export({type: "spki", format: "pem"}), {mode: 0o600});
  const body = Buffer.from("<!doctype html><title>Exact private build</title>");
  const record = {bucket: "local-pilot.invalid", key: path.slice(1), version_id: version, content_type: "text/html", size_bytes: body.length,
    checksum_sha256: createHash("sha256").update(body).digest("hex")};
  writeFileSync(join(work, "objects.json"), JSON.stringify({[version]: record}));writeFileSync(join(work, "objects", version), body);
  const profile = {previewOrigin: origin, previewKeyPairId: "LOCALPREVIEW123", previewPublicKeyPath: "publication-preview-public.pem"};
  const handler = createLocalPreviewHandler({work, profile, studioOrigin, apiRequest, now: () => now});
  return {work, record, body, profile, handler};
}
async function request(handler, url = path, {method = "GET", headers = {}, body = ""} = {}) {
  const incoming = Readable.from(body ? [Buffer.from(body)] : []);Object.assign(incoming, {url, method, headers: {host: "127.0.0.1:42001", ...headers}});
  const response = {headers: {}, status: 200, setHeader(name, value) {this.headers[name.toLowerCase()] = value;return this;},
    writeHead(status, headers = {}) {this.status = status;for (const [key, value] of Object.entries(headers)) this.setHeader(key, value);return this;},
    end(body) {this.body = body === undefined ? Buffer.alloc(0) : Buffer.from(body);return this;}};
  await handler(incoming, response);return response;
}
test("exact RSA signed cookies deliver only their retained output with isolated headers", async t => {
  const f = fixture(t), result = await request(f.handler, path, {headers: {cookie: cookieHeader(cookies())}});
  assert.equal(result.status, 200);assert.deepEqual(result.body, f.body);
  assert.match(result.headers["cache-control"], /no-store/);assert.equal(result.headers["referrer-policy"], "no-referrer");
  assert.match(result.headers["content-security-policy"], /frame-ancestors 'self' http:\/\/127.0.0.1:42002/);
  assert.match(result.headers["content-security-policy"], /connect-src 'self' data: blob:/);
});
test("missing, tampered, expired, wrong-key and cross-build policies cannot read outputs", async t => {
  const f = fixture(t);
  for (const header of [undefined, cookieHeader({...cookies(), "CloudFront-Signature": "bad"}), cookieHeader(cookies(undefined, now / 1000)),
    cookieHeader({...cookies(), "CloudFront-Key-Pair-Id": "OTHER"}), cookieHeader(cookies(origin + prefix.replace(id, version) + "*")),
    cookieHeader(cookies()) + "; session=forbidden"]) {
    assert.equal((await request(f.handler, path, {headers: {cookie: header}})).status, 403);
  }
});
test("host, origin, traversal and bearer headers fail before object delivery", async t => {
  const f = fixture(t), valid = {cookie: cookieHeader(cookies())};
  for (const headers of [{...valid, host: "evil.invalid"}, {...valid, origin: studioOrigin}, {...valid, authorization: "Bearer forbidden"}]) {
    assert.equal((await request(f.handler, path, {headers})).status, 403);
  }
  for (const unsafe of [prefix + "../objects.json", prefix + "%2e%2e/file", prefix + "secret.pem", "//evil.invalid/path", path + "?token=x"]) {
    assert.equal((await request(f.handler, unsafe, {headers: valid})).status, 403);
  }
});
test("symlink, checksum drift and duplicate object identities stay unavailable", async t => {
  const f = fixture(t), headers = {cookie: cookieHeader(cookies())};
  writeFileSync(join(f.work, "objects", version), "changed");
  assert.equal((await request(f.handler, path, {headers})).status, 403);
  writeFileSync(join(f.work, "objects", version), f.body);
  writeFileSync(join(f.work, "objects.json"), JSON.stringify({[version]: f.record, [id]: {...f.record, version_id: id}}));
  assert.equal((await request(f.handler, path, {headers})).status, 403);
  writeFileSync(join(f.work, "objects.json"), JSON.stringify({[version]: f.record}));
  rmSync(join(f.work, "objects", version));symlinkSync(join(f.work, "publication-preview-public.pem"), join(f.work, "objects", version));
  assert.equal((await request(f.handler, path, {headers})).status, 403);
});
test("bootstrap is public but exchange proxies only a bounded capability and preserves path cookies", async t => {
  const calls = [], selected = cookies();
  const f = fixture(t, async (url, options) => {
    calls.push({url, options});return {status: 200, headers: {"set-cookie": Object.entries(selected).map(([key, value]) => `${key}=${value}; Path=${prefix}; HttpOnly; SameSite=Strict`)},
      body: Buffer.from(JSON.stringify({entry_path: path, expires_at: new Date(now + 300_000).toISOString(), publication_authorized: false}))};
  });
  assert.equal((await request(f.handler, "/authorize/")).status, 200);
  const result = await request(f.handler, "/observable-preview/exchange", {method: "POST", headers: {origin, "sec-fetch-site": "same-origin", "content-type": "application/json"}, body: JSON.stringify({capability: "A".repeat(128)})});
  assert.equal(result.status, 200);assert.equal(result.headers["set-cookie"].length, 3);assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0].options.headers).sort(), ["content-type", "origin", "sec-fetch-site"]);
});
test("cross-origin or oversized capability exchanges never reach the API", async t => {
  const f = fixture(t);
  for (const options of [{method: "POST", headers: {origin: studioOrigin}},
    {method: "POST", headers: {origin, "sec-fetch-site": "same-origin", "content-type": "application/json"}, body: "A".repeat(2049)}]) {
    assert.equal((await request(f.handler, "/observable-preview/exchange", options)).status, 403);
  }
});
test("compiled data attachments retain their exact MIME and signed build scope", async t => {
  const f = fixture(t), body = Buffer.from("name,value\nclinic,2\n"), file = prefix + "data/clinics.csv";
  writeFileSync(join(f.work, "objects", version), body);
  writeFileSync(join(f.work, "objects.json"), JSON.stringify({[version]: {...f.record, key: file.slice(1), content_type: "text/csv", size_bytes: body.length,
    checksum_sha256: createHash("sha256").update(body).digest("hex")}}));
  const result = await request(f.handler, file, {headers: {cookie: cookieHeader(cookies())}});
  assert.equal(result.status, 200);assert.equal(result.headers["content-type"], "text/csv");assert.deepEqual(result.body, body);
});

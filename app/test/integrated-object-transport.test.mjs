import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {localObjectDownload} from "../scripts/integrated-studio-object-transport.mjs";
import {parseDownloadTicket} from "../src/lib/apiClient.js";

test("local exact-object transport rejects unissued, expired, credentialed and modified downloads", () => {
  const work = mkdtempSync(join(tmpdir(), "opengeo-object-transport-"));
  try {
    mkdirSync(join(work, "objects"));
    const version = "10000000-0000-4000-8000-000000000001", body = Buffer.from('{"type":"FeatureCollection","features":[]}');
    const url = new URL("https://s3.us-east-1.amazonaws.com/local-pilot.invalid/example.geojson");
    for (const [key, value] of Object.entries({"X-Amz-Algorithm":"AWS4-HMAC-SHA256", "X-Amz-Credential":"synthetic-local-only", "X-Amz-Date":"20260923T000000Z", "X-Amz-Expires":"300", "X-Amz-SignedHeaders":"host", "X-Amz-Signature":"0".repeat(64), "response-content-disposition":'attachment; filename="example.geojson"', versionId:version})) url.searchParams.set(key,value);
    const expires = "2099-01-01T00:00:00Z";
    const ticket = parseDownloadTicket({url:url.href, method:"GET", expires_at:expires});
    writeFileSync(join(work,"objects",version),body);
    writeFileSync(join(work,"issued-downloads.json"),JSON.stringify({[url.href]:{version_id:version,content_type:"application/geo+json",expires_at:expires,size_bytes:body.length,checksum_sha256:createHash("sha256").update(body).digest("hex")}}));
    const request = {work, url:ticket.url, method:"GET"};
    assert.deepEqual(localObjectDownload(request).body,body);
    assert.equal(localObjectDownload({...request,url:ticket.url+"&other=1"}).status,403);
    assert.equal(localObjectDownload({...request,now:Date.parse(expires)}).status,403);
    assert.throws(()=>localObjectDownload({...request,headers:{authorization:"Bearer forbidden"}}));
    assert.throws(()=>localObjectDownload({...request,method:"POST"}));
    writeFileSync(join(work,"objects",version),"modified");
    assert.throws(()=>localObjectDownload(request));
  } finally {rmSync(work,{recursive:true,force:true});}
});

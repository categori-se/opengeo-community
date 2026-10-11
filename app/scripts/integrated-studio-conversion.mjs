import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {prepareManagedSpatialFile} from "../src/lib/spatialInterchange.js";

// Real registration/API/worker; only cloud object transport is substituted by the
// existing orchestrator. Conversion executes the product helper in Node, not UI.
export async function exerciseManagedConversion({page, project, worker, readApi, work}) {
  const original = new File(["POINT (85.324 27.7172)"], "conversion-survey.wkt");
  const prepared = await prepareManagedSpatialFile(original);
  const bytes = Buffer.from(await prepared.file.arrayBuffer());
  await page.getByLabel("Dataset, image, or document file", {exact: true}).setInputFiles({
    name: prepared.file.name, mimeType: prepared.file.type, buffer: bytes
  });
  await page.getByLabel("Dataset, image, or document name", {exact: true}).fill("Conversion provenance survey");
  await page.getByLabel("Dataset classification", {exact: true}).selectOption("internal");
  const completed = page.waitForResponse(r => r.url().endsWith("/complete") && r.request().method() === "POST");
  await page.getByRole("button", {name: "Hash and upload", exact: true}).click();
  const response = await completed; assert.equal(response.status(), 200);
  const completion = await response.json();
  await worker(); await page.reload();
  const dataset = await readApi(`/projects/${project.id}/datasets/${completion.dataset.id}`);
  assert.equal(dataset.status, "active"); assert.equal(dataset.feature_count, 1);
  const versions = await readApi(`/projects/${project.id}/datasets/${dataset.id}/versions`);
  const object = versions.flatMap(v => v.objects).find(o => o.role === "original");
  assert.ok(object);
  const checksum = createHash("sha256").update(bytes).digest("hex");
  assert.equal(object.checksum_sha256, checksum);
  const index = JSON.parse(readFileSync(join(work, "objects.json"), "utf8"));
  const records = Object.values(index).filter(r => r.checksum_sha256 === checksum);
  assert.equal(records.length, 1);
  assert.match(records[0].version_id, /^[0-9a-f-]{36}$/);
  const stored = readFileSync(join(work, "objects", records[0].version_id));
  assert.deepEqual(stored, bytes);
  const knowledge = JSON.parse(stored)["opengeo:conversion"];
  assert.deepEqual(knowledge, prepared.report);
  assert.equal(knowledge.source.originalBytesArchived, false);
  return {datasetId: dataset.id, normalizedSha256: checksum,
    originalSha256: knowledge.source.checksumSha256, storedReportReopened: true,
    workerInspected: true, originalSourceArchived: false,
    scope: "Product conversion helper, registration UI, real API/database/worker; local object transport. Workbench WKT selection not exercised."};
}

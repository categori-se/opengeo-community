import assert from "node:assert/strict";
import {createHash, randomUUID} from "node:crypto";
import {it} from "node:test";
import {planSourceHistoryBackup, createSourceHistoryBackup, readSourceHistoryBackup,
  planSourceHistoryRestore, restoreSourceHistoryStep, reconcileSourceHistoryStep} from "../src/lib/publicationSourceHistory.js";

const sha = blob => blob.arrayBuffer().then(bytes => createHash("sha256").update(new Uint8Array(bytes)).digest("hex"));
const projectId = randomUUID(), sourceId = randomUUID(), siteId = randomUUID(), actor = randomUUID();
async function history() {
  const image = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff])], {type: "image/png"});
  const revisions = [];
  for (let number = 1; number <= 2; number++) {
    const files = [{relativePath: "index.html", contentType: "text/html", blob: new Blob([`\ufeff<p>Saved ${number}</p>\r\n`], {type: "text/html"})},
      {relativePath: "plot.png", contentType: "image/png", blob: image}];
    for (const file of files) {file.sizeBytes = file.blob.size; file.checksumSha256 = await sha(file.blob);}
    revisions.push({id: randomUUID(), sourceProjectId: sourceId, revisionNumber: number,
      parentRevisionId: revisions.at(-1)?.id ?? null, title: `Historical ${number}`, rightsStatus: number === 1 ? "approved" : "rejected",
      entryPath: "index.html", lockfilePath: null, changeSummary: `Original ${number}`, createdBy: actor,
      createdAt: `2026-10-0${number}T12:00:00Z`, manifest: {dataAttachments: [], compiler: "sha256:" + "a".repeat(64)},
      manifestChecksumSha256: "b".repeat(64), dataAttachments: [], files});
  }
  const sourceProject = {id: sourceId, projectId, siteId, title: "History", currentRevisionNumber: 2,
    currentRevisionId: revisions[1].id, buildPolicy: {compilerImageDigest: "sha256:" + "a".repeat(64)}};
  return {sourceProject, revisions};
}
async function archive() {
  const original = await history(), reads = [];
  const adapter = {readPublicationArtifactReferences: async () => ({revision: 0, references: []}),
    listObservableSourceRevisions: async () => original.revisions,
    readObservableSourceRevisionFile: async (_project, _source, id, path) => {reads.push([id, path]);
      return original.revisions.find(revision => revision.id === id).files.find(file => file.relativePath === path);}};
  const plan = planSourceHistoryBackup(original);
  const packed = await createSourceHistoryBackup({...original, adapter, projectId, plan});
  return {...original, adapter, plan, packed, loaded: await readSourceHistoryBackup(packed.blob), reads};
}
function destinationAdapter() {
  const id = randomUUID(), records = [], bodies = new Map(); let saves = 0, loseResponse = false;
  return {id, records, bodies, get saves() {return saves;}, set loseResponse(value) {loseResponse = value;},
    readPublicationArtifactReferences: async () => ({revision: 0, references: []}),
    listObservableSourceRevisions: async () => structuredClone(records),
    readObservableSourceRevisionFile: async (_project, _source, revisionId, path) => bodies.get(`${revisionId}:${path}`),
    saveObservableSourceRevision: async (_project, _source, draft) => {
      saves++; assert.equal(draft.expectedRevision, records.length);
      const revision = {...draft, id: randomUUID(), sourceProjectId: id, revisionNumber: records.length + 1,
        parentRevisionId: records.at(-1)?.id ?? null, manifestChecksumSha256: randomUUID().replaceAll("-", "").repeat(2), files: []};
      for (const file of draft.files) {
        const descriptor = {relativePath: file.relativePath, contentType: file.contentType,
          checksumSha256: await sha(file.blob), sizeBytes: file.blob.size};
        revision.files.push(descriptor); bodies.set(`${revision.id}:${file.relativePath}`, {...descriptor, blob: file.blob});
      }
      records.push(revision);
      if (loseResponse) throw Error("Lost committed response");
      return revision;
    }};
}
const receipt = (archive, id) => ({schemaVersion: "opengeo.source-history-restore.1.0.0", sourceProjectId: id,
  archiveChecksumSha256: archive.checksumSha256, baseRevision: 0, completed: [], pending: null});

it("backs up every saved revision and reads repeated original bytes once", async () => {
  const result = await archive();
  assert.equal(result.plan.revisionCount, 2); assert.equal(result.plan.uniqueFiles.length, 3); assert.equal(result.reads.length, 3);
  assert.equal(result.loaded.revisions.length, 2);
  for (const [index, revision] of result.loaded.revisions.entries()) {
    assert.equal(revision.provenance.createdBy, actor);
    assert.equal(revision.provenance.rightsStatus, result.revisions[index].rightsStatus);
    assert.deepEqual(revision.provenance.manifest, result.revisions[index].manifest);
    assert.deepEqual(new Uint8Array(await revision.files.find(file => file.relativePath === "index.html").blob.arrayBuffer()),
      new Uint8Array(await result.revisions[index].files[0].blob.arrayBuffer()));
  }
});

it("restores staged forward revisions with exact bytes, retained provenance and unreviewed rights", async () => {
  const {loaded} = await archive(), adapter = destinationAdapter(), checkpoints = [];
  const destination = {id: adapter.id, currentRevisionNumber: 0, currentRevisionId: null};
  const plan = planSourceHistoryRestore({archive: loaded, destination}); assert.equal(plan.maximumCommitRequests, 2);
  let checkpoint = receipt(loaded, adapter.id);
  const args = () => ({archive: loaded, adapter, projectId, sourceProjectId: adapter.id, checkpoint,
    saveCheckpoint: async next => {checkpoints.push(structuredClone(next));}});
  checkpoint = await restoreSourceHistoryStep(args());
  assert.equal(adapter.saves, 1); assert.equal(checkpoint.completed.length, 1); assert.equal(checkpoints[0].pending.index, 0);
  checkpoint = await restoreSourceHistoryStep(args());
  assert.equal(adapter.saves, 2); assert.equal(checkpoint.completed.length, 2); assert.equal(checkpoint.pending, null);
  for (const revision of adapter.records) {
    assert.equal(revision.rightsStatus, "unreviewed"); assert.deepEqual(revision.dataAttachments, []);
    const context = revision.files.find(file => file.relativePath.startsWith("opengeo-source-backup-context"));
    const original = JSON.parse(await adapter.bodies.get(`${revision.id}:${context.relativePath}`).blob.text());
    assert.equal(original.revision.createdBy, actor); assert.equal(original.sourceProject.id, sourceId);
  }
});

it("reconciles a lost committed response and never repeats the committed mutation", async () => {
  const {loaded} = await archive(), adapter = destinationAdapter(); adapter.loseResponse = true;
  let checkpoint = receipt(loaded, adapter.id), saved;
  const args = () => ({archive: loaded, adapter, projectId, sourceProjectId: adapter.id, checkpoint,
    saveCheckpoint: async next => {saved = next;}});
  checkpoint = await restoreSourceHistoryStep(args());
  assert.equal(checkpoint.completed.length, 1); assert.equal(adapter.saves, 1); assert.equal(saved.pending, null);
  checkpoint = await reconcileSourceHistoryStep(args()); assert.equal(adapter.saves, 1);
  const unresolved = {...checkpoint, pending: {index: 1}};
  await assert.rejects(restoreSourceHistoryStep({...args(), checkpoint: unresolved}), /Reconcile/);
  assert.equal(adapter.saves, 1);
});

it("refuses partial history, pinned dependencies, changed destination and receipt storage failure before writes", async () => {
  const original = await history();
  assert.throws(() => planSourceHistoryBackup({...original, revisions: original.revisions.slice(1)}), /every saved revision/);
  original.revisions[0].manifest.dataAttachments = [{path: "data.csv"}];
  assert.throws(() => planSourceHistoryBackup(original), /pinned dependencies/);
  const publicHistory = await history();
  publicHistory.revisions[0].manifest.referencedFiles = [{path: "data/original.tif"}];
  assert.throws(() => planSourceHistoryBackup(publicHistory), /pinned dependencies/);
  delete publicHistory.revisions[0].manifest.referencedFiles;
  publicHistory.revisions[0].referencedFiles = [{referenceId: randomUUID(), relativePath: "data/original.tif"}];
  assert.throws(() => planSourceHistoryBackup(publicHistory), /pinned dependencies/);
  const {loaded} = await archive(), adapter = destinationAdapter();
  assert.throws(() => planSourceHistoryRestore({archive: loaded, destination: {id: adapter.id, currentRevisionNumber: 1, currentRevisionId: randomUUID()}}), /new empty/);
  const args = {archive: loaded, adapter, projectId, sourceProjectId: adapter.id, checkpoint: receipt(loaded, adapter.id),
    saveCheckpoint: async () => {throw Error("Storage failed");}};
  await assert.rejects(restoreSourceHistoryStep(args), /Storage failed/); assert.equal(adapter.saves, 0);
  adapter.readPublicationArtifactReferences = async () => ({revision: 1, references: []});
  await assert.rejects(restoreSourceHistoryStep(args), /map-reference history/); assert.equal(adapter.saves, 0);
});

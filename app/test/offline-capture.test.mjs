import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {
  OfflineCaptureQueue,
  OfflineAttachmentFiles,
  pendingDeviceAttachments,
  gpsPoint,
  offlineCaptureAllowed,
  syncCaptureQueue
} from "../src/lib/offlineCapture.js";

const IDS = {
  organization: "10000000-0000-4000-8000-000000000141",
  user: "20000000-0000-4000-8000-000000000141",
  otherUser: "20000000-0000-4000-8000-000000000142",
  project: "50000000-0000-4000-8000-000000000141",
  dataset: "80000000-0000-4000-8000-000000000141",
  form: "a0000000-0000-4000-8000-000000000141",
  first: "b0000000-0000-4000-8000-000000000141",
  second: "b0000000-0000-4000-8000-000000000142"
  ,target: "90000000-0000-4000-8000-000000000141"
};

class MemoryStore {
  constructor() {
    this.records = new Map();
  }

  async list() {
    return structuredClone([...this.records.values()]);
  }

  async put(record) {
    this.records.set(record.queueId, structuredClone(record));
  }

  async remove(id) {
    this.records.delete(id);
  }

  async update(id, change) {
    this.records.set(id, structuredClone(change(this.records.get(id))));
  }
}

function scope(userId = IDS.user) {
  return {organizationId: IDS.organization, userId};
}

function draft(submissionId = IDS.first, name = "Station") {
  return {
    projectId: IDS.project,
    datasetId: IDS.dataset,
    formId: IDS.form,
    formVersion: 1,
    submissionId,
    supersedesSubmissionId: null,
    feature: {
      type: "Feature",
      id: submissionId,
      geometry: {type: "Point", coordinates: [-77.03, 38.9]},
      properties: {name}
    }
  };
}

describe("offline field capture queue", () => {
  it("waits for device attachments and durably pins replay before a lost acknowledgement", async () => {
    const queue = new OfflineCaptureQueue({store: new MemoryStore()});
    const capture = draft();
    capture.feature.properties = {note: `device-file:${IDS.second}`, observations: [{photo: `device-file:${IDS.second}`} ]};
    capture.deviceAttachments = pendingDeviceAttachments([{name:'observations',type:'group',repeat:true,fields:[{name:'photo',type:'string',attachment:true}]}],capture.feature.properties);
    assert.deepEqual(capture.deviceAttachments,[{path:['observations',0,'photo'],localId:IDS.second}]);
    await queue.enqueue(scope(), capture);
    let submissions=0;
    const pending=await syncCaptureQueue(queue,scope(),async()=>{submissions++;});
    assert.equal(pending.stoppedReason,'attachment_pending');assert.equal(submissions,0);
    const version='81000000-0000-4000-8000-000000000001';
    const lost=await syncCaptureQueue(queue,scope(),async request=>{
      submissions++;assert.equal(request.feature.properties.observations[0].photo,version);
      throw new TypeError('Response lost');
    },{resolveDeviceAttachment:async id=>{assert.equal(id,IDS.second);return version;}});
    assert.equal(lost.pending,1);
    const [retained]=await queue.list(scope());
    assert.deepEqual(retained.deviceAttachments,[]);
    assert.equal(retained.request.feature.properties.note,`device-file:${IDS.second}`);
    const accepted=await syncCaptureQueue(queue,scope(),async request=>{
      assert.deepEqual(request,retained.request);
    },{resolveDeviceAttachment:async()=>{throw Error('Must reuse pinned payload');}});
    assert.equal(accepted.synced,1);
  });
  it("retains bounded attachment bytes separately from submissions and refuses sensitive storage", async () => {
    const files = new OfflineAttachmentFiles({store: new MemoryStore()});
    const file = new Blob(["retained bytes"], {type: "image/png"});
    Object.defineProperty(file, "name", {value: "photo.png"});
    await assert.rejects(files.save(scope(), {projectId: IDS.project, classification: "restricted", file}), {code: "offline_attachment_classification_denied"});
    const saved = await files.save(scope(), {projectId: IDS.project, classification: "internal", file});
    const [retained] = await files.list(scope(), IDS.project);
    assert.equal(await retained.file.text(), "retained bytes");
    assert.equal(retained.filename, "photo.png");
    assert.equal(retained.classification, "internal");
    await files.checkpointRegistration(scope(),saved.id,{attemptId:IDS.first,checksumSha256:'a'.repeat(64)});
    await files.checkpointRegistration(scope(),saved.id,{attemptId:IDS.first,uploadId:IDS.second});
    const [checkpoint]=await files.list(scope());
    assert.equal(checkpoint.uploadId,IDS.second);
    assert.equal(checkpoint.checksumSha256,'a'.repeat(64));
    assert.equal(Object.hasOwn(checkpoint,'upload'),false);
    await assert.rejects(files.checkpointRegistration(scope(),saved.id,{attemptId:IDS.target}),{code:'offline_attachment_registration_unresolved'});
    assert.equal((await files.list(scope(IDS.otherUser), IDS.project)).length, 0);
    await files.remove(scope(IDS.otherUser), saved.id);
    assert.equal((await files.list(scope(), IDS.project)).length, 1);
    await files.remove(scope(), saved.id);
    assert.equal((await files.list(scope(), IDS.project)).length, 0);
  });
  it("retains exact nested attachment references after access refusal and retries unchanged", async () => {
    const queue = new OfflineCaptureQueue({store: new MemoryStore()});
    const capture = draft();
    capture.feature.properties = {photo: IDS.first, observations: [{attachment: IDS.second}]};
    await queue.enqueue(scope(), capture);
    const denied = await syncCaptureQueue(queue, scope(), async () => {
      throw Object.assign(new Error("file access revoked"), {status: 403});
    });
    assert.equal(denied.stoppedReason, "access_denied");
    assert.equal(denied.pending, 1);
    assert.equal(denied.synced, 0);
    const [retained] = await queue.list(scope());
    assert.deepEqual(retained.request.feature.properties, capture.feature.properties);
    assert.equal((await queue.list(scope(IDS.otherUser))).length, 0);
    const accepted = await syncCaptureQueue(queue, scope(), async request => {
      assert.deepEqual(request, retained.request);
      assert.deepEqual(request.feature.properties, capture.feature.properties);
    });
    assert.equal(accepted.synced, 1);
    assert.equal(accepted.pending, 0);
  });
  it("partitions records by shared-auth organization and user without storing credentials", async () => {
    const store = new MemoryStore();
    const queue = new OfflineCaptureQueue({
      store,
      now: () => new Date("2026-08-20T18:00:00Z")
    });
    await queue.enqueue(scope(), draft());

    const own = await queue.list(scope());
    const otherUser = await queue.list(scope(IDS.otherUser));

    assert.equal(own.length, 1);
    assert.equal(otherUser.length, 0);
    assert.equal(own[0].queuedAt, "2026-08-20T18:00:00.000Z");
    assert.equal(JSON.stringify(own).includes("Bearer"), false);
    assert.equal(Object.hasOwn(own[0], "accessToken"), false);
  });

  it("makes identical local replay idempotent and rejects changed reuse", async () => {
    const queue = new OfflineCaptureQueue({store: new MemoryStore()});
    const first = await queue.enqueue(scope(), draft());
    const replay = await queue.enqueue(scope(), draft());

    assert.deepEqual(replay, first);
    assert.equal((await queue.list(scope())).length, 1);
    await assert.rejects(
      queue.enqueue(scope(), draft(IDS.first, "Changed station")),
      (error) => error.code === "offline_capture_idempotency_conflict"
    );
  });

  it("retains the authoritative target and exact base for queued updates", async () => {
    const queue = new OfflineCaptureQueue({store: new MemoryStore()});
    const update = draft();
    update.operation = "update";
    update.targetFeatureId = IDS.target;
    update.targetFeatureVersion = 7;
    update.feature.id = IDS.target;

    const stored = await queue.enqueue(scope(), update);

    assert.equal(stored.request.operation, "update");
    assert.equal(stored.request.targetFeatureId, IDS.target);
    assert.equal(stored.request.targetFeatureVersion, 7);
    assert.equal(stored.request.feature.id, IDS.target);
    await assert.rejects(
      queue.enqueue(scope(), {...update, targetFeatureVersion: 8}),
      (error) => error.code === "offline_capture_idempotency_conflict"
    );
  });

  it("preserves bounded nested and ordered repeating properties without credentials", async () => {
    const queue = new OfflineCaptureQueue({store: new MemoryStore()});
    const grouped = draft();
    grouped.feature.properties = {
      observer: {name: "A. Rivera", certified: true},
      samples: [
        {kind: "water", reading: 7.2},
        {kind: "soil", reading: 4.1}
      ]
    };

    await queue.enqueue(scope(), grouped);
    const [stored] = await queue.list(scope());
    let replayed;
    const result = await syncCaptureQueue(queue, scope(), async (request) => {
      replayed = request.feature.properties;
    });

    assert.deepEqual(stored.request.feature.properties, grouped.feature.properties);
    assert.deepEqual(replayed, grouped.feature.properties);
    assert.equal(JSON.stringify(stored).includes("Bearer"), false);
    assert.deepEqual(result, {attempted: 1, synced: 1, conflicts: [], pending: 0});
  });

  it("syncs in order, removes acknowledgements, and retains conflicts", async () => {
    const queue = new OfflineCaptureQueue({
      store: new MemoryStore(),
      now: (() => {
        let second = 0;
        return () => new Date(`2026-08-20T18:00:0${second++}Z`);
      })()
    });
    await queue.enqueue(scope(), draft(IDS.first));
    await queue.enqueue(scope(), draft(IDS.second));
    const received = [];

    const result = await syncCaptureQueue(queue, scope(), async (request) => {
      received.push(request.submissionId);
      if (request.submissionId === IDS.second) {
        throw Object.assign(new Error("conflict"), {status: 409});
      }
    });

    assert.deepEqual(received, [IDS.first, IDS.second]);
    assert.deepEqual(result, {
      attempted: 2,
      synced: 1,
      conflicts: [IDS.second],
      pending: 1
    });
    assert.equal((await queue.list(scope()))[0].submissionId, IDS.second);
  });

  it("stops on network failure so later records preserve capture order", async () => {
    const queue = new OfflineCaptureQueue({store: new MemoryStore()});
    await queue.enqueue(scope(), draft(IDS.first));
    await queue.enqueue(scope(), draft(IDS.second));

    const result = await syncCaptureQueue(queue, scope(), async () => {
      throw new TypeError("network unavailable");
    });

    assert.equal(result.attempted, 1);
    assert.equal(result.synced, 0);
    assert.equal(result.pending, 2);
  });

  it("normalizes bounded GPS positions and gates sensitive offline storage", () => {
    assert.deepEqual(gpsPoint({coords: {longitude: -77.03, latitude: 38.9, accuracy: 4.5}}), {
      geometry: {type: "Point", coordinates: [-77.03, 38.9]},
      accuracyMeters: 4.5
    });
    assert.throws(
      () => gpsPoint({coords: {longitude: 181, latitude: 38.9, accuracy: 5}}),
      (error) => error.code === "gps_position_invalid"
    );
    assert.equal(offlineCaptureAllowed("internal"), true);
    assert.equal(offlineCaptureAllowed("confidential"), false);
    assert.equal(offlineCaptureAllowed("restricted"), false);
  });

  it("enforces record-count and byte ceilings", async () => {
    const queue = new OfflineCaptureQueue({
      store: new MemoryStore(),
      maxRecords: 1,
      maxBytes: 1000
    });
    await queue.enqueue(scope(), draft(IDS.first));
    await assert.rejects(
      queue.enqueue(scope(), draft(IDS.second)),
      (error) => error.code === "offline_capture_queue_full"
    );
  });
});

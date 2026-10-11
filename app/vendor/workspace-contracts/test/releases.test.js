import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {
  assertPublicationAvailabilityTransition, assertPublicationRelease, assertPublicReleaseProjection,
  createPublicationAvailabilityEvent, createPublicationRelease, createPublicReleaseProjection,
  createResourceReference, publicationReleaseBytes, publicationReleaseDigest,
  validatePublicationAvailabilityEvent, validatePublicationProjectionReview, validatePublicationRelease,
  validatePublicReleaseProjection
} from "../src/index.js";

const now = new Date("2026-10-03T10:00:00.000Z");
const hash = "b".repeat(64);
const ref = (type, id, version, workspace = "workspace_private", authority = "urn:example:documents") => createResourceReference({
  authority, workspaceId: workspace, resourceType: type, resourceId: id, ...(version === undefined ? {} : {versionId: version})
});
function fixture() {
  return createPublicationRelease({
    reference: ref("publication_release", "release_original", "release edition / 7"),
    publicationReference: ref("publication", "publication_original"), projectReference: ref("project", "project_private"),
    inputs: [
      {input_id: "input_source", role: "source", reference: ref("source_snapshot", "source_original", '"opaque+/ v2"', "workspace_other_client", "urn:example:archive"), sha256: null},
      {input_id: "input_build", role: "build", reference: ref("build", "build_original", "provider immutable / 3"), sha256: hash}
    ],
    outputManifest: {reference: ref("publication_output_manifest", "manifest_original", "manifest edition 1"), sha256: hash,
      size_bytes: 307, media_type: "application/json", file_count: 40000, total_bytes: 90000000},
    targetReference: ref("asset_location", "target_original"),
    attributions: [
      {attribution_id: "credit_required", input_ids: ["input_source"], text: "Private source title, client and internal URL", url: "https://private.example.invalid/account/private", license: "License edition 2", required: true},
      {attribution_id: "credit_optional", input_ids: ["input_build"], text: "Private analyst notes", url: null, license: null, required: false}
    ], createdBy: "private_analyst", now
  });
}
async function reviewFor(release) {
  return {schema_version: 1, release_reference: release.reference, release_sha256: await publicationReleaseDigest(release),
    projection_id: "projection_reviewed", public_id: "public_report", public_version: "public edition 1", title: "Reviewed report",
    attributions: [
      {attribution_id: "credit_required", decision: "include", text: "Reviewed public attribution", url: "https://public.example.invalid/credit", license: "License edition 2", reason: null},
      {attribution_id: "credit_optional", decision: "omit", text: null, url: null, license: null, reason: "Internal analysis credit remains private"}
    ], decision: "approved", reviewed_by: "disclosure_reviewer", reviewed_at: now.toISOString()};
}

test("pinned releases round-trip original cross-workspace references and opaque versions without operational status", () => {
  const release = fixture(), reopened = assertPublicationRelease(JSON.parse(JSON.stringify(release)));
  assert.deepEqual(reopened, release);
  assert.equal(reopened.inputs[0].reference.resource_id, "source_original");
  assert.equal(reopened.inputs[0].reference.authority, "urn:example:archive");
  assert.equal(reopened.inputs[0].reference.workspace_id, "workspace_other_client");
  assert.equal(reopened.inputs[0].reference.version_id, '"opaque+/ v2"');
  assert.equal(reopened.inputs[0].sha256, null);
  assert.equal(reopened.output_manifest.file_count, 40000);
  assert.ok(Object.isFrozen(reopened.inputs[0].reference));
  assert.throws(() => assertPublicationRelease({...reopened, status: "published"}), /unsupported/);
});

test("a private handoff retains its collection identity and explicit absence of an authored project", () => {
  const release = fixture();
  const handoff = assertPublicationRelease({...release, publication_reference: ref("handoff_collection", "collection_original"), project_reference: null});
  assert.equal(handoff.publication_reference.resource_id, "collection_original");
  assert.equal(handoff.project_reference, null);
  assert.throws(() => assertPublicationRelease({...handoff, project_reference: undefined}), /JSON/);
});

test("canonical release bytes are deterministic and bind all private evidence without sorting input arrays", async () => {
  const release = fixture();
  const reordered = Object.fromEntries(Object.entries(release).reverse().map(([key, value]) => [key,
    key === "output_manifest" ? Object.fromEntries(Object.entries(value).reverse()) : value]));
  assert.deepEqual(publicationReleaseBytes(reordered), publicationReleaseBytes(release));
  assert.equal(await publicationReleaseDigest(reordered), await publicationReleaseDigest(release));
  assert.notEqual(await publicationReleaseDigest({...release, inputs: [...release.inputs].reverse()}), await publicationReleaseDigest(release));
  assert.notEqual(await publicationReleaseDigest({...release, attributions: release.attributions.map((credit, index) => index ? credit : {...credit, text: "Changed private evidence"})}), await publicationReleaseDigest(release));
});

test("release validators reject unpinned editions, scope coercion, unknown fields and broken attribution links", () => {
  const release = fixture();
  for (const changed of [
    {...release, inputs: release.inputs.map((input, index) => index ? input : {...input, reference: ref("source_snapshot", "source_original")})},
    {...release, project_reference: ref("project", "project_private", undefined, "other_workspace")},
    {...release, target_reference: {...release.target_reference, authority: "urn:example:other"}},
    {...release, output_manifest: {...release.output_manifest, sha256: "etag"}},
    {...release, output_manifest: {...release.output_manifest, bucket: "private-bucket"}},
    {...release, inputs: [...release.inputs, release.inputs[0]]},
    {...release, inputs: [{...release.inputs[0], role: "future_authorizing_role"}]},
    {...release, attributions: [{...release.attributions[0], input_ids: ["missing"]}]},
    {...release, attributions: [{...release.attributions[0], required: "false"}]},
    {...release, output_manifest: {...release.output_manifest, total_bytes: Number.MAX_SAFE_INTEGER + 1}},
    {...release, created_at: "2026-02-30T10:00:00.000Z"}
  ]) assert.ok(validatePublicationRelease(changed).length);
});

test("release records reject credentials, signed URLs, accessors and oversized private metadata", () => {
  const release = fixture();
  const cases = [
    {...release, access_token: "synthetic"},
    {...release, attributions: [{...release.attributions[0], url: "https://example.invalid/file?X-Amz-Signature=synthetic"}]},
    {...release, attributions: [{...release.attributions[0], url: "https://user:pass@example.invalid/file"}]},
    {...release, attributions: [{...release.attributions[0], text: "界".repeat(22000)}]},
    {...release, inputs: Array(65).fill(release.inputs[0])}
  ];
  const accessor = Object.defineProperty({...release}, "inputs", {enumerable: true, get() {throw Error("must not run");}});
  cases.push(accessor);
  for (const value of cases) assert.ok(validatePublicationRelease(value).length);
});

test("public projection constructs only explicitly reviewed public fields and preserves governed lineage separately", async () => {
  const release = fixture(), originalBytes = publicationReleaseBytes(release), review = await reviewFor(release);
  const projection = await createPublicReleaseProjection(release, review);
  assert.deepEqual(validatePublicReleaseProjection(JSON.parse(JSON.stringify(projection))), []);
  assert.deepEqual(projection.attributions, [{text: "Reviewed public attribution", url: "https://public.example.invalid/credit", license: "License edition 2"}]);
  const publicJSON = JSON.stringify(projection);
  for (const privateValue of ["workspace_private", "workspace_other_client", "project_private", "private_analyst", "source_original", "Private source", "private.example.invalid", "input_source", "credit_required", "Internal analysis", "disclosure_reviewer"]) assert.equal(publicJSON.includes(privateValue), false, privateValue);
  assert.deepEqual(publicationReleaseBytes(release), originalBytes);
  assert.ok(Object.isFrozen(projection.output_manifest));
  assert.throws(() => assertPublicReleaseProjection({...projection, lineage: release.inputs}), /unsupported/);
});

test("disclosure is fail-closed for stale reviews, missing decisions, required omissions and changed licenses", async () => {
  const release = fixture(), review = await reviewFor(release);
  for (const invalid of [
    {...review, release_reference: {...review.release_reference, workspace_id: "other_workspace"}},
    {...review, release_sha256: "c".repeat(64)},
    {...review, decision: "pending"},
    {...review, attributions: [review.attributions[0]]},
    {...review, attributions: [{...review.attributions[0], decision: "omit", text: null, url: null, license: null, reason: "Hide required credit"}, review.attributions[1]]},
    {...review, attributions: [{...review.attributions[0], license: "Other license"}, review.attributions[1]]},
    {...review, attributions: [review.attributions[0], {...review.attributions[1], reason: null}]},
    {...review, private_path: "/clients/private"}
  ]) await assert.rejects(createPublicReleaseProjection(release, invalid));
  await assert.rejects(createPublicReleaseProjection({...release, inputs: [{...release.inputs[0], sha256: hash}, release.inputs[1]]}, review), /exact immutable release/);
  assert.ok(validatePublicationProjectionReview({...review, public_version: "line\nbreak"}).length);
});

test("withdrawal changes availability through exact append-only event pins while release contents remain unchanged", () => {
  const release = fixture(), before = publicationReleaseBytes(release);
  const first = createPublicationAvailabilityEvent({reference: ref("publication_availability_event", "event_one", "1"), releaseReference: release.reference, event: "available", createdBy: "release_operator", now});
  const withdrawn = createPublicationAvailabilityEvent({reference: ref("publication_availability_event", "event_two", "2"), releaseReference: release.reference, event: "withdrawn", reason: "Delivery withdrawn", previousEvent: first, createdBy: "release_operator", now});
  const resumed = createPublicationAvailabilityEvent({reference: ref("publication_availability_event", "event_three", "3"), releaseReference: release.reference, event: "available", previousEvent: withdrawn, createdBy: "release_operator", now});
  assert.equal(withdrawn.sequence, 2);
  assert.deepEqual(withdrawn.previous_event_reference, first.reference);
  assert.deepEqual(assertPublicationAvailabilityTransition(JSON.parse(JSON.stringify(resumed)), withdrawn), resumed);
  assert.deepEqual(publicationReleaseBytes(release), before);
  assert.throws(() => assertPublicationAvailabilityTransition({...withdrawn, sequence: 3}, first), /exact prior/);
  assert.throws(() => assertPublicationAvailabilityTransition({...withdrawn, release_reference: {...release.reference, version_id: "other edition"}}, first), /exact prior/);
  assert.ok(validatePublicationAvailabilityEvent({...withdrawn, previous_event_reference: null}).length);
});

test("revocation is terminal for that release event chain and never overwrites historical release evidence", () => {
  const release = fixture();
  const first = createPublicationAvailabilityEvent({reference: ref("publication_availability_event", "event_one", "1"), releaseReference: release.reference, event: "available", createdBy: "release_operator", now});
  const revoked = createPublicationAvailabilityEvent({reference: ref("publication_availability_event", "event_two", "2"), releaseReference: release.reference, event: "revoked", reason: "Rights revoked", previousEvent: first, createdBy: "release_operator", now});
  assert.throws(() => createPublicationAvailabilityEvent({reference: ref("publication_availability_event", "event_three", "3"), releaseReference: release.reference, event: "available", previousEvent: revoked, createdBy: "release_operator", now}), /exact prior/);
  assert.throws(() => createPublicationAvailabilityEvent({reference: ref("publication_availability_event", "event_bad", "1"), releaseReference: release.reference, event: "withdrawn", reason: "Never published", createdBy: "release_operator", now}), /Initial availability/);
  assert.throws(() => createPublicationAvailabilityEvent({reference: ref("publication_availability_event", "event_two", "2"), releaseReference: release.reference, event: "withdrawn", previousEvent: first, createdBy: "release_operator", now}), /requires an explicit reason/);
});

test("release wire schema and exported validation fixtures remain available to consumers", () => {
  const schema = JSON.parse(readFileSync(new URL("../schemas/releases.schema.json", import.meta.url)));
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  for (const name of ["release", "projectionReview", "publicProjection", "availabilityEvent"]) assert.ok(schema.$defs[name]);
  const fixtures = JSON.parse(readFileSync(new URL("./releases-fixtures.json", import.meta.url)));
  const validators = {release: validatePublicationRelease, projectionReview: validatePublicationProjectionReview, publicProjection: validatePublicReleaseProjection, availabilityEvent: validatePublicationAvailabilityEvent};
  for (const fixture of fixtures) assert.equal(validators[fixture.kind](fixture.value).length === 0, fixture.valid, fixture.name);
});

import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {describe, it} from "node:test";
import {AwsSigV4Client} from "../src/aws-sigv4.mjs";
import {
  AwsExactVersionStorage,
  AwsRdsDataClient,
  ObservableCoordinatorSettings,
  RdsDataBuildRepository
} from "../src/production-adapters.mjs";

const ID = {
  organization: "10000000-0000-4000-8000-000000000451",
  project: "50000000-0000-4000-8000-000000000451",
  sourceProject: "b0000000-0000-4000-8000-000000000451",
  upload: "c0000000-0000-4000-8000-000000000451",
  revision: "e0000000-0000-4000-8000-000000000451",
  build: "f0000000-0000-4000-8000-000000000451",
  token: "80000000-0000-4000-8000-000000000451"
};
const BUCKET = "source.opengeo.tools";

it("keeps public reference staging unavailable unless the connected host injects the anonymous reader", async () => {
  const calls = [];
  const client = {async request() {assert.fail("Public-file transport must not use the AWS client");}};
  assert.equal(new AwsExactVersionStorage(settings(), {client}).readPublicExact, undefined);
  const publicFileReader = async value => {calls.push(value); return {bytes: Buffer.from("tiny fixture")};};
  const storage = new AwsExactVersionStorage(settings(), {client, publicFileReader});
  const args = {url: "https://public.example.test/exact.tif", contentType: "image/tiff",
    maximumBytes: 8, checksumSha256: "a".repeat(64), signal: new AbortController().signal};
  assert.deepEqual(await storage.readPublicExact(args), {bytes: Buffer.from("tiny fixture")});
  assert.deepEqual(calls, [args]);
  assert.throws(() => new AwsExactVersionStorage(settings(), {publicFileReader: true}), /configuration_invalid/);
});

it('cache admission calls only the fixed leased-job function and rejects malformed responses', async () => {
  for (const value of [null, {organizationId:ID.organization}]) {
    const repository=new RdsDataBuildRepository({async execute(sql,parameters) {
      assert.equal(sql,'SELECT app.admit_observable_page_cache(:job, :token)');
      assert.deepEqual(parameters.map(p=>p.name),['job','token']);
      return [[value]];
    }});
    assert.deepEqual(await repository.admitPageCache(ID.build,ID.token),value);
    await assert.rejects(repository.admitPageCache('../other',ID.token));
  }
  for (const rows of [[],[[true]],[[[]]],[[null,null]]]) {
    const repository=new RdsDataBuildRepository({execute:async()=>rows});
    await assert.rejects(repository.admitPageCache(ID.build,ID.token),/admission_invalid/);
  }
});
const KEY =
  `organizations/${ID.organization}/projects/${ID.project}/source-projects/${ID.sourceProject}/` +
  `uploads/${ID.upload}/files/index.md`;
const OUTPUT_KEY =
  `organizations/${ID.organization}/projects/${ID.project}/source-projects/${ID.sourceProject}/` +
  `builds/${ID.build}/output/index.html`;

it("requires native single HTML consent and fixed output path for a larger write ceiling", async () => {
  const bytes = Buffer.from("<!doctype html><title>Localized output</title>");
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const calls = [];
  const storage = new AwsExactVersionStorage(settings(), {client: {async request(call) {
    calls.push(call);
    return response(200, {etag: '"output-etag"', "x-amz-version-id": "output-v1",
      "x-amz-checksum-sha256": Buffer.from(checksum, "hex").toString("base64")});
  }}});
  const input = {bucket: BUCKET, objectKey: OUTPUT_KEY, contentType: "text/html", checksumSha256: checksum, bytes,
    maximumBytes: 96 * 1024 * 1024, outputRepresentation: "single-html", outputProfile: "archive-96m",
    sizeAcknowledgment: "allow-up-to-96-mib-output"};
  for (const change of [{outputRepresentation: undefined}, {sizeAcknowledgment: null}, {outputProfile: "default-32m"},
    {objectKey: OUTPUT_KEY.replace("index.html", "other.html")}, {objectKey: KEY},
    {objectKey: KEY.replace("index.md", `nested/builds/${ID.build}/output/index.html`)}, {contentType: "text/css"}]) {
    await assert.rejects(storage.writeExact({...input, ...change}));
    assert.equal(calls.length, 0);
  }
  await storage.writeExact(input);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers["x-amz-server-side-encryption-bucket-key-enabled"], "true");
  await assert.rejects(storage.writeExact({...input, maximumBytes: 96 * 1024 * 1024 + 1}));
  assert.equal(calls.length, 1);
});

function settings(overrides = {}) {
  return new ObservableCoordinatorSettings({
    stage: "production",
    region: "us-east-1",
    databaseClusterArn: "arn:aws:rds:us-east-1:111111111111:cluster:opengeo-production",
    databaseSecretArn:
      "arn:aws:secretsmanager:us-east-1:111111111111:secret:opengeo/production/observable-coordinator-AbCd12",
    bucket: BUCKET,
    kmsKeyArn: "arn:aws:kms:us-east-1:111111111111:key/00000000-0000-4000-8000-000000000001",
    compilerImageDigest: `sha256:${"c".repeat(64)}`,
    ...overrides
  });
}

function response(status, headers = {}, body = "") {
  return new Response(body, {status, headers});
}

describe("production Observable coordinator adapters", () => {
  it("loads leased Artifact authority for distribution requests only when they carry Artifact inputs", async () => {
    const user = "20000000-0000-4000-8000-000000000451";
    const authority = {organizationId: ID.organization, userId: user, projectId: ID.project,
      sourceProjectId: ID.sourceProject, inputId: ID.upload, manifest: {artifacts: []}};
    for (const checksum of [undefined, null, "a".repeat(64), "invalid-checksum"]) {
      const request = {schemaVersion: "opengeo.observable-build-request.3.0.0",
        ...(checksum === undefined ? {} : {artifactInputsChecksumSha256: checksum})};
      const calls = [], resolutions = [];
      const repository = new RdsDataBuildRepository({async execute(sql, parameters) {
        calls.push({sql, parameters});
        if (sql.includes("claim_observable_build_runtime")) return [["claimed", ID.build, ID.organization,
          ID.project, ID.sourceProject, ID.revision, 1, "preview", request, "b".repeat(64), {},
          "c".repeat(64), "prefix/", 1]];
        assert.equal(sql, "SELECT app.read_observable_artifact_lease(:job, :token)");
        assert.deepEqual(parameters, [
          {name: "job", value: {stringValue: ID.build}, typeHint: "UUID"},
          {name: "token", value: {stringValue: ID.token}, typeHint: "UUID"}
        ]);
        return [[authority]];
      }}, {artifactResolver: async value => {resolutions.push(value); return [];} });
      const claim = await repository.claim(ID.build, ID.token, 900);
      assert.deepEqual(claim.request, request, "The request remains unchanged for canonical parser validation");
      if (checksum != null) {
        assert.equal(calls.length, 2);
        assert.deepEqual(claim.artifactInputs, authority.manifest);
        await assert.rejects(repository.resolveArtifactInputs(ID.build, ID.upload), /artifact_staging_unavailable/);
        assert.equal(resolutions.length, 0);
        assert.deepEqual(await repository.resolveArtifactInputs(ID.build, ID.token), []);
        assert.deepEqual(resolutions, [{buildJobId: ID.build, coordinatorToken: ID.token, authority}]);
      } else {
        assert.equal(calls.length, 1, "Distribution without Artifacts never requests Artifact authority");
        assert.equal(Object.hasOwn(claim, "artifactInputs"), false);
        await assert.rejects(repository.resolveArtifactInputs(ID.build, ID.token), /artifact_staging_unavailable/);
        assert.equal(resolutions.length, 0);
      }
    }
  });

  it("resolves archives only through the fixed leased function and reads tenant-scoped exact versions", async () => {
    const calls = [];
    const repository = new RdsDataBuildRepository({execute: async (sql, parameters) => {
      calls.push({sql, parameters}); return [[[]]];
    }});
    assert.deepEqual(await repository.resolveDataAttachments(ID.build, ID.token), []);
    assert.equal(calls[0].sql, "SELECT app.resolve_observable_build_data(:job, :token)");
    const bytes = Buffer.from('{"features":[]}');
    const requests = [];
    const archiveKey = `organizations/${ID.organization}/projects/${ID.project}/datasets/${ID.project}/uploads/${ID.upload}/original/water.geojson`;
    const storage = new AwsExactVersionStorage(settings({archiveBucket: "geodata.opengeo.tools"}), {client: {request: async request => {
      requests.push(request);
      return response(200, {"x-amz-version-id": "archive-v1", etag: '"archive-etag"', "content-type": "application/geo+json"}, bytes);
    }}});
    const args = {bucket: "geodata.opengeo.tools", objectKey: archiveKey, s3VersionId: "archive-v1",
      maximumBytes: bytes.length, organizationId: ID.organization, datasetId: ID.project};
    const stored = await storage.readArchiveExact(args);
    assert.deepEqual(stored.bytes, bytes);
    assert.deepEqual(requests[0].query, [["versionId", "archive-v1"]]);
    assert.equal(requests[0].maximumResponseBytes, bytes.length);
    for (const changed of [{bucket: "other-bucket"}, {objectKey: "archive/water.geojson"},
      {objectKey: archiveKey.replace(ID.organization, ID.project)}, {objectKey: archiveKey + "/../elsewhere"},
      {maximumBytes: 67_108_865}, {s3VersionId: "null"}]) {
      await assert.rejects(storage.readArchiveExact({...args, ...changed}));
    }
    assert.equal(requests.length, 1, "Rejected coordinates do not make a network request");
    await assert.rejects(storage.readExact(args), /storage_identity_invalid/);
  });

  it("requires one exact AWS partition, account, region, database and bucket identity", () => {
    assert.equal(settings().bucket, BUCKET);
    assert.throws(
      () => settings({databaseSecretArn:
        "arn:aws-us-gov:secretsmanager:us-east-1:111111111111:secret:opengeo/production/coordinator-AbCd12"}),
      /production_configuration_invalid/
    );
    assert.throws(() => settings({databaseName: "postgres"}), /production_configuration_invalid/);
    assert.throws(() => settings({bucket: "111.222.3.4"}), /production_configuration_invalid/);
  });

  it("signs bounded requests without serializing the secret access key", async () => {
    const calls = [];
    const client = new AwsSigV4Client({
      region: "us-east-1",
      credentials: {async load() {
        return {
          accessKeyId: "AKIDEXAMPLE000000",
          secretAccessKey: "never-serialize-this-secret-value",
          sessionToken: "session-token"
        };
      }},
      now: () => new Date("2026-08-23T12:00:00Z"),
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        return response(200, {"content-length": "2"}, "{}");
      }
    });
    const result = await client.request({
      service: "rds-data", method: "POST", host: "rds-data.us-east-1.amazonaws.com",
      path: "/Execute", headers: {"content-type": "application/json"},
      body: Buffer.from("{}"), maximumResponseBytes: 1024
    });
    assert.equal(result.status, 200);
    assert.match(calls[0].options.headers.authorization, /Credential=AKIDEXAMPLE000000\/20260823\/us-east-1\/rds-data\/aws4_request/);
    assert.equal(calls[0].options.headers["x-amz-security-token"], "session-token");
    assert.doesNotMatch(JSON.stringify(calls), /never-serialize-this-secret-value/);
  });

  it("uses only the fixed build coordination functions and typed parameters", async () => {
    const request = {schemaVersion: "opengeo.observable-build-request.1.0.0"};
    const manifest = {schemaVersion: "opengeo.observable-source-revision.1.0.0"};
    const calls = [];
    const results = [
      [["claimed", ID.build, ID.organization, ID.project, ID.sourceProject, ID.revision,
        1, "preview", request, "a".repeat(64), manifest, "b".repeat(64),
        `organizations/${ID.organization}/projects/${ID.project}/source-projects/${ID.sourceProject}/builds/${ID.build}/output/`, 1]],
      [[true]], [[true]], [[true]], [["pending"]]
    ];
    const repository = new RdsDataBuildRepository({async execute(sql, parameters) {
      calls.push({sql, parameters});
      return results.shift();
    }});
    const claim = await repository.claim(ID.build, ID.token, 900);
    assert.equal(claim.claimStatus, "claimed");
    assert.deepEqual(claim.request, request);
    assert.equal(await repository.heartbeat(ID.build, ID.token, 900), true);
    assert.equal(await repository.complete(ID.build, ID.token, {safe: true}), true);
    assert.equal(await repository.fail(ID.build, ID.token, "runner_failed"), true);
    assert.equal(await repository.release(ID.build, ID.token, "s3_unavailable", 3), "pending");
    assert.match(calls[0].sql, /app\.claim_observable_build_runtime/);
    assert.match(calls[0].sql, /CAST\(:lease AS integer\)/);
    assert.match(calls[1].sql, /app\.heartbeat_observable_build/);
    assert.match(calls[1].sql, /CAST\(:lease AS integer\)/);
    assert.match(calls[2].sql, /app\.complete_observable_build/);
    assert.match(calls[3].sql, /app\.fail_observable_build/);
    assert.match(calls[4].sql, /app\.release_observable_build/);
    assert.match(calls[4].sql, /CAST\(:attempts AS integer\)/);
    assert.deepEqual(calls[0].parameters[0], {
      name: "job", value: {stringValue: ID.build}, typeHint: "UUID"
    });
    assert.equal(calls[2].parameters[2].typeHint, "JSON");
  });

  it("encodes and decodes the bounded Data API result union", async () => {
    const calls = [];
    const data = new AwsRdsDataClient(settings(), {client: {async request(call) {
      calls.push(call);
      return response(200, {"content-length": "230"}, JSON.stringify({
        columnMetadata: [
          {typeName: "text"}, {typeName: "uuid"}, {typeName: "jsonb"},
          {typeName: "int8"}, {typeName: "bool"}
        ],
        records: [[
          {stringValue: "claimed"}, {stringValue: ID.build},
          {stringValue: "{\"safe\":true}"}, {longValue: 1}, {booleanValue: true}
        ]]
      }));
    }}});
    const rows = await data.execute("SELECT :job", [{name: "job", value: {stringValue: ID.build}}]);
    assert.deepEqual(rows, [["claimed", ID.build, {safe: true}, 1, true]]);
    const payload = JSON.parse(calls[0].body);
    assert.equal(payload.resourceArn, settings().databaseClusterArn);
    assert.equal(payload.secretArn, settings().databaseSecretArn);
    assert.equal(calls[0].path, "/Execute");
  });

  it("reads one exact S3 version and derives checksum from bounded bytes", async () => {
    const bytes = Buffer.from("# exact source\n");
    const calls = [];
    const storage = new AwsExactVersionStorage(settings(), {client: {async request(call) {
      calls.push(call);
      return response(200, {
        "content-length": String(bytes.length),
        "content-type": "text/markdown",
        etag: '"source-etag"',
        "x-amz-version-id": "source-v1"
      }, bytes);
    }}});
    const stored = await storage.readExact({
      bucket: BUCKET, objectKey: KEY, s3VersionId: "source-v1", maximumBytes: bytes.length
    });
    assert.equal(stored.etag, "source-etag");
    assert.equal(stored.checksumSha256, createHash("sha256").update(bytes).digest("hex"));
    assert.deepEqual(calls[0].query, [["versionId", "source-v1"]]);
    assert.match(calls[0].path, /^\/source\.opengeo\.tools\/organizations\//);
  });

  it("reconciles an already-written exact output without creating another S3 version", async () => {
    const bytes = Buffer.from("<!doctype html>\n");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const calls = [];
    const storage = new AwsExactVersionStorage(settings(), {client: {async request(call) {
      calls.push(call);
      if (call.method === "PUT") return response(412);
      return response(200, {
        "content-length": String(bytes.length),
        "content-type": "text/html",
        etag: '"output-etag"',
        "x-amz-version-id": "output-v1",
        "x-amz-checksum-sha256": Buffer.from(checksum, "hex").toString("base64")
      });
    }}});
    const stored = await storage.writeExact({
      bucket: BUCKET, objectKey: OUTPUT_KEY, contentType: "text/html",
      checksumSha256: checksum, bytes
    });
    assert.equal(stored.s3VersionId, "output-v1");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].headers["if-none-match"], "*");
    assert.equal(calls[1].method, "HEAD");
    assert.equal(calls[1].headers["x-amz-checksum-mode"], "ENABLED");
  });

  it("writes a new output with exact checksum and KMS headers after a clean miss", async () => {
    const bytes = Buffer.from("body{}\n");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const checksumBase64 = Buffer.from(checksum, "hex").toString("base64");
    const calls = [];
    const storage = new AwsExactVersionStorage(settings(), {client: {async request(call) {
      calls.push(call);
      if (call.method === "HEAD") return response(404);
      return response(200, {
        "content-length": "0", etag: '"output-etag"',
        "x-amz-version-id": "output-v2", "x-amz-checksum-sha256": checksumBase64
      });
    }}});
    const stored = await storage.writeExact({
      bucket: BUCKET, objectKey: OUTPUT_KEY.replace("index.html", "app.css"),
      contentType: "text/css", checksumSha256: checksum, bytes
    });
    assert.equal(stored.s3VersionId, "output-v2");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "PUT");
    assert.equal(calls[0].headers["if-none-match"], "*");
    assert.equal(calls[0].headers["x-amz-server-side-encryption"], "aws:kms");
    assert.equal(calls[0].headers["x-amz-server-side-encryption-bucket-key-enabled"], "true");
    assert.equal(calls[0].headers["x-amz-server-side-encryption-aws-kms-key-id"], settings().kmsKeyArn);
    assert.equal(calls[0].headers["x-amz-checksum-sha256"], checksumBase64);
  });

  it("accepts an explicit bounded archive output ceiling without increasing the default writer limit", async () => {
    const bytes = Buffer.alloc(16_777_217);
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const calls = [];
    const storage = new AwsExactVersionStorage(settings(), {client: {async request(call) {
      calls.push(call);
      return response(200, {"content-length": "0", etag: '"output-etag"', "x-amz-version-id": "output-v2",
        "x-amz-checksum-sha256": Buffer.from(checksum, "hex").toString("base64")});
    }}});
    const args = {bucket: BUCKET, objectKey: OUTPUT_KEY.replace("index.html", "elevation.tif"),
      contentType: "application/octet-stream", checksumSha256: checksum, bytes};
    await assert.rejects(storage.writeExact(args), /stored_output_invalid/);
    await assert.rejects(storage.writeExact({...args, maximumBytes: 67_108_865}));
    assert.equal(calls.length, 0);
    await storage.writeExact({...args, maximumBytes: 67_108_864});
    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers["x-amz-server-side-encryption-bucket-key-enabled"], "true");
  });

  it("fails closed on a mismatched deterministic output and cross-project storage key", async () => {
    const bytes = Buffer.from("safe\n");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const storage = new AwsExactVersionStorage(settings(), {client: {async request(call) {
      if (call.method === "PUT") return response(412);
      return response(200, {
        "content-length": "7", "content-type": "text/plain", etag: '"other"',
        "x-amz-version-id": "other-v1",
        "x-amz-checksum-sha256": Buffer.alloc(32, 1).toString("base64")
      });
    }}});
    await assert.rejects(
      storage.writeExact({bucket: BUCKET, objectKey: OUTPUT_KEY, contentType: "text/plain", checksumSha256: checksum, bytes}),
      /stored_output_collision/
    );
    await assert.rejects(
      storage.readExact({bucket: "other.opengeo.tools", objectKey: KEY, s3VersionId: "v1", maximumBytes: 10}),
      /storage_identity_invalid/
    );
  });
});

it('reads portable Artifacts only from their exact tenant and Artifact storage prefix', async () => {
  const requests=[],bytes=Buffer.from('<!doctype html><title>Retained</title>');
  const key=`organizations/${ID.organization}/projects/${ID.project}/artifacts/${ID.sourceProject}/uploads/${ID.upload}/map.html`;
  const storage=new AwsExactVersionStorage(settings(),{client:{request:async request=>{
    requests.push(request);return response(200,{'x-amz-version-id':'artifact-v1',etag:'"retained"','content-type':'text/html'},bytes);
  }}});
  const args={bucket:BUCKET,objectKey:key,s3VersionId:'artifact-v1',maximumBytes:bytes.length,
    organizationId:ID.organization,artifactId:ID.sourceProject};
  assert.deepEqual((await storage.readArtifactExact(args)).bytes,bytes);
  assert.deepEqual(requests[0].query,[['versionId','artifact-v1']]);
  for(const changed of [{artifactId:ID.project},{organizationId:ID.project},{bucket:'other.invalid'},
    {objectKey:key+'/../other.html'},{objectKey:key.replace('/map.html','/other.html')},
    {s3VersionId:'null'},{maximumBytes:4194305}]) {
    await assert.rejects(storage.readArtifactExact({...args,...changed}));
  }
  assert.equal(requests.length,1);
  await assert.rejects(storage.readExact(args),/storage_identity_invalid/);
});

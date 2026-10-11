import {createHash} from "node:crypto";
import {CoordinatorContractError} from "./contracts.mjs";
import {approvedCompilerDigests, compilerDigestsFromEnvironment} from "./compiler-policy.mjs";
import {
  AwsDependencyError,
  AwsSigV4Client,
  awsEncode,
  boundedResponseBytes
} from "./aws-sigv4.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ERROR_CODE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const BUCKET = /^(?!\d+\.\d+\.\d+\.\d+$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const OBJECT_KEY = /^organizations\/[0-9a-f-]{36}\/projects\/[0-9a-f-]{36}\/source-projects\/[0-9a-f-]{36}\/(?:uploads\/[0-9a-f-]{36}\/files|builds\/[0-9a-f-]{36}\/output)\/[A-Za-z0-9_@][A-Za-z0-9_@./-]{0,1023}$/;

export class ObservableCoordinatorSettings {
  constructor({stage, region, databaseClusterArn, databaseSecretArn, databaseName = "opengeo", bucket, archiveBucket = bucket, kmsKeyArn, compilerImageDigest, compilerImageDigests}) {
    const cluster = /^arn:(aws(?:-us-gov)?):rds:([^:]+):(\d{12}):cluster:[A-Za-z0-9-]{1,63}$/.exec(databaseClusterArn ?? "");
    const secret = /^arn:(aws(?:-us-gov)?):secretsmanager:([^:]+):(\d{12}):secret:[A-Za-z0-9/_+=.@-]+$/.exec(databaseSecretArn ?? "");
    const key = /^arn:(aws(?:-us-gov)?):kms:([^:]+):(\d{12}):key\/[0-9a-f-]{36}$/.exec(kmsKeyArn ?? "");
    if (
      !["dev", "staging", "production"].includes(stage) ||
      !cluster || !secret || !key ||
      cluster.slice(1, 4).join(":") !== secret.slice(1, 4).join(":") ||
      cluster.slice(1, 4).join(":") !== key.slice(1, 4).join(":") ||
      cluster[2] !== region || databaseName !== "opengeo" || !BUCKET.test(bucket ?? "") ||
      !IMAGE_DIGEST.test(compilerImageDigest ?? "") || !BUCKET.test(archiveBucket ?? "")
    ) {
      throw new CoordinatorContractError("production_configuration_invalid");
    }
    this.stage = stage;
    this.region = region;
    this.databaseClusterArn = databaseClusterArn;
    this.databaseSecretArn = databaseSecretArn;
    this.databaseName = databaseName;
    this.bucket = bucket;
    this.archiveBucket = archiveBucket;
    this.kmsKeyArn = kmsKeyArn;
    this.compilerImageDigest = compilerImageDigest;
    this.compilerImageDigests = approvedCompilerDigests(compilerImageDigest, compilerImageDigests);
  }

  static fromEnvironment(environment = process.env) {
    return new ObservableCoordinatorSettings({
      stage: environment.OPEN_GEO_OBSERVABLE_COORDINATOR_STAGE,
      region: environment.OPEN_GEO_AWS_REGION,
      databaseClusterArn: environment.OPEN_GEO_DATA_API_CLUSTER_ARN,
      databaseSecretArn: environment.OPEN_GEO_DATA_API_SECRET_ARN,
      databaseName: environment.OPEN_GEO_DB_NAME ?? "opengeo",
      bucket: environment.OPEN_GEO_APPLICATION_BUCKET,
      archiveBucket: environment.OPEN_GEO_ARCHIVE_BUCKET ?? environment.OPEN_GEO_APPLICATION_BUCKET,
      kmsKeyArn: environment.OPEN_GEO_APPLICATION_KMS_KEY_ARN,
      compilerImageDigest: environment.OPEN_GEO_OBSERVABLE_COMPILER_IMAGE_DIGEST,
      compilerImageDigests: compilerDigestsFromEnvironment(environment)
    });
  }
}

export class AwsRdsDataClient {
  constructor(settings, {client} = {}) {
    this.settings = settings;
    this.client = client ?? new AwsSigV4Client({region: settings.region});
  }

  async execute(sql, parameters) {
    if (typeof sql !== "string" || sql.length < 1 || sql.length > 16_384 || !Array.isArray(parameters)) {
      throw new AwsDependencyError("data_api_request_invalid");
    }
    const body = Buffer.from(JSON.stringify({
      resourceArn: this.settings.databaseClusterArn,
      secretArn: this.settings.databaseSecretArn,
      database: this.settings.databaseName,
      sql,
      parameters,
      includeResultMetadata: true,
      resultSetOptions: {decimalReturnType: "STRING", longReturnType: "LONG"}
    }));
    const response = await this.client.request({
      service: "rds-data",
      method: "POST",
      host: `rds-data.${this.settings.region}.amazonaws.com`,
      path: "/Execute",
      headers: {"content-type": "application/json"},
      body,
      maximumResponseBytes: 1_048_576
    });
    const bytes = await boundedResponseBytes(response, 1_048_576);
    if (!response.ok) throw new AwsDependencyError("data_api_unavailable");
    let value;
    try {
      value = JSON.parse(bytes);
    } catch {
      throw new AwsDependencyError("data_api_response_invalid");
    }
    return decodeDataApi(value);
  }
}

export class RdsDataBuildRepository {
  constructor(client, {artifactResolver = null} = {}) {
    this.client = client;
    this.artifactResolver = artifactResolver;
    this.artifactAuthority = new Map();
  }

  async claim(buildJobId, coordinatorToken, leaseSeconds) {
    validateUuid(buildJobId);
    validateUuid(coordinatorToken);
    validateInteger(leaseSeconds, 30, 900);
    const rows = await this.client.execute(
      `SELECT claim_status, build_job_id, organization_id, project_id,
              source_project_id, source_revision_id, source_revision_number,
              purpose, request, request_checksum_sha256, input_manifest,
              input_manifest_checksum_sha256, output_prefix, attempt_count
       FROM app.claim_observable_build_runtime(:job, :token, CAST(:lease AS integer))`,
      [uuidParameter("job", buildJobId), uuidParameter("token", coordinatorToken), longParameter("lease", leaseSeconds)]
    );
    if (rows.length !== 1 || rows[0].length !== 14) {
      throw new AwsDependencyError("data_api_response_invalid");
    }
    const record = claimRecord(rows[0], buildJobId);
    this.artifactAuthority.delete(buildJobId);
    if (record.claimStatus === "claimed" && record.request?.schemaVersion === "opengeo.observable-build-request.2.0.0") {
      try {
        const resolved = await this.client.execute("SELECT app.read_observable_artifact_lease(:job, :token)",
          [uuidParameter("job", buildJobId), uuidParameter("token", coordinatorToken)]);
        const authority = resolved?.[0]?.[0];
        if (resolved.length !== 1 || resolved[0].length !== 1 || !authority || typeof authority !== "object"
          || Array.isArray(authority) || Object.keys(authority).sort().join(",") !== "inputId,manifest,organizationId,projectId,sourceProjectId,userId"
          || authority.organizationId !== record.organizationId || authority.projectId !== record.projectId
          || authority.sourceProjectId !== record.sourceProjectId) throw new CoordinatorContractError("artifact_lease_invalid");
        validateUuid(authority.userId); validateUuid(authority.inputId);
        record.artifactInputs = authority.manifest;
        // A repository services bounded jobs. Evicted entries fail closed, never refetch as another actor.
        if (this.artifactAuthority.size >= 128) this.artifactAuthority.delete(this.artifactAuthority.keys().next().value);
        this.artifactAuthority.set(buildJobId, {coordinatorToken, authority});
      } catch (error) {
        // Claim succeeded: return its lease promptly if context loading failed.
        try { await this.release(buildJobId, coordinatorToken, "artifact_lease_context_unavailable", 3); }
        catch { /* The existing bounded lease remains the fallback cleanup boundary. */ }
        throw error;
      }
    }
    return record;
  }

  async resolveArtifactInputs(buildJobId, coordinatorToken) {
    validateUuid(buildJobId); validateUuid(coordinatorToken);
    const retained = this.artifactAuthority.get(buildJobId);
    if (!retained || retained.coordinatorToken !== coordinatorToken || !this.artifactResolver) {
      throw new CoordinatorContractError("artifact_staging_unavailable");
    }
    return this.artifactResolver({buildJobId, coordinatorToken, authority: retained.authority});
  }

  async heartbeat(buildJobId, coordinatorToken, leaseSeconds) {
    return this.#boolean(
      "SELECT app.heartbeat_observable_build(:job, :token, CAST(:lease AS integer))",
      [uuidParameter("job", buildJobId), uuidParameter("token", coordinatorToken), longParameter("lease", leaseSeconds)]
    );
  }

  async admitPageCache(buildJobId, coordinatorToken) {
    validateUuid(buildJobId);
    validateUuid(coordinatorToken);
    const rows = await this.client.execute(
      'SELECT app.admit_observable_page_cache(:job, :token)',
      [uuidParameter('job', buildJobId), uuidParameter('token', coordinatorToken)]
    );
    if (rows.length !== 1 || rows[0].length !== 1 || (rows[0][0] !== null &&
        (typeof rows[0][0] !== 'object' || Array.isArray(rows[0][0])))) {
      throw new CoordinatorContractError('page_cache_admission_invalid');
    }
    return rows[0][0];
  }

  async resolveDataAttachments(buildJobId, coordinatorToken) {
    validateUuid(buildJobId);
    validateUuid(coordinatorToken);
    const rows = await this.client.execute(
      "SELECT app.resolve_observable_build_data(:job, :token)",
      [uuidParameter("job", buildJobId), uuidParameter("token", coordinatorToken)]
    );
    if (rows.length !== 1 || rows[0].length !== 1 || !Array.isArray(rows[0][0])) {
      throw new CoordinatorContractError("archive_resolution_invalid");
    }
    return rows[0][0];
  }

  async complete(buildJobId, coordinatorToken, result) {
    const completed = await this.#boolean(
      "SELECT app.complete_observable_build(:job, :token, :result)",
      [uuidParameter("job", buildJobId), uuidParameter("token", coordinatorToken), jsonParameter("result", result)]
    );
    if (completed) this.#clearArtifactAuthority(buildJobId, coordinatorToken);
    return completed;
  }

  async fail(buildJobId, coordinatorToken, errorCode) {
    validateErrorCode(errorCode);
    const failed = await this.#boolean(
      "SELECT app.fail_observable_build(:job, :token, :error)",
      [uuidParameter("job", buildJobId), uuidParameter("token", coordinatorToken), stringParameter("error", errorCode)]
    );
    if (failed) this.#clearArtifactAuthority(buildJobId, coordinatorToken);
    return failed;
  }

  async release(buildJobId, coordinatorToken, errorCode, maxAttempts) {
    validateErrorCode(errorCode);
    validateInteger(maxAttempts, 1, 10);
    const rows = await this.client.execute(
      "SELECT app.release_observable_build(:job, :token, :error, CAST(:attempts AS integer))",
      [
        uuidParameter("job", buildJobId),
        uuidParameter("token", coordinatorToken),
        stringParameter("error", errorCode),
        longParameter("attempts", maxAttempts)
      ]
    );
    if (rows.length !== 1 || rows[0].length !== 1 || !["pending", "failed", "lost"].includes(rows[0][0])) {
      throw new AwsDependencyError("data_api_response_invalid");
    }
    this.#clearArtifactAuthority(buildJobId, coordinatorToken);
    return rows[0][0];
  }

  #clearArtifactAuthority(buildJobId, coordinatorToken) {
    if (this.artifactAuthority.get(buildJobId)?.coordinatorToken === coordinatorToken) {
      this.artifactAuthority.delete(buildJobId);
    }
  }

  async #boolean(sql, parameters) {
    const rows = await this.client.execute(sql, parameters);
    if (rows.length !== 1 || rows[0].length !== 1 || typeof rows[0][0] !== "boolean") {
      throw new AwsDependencyError("data_api_response_invalid");
    }
    return rows[0][0];
  }
}

export class AwsExactVersionStorage {
  constructor(settings, {client, publicFileReader = null} = {}) {
    if (publicFileReader !== null && typeof publicFileReader !== "function") {
      throw new CoordinatorContractError("public_file_staging_configuration_invalid");
    }
    this.settings = settings;
    this.client = client ?? new AwsSigV4Client({region: settings.region});
    this.host = `s3.${settings.region}.amazonaws.com`;
    // The isolated AMI has no public transport capability. Only the accepted
    // connected host explicitly injects the credential-free pinned reader.
    if (publicFileReader) this.readPublicExact = publicFileReader;
  }

  async readExact({bucket, objectKey, s3VersionId, maximumBytes}) {
    this.#identity(bucket, objectKey);
    validateInteger(maximumBytes, 1, 16_777_216);
    return this.#read({bucket, objectKey, s3VersionId, maximumBytes});
  }

  async readArtifactExact({bucket, objectKey, s3VersionId, maximumBytes, organizationId, artifactId}) {
    validateUuid(organizationId); validateUuid(artifactId);
    const match = /^organizations\/([0-9a-f-]{36})\/projects\/([0-9a-f-]{36})\/artifacts\/([0-9a-f-]{36})\/uploads\/([0-9a-f-]{36})\/map\.html$/.exec(objectKey ?? "");
    if (bucket !== this.settings.bucket || !match || match[1] !== organizationId || match[3] !== artifactId) {
      throw new CoordinatorContractError("storage_identity_invalid");
    }
    validateUuid(match[2]); validateUuid(match[4]);
    validateInteger(maximumBytes, 1, 4194304);
    return this.#read({bucket, objectKey, s3VersionId, maximumBytes});
  }

  async readArchiveExact({bucket, objectKey, s3VersionId, maximumBytes, organizationId, datasetId}) {
    validateUuid(organizationId);
    validateUuid(datasetId);
    const match = /^organizations\/([0-9a-f-]{36})\/projects\/([0-9a-f-]{36})\/datasets\/([0-9a-f-]{36})\/(?:uploads\/[0-9a-f-]{36}\/original|versions\/[0-9a-f-]{36}\/derivatives)\/.+/.exec(objectKey ?? "");
    if (bucket !== this.settings.archiveBucket || !match || match[1] !== organizationId || match[3] !== datasetId
      || typeof objectKey !== "string" || objectKey.length > 1024
      || !objectKey.startsWith(`organizations/${organizationId}/`)
      || objectKey.split("/").some(segment => !segment || segment === "." || segment === "..")
      || /[\\\x00-\x1f\x7f]/.test(objectKey)) throw new CoordinatorContractError("storage_identity_invalid");
    validateInteger(maximumBytes, 1, 67_108_864);
    return this.#read({bucket, objectKey, s3VersionId, maximumBytes});
  }

  async #read({bucket, objectKey, s3VersionId, maximumBytes}) {
    boundedString(s3VersionId, 1, 1024);
    if (s3VersionId === "null") throw new CoordinatorContractError("stored_source_invalid");
    const response = await this.client.request({
      service: "s3",
      method: "GET",
      host: this.host,
      path: s3Path(bucket, objectKey),
      query: [["versionId", s3VersionId]],
      maximumResponseBytes: maximumBytes
    });
    if (response.status === 404) throw new CoordinatorContractError("stored_source_missing");
    if (!response.ok) throw new AwsDependencyError("s3_read_unavailable");
    const bytes = await boundedResponseBytes(response, maximumBytes);
    const returnedVersion = response.headers.get("x-amz-version-id");
    const etag = normalizedEtag(response.headers.get("etag"));
    const contentType = response.headers.get("content-type");
    if (returnedVersion !== s3VersionId || etag === null || contentType === null) {
      throw new CoordinatorContractError("stored_source_invalid");
    }
    return {
      bucket,
      objectKey,
      s3VersionId,
      etag,
      contentType,
      checksumSha256: digest(bytes),
      bytes
    };
  }

  async writeExact({bucket, objectKey, contentType, checksumSha256, bytes, maximumBytes = 16_777_216,
    outputRepresentation, outputProfile, sizeAcknowledgment}) {
    this.#identity(bucket, objectKey);
    boundedString(contentType, 1, 100);
    const localized = outputRepresentation === "single-html" && contentType === "text/html"
      && /^organizations\/[0-9a-f-]{36}\/projects\/[0-9a-f-]{36}\/source-projects\/[0-9a-f-]{36}\/builds\/[0-9a-f-]{36}\/output\/index\.html$/.test(objectKey)
      && outputProfile === "archive-96m" && sizeAcknowledgment === "allow-up-to-96-mib-output";
    validateInteger(maximumBytes, 1, localized ? 100_663_296 : 67_108_864);
    if (!SHA256.test(checksumSha256 ?? "") || !Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > maximumBytes || digest(bytes) !== checksumSha256) {
      throw new CoordinatorContractError("stored_output_invalid");
    }
    const checksumBase64 = Buffer.from(checksumSha256, "hex").toString("base64");
    const response = await this.client.request({
      service: "s3",
      method: "PUT",
      host: this.host,
      path: s3Path(bucket, objectKey),
      headers: {
        "if-none-match": "*",
        "content-type": contentType,
        "x-amz-checksum-sha256": checksumBase64,
        "x-amz-server-side-encryption": "aws:kms",
        "x-amz-server-side-encryption-bucket-key-enabled": "true",
        "x-amz-server-side-encryption-aws-kms-key-id": this.settings.kmsKeyArn
      },
      body: bytes,
      maximumResponseBytes: 65_536
    });
    await boundedResponseBytes(response, 65_536);
    // A missing object can return HEAD 403 without ListBucket. Conditional PUT
    // needs no bucket listing and cannot overwrite a retained output on replay.
    if (response.status === 412) {
      const existing = await this.#head(bucket, objectKey);
      if (!existing || existing.contentType !== contentType || existing.sizeBytes !== bytes.length ||
          existing.checksumSha256 !== checksumSha256) {
        throw new CoordinatorContractError("stored_output_collision");
      }
      return {...existing, bucket, objectKey, contentType, sizeBytes: bytes.length, checksumSha256};
    }
    if (!response.ok) throw new AwsDependencyError("s3_write_unavailable");
    const s3VersionId = response.headers.get("x-amz-version-id");
    const etag = normalizedEtag(response.headers.get("etag"));
    if (
      s3VersionId === null || s3VersionId.length > 1024 || etag === null ||
      response.headers.get("x-amz-checksum-sha256") !== checksumBase64
    ) {
      throw new AwsDependencyError("s3_write_response_invalid");
    }
    return {bucket, objectKey, s3VersionId, etag, contentType, sizeBytes: bytes.length, checksumSha256};
  }

  async #head(bucket, objectKey) {
    const response = await this.client.request({
      service: "s3",
      method: "HEAD",
      host: this.host,
      path: s3Path(bucket, objectKey),
      headers: {"x-amz-checksum-mode": "ENABLED"},
      maximumResponseBytes: 33_554_432
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new AwsDependencyError("s3_head_unavailable");
    const s3VersionId = response.headers.get("x-amz-version-id");
    const etag = normalizedEtag(response.headers.get("etag"));
    const contentType = response.headers.get("content-type");
    const length = response.headers.get("content-length");
    const checksum = response.headers.get("x-amz-checksum-sha256");
    if (
      s3VersionId === null || s3VersionId.length > 1024 || etag === null ||
      contentType === null || length === null || !/^\d+$/.test(length) ||
      checksum === null
    ) {
      throw new AwsDependencyError("s3_head_response_invalid");
    }
    if (!/^[A-Za-z0-9+/]{43}=$/.test(checksum)) {
      throw new AwsDependencyError("s3_head_response_invalid");
    }
    const checksumSha256 = Buffer.from(checksum, "base64").toString("hex");
    if (!SHA256.test(checksumSha256)) throw new AwsDependencyError("s3_head_response_invalid");
    return {s3VersionId, etag, contentType, sizeBytes: Number(length), checksumSha256};
  }

  #identity(bucket, objectKey) {
    if (bucket !== this.settings.bucket || !OBJECT_KEY.test(objectKey ?? "") || objectKey.includes("..")) {
      throw new CoordinatorContractError("storage_identity_invalid");
    }
  }
}

function claimRecord(row, expectedBuildJobId) {
  const [
    claimStatus, buildJobId, organizationId, projectId, sourceProjectId,
    sourceRevisionId, sourceRevisionNumber, purpose, request,
    requestChecksumSha256, inputManifest, inputManifestChecksumSha256,
    outputPrefix, attemptCount
  ] = row;
  if (typeof claimStatus !== "string" || buildJobId !== expectedBuildJobId) {
    throw new AwsDependencyError("data_api_response_invalid");
  }
  if (claimStatus !== "claimed") return {claimStatus, buildJobId};
  return {
    claimStatus, buildJobId, organizationId, projectId, sourceProjectId,
    sourceRevisionId, sourceRevisionNumber, purpose, request,
    requestChecksumSha256, inputManifest, inputManifestChecksumSha256,
    outputPrefix, attemptCount
  };
}

function decodeDataApi(value) {
  if (value === null || typeof value !== "object" || !Array.isArray(value.columnMetadata) || !Array.isArray(value.records)) {
    throw new AwsDependencyError("data_api_response_invalid");
  }
  return value.records.map((record) => {
    if (!Array.isArray(record) || record.length !== value.columnMetadata.length) {
      throw new AwsDependencyError("data_api_response_invalid");
    }
    return record.map((field, index) => decodeField(field, value.columnMetadata[index]?.typeName));
  });
}

function decodeField(field, typeName) {
  if (field === null || typeof field !== "object" || Object.keys(field).length !== 1) {
    throw new AwsDependencyError("data_api_response_invalid");
  }
  if (field.isNull === true) return null;
  if (typeof field.booleanValue === "boolean") return field.booleanValue;
  if (Number.isSafeInteger(field.longValue)) return field.longValue;
  if (typeof field.stringValue === "string") {
    if (["json", "jsonb"].includes(String(typeName).toLowerCase())) {
      try { return JSON.parse(field.stringValue); }
      catch { throw new AwsDependencyError("data_api_response_invalid"); }
    }
    return field.stringValue;
  }
  throw new AwsDependencyError("data_api_response_invalid");
}

function uuidParameter(name, value) {
  validateUuid(value);
  return {name, value: {stringValue: value}, typeHint: "UUID"};
}

function stringParameter(name, value) {
  boundedString(value, 1, 100);
  return {name, value: {stringValue: value}};
}

function longParameter(name, value) {
  return {name, value: {longValue: value}};
}

function jsonParameter(name, value) {
  const serialized = JSON.stringify(value);
  if (serialized.length > 262_144) throw new CoordinatorContractError("build_result_too_large");
  return {name, value: {stringValue: serialized}, typeHint: "JSON"};
}

function validateUuid(value) {
  if (!UUID.test(value ?? "")) throw new CoordinatorContractError("build_identity_invalid");
}

function validateInteger(value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new CoordinatorContractError("integer_invalid");
  }
}

function validateErrorCode(value) {
  if (typeof value !== "string" || value.length > 100 || !ERROR_CODE.test(value)) {
    throw new CoordinatorContractError("error_code_invalid");
  }
}

function boundedString(value, minimum, maximum) {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new CoordinatorContractError("string_invalid");
  }
}

function s3Path(bucket, objectKey) {
  return `/${[bucket, ...objectKey.split("/")].map(awsEncode).join("/")}`;
}

function normalizedEtag(value) {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/^"|"$/g, "");
  return normalized.length >= 1 && normalized.length <= 512 && !/[\u0000-\u001f\u007f]/.test(normalized)
    ? normalized
    : null;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

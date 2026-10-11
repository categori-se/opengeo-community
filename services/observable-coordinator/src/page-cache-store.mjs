import {AwsSigV4Client, AwsDependencyError, awsEncode, boundedResponseBytes} from "./aws-sigv4.mjs";
import {CoordinatorContractError, sha256} from "./contracts.mjs";
import {verifiedPageCache} from "./page-cache-transport.mjs";
import {approvedCompilerDigests} from "./compiler-policy.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const ETAG = /^"[\x21\x23-\x7e]{1,128}"$/;
const MAX_BYTES = 32 * 1024 * 1024;
export const PAGE_CACHE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
export const PAGE_CACHE_PREFIX = "compiler-cache/pages/v1/";

// The prefix must be writable only by trusted build hosts, never by upload
// clients, publication sources or CloudFront. Metadata hashes are integrity
// checks; write authority over this prefix establishes cache provenance.
export class AwsPageCacheStore {
  constructor(settings, {sourceProjectIds = [], accountAdmission = false, client, now = Date.now} = {}) {
    if (typeof accountAdmission !== 'boolean' || !Array.isArray(sourceProjectIds) ||
        (accountAdmission ? sourceProjectIds.length !== 0 : sourceProjectIds.length < 1) || sourceProjectIds.length > 20 ||
        sourceProjectIds.some(id => !UUID.test(id)) || new Set(sourceProjectIds).size !== sourceProjectIds.length) {
      throw new CoordinatorContractError("page_cache_configuration_invalid");
    }
    this.settings = settings;
    if (typeof now !== 'function') throw new CoordinatorContractError('page_cache_configuration_invalid');
    this.now = now;
    this.compilerImageDigests = approvedCompilerDigests(settings.compilerImageDigest, settings.compilerImageDigests);
    this.sourceProjectIds = new Set(sourceProjectIds);
    this.requiresAdmission = accountAdmission;
    this.admissions = new Map();
    this.client = client ?? new AwsSigV4Client({region: settings.region});
    this.observed = new Map();
  }

  supports(scope) {
    return this.requiresAdmission ? this.admissions.has(JSON.stringify(scope)) : this.sourceProjectIds.has(scope?.sourceProjectId);
  }

  authorize(scope, admission, evidence) {
    if (!this.requiresAdmission) throw new CoordinatorContractError('page_cache_configuration_invalid');
    this.#identity(scope);
    const key = JSON.stringify(scope);
    this.admissions.delete(key);
    if (admission == null) return false;
    const expected = {...scope, buildJobId: evidence.buildJobId, sourceRevisionId: evidence.sourceRevisionId,
      maxBytes: MAX_BYTES, maxAgeSeconds: PAGE_CACHE_MAX_AGE_SECONDS};
    if (typeof admission !== 'object' || Object.keys(admission).sort().join(',') !== Object.keys(expected).sort().join(',') ||
        Object.entries(expected).some(([name, value]) => admission[name] !== value) ||
        !UUID.test(evidence.buildJobId ?? '') || !UUID.test(evidence.sourceRevisionId ?? '')) {
      throw new CoordinatorContractError('page_cache_admission_invalid');
    }
    while (this.admissions.size >= 32) this.admissions.delete(this.admissions.keys().next().value);
    this.admissions.set(key, {buildJobId: evidence.buildJobId, sourceRevisionId: evidence.sourceRevisionId});
    return true;
  }

  async read(scope) {
    const identity = this.#identity(scope);
    if (!this.supports(scope)) return null;
    this.observed.delete(identity.key);
    const response = await this.client.request({service: "s3", method: "GET",
      host: `s3.${this.settings.region}.amazonaws.com`, path: identity.path,
      maximumResponseBytes: MAX_BYTES});
    if ([403, 404].includes(response.status)) {
      await boundedResponseBytes(response, 65_536);
      // Without ListBucket a missing object may be 403. A later conditional
      // create can still succeed, but can never overwrite an existing object.
      this.#remember(identity.key, {etag: null, checksumSha256: null});
      return null;
    }
    if (!response.ok) {await boundedResponseBytes(response, 65_536); throw new AwsDependencyError("page_cache_read_unavailable");}
    const etag = response.headers.get("etag");
    if (!ETAG.test(etag ?? "")) {await response.body?.cancel(); return null;}
    this.#remember(identity.key, {etag, checksumSha256: null});
    const body = await boundedResponseBytes(response, MAX_BYTES);
    const checksumSha256 = response.headers.get("x-amz-meta-sha256");
    const created = response.headers.get('x-amz-meta-created-at');
    const expires = response.headers.get('x-amz-meta-expires-at');
    const createdAt = Date.parse(created ?? '');
    const expiresAt = Date.parse(expires ?? '');
    const now = this.now();
    // Undated legacy entries are rebuilt once. Expiration is a reuse boundary,
    // not a substitute for S3 current/noncurrent-version lifecycle deletion.
    if (!Number.isFinite(now) || !Number.isFinite(createdAt) || !Number.isFinite(expiresAt) ||
        new Date(createdAt).toISOString() !== created || new Date(expiresAt).toISOString() !== expires ||
        createdAt > now || expiresAt <= now || expiresAt <= createdAt ||
        expiresAt - createdAt > PAGE_CACHE_MAX_AGE_SECONDS * 1000) return null;
    if (response.headers.get("content-type") !== "application/json" ||
        response.headers.get("x-amz-meta-scope-sha256") !== identity.scopeHash ||
        response.headers.get("x-amz-server-side-encryption") !== "aws:kms" ||
        response.headers.get("x-amz-server-side-encryption-aws-kms-key-id") !== this.settings.kmsKeyArn ||
        !UUID.test(response.headers.get("x-amz-meta-build-id") ?? "") ||
        !UUID.test(response.headers.get("x-amz-meta-revision-id") ?? "") ||
        !HASH.test(response.headers.get("x-amz-meta-output-sha256") ?? "")) return null;
    const cache = verifiedPageCache({body, checksumSha256});
    if (cache) this.#remember(identity.key, {etag, checksumSha256});
    return cache;
  }

  async write(scope, cache, evidence) {
    const identity = this.#identity(scope);
    if (!this.supports(scope)) return {status: "disabled"};
    const admission = this.admissions.get(JSON.stringify(scope));
    if (this.requiresAdmission && (admission.buildJobId !== evidence?.buildJobId ||
        admission.sourceRevisionId !== evidence?.sourceRevisionId)) throw new CoordinatorContractError('page_cache_admission_invalid');
    const verified = verifiedPageCache(cache);
    if (!verified || !UUID.test(evidence?.buildJobId ?? "") || !UUID.test(evidence?.sourceRevisionId ?? "") ||
        !HASH.test(evidence?.outputTreeChecksumSha256 ?? "")) throw new CoordinatorContractError("page_cache_admission_invalid");
    const previous = this.observed.get(identity.key);
    this.observed.delete(identity.key);
    if (!previous) return {status: "not_observed"};
    if (previous.checksumSha256 === verified.checksumSha256) return {status: "unchanged"};
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000 - PAGE_CACHE_MAX_AGE_SECONDS * 1000) {
      throw new CoordinatorContractError('page_cache_clock_invalid');
    }
    const checksumBase64 = Buffer.from(verified.checksumSha256, "hex").toString("base64");
    const response = await this.client.request({service: "s3", method: "PUT",
      host: `s3.${this.settings.region}.amazonaws.com`, path: identity.path,
      headers: {
        ...(previous.etag ? {"if-match": previous.etag} : {"if-none-match": "*"}),
        "content-type": "application/json", "cache-control": "no-store",
        "x-amz-checksum-sha256": checksumBase64,
        "x-amz-meta-sha256": verified.checksumSha256,
        "x-amz-meta-scope-sha256": identity.scopeHash,
        "x-amz-meta-build-id": evidence.buildJobId,
        "x-amz-meta-revision-id": evidence.sourceRevisionId,
        "x-amz-meta-output-sha256": evidence.outputTreeChecksumSha256,
        "x-amz-meta-created-at": new Date(now).toISOString(),
        "x-amz-meta-expires-at": new Date(now + PAGE_CACHE_MAX_AGE_SECONDS * 1000).toISOString(),
        "x-amz-server-side-encryption": "aws:kms",
        "x-amz-server-side-encryption-aws-kms-key-id": this.settings.kmsKeyArn,
        "x-amz-server-side-encryption-bucket-key-enabled": "true"
      }, body: verified.body, maximumResponseBytes: 65_536});
    await boundedResponseBytes(response, 65_536);
    if ([404, 409, 412].includes(response.status)) return {status: "superseded"};
    if (!response.ok) throw new AwsDependencyError("page_cache_write_unavailable");
    const version = response.headers.get("x-amz-version-id");
    if (!version || version === "null" || version.length > 1024 ||
        !ETAG.test(response.headers.get("etag") ?? "") ||
        response.headers.get("x-amz-checksum-sha256") !== checksumBase64) {
      throw new AwsDependencyError("page_cache_write_response_invalid");
    }
    return {status: "written", s3VersionId: version, checksumSha256: verified.checksumSha256};
  }

  #identity(scope) {
    if (!scope || Object.keys(scope).sort().join(",") !==
        "compilerImageDigest,frameworkVersion,organizationId,projectId,sourceProjectId" ||
        ![scope.organizationId, scope.projectId, scope.sourceProjectId].every(id => UUID.test(id)) ||
        !this.compilerImageDigests.includes(scope.compilerImageDigest) || scope.frameworkVersion !== "1.13.4") {
      throw new CoordinatorContractError("page_cache_scope_invalid");
    }
    const key = `${PAGE_CACHE_PREFIX}organizations/${scope.organizationId}/projects/${scope.projectId}/` +
      `source-projects/${scope.sourceProjectId}/${scope.compilerImageDigest.slice(7)}/pages.json`;
    const scopeHash = sha256(Buffer.from(JSON.stringify([scope.organizationId, scope.projectId,
      scope.sourceProjectId, scope.compilerImageDigest, scope.frameworkVersion])));
    return {key, scopeHash, path: `/${[this.settings.bucket, ...key.split("/")].map(awsEncode).join("/")}`};
  }

  #remember(key, value) {
    this.observed.delete(key);
    while (this.observed.size >= 32) this.observed.delete(this.observed.keys().next().value);
    this.observed.set(key, value);
  }
}

export function configuredPageCacheStore(settings, environment) {
  const configured = environment.OPEN_GEO_OBSERVABLE_PAGE_CACHE_SOURCE_PROJECT_IDS;
  const mode = environment.OPEN_GEO_OBSERVABLE_PAGE_CACHE_ADMISSION;
  if (mode !== undefined && mode !== '' && mode !== 'account') throw new CoordinatorContractError('page_cache_configuration_invalid');
  if (mode === 'account') {
    if (configured) throw new CoordinatorContractError('page_cache_configuration_invalid');
    return new AwsPageCacheStore(settings, {accountAdmission: true});
  }
  if (configured === undefined || configured === "") return undefined;
  return new AwsPageCacheStore(settings, {sourceProjectIds: configured.split(",")});
}

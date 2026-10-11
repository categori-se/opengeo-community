// @ts-nocheck -- Runtime contract behavior is enforced by the package's conformance suite.
export const demoSchemaVersion = 1;

export const demoResetCadences = Object.freeze({
  dailyUtc: "daily_utc"
});

export const demoMutationActions = Object.freeze({
  createProject: "project.create",
  createNotebook: "notebook.create",
  editNotebook: "notebook.edit",
  commentNotebook: "notebook.comment",
  editMetadata: "metadata.edit"
});

const mutationActionSet = new Set(Object.values(demoMutationActions));
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

export function createDemoPolicy({
  demoId,
  seedId,
  seedVersion,
  seedSha256,
  sourceManifestSha256,
  allowedMutations = Object.values(demoMutationActions),
  visitorQuotas = {},
  globalQuotas = {},
  partitionTtlSeconds = 172800,
  showcaseSourceRefs = [],
  allowedEgressHosts = []
} = {}) {
  return assertDemoPolicy({
    schema_version: demoSchemaVersion,
    demo_id: demoId,
    seed: {
      seed_id: seedId,
      version: seedVersion,
      sha256: seedSha256
    },
    reset: {
      cadence: demoResetCadences.dailyUtc,
      partition_ttl_seconds: partitionTtlSeconds
    },
    isolation: {
      mode: "server_issued_visitor_partition",
      seed_is_immutable: true,
      production_writes: false,
      external_write_back: false,
      public_sharing: false,
      connection_use: false,
      uploads: false,
      notebook_execution: false
    },
    allowed_mutations: [...new Set(allowedMutations)],
    quotas: {
      per_visitor: {
        mutations_per_minute: 20,
        mutations_per_day: 200,
        projects_per_day: 10,
        notebooks_per_day: 20,
        ...visitorQuotas
      },
      global: {
        mutations_per_minute: 500,
        mutations_per_day: 10000,
        ...globalQuotas
      }
    },
    showcases: {
      data_authority: "massgis",
      source_manifest_sha256: sourceManifestSha256,
      source_refs: [...new Set(showcaseSourceRefs)],
      source_access: "read_only",
      allowed_egress_hosts: [...new Set(allowedEgressHosts)]
    }
  });
}

export function validateDemoPolicy(policy) {
  const errors = [];
  if (!objectValue(policy)) return [issue("$", "demo policy must be an object")];
  if (Number(policy.schema_version) !== demoSchemaVersion) errors.push(issue("$.schema_version", `schema_version must be ${demoSchemaVersion}`));
  validateIdentifier(policy.demo_id, "$.demo_id", errors);
  if (!objectValue(policy.seed)) errors.push(issue("$.seed", "seed is required"));
  else {
    validateIdentifier(policy.seed.seed_id, "$.seed.seed_id", errors);
    validateIdentifier(policy.seed.version, "$.seed.version", errors);
    if (!sha256Pattern.test(String(policy.seed.sha256 || ""))) errors.push(issue("$.seed.sha256", "seed sha256 must be a lowercase SHA-256 digest"));
  }
  if (policy.reset?.cadence !== demoResetCadences.dailyUtc) errors.push(issue("$.reset.cadence", "public demos must reset on a daily UTC partition"));
  if (!Number.isInteger(policy.reset?.partition_ttl_seconds) || policy.reset.partition_ttl_seconds < 86400 || policy.reset.partition_ttl_seconds > 604800) {
    errors.push(issue("$.reset.partition_ttl_seconds", "partition TTL must be between one and seven days"));
  }
  const isolation = policy.isolation || {};
  if (isolation.mode !== "server_issued_visitor_partition") errors.push(issue("$.isolation.mode", "demo mutations require a server-issued visitor partition"));
  for (const field of ["seed_is_immutable"]) if (isolation[field] !== true) errors.push(issue(`$.isolation.${field}`, `${field} must be true`));
  for (const field of ["production_writes", "external_write_back", "public_sharing", "connection_use", "uploads"]) {
    if (isolation[field] !== false) errors.push(issue(`$.isolation.${field}`, `${field} must be false`));
  }
  if (isolation.notebook_execution !== false) errors.push(issue("$.isolation.notebook_execution", "public demo notebook execution must remain disabled until an isolated, resource-limited sandbox is available"));
  if (!Array.isArray(policy.allowed_mutations) || !policy.allowed_mutations.length) errors.push(issue("$.allowed_mutations", "at least one bounded mutation is required"));
  else for (const action of policy.allowed_mutations) if (!mutationActionSet.has(action)) errors.push(issue("$.allowed_mutations", `unsupported demo mutation: ${action}`));
  validateQuotaSet(policy.quotas?.per_visitor, "$.quotas.per_visitor", errors, [
    "mutations_per_minute",
    "mutations_per_day",
    "projects_per_day",
    "notebooks_per_day"
  ]);
  validateQuotaSet(policy.quotas?.global, "$.quotas.global", errors, ["mutations_per_minute", "mutations_per_day"]);
  if (policy.showcases?.source_access !== "read_only") errors.push(issue("$.showcases.source_access", "showcase sources must be read_only"));
  if (policy.showcases?.data_authority !== "massgis") errors.push(issue("$.showcases.data_authority", "the initial public demo is limited to reviewed MassGIS sources"));
  if (!sha256Pattern.test(String(policy.showcases?.source_manifest_sha256 || ""))) errors.push(issue("$.showcases.source_manifest_sha256", "a reviewed MassGIS source-manifest digest is required"));
  if (!Array.isArray(policy.showcases?.source_refs) || !policy.showcases.source_refs.length) errors.push(issue("$.showcases.source_refs", "at least one reviewed MassGIS source is required"));
  else for (const sourceRef of policy.showcases.source_refs) validateIdentifier(sourceRef, "$.showcases.source_refs", errors);
  if (!Array.isArray(policy.showcases?.allowed_egress_hosts) || !policy.showcases.allowed_egress_hosts.length) errors.push(issue("$.showcases.allowed_egress_hosts", "an explicit runtime egress allowlist is required"));
  else for (const host of policy.showcases.allowed_egress_hosts) validateEgressHost(host, errors);
  return errors;
}

export function assertDemoPolicy(policy) {
  const errors = validateDemoPolicy(policy);
  if (errors.length) throw new TypeError(formatIssues("invalid demo policy", errors));
  return deepFreeze(structuredClone(policy));
}

export function demoUtcDayKey(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(date.getTime())) throw new TypeError("now must be a valid date");
  return date.toISOString().slice(0, 10);
}

export function demoMinuteKey(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(date.getTime())) throw new TypeError("now must be a valid date");
  return date.toISOString().slice(0, 16);
}

export function buildDemoPartitionScope({demoId, visitorPartitionId, seedSha256, now = new Date()} = {}) {
  const errors = [];
  validateIdentifier(demoId, "$.demo_id", errors);
  validateIdentifier(visitorPartitionId, "$.visitor_partition_id", errors);
  if (!sha256Pattern.test(String(seedSha256 || ""))) errors.push(issue("$.seed_sha256", "seed sha256 is required"));
  if (errors.length) throw new TypeError(formatIssues("invalid demo partition", errors));
  const date = now instanceof Date ? now : new Date(now);
  const day = demoUtcDayKey(now);
  const expiresAt = new Date(`${day}T00:00:00.000Z`);
  expiresAt.setUTCDate(expiresAt.getUTCDate() + 1);
  return deepFreeze({
    demo_id: demoId,
    visitor_partition_id: visitorPartitionId,
    utc_day: day,
    seed_sha256: seedSha256,
    issued_at: date.toISOString(),
    expires_at: expiresAt.toISOString(),
    reset_generation: day,
    partition_key: `DEMO#${demoId}#DAY#${day}#VISITOR#${visitorPartitionId}`
  });
}

export function demoPartitionNeedsReset(partition, now = new Date()) {
  return !partition || partition.utc_day !== demoUtcDayKey(now);
}

export function authorizeDemoMutation({
  policy,
  action,
  partition,
  visitorUsage = {},
  globalUsage = {},
  enforcement = {},
  mutation = {},
  now = new Date()
} = {}) {
  const policyErrors = validateDemoPolicy(policy);
  if (policyErrors.length) return decision(false, "invalid_policy", policyErrors);
  if (!validDemoPartition(partition, policy, now)) return decision(false, "stale_or_invalid_partition");
  if (enforcement.partition_session_verified !== true) return decision(false, "unverified_partition_session");
  if (enforcement.counter_source !== "authoritative_server") return decision(false, "untrusted_usage_counters");
  if (enforcement.quota_reservation !== "atomic") return decision(false, "non_atomic_quota_reservation");
  if (enforcement.seed_healthy !== true) return decision(false, "seed_unavailable_read_only");
  if (mutation.overlay_owned !== true || mutation.targets_seed === true) return decision(false, "invalid_overlay_target");
  validateIdentifier(mutation.idempotency_key, "$.mutation.idempotency_key", policyErrors);
  if (policyErrors.length) return decision(false, "invalid_mutation_context", policyErrors);
  if (!Number.isSafeInteger(mutation.expected_revision) || mutation.expected_revision < 0) return decision(false, "invalid_mutation_revision");
  if (!Number.isSafeInteger(mutation.content_bytes) || mutation.content_bytes < 0 || mutation.content_bytes > 100000) return decision(false, "mutation_too_large");
  if (!policy.allowed_mutations.includes(action)) return decision(false, "mutation_not_allowed");
  if (!validUsageCounters(visitorUsage) || !validUsageCounters(globalUsage)) return decision(false, "invalid_usage");
  const visitor = policy.quotas.per_visitor;
  const global = policy.quotas.global;
  const checks = [
    [Number(visitorUsage.mutations_this_minute || 0) + 1, visitor.mutations_per_minute, "visitor_minute_quota"],
    [Number(visitorUsage.mutations_today || 0) + 1, visitor.mutations_per_day, "visitor_daily_quota"],
    [Number(globalUsage.mutations_this_minute || 0) + 1, global.mutations_per_minute, "global_minute_quota"],
    [Number(globalUsage.mutations_today || 0) + 1, global.mutations_per_day, "global_daily_quota"]
  ];
  if (action === demoMutationActions.createProject) checks.push([Number(visitorUsage.projects_created_today || 0) + 1, visitor.projects_per_day, "project_quota"]);
  if (action === demoMutationActions.createNotebook) checks.push([Number(visitorUsage.notebooks_created_today || 0) + 1, visitor.notebooks_per_day, "notebook_quota"]);
  for (const [value, limit, reason] of checks) if (!Number.isFinite(value) || value > limit) return decision(false, reason);
  return decision(true, "allowed", [], {
    utc_day: partition.utc_day,
    minute: demoMinuteKey(now),
    remaining: {
      visitor_mutations_today: Math.max(0, visitor.mutations_per_day - Number(visitorUsage.mutations_today || 0) - 1)
    }
  });
}

function decision(allowed, reason, issues = [], extra = {}) {
  return deepFreeze({allowed, reason, issues, ...extra});
}

function validateQuotaSet(value, path, errors, keys) {
  if (!objectValue(value)) {
    errors.push(issue(path, "quota set is required"));
    return;
  }
  for (const key of keys) {
    if (!Number.isSafeInteger(value[key]) || value[key] <= 0) errors.push(issue(`${path}.${key}`, "quota must be a positive safe integer"));
  }
}

function validUsageCounters(value) {
  if (!objectValue(value)) return false;
  return Object.values(value).every((counter) => Number.isSafeInteger(counter) && counter >= 0);
}

function validateIdentifier(value, path, errors) {
  if (!identifierPattern.test(String(value || ""))) errors.push(issue(path, "must be a non-empty opaque identifier"));
}

function validateEgressHost(value, errors) {
  const host = String(value || "").toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(host) || host.includes("..") || host === "localhost" || /^\d+(?:\.\d+){3}$/.test(host)) {
    errors.push(issue("$.showcases.allowed_egress_hosts", "egress hosts must be explicit public DNS names"));
  }
}

function validDemoPartition(partition, policy, now) {
  if (!objectValue(partition)) return false;
  const day = demoUtcDayKey(now);
  const expectedKey = `DEMO#${policy.demo_id}#DAY#${day}#VISITOR#${partition.visitor_partition_id}`;
  return identifierPattern.test(String(partition.visitor_partition_id || "")) &&
    partition.demo_id === policy.demo_id &&
    partition.utc_day === day &&
    partition.reset_generation === day &&
    partition.seed_sha256 === policy.seed.sha256 &&
    partition.partition_key === expectedKey &&
    Number.isFinite(Date.parse(partition.issued_at)) &&
    Number.isFinite(Date.parse(partition.expires_at)) &&
    Date.parse(partition.issued_at) <= new Date(now).getTime() &&
    Date.parse(partition.expires_at) > new Date(now).getTime();
}

function objectValue(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function issue(path, message) {
  return {path, message};
}

function formatIssues(prefix, errors) {
  return `${prefix}: ${errors.map((error) => `${error.path} ${error.message}`).join("; ")}`;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

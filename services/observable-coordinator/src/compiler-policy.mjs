import {CoordinatorContractError} from "./contracts.mjs";
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const BUCKET = /^(?!\d+\.\d+\.\d+\.\d+$)(?!.*\.\.)(?!.*\.-)(?!.*-\.)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const MAX_COMPILER_DIGESTS = 6;
export const COMPILER_REPOSITORY = "111111111111.dkr.ecr.us-east-1.amazonaws.com/opengeo/production/observable-builder";

// This profile is installed by the operator in the trusted host environment.
// It is never admitted from source revisions, compiler requests or queue bodies.
export function parseIndependentDeployment(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "account,compilerRepository,ownerId,region,repository,repositoryId,runtimeSha" ||
      Object.values(value).some(item => typeof item === "string" && /[\u0000-\u0020\u007f]/.test(item)) ||
      typeof value.account !== "string" || !/^\d{12}$/.test(value.account) || value.region !== "us-east-1" ||
      typeof value.repository !== "string" ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/.test(value.repository) ||
      !Number.isSafeInteger(value.repositoryId) || value.repositoryId < 1 ||
      !Number.isSafeInteger(value.ownerId) || value.ownerId < 1 ||
      typeof value.runtimeSha !== "string" || !SHA.test(value.runtimeSha) ||
      typeof value.compilerRepository !== "string") {
    throw new CoordinatorContractError("independent_deployment_configuration_invalid");
  }
  const prefix = `${value.account}.dkr.ecr.${value.region}.amazonaws.com/`;
  const path = value.compilerRepository.slice(prefix.length);
  if (!value.compilerRepository.startsWith(prefix) || path.length < 2 || path.length > 256 ||
      !/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/.test(path)) {
    throw new CoordinatorContractError("independent_deployment_configuration_invalid");
  }
  return Object.freeze({...value});
}

export function independentDeploymentFromEnvironment(environment) {
  const configured = environment.OPEN_GEO_OBSERVABLE_INDEPENDENT_BUILD_CONFIG;
  if (configured === undefined || configured === "") return undefined;
  if (typeof configured !== "string" || configured.length > 2048) {
    throw new CoordinatorContractError("independent_deployment_configuration_invalid");
  }
  let value;
  try { value = JSON.parse(configured); }
  catch { throw new CoordinatorContractError("independent_deployment_configuration_invalid"); }
  return parseIndependentDeployment(value);
}

export function validateIndependentDeploymentEnvironment(environment, independentDeployment) {
  const profile = parseIndependentDeployment(independentDeployment);
  const {account, region} = profile;
  const sourceBucket = environment.OPEN_GEO_APPLICATION_BUCKET;
  const archiveBucket = environment.OPEN_GEO_ARCHIVE_BUCKET;
  const canonicalBucket = bucket => typeof bucket === "string" && BUCKET.test(bucket) &&
    bucket.trim() === bucket &&
    !/^(?:xn--|sthree-|amzn-s3-demo-)/.test(bucket) && !/(?:-s3alias|--ol-s3|\.mrap|--x-s3|--table-s3)$/.test(bucket) &&
    bucket !== "opengeo.tools" && !bucket.endsWith(".opengeo.tools");
  if (environment.OPEN_GEO_AWS_REGION !== region ||
      [environment.OPEN_GEO_DATA_API_CLUSTER_ARN, environment.OPEN_GEO_DATA_API_SECRET_ARN,
        environment.OPEN_GEO_APPLICATION_KMS_KEY_ARN].some(arn => typeof arn !== "string" || /[\u0000-\u0020\u007f]/.test(arn)) ||
      !new RegExp(`^arn:aws:rds:${region}:${account}:cluster:[A-Za-z][A-Za-z0-9-]{0,62}$`).test(environment.OPEN_GEO_DATA_API_CLUSTER_ARN ?? "") ||
      !new RegExp(`^arn:aws:secretsmanager:${region}:${account}:secret:[A-Za-z0-9/_+=.@-]+-[A-Za-z0-9]{6}$`).test(environment.OPEN_GEO_DATA_API_SECRET_ARN ?? "") ||
      !new RegExp(`^arn:aws:kms:${region}:${account}:key/${UUID}$`).test(environment.OPEN_GEO_APPLICATION_KMS_KEY_ARN ?? "") ||
      environment.OPEN_GEO_OBSERVABLE_COMPILER_REPOSITORY !== profile.compilerRepository ||
      !canonicalBucket(sourceBucket) || !canonicalBucket(archiveBucket) || sourceBucket === archiveBucket) {
    throw new CoordinatorContractError("independent_deployment_environment_invalid");
  }
  return profile;
}

// Trusted deployment configuration only, never a browser/source/queue input.
// Retain five previous reviewed images for existing Publications while introducing
// an explicitly pinned compiler. Never accept mutable tags or open-ended admission.
export function approvedCompilerDigests(primary, configured) {
  const digests = configured === undefined ? [primary] : configured;
  if (!DIGEST.test(primary ?? "") || !Array.isArray(digests) || digests.length < 1 || digests.length > MAX_COMPILER_DIGESTS ||
      !digests.includes(primary) || digests.some(digest => typeof digest !== "string" || !DIGEST.test(digest)) ||
      new Set(digests).size !== digests.length) throw new CoordinatorContractError("compiler_policy_invalid");
  return Object.freeze([...digests]);
}

export function compilerDigestsFromEnvironment(environment) {
  const configured = environment.OPEN_GEO_OBSERVABLE_COMPILER_IMAGE_DIGESTS;
  return approvedCompilerDigests(environment.OPEN_GEO_OBSERVABLE_COMPILER_IMAGE_DIGEST,
    configured === undefined || configured === "" ? undefined : configured.split(","));
}

export function compilerPullTargets(environment) {
  const independentDeployment = independentDeploymentFromEnvironment(environment);
  if (independentDeployment) validateIndependentDeploymentEnvironment(environment, independentDeployment);
  const repository = independentDeployment?.compilerRepository ?? COMPILER_REPOSITORY;
  if (environment.OPEN_GEO_OBSERVABLE_COMPILER_REPOSITORY !== repository) {
    throw new CoordinatorContractError("runner_image_repository_invalid");
  }
  return compilerDigestsFromEnvironment(environment).map(digest => `${repository}@${digest}`);
}

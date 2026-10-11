import {CoordinatorContractError} from "./contracts.mjs";
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const MAX_COMPILER_DIGESTS = 6;
export const COMPILER_REPOSITORY = "111111111111.dkr.ecr.us-east-1.amazonaws.com/opengeo/production/observable-builder";

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
  if (environment.OPEN_GEO_OBSERVABLE_COMPILER_REPOSITORY !== COMPILER_REPOSITORY) {
    throw new CoordinatorContractError("runner_image_repository_invalid");
  }
  return compilerDigestsFromEnvironment(environment).map(digest => `${COMPILER_REPOSITORY}@${digest}`);
}

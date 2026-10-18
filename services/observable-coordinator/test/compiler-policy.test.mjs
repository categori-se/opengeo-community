import assert from "node:assert/strict";
import {test} from "node:test";
import {approvedCompilerDigests, compilerDigestsFromEnvironment, compilerPullTargets, COMPILER_REPOSITORY,
  independentDeploymentFromEnvironment, parseIndependentDeployment} from "../src/compiler-policy.mjs";
const old = `sha256:${"a".repeat(64)}`, next = `sha256:${"b".repeat(64)}`, third = `sha256:${"c".repeat(64)}`, fourth = `sha256:${"d".repeat(64)}`;
const fifth = `sha256:${"e".repeat(64)}`, sixth = `sha256:${"f".repeat(64)}`;
const seventh = `sha256:${"0".repeat(64)}`;
const historical = [old, next, third, fourth, fifth];
const reviewed = [...historical, sixth];
test("compiler transition retains five existing pins while admitting a sixth explicit reviewed digest", () => {
  assert.deepEqual(approvedCompilerDigests(old), [old]);
  assert.deepEqual(approvedCompilerDigests(next, [old, next]), [old, next]);
  assert.deepEqual(approvedCompilerDigests(next, [old, next, third]), [old, next, third]);
  assert.deepEqual(approvedCompilerDigests(next, reviewed.slice(0, 4)), reviewed.slice(0, 4));
  assert.deepEqual(approvedCompilerDigests(next, historical), historical);
  assert.deepEqual(approvedCompilerDigests(next, reviewed), reviewed);
  assert.deepEqual(approvedCompilerDigests(next, reviewed).slice(0, 5), historical);
  for (const primary of reviewed) assert.deepEqual(approvedCompilerDigests(primary, reviewed), reviewed);
  assert.equal(Object.isFrozen(approvedCompilerDigests(next, reviewed)), true);
  assert.notEqual(approvedCompilerDigests(next, reviewed), reviewed);
});
test("compiler admission rejects a seventh pin, missing default, duplicates and invalid digests", () => {
  for (const value of [[], [old], [...reviewed, seventh], [...reviewed.slice(0, 5), fifth], [next, next],
    [next, "*"], [next, "latest"], [next, ` ${old}`], [next, old.toUpperCase()], [next, null], next]) {
    assert.throws(() => approvedCompilerDigests(next, value), /compiler_policy_invalid/);
  }
  assert.throws(() => approvedCompilerDigests(null, [old]), /compiler_policy_invalid/);
  assert.throws(() => approvedCompilerDigests("latest", reviewed), /compiler_policy_invalid/);
  assert.throws(() => approvedCompilerDigests(seventh, reviewed), /compiler_policy_invalid/);
});
test("trusted environment admits only six fixed-repository pull targets and preserves the primary default", () => {
  const environment = {OPEN_GEO_OBSERVABLE_COMPILER_IMAGE_DIGEST: next, OPEN_GEO_OBSERVABLE_COMPILER_IMAGE_DIGESTS: reviewed.join(","),
    OPEN_GEO_OBSERVABLE_COMPILER_REPOSITORY: COMPILER_REPOSITORY};
  assert.deepEqual(compilerDigestsFromEnvironment(environment), reviewed);
  assert.deepEqual(compilerPullTargets(environment), reviewed.map(digest => `${COMPILER_REPOSITORY}@${digest}`));
  for (const configured of [undefined, ""]) {
    assert.deepEqual(compilerDigestsFromEnvironment({...environment, OPEN_GEO_OBSERVABLE_COMPILER_IMAGE_DIGESTS: configured}), [next]);
  }
  assert.throws(() => compilerPullTargets({...environment, OPEN_GEO_OBSERVABLE_COMPILER_IMAGE_DIGESTS: [...reviewed, seventh].join(",")}), /compiler_policy_invalid/);
  assert.throws(() => compilerPullTargets({...environment, OPEN_GEO_OBSERVABLE_COMPILER_IMAGE_DIGEST: seventh}), /compiler_policy_invalid/);
  assert.throws(() => compilerPullTargets({...environment, OPEN_GEO_OBSERVABLE_COMPILER_REPOSITORY: "untrusted.example/repo"}), /runner_image_repository_invalid/);
});

const profile = {account: "111111111111", region: "us-east-1", repository: "owner/public-runtime",
  repositoryId: 123, ownerId: 321, runtimeSha: "a".repeat(40),
  compilerRepository: "111111111111.dkr.ecr.us-east-1.amazonaws.com/opengeo/compiler"};
const independentEnvironment = {
  OPEN_GEO_OBSERVABLE_INDEPENDENT_BUILD_CONFIG: JSON.stringify(profile),
  OPEN_GEO_AWS_REGION: profile.region,
  OPEN_GEO_DATA_API_CLUSTER_ARN: "arn:aws:rds:us-east-1:111111111111:cluster:independent-runtime",
  OPEN_GEO_DATA_API_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:111111111111:secret:independent/coordinator-AbCd12",
  OPEN_GEO_APPLICATION_KMS_KEY_ARN: "arn:aws:kms:us-east-1:111111111111:key/00000000-0000-4000-8000-000000000001",
  OPEN_GEO_APPLICATION_BUCKET: "independent-source", OPEN_GEO_ARCHIVE_BUCKET: "independent-archive",
  OPEN_GEO_OBSERVABLE_COMPILER_REPOSITORY: profile.compilerRepository,
  OPEN_GEO_OBSERVABLE_COMPILER_IMAGE_DIGEST: next, OPEN_GEO_OBSERVABLE_COMPILER_IMAGE_DIGESTS: reviewed.join(",")
};

test("independent compiler admission accepts only a closed trusted same-account deployment profile", () => {
  assert.equal(independentDeploymentFromEnvironment({}), undefined);
  assert.equal(independentDeploymentFromEnvironment({OPEN_GEO_OBSERVABLE_INDEPENDENT_BUILD_CONFIG: ""}), undefined);
  assert.deepEqual(independentDeploymentFromEnvironment(independentEnvironment), profile);
  assert.equal(Object.isFrozen(parseIndependentDeployment(profile)), true);
  for (const value of [null, [], "{}", {...profile, extra: true}, {...profile, account: 111111111111},
    {...profile, region: "us-west-2"}, {...profile, repositoryId: "123"}, {...profile, ownerId: 0},
    {...profile, repositoryId: Number.MAX_SAFE_INTEGER + 1}, {...profile, runtimeSha: "main"},
    {...profile, repository: "owner/../public-runtime"},
    ...[`${profile.compilerRepository}:latest`, `${profile.compilerRepository}@${next}`,
      `${profile.compilerRepository}/`, `${profile.compilerRepository}/../compiler`,
      `${profile.compilerRepository}\n`,
      profile.compilerRepository.replace("111111111111", "222222222222"),
      profile.compilerRepository.replace("us-east-1", "us-west-2"),
      `https://${profile.compilerRepository}`, `user:password@${profile.compilerRepository}`,
      profile.compilerRepository.replace("compiler", "Compiler")].map(compilerRepository => ({...profile, compilerRepository}))]) {
    assert.throws(() => parseIndependentDeployment(value), /independent_deployment_configuration_invalid/);
  }
  for (const configured of [" ", "not-json", "null", "{}", profile]) {
    assert.throws(() => independentDeploymentFromEnvironment({OPEN_GEO_OBSERVABLE_INDEPENDENT_BUILD_CONFIG: configured}),
      /independent_deployment_configuration_invalid/);
  }
});

test("independent pulls retain the six immutable pins and refuse foreign or managed custody before pulling", () => {
  assert.deepEqual(compilerPullTargets(independentEnvironment), reviewed.map(digest => `${profile.compilerRepository}@${digest}`));
  for (const change of [
    {OPEN_GEO_OBSERVABLE_COMPILER_REPOSITORY: COMPILER_REPOSITORY},
    {OPEN_GEO_DATA_API_CLUSTER_ARN: independentEnvironment.OPEN_GEO_DATA_API_CLUSTER_ARN.replace("111111111111", "222222222222")},
    {OPEN_GEO_DATA_API_CLUSTER_ARN: "arn:aws:rds:us-east-1:111111111111:cluster:1invalid-cluster"},
    {OPEN_GEO_DATA_API_SECRET_ARN: independentEnvironment.OPEN_GEO_DATA_API_SECRET_ARN.replace("111111111111", "222222222222")},
    {OPEN_GEO_APPLICATION_KMS_KEY_ARN: independentEnvironment.OPEN_GEO_APPLICATION_KMS_KEY_ARN.replace("111111111111", "222222222222")},
    {OPEN_GEO_AWS_REGION: "us-west-2"}, {OPEN_GEO_ARCHIVE_BUCKET: undefined},
    {OPEN_GEO_ARCHIVE_BUCKET: "independent-source"}, {OPEN_GEO_ARCHIVE_BUCKET: "geodata.opengeo.tools"},
    ...["source.opengeo.tools", "other.opengeo.tools", "opengeo.tools", "111.222.3.4", "source..bucket", "source.-bucket",
      "source-.bucket", "source-bucket/", "source-bucket\n", "user:password@source-bucket"].map(OPEN_GEO_APPLICATION_BUCKET => ({OPEN_GEO_APPLICATION_BUCKET}))
  ]) {
    assert.throws(() => compilerPullTargets({...independentEnvironment, ...change}), /independent_deployment_environment_invalid/);
  }
  assert.throws(() => compilerPullTargets({...independentEnvironment,
    OPEN_GEO_OBSERVABLE_COMPILER_IMAGE_DIGESTS: [...reviewed, seventh].join(",")}), /compiler_policy_invalid/);
});

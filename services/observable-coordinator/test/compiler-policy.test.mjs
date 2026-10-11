import assert from "node:assert/strict";
import {test} from "node:test";
import {approvedCompilerDigests, compilerDigestsFromEnvironment, compilerPullTargets, COMPILER_REPOSITORY} from "../src/compiler-policy.mjs";
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

import {readFileSync, statSync} from "node:fs";
import assert from "node:assert/strict";
import {validateDemoApiInvocation, validateDemoApiInvocationContinuation} from "../lib/demo-api-invocation-guard.ts";
import {releaseContractSha256} from "../lib/demo-pilot-release-guard.ts";

const allowed = new Set(["--function", "--integration", "--policy", "--digest", "--before-function", "--before-integration", "--before-policy", "--before-digest"]);
const flags = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const [name, value] = process.argv.slice(index, index + 2);
  assert.ok(allowed.has(name) && value && !value.startsWith("--") && !flags.has(name), "Invalid, missing or duplicate argument");
  flags.set(name, value);
}
function snapshot(prefix = "") {
  function read(name) {
    const path = flags.get(`--${prefix}${name}`);
    assert.ok(path && statSync(path).isFile() && statSync(path).size <= 1_048_576, "Missing or oversized snapshot");
    return JSON.parse(readFileSync(path, "utf8"));
  }
  return {fn: read("function"), integration: read("integration"), policy: read("policy"), digest: flags.get(`--${prefix}digest`)};
}
const after = snapshot();
const comparison = [...flags.keys()].some((key) => key.startsWith("--before-"));
const result = comparison
  ? validateDemoApiInvocationContinuation(snapshot("before-"), after)
  : validateDemoApiInvocation(after.fn, after.integration, after.policy, after.digest);
console.log(JSON.stringify({status: "saved-snapshots-verified-not-live-acceptance", comparison, releaseContractSha256, ...result}, null, 2));

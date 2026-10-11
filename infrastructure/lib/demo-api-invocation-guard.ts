import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {canonicalJson, sha256, validateApiDigest} from "./demo-pilot-release-guard.js";

type Snapshot = Record<string, any>;
const contract = JSON.parse(readFileSync(new URL("../bootstrap/opengeo-demo-pilot-release-contract.json", import.meta.url), "utf8"));
const verificationPolicy = JSON.parse(readFileSync(new URL("../bootstrap/opengeo-production-demo-api-verification-policy.json", import.meta.url), "utf8"));
const integrationResource = verificationPolicy.Statement.find((entry: Snapshot) => entry.Sid === "ReadExactDemoApiIntegration")?.Resource;
const integrationIdentity = /^arn:aws:apigateway:us-east-1::\/apis\/([a-z0-9]+)\/integrations\/([a-z0-9]+)$/.exec(integrationResource ?? "");
assert.ok(integrationIdentity, "Missing exact reviewed integration identity");
const functionArn = `arn:aws:lambda:${contract.region}:${contract.account}:function:${contract.apiFunctionName}`;

/** Inspect saved AWS CLI responses. This function neither reads AWS nor authorizes execution. */
export function validateDemoApiInvocation(
  fn: Snapshot, integration: Snapshot, policyResponse: Snapshot, digest: string
): Snapshot {
  validateApiDigest(digest);
  assert.equal(fn.Configuration?.FunctionName, contract.apiFunctionName, "Wrong API function name");
  assert.equal(fn.Configuration?.FunctionArn, functionArn, "Wrong API function ARN");
  assert.equal(fn.Configuration?.PackageType, "Image", "The API must remain image based");
  assert.deepEqual(fn.Configuration?.Architectures, ["arm64"], "Wrong API architecture");
  assert.equal(fn.Configuration?.State, "Active", "API function is not active");
  assert.equal(fn.Configuration?.LastUpdateStatus, "Successful", "API update has not succeeded");
  assert.equal(fn.Code?.ResolvedImageUri, `${contract.apiRepository}@${digest}`, "Wrong resolved API image");
  assert.equal(integration.IntegrationId, integrationIdentity![2], "Wrong integration ID");
  assert.equal(integration.IntegrationType, "AWS_PROXY", "Wrong integration type");
  assert.equal(integration.IntegrationUri, functionArn, "Integration must target the exact API function");
  assert.equal(integration.PayloadFormatVersion, "2.0", "Wrong payload format");
  // The pinned template has no alternate credentials, private link or mappings.
  for (const field of ["CredentialsArn", "ConnectionId", "IntegrationSubtype", "TlsConfig", "RequestParameters", "ResponseParameters", "RequestTemplates"]) {
    assert.ok(!Object.hasOwn(integration, field), `Unreviewed integration field: ${field}`);
  }
  if (integration.ConnectionType !== undefined) assert.equal(integration.ConnectionType, "INTERNET");
  if (integration.IntegrationMethod !== undefined) assert.equal(integration.IntegrationMethod, "POST");

  assert.ok(typeof policyResponse.Policy === "string" && policyResponse.Policy.length <= 32_768, "Missing or oversized function policy");
  assert.ok(typeof policyResponse.RevisionId === "string" && policyResponse.RevisionId.length > 0, "Missing policy revision");
  const policy = JSON.parse(policyResponse.Policy);
  assert.ok(Object.keys(policy).every((key) => ["Version", "Id", "Statement"].includes(key)), "Unreviewed policy document fields");
  assert.equal(policy.Version, "2012-10-17", "Wrong policy version");
  assert.ok(Array.isArray(policy.Statement) && policy.Statement.length === 1, "Exactly one invocation grant must remain");
  const statement = structuredClone(policy.Statement[0]);
  assert.ok(typeof statement.Sid === "string" && statement.Sid.length > 0 && statement.Sid.length <= 256, "Missing invocation statement identity");
  // CloudFormation may replace this permission and generate a new statement ID.
  delete statement.Sid;
  assert.deepEqual(statement, {
    Effect: "Allow",
    Principal: {Service: "apigateway.amazonaws.com"},
    Action: "lambda:InvokeFunction",
    Resource: functionArn,
    Condition: {ArnLike: {"AWS:SourceArn": `arn:aws:execute-api:${contract.region}:${contract.account}:${integrationIdentity![1]}/*/*`}}
  }, "Invocation policy differs from the exact reviewed API boundary");
  return {
    functionArn,
    apiId: integrationIdentity![1],
    integrationId: integrationIdentity![2],
    digest,
    integrationSha256: sha256(canonicalJson(integration)),
    invocationSemanticsSha256: sha256(canonicalJson(statement))
  };
}

export function validateDemoApiInvocationContinuation(
  before: {fn: Snapshot; integration: Snapshot; policy: Snapshot; digest: string},
  after: {fn: Snapshot; integration: Snapshot; policy: Snapshot; digest: string}
): Snapshot {
  const retained = validateDemoApiInvocation(before.fn, before.integration, before.policy, before.digest);
  const current = validateDemoApiInvocation(after.fn, after.integration, after.policy, after.digest);
  assert.deepEqual(after.integration, before.integration, "Integration configuration changed during the release");
  assert.equal(current.invocationSemanticsSha256, retained.invocationSemanticsSha256, "Invocation authority changed during the release");
  return current;
}

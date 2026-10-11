import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

const root = new URL("../bootstrap/dataset-connections/", import.meta.url);
const readJson = (name: string): Record<string, any> =>
  JSON.parse(readFileSync(new URL(name, root), "utf8"));

test("dev verifier has no direct S3 or secret-mutation authority", () => {
  const policy = readJson("opengeo-dev-dataset-verifier-policy.json");
  const serialized = JSON.stringify(policy);
  assert.match(serialized, /arn:aws:iam::111111111111:role\/opengeo\/OpenGeoDatasetReader/);
  assert.match(serialized, /opengeo\/dev\/user-connections\/\*/);
  assert.doesNotMatch(serialized, /s3:/);
  assert.doesNotMatch(serialized, /CreateSecret|DeleteSecret|PutSecretValue|UpdateSecret/);
});

test("production reader is read-only and bounded to the observed prefixes", () => {
  const policy = readJson("opengeo-production-dataset-reader-policy.json");
  const serialized = JSON.stringify(policy);
  for (const prefix of [
    "bhutan", "global", "india", "nepal", "regional", "sri-lanka", "usa"
  ]) {
    assert.match(serialized, new RegExp(`geospatial\\.data/${prefix}/\\*`));
  }
  assert.match(serialized, /DenyObjectReadOutsideReviewedPrefixes/);
  assert.match(serialized, /s3:ListBucketVersions/);
  assert.match(serialized, /s3:GetObjectVersion/);
  assert.doesNotMatch(serialized, /PutObject|DeleteObject|CreateBucket|PutBucket/);
});

test("production trust requires exact verifier principal and external ID", () => {
  const policy = readJson("opengeo-production-dataset-reader-trust-policy.template.json");
  const statement = policy.Statement[0];
  assert.equal(
    statement.Principal.AWS,
    "arn:aws:iam::222222222222:role/opengeo/dev/OpenGeoDevDatasetConnectionVerifierRole"
  );
  assert.equal(statement.Condition.StringEquals["sts:ExternalId"], "OPEN_GEO_EXTERNAL_ID");
});

test("dedicated Cognito client is a public PKCE-compatible code client", () => {
  const client = readJson("opengeo-dev-cognito-client.json");
  assert.equal(client.GenerateSecret, false);
  assert.deepEqual(client.AllowedOAuthFlows, ["code"]);
  assert.deepEqual(client.ExplicitAuthFlows, ["ALLOW_REFRESH_TOKEN_AUTH"]);
  assert.deepEqual(client.AllowedOAuthScopes.sort(), ["email", "openid", "profile"]);
  assert.deepEqual(client.SupportedIdentityProviders, ["COGNITO"]);
  assert.ok(client.CallbackURLs.includes("https://d27oi53tjzmbe8.cloudfront.net/login"));
  assert.ok(client.CallbackURLs.includes("http://127.0.0.1:3000/login"));
  assert.equal(client.PreventUserExistenceErrors, "ENABLED");
  assert.equal(client.EnableTokenRevocation, true);
});

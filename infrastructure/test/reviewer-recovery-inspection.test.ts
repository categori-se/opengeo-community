import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {describe, it} from "node:test";

const bytes = readFileSync(new URL("../bootstrap/opengeo-production-reviewer-recovery-inspection-policy.json", import.meta.url));
const policy = JSON.parse(bytes.toString());

describe("proposed reviewer recovery inspection", () => {
  it("permits only exact-pool reads and verification of the existing operator", () => {
    assert.equal(policy.Version, "2012-10-17");
    assert.equal(policy.Statement.length, 3);
    const [boundary, role, pool] = policy.Statement;
    assert.equal(boundary.Effect, "Deny");
    assert.equal(boundary.Resource, "*");
    assert.equal(role.Effect, "Allow");
    assert.equal(role.Resource, "arn:aws:iam::111111111111:role/OpenGeoProductionOperatorRole");
    assert.deepEqual(role.Action, ["iam:GetRole", "iam:ListRolePolicies", "iam:GetRolePolicy", "iam:ListAttachedRolePolicies"]);
    assert.equal(pool.Effect, "Allow");
    assert.equal(pool.Resource, "arn:aws:cognito-idp:us-east-1:111111111111:userpool/us-east-1_KXUwaZnuQ");
    assert.deepEqual(pool.Action, ["cognito-idp:ListUsers", "cognito-idp:AdminGetUser", "cognito-idp:DescribeUserPool", "cognito-idp:DescribeUserPoolClient"]);
    assert.deepEqual(boundary.NotAction, ["sts:GetCallerIdentity", ...role.Action, ...pool.Action]);
    assert.ok(bytes.length < 6144);
  });

  it("pins reviewed bytes and does not equate inspection with recovery or authorization", () => {
    const contract = readFileSync(new URL("../../docs/reviewer-password-recovery-inspection.md", import.meta.url), "utf8");
    assert.ok(contract.includes(createHash("sha256").update(bytes).digest("hex")));
    assert.match(contract, /not authorized or attached/);
    assert.match(contract, /IAM scopes these actions to the pool, not an individual email or client/);
    assert.match(contract, /success message alone is not delivery evidence/);
    assert.match(contract, /does not authorize account creation/);
    assert.match(contract, /Verify original permissions after detachment/);
  });
});

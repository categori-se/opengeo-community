import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {describe, it} from "node:test";

const policy = JSON.parse(readFileSync(new URL("../bootstrap/opengeo-production-managed-demo-pilot-release-policy.json", import.meta.url), "utf8"));
const statements: any[] = policy.Statement;
const get = (sid: string) => {
  const matches = statements.filter((entry) => entry.Sid === sid);
  assert.equal(matches.length, 1);
  return matches[0];
};
const array = (value: string | string[]) => Array.isArray(value) ? value : [value];

describe("proposed temporary demo pilot operator policy", () => {
  it("prepares a separate exact-resource verification supplement with no writes or queue reads", () => {
    const verification = JSON.parse(readFileSync(new URL("../bootstrap/opengeo-production-demo-api-verification-policy.json", import.meta.url), "utf8"));
    assert.deepEqual(verification, {
      Version: "2012-10-17",
      Statement: [
        {Sid: "ReadExactDemoInvocationPolicy", Effect: "Allow", Action: "lambda:GetPolicy",
          Resource: "arn:aws:lambda:us-east-1:111111111111:function:opengeo-demo-api"},
        {Sid: "ReadExactDemoApiIntegration", Effect: "Allow", Action: "apigateway:GET",
          Resource: "arn:aws:apigateway:us-east-1::/apis/kbqcyelp3h/integrations/a74m9ko"}
      ]
    });
    assert.ok(JSON.stringify(verification).length <= 6144);
    assert.ok(verification.Statement.every((s: any) => !s.Resource.includes("*") && !s.Action.includes("*")));
  });

  it("fits one managed policy and never grants unrestricted write actions", () => {
    assert.ok(JSON.stringify(policy).length <= 6144);
    assert.equal(policy.Version, "2012-10-17");
    assert.equal(new Set(statements.map(({Sid}) => Sid)).size, statements.length);
    const globalReadActions = new Set([
      "ecr:GetAuthorizationToken", "rds:DescribeDBClusters", "rds:DescribeDBInstances",
      "ec2:DescribeVpcEndpoints", "ec2:DescribeNetworkInterfaces", "ecs:ListTasks",
      "ecs:DescribeTasks", "ecs:DescribeServices", "cloudformation:ListImports"
    ]);
    for (const statement of statements.filter(({Effect}) => Effect === "Allow")) {
      for (const action of array(statement.Action)) {
        assert.ok(!action.includes("*"), `Wildcard action: ${action}`);
        if (array(statement.Resource).includes("*")) assert.ok(globalReadActions.has(action), `Unscoped write: ${action}`);
        assert.ok(!/^(route53|cognito-idp|s3|cloudfront):/.test(action), "This policy is backend-only; demo static release has its own existing checked policy");
        if (action.startsWith("iam:")) assert.ok(["iam:PassRole", "iam:GetRole", "iam:ListRolePolicies", "iam:GetRolePolicy", "iam:ListAttachedRolePolicies"].includes(action));
      }
    }
  });

  it("cannot chain into broader deployment roles or use standing primary static authority", () => {
    assert.deepEqual(get("NoRoleChaining"), {Sid: "NoRoleChaining", Effect: "Deny", Action: "sts:AssumeRole", Resource: "*"});
    const protection = get("ProtectPrimary");
    assert.equal(protection.Effect, "Deny");
    assert.equal(protection.Action, "*");
    assert.ok(protection.Resource.includes("arn:aws:s3:::studio.opengeo.tools/*"));
    assert.ok(protection.Resource.includes("arn:aws:cloudfront::111111111111:distribution/E2GPOVS3D9R9NX"));
    assert.ok(protection.Resource.includes("arn:aws:cloudformation:us-east-1:111111111111:stack/OpenGeo-production-StudioWeb/*"));
    assert.deepEqual(get("PassCfnRole").Condition, {StringEquals: {"iam:PassedToService": "cloudformation.amazonaws.com"}});
  });

  it("limits stack operations to the demo and deletion to its two activation stacks", () => {
    const expected = ["Foundation", "Api", "Worker", "PrivateRuntimeEndpoints"].map((name) => `arn:aws:cloudformation:us-east-1:111111111111:stack/OpenGeo-demo-${name}/*`);
    assert.deepEqual(get("StackOps").Resource, expected);
    assert.deepEqual(get("CreateChangeSets").Resource, expected);
    assert.deepEqual(get("ExecuteChangeSets").Resource, expected);
    assert.deepEqual(get("RemoveRuntime").Resource, expected.slice(2));
    assert.equal(get("RemoveRuntime").Action, "cloudformation:DeleteStack");
    assert.equal(get("CreateChangeSets").Condition.StringEquals["cloudformation:RoleArn"], get("PassCfnRole").Resource);
    assert.equal(get("ExecuteChangeSets").Condition.StringLike["cloudformation:ChangeSetName"], "opengeo-demo-pilot-*");
  });

  it("confines migration authority to the exact demo database and its three credentials", () => {
    assert.equal(get("DemoTransactions").Resource, "arn:aws:rds:us-east-1:111111111111:cluster:opengeo-demo-foundation-databaseb269d8bb-yx9lmupzvqwr");
    assert.equal(get("DemoSecrets").Resource.length, 3);
    assert.deepEqual(get("DecryptSecrets").Condition.StringEquals["kms:EncryptionContext:SecretARN"], get("DemoSecrets").Resource);
    assert.equal(get("DecryptSecrets").Condition.StringEquals["kms:ViaService"], "secretsmanager.us-east-1.amazonaws.com");
    assert.equal(get("ReadQueues").Resource.length, 2);
    for (const arn of get("ReadQueues").Resource) assert.ok(!arn.includes("*") && arn.includes("OpenGeo-demo-Foundation-Processing"));
    assert.deepEqual(get("DemoImages").Resource, ["api", "gis-worker"].map((name) => `arn:aws:ecr:us-east-1:111111111111:repository/opengeo/demo/${name}`));
  });
});

import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {App, Stack} from "aws-cdk-lib";
import {CfnInclude} from "aws-cdk-lib/cloudformation-include";
import {describe, it} from "node:test";

const bootstrapRoot = new URL("../bootstrap/", import.meta.url);
const templateFile = fileURLToPath(new URL("opengeo-dev-cdk-bootstrap.yaml", bootstrapRoot));

function policy(name: string) {
  return JSON.parse(readFileSync(new URL(name, bootstrapRoot), "utf8"));
}

function includedTemplate() {
  const app = new App();
  const stack = new Stack(app, "ScopedBootstrapFixture", {
    env: {account: "222222222222", region: "us-east-1"}
  });
  new CfnInclude(stack, "Template", {templateFile, preserveLogicalIds: true});
  return app.synth().getStackArtifact(stack.artifactId).template;
}

describe("scoped OpenGeo development CDK bootstrap", () => {
  it("creates four named fail-closed roles without administrator policy", () => {
    const template = includedTemplate();
    const roles = Object.values(template.Resources).filter(
      (resource: any) => resource.Type === "AWS::IAM::Role"
    ) as any[];
    assert.equal(roles.length, 4);
    assert.deepEqual(
      roles.map((resource) => resource.Properties.RoleName).sort(),
      [
        "cdk-hnb659fds-cfn-exec-role-222222222222-us-east-1",
        "cdk-hnb659fds-deploy-role-222222222222-us-east-1",
        "cdk-hnb659fds-file-publishing-role-222222222222-us-east-1",
        "cdk-hnb659fds-lookup-role-222222222222-us-east-1"
      ]
    );
    for (const resource of roles) {
      assert.equal(resource.Properties.ManagedPolicyArns, undefined);
      assert.doesNotMatch(JSON.stringify(resource), /AdministratorAccess|Action":"\*"/);
    }
    assert.equal(template.Resources.CloudFormationExecutionRole.Properties.Policies, undefined);
  });

  it("trusts only the OpenGeo operator or CloudFormation for their exact purpose", () => {
    const template = includedTemplate();
    for (const logicalId of ["FilePublishingRole", "DeploymentActionRole", "LookupRole"]) {
      const trust = template.Resources[logicalId].Properties.AssumeRolePolicyDocument;
      assert.deepEqual(trust.Statement[0].Principal, {
        AWS: "arn:aws:iam::222222222222:role/opengeo/dev/OpenGeoDevOperatorRole"
      });
      assert.deepEqual(trust.Statement[0].Action, ["sts:AssumeRole", "sts:TagSession"]);
    }
    assert.deepEqual(
      template.Resources.CloudFormationExecutionRole.Properties.AssumeRolePolicyDocument.Statement[0].Principal,
      {Service: "cloudformation.amazonaws.com"}
    );
  });

  it("limits assets, stacks, pass-role authority, and secret lookup", () => {
    const templateText = JSON.stringify(includedTemplate());
    assert.match(templateText, /cdk-hnb659fds-assets-222222222222-us-east-1/);
    assert.ok(templateText.includes("stack/OpenGeo-dev-*/*"));
    assert.match(templateText, /OpenGeoDevApiCloudFormationRole/);
    assert.match(templateText, /OpenGeoDevBuildCloudFormationRole/);
    assert.match(templateText, /OpenGeoDevPlatformCloudFormationRole/);
    assert.match(templateText, /OpenGeoDevWebCloudFormationRole/);
    assert.match(templateText, /DenySecretMaterial/);
    assert.match(templateText, /ReadOpenGeoDevelopmentStacks/);
    assert.match(templateText, /cloudformation:DescribeStacks/);
    assert.doesNotMatch(templateText, /arn:aws:cloudformation:[^\"]+:222222222222:stack\/\*/);
  });

  it("updates the existing service roles only for the exact bootstrap roles", () => {
    const operator = policy("opengeo-dev-operator-policy.json");
    const platform = policy("opengeo-dev-platform-cloudformation-policy.json");
    const operatorStatement = operator.Statement.find(
      (statement: any) => statement.Sid === "AssumeScopedCdkPublishingAndDeploymentRoles"
    );
    const platformStatement = platform.Statement.find(
      (statement: any) => statement.Sid === "ManageScopedCdkBootstrapRoles"
    );
    assert.deepEqual(operatorStatement.Action, ["sts:AssumeRole", "sts:TagSession"]);
    assert.equal(operatorStatement.Resource.length, 3);
    assert.equal(platformStatement.Resource.length, 4);
    for (const resource of [...operatorStatement.Resource, ...platformStatement.Resource]) {
      assert.match(resource, /^arn:aws:iam::222222222222:role\/cdk-hnb659fds-/);
      assert.doesNotMatch(resource, /\*/);
    }
    assert.doesNotMatch(JSON.stringify(platformStatement.Action), /AttachRolePolicy/);
  });
});

import assert from "node:assert/strict";
import {test} from "node:test";
import {App, aws_lambda as lambda, aws_sqs as sqs} from "aws-cdk-lib";
import {Template} from "aws-cdk-lib/assertions";
import {environmentConfig, SHARED_AUTH_ACCOUNT_ID} from "../lib/config.js";
import {PlatformFoundationStack} from "../lib/platform-foundation-stack.js";
import {ServerlessApiStack} from "../lib/serverless-api-stack.js";

function prepare({enabled = false, withFunction = true, catalog = false, withQueue = true} = {}) {
  const app = new App(), env = {account: SHARED_AUTH_ACCOUNT_ID, region: "us-east-1"};
  const config = environmentConfig("dev", "http://localhost:3000");
  const foundation = new PlatformFoundationStack(app, "Foundation", {config, budgetAlertEmail: "ci@example.invalid", env});
  const connector = withFunction
    ? lambda.Function.fromFunctionName(foundation, "Connector", "opengeo-dev-connection-verifier") : undefined;
  const api = new ServerlessApiStack(app, "Api", {config, foundation, env,
    imageDigest: `sha256:${"d".repeat(64)}`, observableBuilderImageDigest: `sha256:${"c".repeat(64)}`,
    enablePostgisPreview: enabled, enableConnectionCatalogDiscovery: catalog,
    ...(connector ? {connectionVerificationFunction: connector} : {}),
    ...(withQueue ? {connectionVerificationQueue: sqs.Queue.fromQueueArn(foundation, "ConnectorQueue", `arn:aws:sqs:us-east-1:${SHARED_AUTH_ACCOUNT_ID}:connector`)} : {})});
  return {template: Template.fromStack(api),
    connectorName: connector ? api.resolve(connector.functionName) : undefined,
    connectorResources: connector ? [api.resolve(connector.functionArn), api.resolve(`${connector.functionArn}:*`)] : []};
}

test("PostGIS preview defaults off and enabling grants only the existing exact connector", () => {
  const disabled = prepare(), enabled = prepare({enabled: true, catalog: true});
  const environment = (template: Template) => Object.values(template.findResources("AWS::Lambda::Function"))
    .map((resource: any) => resource.Properties.Environment.Variables);
  assert.equal(environment(disabled.template).some(value => value.OPEN_GEO_CONNECTION_POSTGIS_PREVIEW_ENABLED), false);
  assert.equal(JSON.stringify(disabled.template.findResources("AWS::IAM::Policy")).includes("lambda:InvokeFunction"), false);
  const enabledEnvironment = environment(enabled.template).find(value => value.OPEN_GEO_CONNECTION_POSTGIS_PREVIEW_ENABLED === "true");
  assert.ok(enabledEnvironment);
  assert.equal(enabledEnvironment.OPEN_GEO_CONNECTION_CATALOG_DISCOVERY_ENABLED, "true");
  // Imported Lambda names may remain CloudFormation expressions. Compare the
  // resolved exact target, rather than assuming CDK emits a literal name.
  assert.deepEqual(enabledEnvironment.OPEN_GEO_CONNECTION_VERIFICATION_FUNCTION_NAME, enabled.connectorName);
  const statements = Object.values(enabled.template.findResources("AWS::IAM::Policy"))
    .flatMap((resource: any) => resource.Properties.PolicyDocument.Statement)
    .filter(statement => [statement.Action].flat().includes("lambda:InvokeFunction"));
  assert.equal(statements.length, 1);
  assert.deepEqual(statements[0].Resource, enabled.connectorResources);
  assert.match(JSON.stringify(statements[0].Resource), /opengeo-dev-connection-verifier/);
  assert.doesNotMatch(JSON.stringify(statements[0].Resource), /function:\*/);
  assert.equal(Object.keys(enabled.template.findResources("AWS::Lambda::Function")).length,
    Object.keys(disabled.template.findResources("AWS::Lambda::Function")).length);
});

test("enabling a connector capability without its existing target fails configuration", () => {
  assert.throws(() => prepare({enabled: true, withFunction: false}), /existing connection verifier function/);
  assert.throws(() => prepare({catalog: true, withQueue: false}), /existing verifier queue/);
});

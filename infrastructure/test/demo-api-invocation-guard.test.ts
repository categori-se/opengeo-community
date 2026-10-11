import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {validateDemoApiInvocation, validateDemoApiInvocationContinuation} from "../lib/demo-api-invocation-guard.js";

const digest = "sha256:6edbdcf9e58526fa69b2ce27acf167b0d71550d799ecbb22d7bd2ccba433db45";
const functionArn = "arn:aws:lambda:us-east-1:111111111111:function:opengeo-demo-api";
function snapshots() {
  const statement = {Sid: "retained-permission", Effect: "Allow", Principal: {Service: "apigateway.amazonaws.com"}, Action: "lambda:InvokeFunction", Resource: functionArn,
    Condition: {ArnLike: {"AWS:SourceArn": "arn:aws:execute-api:us-east-1:111111111111:kbqcyelp3h/*/*"}}};
  return {
    fn: {Configuration: {FunctionName: "opengeo-demo-api", FunctionArn: functionArn, PackageType: "Image", Architectures: ["arm64"], State: "Active", LastUpdateStatus: "Successful"}, Code: {ResolvedImageUri: `111111111111.dkr.ecr.us-east-1.amazonaws.com/opengeo/demo/api@${digest}`}},
    integration: {IntegrationId: "a74m9ko", IntegrationType: "AWS_PROXY", IntegrationUri: functionArn, PayloadFormatVersion: "2.0", ConnectionType: "INTERNET", IntegrationMethod: "POST", TimeoutInMillis: 30000},
    policy: {Policy: JSON.stringify({Version: "2012-10-17", Statement: [statement]}), RevisionId: "revision-1"}, digest
  };
}
describe("demo API invocation boundary", () => {
  it("accepts the exact configured target and unchanged invocation authority after permission replacement", () => {
    const before = snapshots();
    before.digest = "sha256:0fb6456cbdf5fa78667001a4e721c45694e703a13fba53c5c976a7e04ed5b00d";
    before.fn.Code.ResolvedImageUri = `111111111111.dkr.ecr.us-east-1.amazonaws.com/opengeo/demo/api@${before.digest}`;
    const after = snapshots();
    const document = JSON.parse(after.policy.Policy);
    document.Statement[0].Sid = "replacement-permission";
    after.policy = {Policy: JSON.stringify(document), RevisionId: "revision-2"};
    assert.equal(validateDemoApiInvocationContinuation(before, after).apiId, "kbqcyelp3h");
  });
  it("rejects wrong function, image, readiness, architecture and integration targets", () => {
    const mutations = [
      (s: any) => {s.fn.Configuration.FunctionArn += ":alias";},
      (s: any) => {s.fn.Code.ResolvedImageUri = "other";},
      (s: any) => {s.fn.Configuration.State = "Pending";},
      (s: any) => {s.fn.Configuration.LastUpdateStatus = "InProgress";},
      (s: any) => {s.fn.Configuration.Architectures = ["x86_64"];},
      (s: any) => {s.integration.IntegrationId = "other";},
      (s: any) => {s.integration.IntegrationUri += ":alias";},
      (s: any) => {s.integration.PayloadFormatVersion = "1.0";},
      (s: any) => {s.integration.CredentialsArn = "arn:aws:iam::111111111111:role/other";}
    ];
    for (const mutate of mutations) {
      const s = snapshots(); mutate(s);
      assert.throws(() => validateDemoApiInvocation(s.fn, s.integration, s.policy, s.digest));
    }
  });
  it("rejects broadened invocation grants, extra statements and missing policy observations", () => {
    for (const mutate of [
      (p: any) => {p.Statement[0].Principal = "*";},
      (p: any) => {p.Statement[0].Action = "lambda:*";},
      (p: any) => {p.Statement[0].Resource += ":*";},
      (p: any) => {delete p.Statement[0].Condition;},
      (p: any) => {p.Statement[0].Condition.ArnLike["AWS:SourceArn"] = "arn:aws:execute-api:us-east-1:111111111111:*/*/*";},
      (p: any) => {p.Statement.push(structuredClone(p.Statement[0]));},
      (p: any) => {p.Statement[0].NotPrincipal = {AWS: "other"};}
    ]) {
      const s = snapshots(); const p = JSON.parse(s.policy.Policy); mutate(p); s.policy.Policy = JSON.stringify(p);
      assert.throws(() => validateDemoApiInvocation(s.fn, s.integration, s.policy, s.digest));
    }
    const s = snapshots();
    assert.throws(() => validateDemoApiInvocation(s.fn, s.integration, {}, s.digest));
  });
  it("rejects unrelated integration drift even when both targets still match", () => {
    const before = snapshots(); const after = snapshots(); after.integration.TimeoutInMillis = 29000;
    assert.throws(() => validateDemoApiInvocationContinuation(before, after), /configuration changed/);
  });
});

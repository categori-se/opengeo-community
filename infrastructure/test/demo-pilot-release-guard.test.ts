import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, it} from "node:test";
import {
  canonicalJson, sha256, templateBody, validateDemoStackIdentity, validateApiDigest,
  prepareFoundationTemplate, prepareApiTemplate, validateTemplateDelta,
  readReviewedMigrations, validateMigrationLedger, validateChangeSet, releaseContractSha256
} from "../lib/demo-pilot-release-guard.js";

const contract = JSON.parse(readFileSync(new URL("../bootstrap/opengeo-demo-pilot-release-contract.json", import.meta.url), "utf8"));
const repository = fileURLToPath(new URL("../../", import.meta.url));
const digest = `sha256:${sha256("test-only image; not an approved release")}`;
const observed = JSON.parse(readFileSync(new URL("../../docs/opengeo-demo-backend-renewal-20260907-evidence.json", import.meta.url), "utf8")).api.observedChanges;

function observedChangeSet(): any {
  return {...changeSet("Api"), Changes: structuredClone(observed)};
}

function foundationPair(): [any, any] {
  const live = {
    Resources: {Database: {Type: "AWS::RDS::DBCluster", Properties: {DeletionProtection: true}}},
    Outputs: {Existing: {Value: "unchanged"}}, Metadata: {Existing: "retain exactly"}
  };
  const candidate = structuredClone(live);
  Object.assign(candidate.Outputs, structuredClone(contract.foundationOutputs));
  return [live, candidate];
}

function apiPair(): [any, any] {
  const live = {Resources: {...Object.fromEntries(Object.entries(contract.apiDependentResources).map(([id, rule]: [string, any]) => [id, structuredClone(rule.definition)])), [contract.apiFunction]: {
    Type: "AWS::Lambda::Function", Properties: {
      Code: {ImageUri: {"Fn::Join": ["", ["repository", "@old"]]}},
      Environment: {Variables: {OPTIONAL_FETCH_ENABLED: "false"}}, Architectures: ["arm64"], FunctionName: contract.apiFunctionName
    }
  }}, Parameters: {Existing: {Type: "String"}}, Metadata: {Existing: "retained"}};
  const candidate: any = structuredClone(live);
  candidate.Resources[contract.apiFunction].Properties.Code.ImageUri = `${contract.apiRepository}@${digest}`;
  return [live, candidate];
}

function stack(kind: string): any {
  return {
    StackName: `OpenGeo-demo-${kind}`,
    StackId: `arn:aws:cloudformation:us-east-1:111111111111:stack/OpenGeo-demo-${kind}/test-stack-id`,
    StackStatus: "UPDATE_COMPLETE",
    RoleARN: "arn:aws:iam::111111111111:role/cdk-hnb659fds-cfn-exec-role-111111111111-us-east-1",
    Parameters: [{ParameterKey: "BootstrapVersion", ParameterValue: "/cdk/hnb659fds/version", ResolvedValue: "32"}],
    Tags: [{Key: "environment", Value: "demo"}],
    NotificationARNs: [], RollbackConfiguration: {}
  };
}

function changeSet(kind: string): any {
  const target = stack(kind);
  return {
    StackId: target.StackId, StackName: target.StackName,
    ChangeSetId: "arn:aws:cloudformation:us-east-1:111111111111:changeSet/opengeo-demo-pilot-test/test-change-id",
    Status: "CREATE_COMPLETE", ExecutionStatus: "AVAILABLE",
    Parameters: target.Parameters, Tags: target.Tags,
    Changes: kind === "Foundation" ? [] : [{Type: "Resource", ResourceChange: {
      LogicalResourceId: contract.apiFunction, ResourceType: "AWS::Lambda::Function",
      Action: "Modify", Replacement: "False", Scope: ["Properties"],
      Details: [{Target: {Attribute: "Properties", Name: "Code", RequiresRecreation: "Never", Path: "/Properties/Code/ImageUri"}, Evaluation: "Static", ChangeSource: "DirectModification"}]
    }}]
  };
}

describe("demo pilot release boundary", () => {
  it("accepts the recorded dependency closure in either order for forward and rollback candidates", () => {
    const [retained, forward] = apiPair();
    for (const reviewed of [retained, forward]) {
      const change = observedChangeSet();
      validateChangeSet("Api", stack("Api"), change, reviewed, structuredClone(reviewed));
      change.Changes.reverse();
      validateChangeSet("Api", stack("Api"), change, reviewed, structuredClone(reviewed));
    }
    const permission = observed.find((entry: any) => entry.ResourceChange.ResourceType === "AWS::Lambda::Permission");
    assert.equal(permission.ResourceChange.Replacement, "Conditional");
    assert.equal(permission.ResourceChange.Details[0].Target.RequiresRecreation, "Always");
  });

  it("pins complete dependency definitions even when a caller supplies the same altered candidate twice", () => {
    const ids = Object.keys(contract.apiDependentResources);
    assert.deepEqual(ids.sort(), ["HttpApiDefaultRouteDefaultIntegrationD8350D02", "HttpApiDefaultRouteDefaultIntegrationPermission2EF7CBF0"].sort());
    const integration = ids.find((id) => contract.apiDependentResources[id].definition.Type === "AWS::ApiGatewayV2::Integration")!;
    const permission = ids.find((id) => contract.apiDependentResources[id].definition.Type === "AWS::Lambda::Permission")!;
    for (const mutate of [
      (t: any) => {t.Resources[permission].Properties.Principal = "*";},
      (t: any) => {t.Resources[permission].Properties.Action = "lambda:*";},
      (t: any) => {t.Resources[permission].Properties.SourceArn = "*";},
      (t: any) => {t.Resources[permission].Properties.FunctionName = "other";},
      (t: any) => {t.Resources[integration].Properties.IntegrationUri = "other";},
      (t: any) => {t.Resources[integration].Properties.ApiId = "other";},
      (t: any) => {t.Resources[integration].Metadata = {};},
      (t: any) => {t.Resources[contract.apiFunction].Properties.FunctionName = "other";},
      (t: any) => {delete t.Resources[permission];}
    ]) {
      const changed = apiPair()[1]; mutate(changed);
      assert.throws(() => validateChangeSet("Api", stack("Api"), observedChangeSet(), changed, changed));
    }
  });

  it("rejects missing, duplicate and extra resources rather than trusting the count", () => {
    const reviewed = apiPair()[1];
    for (const mutate of [
      (c: any) => {c.Changes.pop();},
      (c: any) => {c.Changes.shift();},
      (c: any) => {c.Changes[2] = structuredClone(c.Changes[1]);},
      (c: any) => {c.Changes.push(structuredClone(c.Changes[1]));},
      (c: any) => {c.Changes[1].ResourceChange.LogicalResourceId = "ApiRole";},
      (c: any) => {c.Changes = [c.Changes[2]];}
    ]) {
      const change = observedChangeSet(); mutate(change);
      assert.throws(() => validateChangeSet("Api", stack("Api"), change, reviewed, reviewed));
    }
  });

  it("rejects every unreviewed dependency cause, property, replacement and metadata expansion", () => {
    const reviewed = apiPair()[1];
    for (const index of [1, 2]) {
      for (const mutate of [
        (r: any) => {r.Action = "Add";},
        (r: any) => {r.Action = "Remove";},
        (r: any) => {r.Replacement = "True";},
        (r: any) => {r.ResourceType = "AWS::IAM::Role";},
        (r: any) => {r.Scope.push("Tags");},
        (r: any) => {r.PolicyAction = "ReplaceAndDelete";},
        (r: any) => {r.Details[0].Evaluation = "Static";},
        (r: any) => {r.Details[0].ChangeSource = "DirectModification";},
        (r: any) => {r.Details[0].CausingEntity = "OtherFunction.Arn";},
        (r: any) => {r.Details[0].CausingEntity = "ApiFunctionCE271BD4.Role";},
        (r: any) => {delete r.Details[0].CausingEntity;},
        (r: any) => {r.Details[0].Target.Name = "Principal";},
        (r: any) => {r.Details[0].Target.Path = "/Properties/SourceArn";},
        (r: any) => {r.Details[0].Target.Path = "";},
        (r: any) => {r.Details[0].Target.RequiresRecreation = "Conditional";},
        (r: any) => {r.Details.push(structuredClone(r.Details[0]));},
        (r: any) => {r.Details = [];}
      ]) {
        const change = observedChangeSet(); mutate(change.Changes[index].ResourceChange);
        assert.throws(() => validateChangeSet("Api", stack("Api"), change, reviewed, reviewed));
      }
    }
    for (const mutate of [
      (c: any) => {c.Changes[0].ResourceChange.Replacement = "Conditional";},
      (c: any) => {c.Changes[0].ResourceChange.PhysicalResourceId = "opengeo-production-api";},
      (c: any) => {c.Changes[0].ResourceChange.Details[0].Evaluation = "Dynamic";},
      (c: any) => {c.Changes[0].ResourceChange.Details[0].CausingEntity = "Other.Arn";},
      (c: any) => {c.Changes[1].ResourceChange.Replacement = "Conditional";},
      (c: any) => {c.Changes[2].ResourceChange.Replacement = "False";},
      (c: any) => {c.NextToken = "more";},
      (c: any) => {c.IncludeNestedStacks = true;},
      (c: any) => {c.ImportExistingResources = true;}
    ]) {
      const change = observedChangeSet(); mutate(change);
      assert.throws(() => validateChangeSet("Api", stack("Api"), change, reviewed, reviewed));
    }
  });

  it("pins complete reviewed template hashes and exactly 13 export definitions", () => {
    assert.equal(releaseContractSha256, sha256(readFileSync(new URL("../bootstrap/opengeo-demo-pilot-release-contract.json", import.meta.url))));
    assert.equal(Object.keys(contract.foundationOutputs).length, 13);
    for (const [name, output] of Object.entries(contract.foundationOutputs) as [string, any][]) {
      assert.equal(output.Export.Name, `OpenGeo-demo-Foundation:${name}`);
      assert.ok(output.Value.Ref || output.Value["Fn::GetAtt"]);
    }
    assert.match(contract.foundationTemplateSha256, /^[a-f0-9]{64}$/);
    assert.match(contract.apiTemplateSha256, /^[a-f0-9]{64}$/);
    assert.throws(() => prepareFoundationTemplate(foundationPair()[0]), /changed since review/);
    assert.throws(() => prepareApiTemplate(apiPair()[0], digest), /changed since review/);
    assert.throws(() => templateBody({TemplateBody: "unparsed YAML"}), /JSON TemplateBody/);
    assert.equal(canonicalJson({b: 1, a: {d: 2, c: 3}}), canonicalJson({a: {c: 3, d: 2}, b: 1}));
  });

  it("accepts only stable demo stacks in the reviewed account and execution role", () => {
    for (const kind of ["Foundation", "Api"] as const) validateDemoStackIdentity(kind, stack(kind));
    for (const mutation of [
      {StackName: "OpenGeo-production-Api"},
      {StackId: stack("Api").StackId.replace("111111111111", "222222222222")},
      {StackId: stack("Api").StackId.replace("us-east-1", "us-west-2")},
      {StackStatus: "UPDATE_IN_PROGRESS"}, {StackStatus: "UPDATE_ROLLBACK_COMPLETE"},
      {RoleARN: "arn:aws:iam::111111111111:role/Admin"}
    ]) assert.throws(() => validateDemoStackIdentity("Api", {...stack("Api"), ...mutation}));
  });

  it("allows precisely the reviewed outputs without dropping any other template field", () => {
    const [live, candidate] = foundationPair();
    validateTemplateDelta("Foundation", live, candidate);
    const name = Object.keys(contract.foundationOutputs)[0]!;
    const mutations = [
      (value: any) => {value.Outputs[name].Value = "another-resource";},
      (value: any) => {value.Outputs.Extra = {Value: "not-reviewed"};},
      (value: any) => {delete value.Outputs[name];},
      (value: any) => {value.Outputs.Existing.Value = "changed";},
      (value: any) => {value.Resources.Database.Properties.DeletionProtection = false;},
      (value: any) => {value.Resources.Extra = {Type: "AWS::EC2::NatGateway"};},
      (value: any) => {delete value.Metadata;},
      (value: any) => {value.Transform = "AWS::Include";}
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(candidate); mutate(changed);
      assert.throws(() => validateTemplateDelta("Foundation", live, changed));
    }
    assert.throws(() => validateTemplateDelta("Foundation", candidate, candidate), /no longer new/);
  });

  it("allows only the reviewed API repository and image property", () => {
    const [live, candidate] = apiPair();
    validateTemplateDelta("Api", live, candidate, digest);
    for (const invalid of ["latest", "sha256:abcd", `sha256:${"c".repeat(64)}`, `${digest.toUpperCase()}`, `${contract.apiRepository}@${digest}`]) {
      assert.throws(() => validateApiDigest(invalid));
    }
    for (const mutate of [
      (value: any) => {value.Resources[contract.apiFunction].Properties.Environment.Variables.OPTIONAL_FETCH_ENABLED = "true";},
      (value: any) => {value.Resources[contract.apiFunction].Properties.Architectures = ["x86_64"];},
      (value: any) => {value.Resources[contract.apiFunction].Properties.Code.ImageUri = `other-repository@${digest}`;},
      (value: any) => {value.Resources[contract.apiFunction].Properties.Role = "broader-role";},
      (value: any) => {value.Metadata.Existing = "changed";},
      (value: any) => {delete value.Parameters;}
    ]) {
      const changed = structuredClone(candidate); mutate(changed);
      assert.throws(() => validateTemplateDelta("Api", live, changed, digest));
    }
  });

  it("verifies source bytes and resumes only a matching contiguous 0063–0082 ledger", () => {
    const migrations = readReviewedMigrations(repository);
    const ledger = migrations.map(({name, sha256}) => ({migration_name: name, sha256}));
    assert.equal(validateMigrationLedger(ledger.slice(0, 63), migrations).length, 19);
    assert.equal(validateMigrationLedger(ledger.slice(0, 70), migrations).length, 12);
    assert.deepEqual(validateMigrationLedger(ledger, migrations), []);
    for (const invalid of [[], ledger.slice(0, 60), ledger.slice(1), [...ledger, ledger[81]!], [...ledger].reverse()]) {
      assert.throws(() => validateMigrationLedger(invalid, migrations));
    }
    const tampered = structuredClone(ledger.slice(0, 63));
    tampered[62]!.sha256 = "0".repeat(64);
    assert.throws(() => validateMigrationLedger(tampered, migrations));
    assert.throws(() => validateMigrationLedger(ledger.slice(0, 63), migrations.slice(0, 81)));
  });

  it("checks both the exact change-set template and the AWS resource-change inventory", () => {
    for (const kind of ["Foundation", "Api"] as const) {
      const reviewed = kind === "Api" ? apiPair()[1] : foundationPair()[1];
      validateChangeSet(kind, stack(kind), changeSet(kind), reviewed, structuredClone(reviewed));
      for (const mutation of [
        {StackId: "another-stack"}, {Status: "FAILED"}, {ExecutionStatus: "OBSOLETE"},
        {NextToken: "second-page"}, {IncludeNestedStacks: true}, {ImportExistingResources: true},
        {DeploymentMode: "REVERT_DRIFT"}, {ChangeSetId: "another-change-set"},
        {Parameters: []}, {Tags: []}, {NotificationARNs: ["another-topic"]},
        {RollbackConfiguration: {MonitoringTimeInMinutes: 10}}
      ]) assert.throws(() => validateChangeSet(kind, stack(kind), {...changeSet(kind), ...mutation}, reviewed, reviewed));
      assert.throws(() => validateChangeSet(kind, stack(kind), changeSet(kind), reviewed, {...reviewed, Metadata: {tampered: true}}));
    }
    const reviewed = apiPair()[1];
    for (const mutation of [
      {Action: "Add"}, {LogicalResourceId: "ApiRole"}, {Replacement: "True"},
      {Scope: ["Properties", "Tags"]}, {Details: []},
      {Details: [{Target: {Attribute: "Properties", Name: "Environment", RequiresRecreation: "Never"}}]}
    ]) {
      const change = changeSet("Api");
      Object.assign(change.Changes[0].ResourceChange, mutation);
      assert.throws(() => validateChangeSet("Api", stack("Api"), change, reviewed, reviewed));
    }
    assert.throws(() => validateChangeSet("Foundation", stack("Foundation"), {...changeSet("Foundation"), Changes: changeSet("Api").Changes}, foundationPair()[1], foundationPair()[1]));
  });
});

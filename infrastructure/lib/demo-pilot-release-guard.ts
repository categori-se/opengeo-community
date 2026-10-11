import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync, readdirSync} from "node:fs";
import {join} from "node:path";

type JsonObject = Record<string, any>;
type Migration = {name: string; sha256: string};
type LedgerEntry = {migration_name: string; sha256: string};
type StackKind = "Foundation" | "Api";

// This reviewed contract is fixed in source, not supplied by the command caller.
const contractBytes = readFileSync(new URL("../bootstrap/opengeo-demo-pilot-release-contract.json", import.meta.url));
const contract: JsonObject = JSON.parse(contractBytes.toString("utf8"));
export const releaseContractSha256 = sha256(contractBytes);
assert.equal(contract.schemaVersion, "opengeo.demo-pilot-release-contract.2", "Unsupported demo release contract");

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
    : item);
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function templateBody(response: JsonObject): JsonObject {
  const body = response.TemplateBody;
  assert.ok(body && typeof body === "object" && !Array.isArray(body), "Expected an AWS JSON TemplateBody object");
  return body;
}

export function validateDemoStackIdentity(kind: StackKind, stack: JsonObject): void {
  const name = stackName(kind);
  assert.equal(stack.StackName, name, "Wrong stack name");
  assert.match(stack.StackId ?? "", new RegExp(`^arn:aws:cloudformation:${contract.region}:${contract.account}:stack/${name}/[a-zA-Z0-9-]+$`), "Wrong stack account, region, or identity");
  assert.ok(["CREATE_COMPLETE", "UPDATE_COMPLETE"].includes(stack.StackStatus), "Stack is not stable and successful");
  assert.equal(stack.RoleARN, `arn:aws:iam::${contract.account}:role/cdk-hnb659fds-cfn-exec-role-${contract.account}-${contract.region}`, "Unexpected CloudFormation execution role");
}

function stackName(kind: StackKind): string {
  assert.ok(kind === "Foundation" || kind === "Api", "Only the demo Foundation and API are supported");
  return kind === "Foundation" ? contract.foundationStack : contract.apiStack;
}

export function validateApiDigest(digest: string): void {
  assert.match(digest, /^sha256:[a-f0-9]{64}$/, "A full lowercase image digest is required; tags and URIs are not accepted");
  assert.ok(!/^sha256:([a-f0-9])\1{63}$/.test(digest), "Planning placeholder digests are not release images");
}

export function prepareFoundationTemplate(live: JsonObject): JsonObject {
  assert.equal(sha256(canonicalJson(live)), contract.foundationTemplateSha256, "Foundation changed since review; refresh the contract before proceeding");
  const candidate = structuredClone(live);
  for (const [name, output] of Object.entries(contract.foundationOutputs)) {
    assert.ok(!Object.hasOwn(candidate.Outputs, name), "A planned export already exists; re-review the live template");
    candidate.Outputs[name] = structuredClone(output);
  }
  validateTemplateDelta("Foundation", live, candidate);
  return candidate;
}

export function prepareApiTemplate(live: JsonObject, digest: string): JsonObject {
  assert.equal(sha256(canonicalJson(live)), contract.apiTemplateSha256, "API changed since review; refresh the contract before proceeding");
  validateApiDigest(digest);
  const candidate = structuredClone(live);
  candidate.Resources[contract.apiFunction].Properties.Code.ImageUri = `${contract.apiRepository}@${digest}`;
  validateTemplateDelta("Api", live, candidate, digest);
  return candidate;
}

/** Restore only the pinned pre-window API template; never reverse schema migrations. */
export function prepareApiRollback(live: JsonObject, retained: JsonObject, releasedDigest: string): JsonObject {
  assert.equal(sha256(canonicalJson(retained)), contract.apiTemplateSha256, "API rollback target is not the reviewed pre-window template");
  if (canonicalJson(live) !== canonicalJson(retained)) validateTemplateDelta("Api", retained, live, releasedDigest);
  return structuredClone(retained);
}

/** Call only after removing the new runtime stacks and checking every new export for importers. */
export function prepareFoundationRollback(live: JsonObject, retained: JsonObject, importers: JsonObject): JsonObject {
  assert.equal(sha256(canonicalJson(retained)), contract.foundationTemplateSha256, "Foundation rollback target is not the reviewed pre-window template");
  const names = Object.values(contract.foundationOutputs).map((value: any) => value.Export.Name).sort();
  assert.deepEqual(Object.keys(importers).sort(), names, "Read all 13 new exports before rollback");
  for (const name of names) {
    assert.ok(!importers[name].NextToken, "Incomplete export importer inventory");
    assert.deepEqual(importers[name].Imports, [], "Cannot remove an export still used by another stack");
  }
  if (canonicalJson(live) !== canonicalJson(retained)) validateTemplateDelta("Foundation", retained, live);
  return structuredClone(retained);
}

/** Compare the complete template. Do not discard Metadata, policies, parameters, or any other keys. */
export function validateTemplateDelta(kind: StackKind, live: JsonObject, candidate: JsonObject, digest?: string): void {
  stackName(kind);
  const restored = structuredClone(candidate);
  if (kind === "Foundation") {
    for (const [name, output] of Object.entries(contract.foundationOutputs)) {
      assert.ok(!Object.hasOwn(live.Outputs ?? {}, name), "A reviewed export is no longer new");
      assert.deepEqual(restored.Outputs?.[name], output, "An export differs from its reviewed definition");
      delete restored.Outputs[name];
    }
  } else {
    validateApiDigest(digest ?? "");
    const before = live.Resources?.[contract.apiFunction];
    const after = restored.Resources?.[contract.apiFunction];
    assert.equal(before?.Type, "AWS::Lambda::Function", "Reviewed API function is missing");
    assert.equal(after?.Properties?.Code?.ImageUri, `${contract.apiRepository}@${digest}`, "Wrong API repository or digest");
    after.Properties.Code.ImageUri = structuredClone(before.Properties.Code.ImageUri);
  }
  assert.deepEqual(restored, live, `${kind} contains an out-of-scope template change`);
}

export function validateMigrationLedger(ledger: LedgerEntry[], migrations: Migration[]): Migration[] {
  assert.equal(migrations.length, contract.maximumMigrations, "Unexpected source migration count");
  assert.ok(Array.isArray(ledger) && ledger.length >= contract.minimumAppliedMigrations && ledger.length <= migrations.length, "Demo ledger must be a contiguous 0063–0082 prefix; never initialize a fresh database here");
  for (const [index, record] of ledger.entries()) {
    assert.deepEqual(record, {
      migration_name: migrations[index]!.name, sha256: migrations[index]!.sha256
    }, "Applied migration sequence or checksum differs; do not skip, reorder, or replay it");
  }
  return migrations.slice(ledger.length);
}

export function readReviewedMigrations(repository: string): Migration[] {
  const bytes = readFileSync(join(repository, contract.migrationManifest));
  assert.equal(sha256(bytes), contract.migrationManifestSha256, "Reviewed migration manifest changed");
  const migrations: Migration[] = JSON.parse(bytes.toString("utf8")).migrations;
  assert.equal(migrations.length, contract.maximumMigrations);
  const directory = join(repository, "database/migrations");
  assert.deepEqual(readdirSync(directory).filter((name) => name.endsWith(".sql")).sort(), migrations.map(({name}) => name), "Source migration set changed");
  for (const migration of migrations) {
    assert.equal(sha256(readFileSync(join(directory, migration.name))), migration.sha256, `Migration checksum mismatch: ${migration.name}`);
  }
  return migrations;
}

/** Run against DescribeChangeSet AND GetTemplate for that exact change-set ARN, before execution. */
export function validateChangeSet(
  kind: StackKind, stack: JsonObject, changeSet: JsonObject,
  reviewed: JsonObject, changeSetTemplate: JsonObject
): void {
  validateDemoStackIdentity(kind, stack);
  assert.equal(changeSet.StackId, stack.StackId, "Change set targets a different stack");
  assert.equal(changeSet.StackName, stack.StackName);
  assert.match(changeSet.ChangeSetId ?? "", new RegExp(`^arn:aws:cloudformation:${contract.region}:${contract.account}:changeSet/opengeo-demo-pilot-[a-zA-Z0-9-]+/[a-zA-Z0-9-]+$`), "Unexpected change-set identity");
  assert.equal(changeSet.Status, "CREATE_COMPLETE", "Change set is not ready");
  assert.equal(changeSet.ExecutionStatus, "AVAILABLE", "Change set is not executable");
  assert.ok(!changeSet.NextToken, "Read every change-set page before validation");
  assert.ok(!changeSet.IncludeNestedStacks, "Nested stack execution is outside this release");
  assert.ok(!changeSet.ImportExistingResources && !changeSet.DeploymentMode && !changeSet.ParentChangeSetId, "Imports, drift reversion, and child change sets are outside this release");
  const parameters = (items: JsonObject[] = []) => items.map(({ParameterKey, ParameterValue, ResolvedValue}) => ({ParameterKey, ParameterValue, ResolvedValue})).sort((a, b) => a.ParameterKey.localeCompare(b.ParameterKey));
  const tags = (items: JsonObject[] = []) => [...items].sort((a, b) => a.Key.localeCompare(b.Key));
  assert.deepEqual(parameters(changeSet.Parameters), parameters(stack.Parameters), "Stack parameters changed");
  assert.deepEqual(tags(changeSet.Tags), tags(stack.Tags), "Stack tags changed");
  assert.deepEqual([...(changeSet.NotificationARNs ?? [])].sort(), [...(stack.NotificationARNs ?? [])].sort(), "Stack notifications changed");
  assert.deepEqual(changeSet.RollbackConfiguration ?? {}, stack.RollbackConfiguration ?? {}, "Rollback configuration changed");
  assert.equal(canonicalJson(changeSetTemplate), canonicalJson(reviewed), "CloudFormation change-set template differs from the reviewed artifact");
  assert.ok(Array.isArray(changeSet.Changes), "Missing resource change inventory");
  if (kind === "Foundation") {
    assert.equal(changeSet.Changes.length, 0, "An outputs-only Foundation update must not change resources");
  } else {
    const dependencies: JsonObject = contract.apiDependentResources;
    const ids = Object.keys(dependencies);
    assert.equal(ids.length, 2, "Exactly two API dependencies must be pinned");
    assert.equal(reviewed.Resources?.[contract.apiFunction]?.Type, "AWS::Lambda::Function");
    assert.equal(reviewed.Resources[contract.apiFunction].Properties?.FunctionName, contract.apiFunctionName,
      "The API function identity must remain fixed");
    for (const id of ids) {
      assert.deepEqual(reviewed.Resources?.[id], dependencies[id].definition,
        `The complete ${id} definition must remain pinned`);
    }
    const changedIds = changeSet.Changes.map((entry: JsonObject) => entry.ResourceChange?.LogicalResourceId);
    // Preserve the original function-only case, or accept the exact observed
    // three-resource dependency closure. Partial/duplicate/unknown sets fail.
    const expectedIds = changedIds.length === 1 ? [contract.apiFunction] : [contract.apiFunction, ...ids];
    assert.deepEqual([...changedIds].sort(), expectedIds.sort(), "Unexpected API resource-change inventory");
    for (const entry of changeSet.Changes) {
      onlyKeys(entry, ["Type", "ResourceChange"], "API change entry");
      assert.equal(entry.Type, "Resource");
      const resource = entry.ResourceChange;
      onlyKeys(resource, ["Action", "LogicalResourceId", "PhysicalResourceId", "ResourceType", "Replacement", "Scope", "Details"], "API resource change");
      assert.equal(resource.Action, "Modify");
      assert.deepEqual(resource.Scope, ["Properties"]);
      assert.ok(Array.isArray(resource.Details) && resource.Details.length === 1, "Exactly one reviewed property detail is required");
      const detail = resource.Details[0];
      const dependency = dependencies[resource.LogicalResourceId];
      const direct = resource.LogicalResourceId === contract.apiFunction;
      onlyKeys(detail, direct ? ["Target", "Evaluation", "ChangeSource"]
        : ["Target", "Evaluation", "ChangeSource", "CausingEntity"], "API property detail");
      onlyKeys(detail.Target, ["Attribute", "Name", "RequiresRecreation", "Path"], "API property target");
      assert.equal(detail.Target.Attribute, "Properties");
      assert.equal(resource.ResourceType, direct ? "AWS::Lambda::Function" : dependency.definition.Type);
      assert.equal(resource.Replacement, direct ? "False" : dependency.replacement, "Unreviewed replacement semantics");
      assert.equal(detail.Target.Name, direct ? "Code" : dependency.property);
      assert.equal(detail.Target.RequiresRecreation, direct ? "Never" : dependency.requiresRecreation);
      assert.equal(detail.Evaluation, direct ? "Static" : "Dynamic", "Unreviewed evaluation semantics");
      assert.equal(detail.ChangeSource, direct ? "DirectModification" : "ResourceAttribute", "Unreviewed change source");
      if (direct && resource.PhysicalResourceId !== undefined) {
        assert.equal(resource.PhysicalResourceId, contract.apiFunctionName, "Wrong physical API function");
      }
      if (!direct) assert.equal(detail.CausingEntity, `${contract.apiFunction}.Arn`, "Dependency must reference only the API ARN");
      if (Object.hasOwn(detail.Target, "Path")) {
        const paths = direct ? ["/Properties/Code", "/Properties/Code/ImageUri"] : [`/Properties/${dependency.property}`];
        assert.ok(paths.includes(detail.Target.Path), "Unexpected changed property path");
      }
    }
  }
}

function onlyKeys(value: JsonObject, allowed: string[], label: string): void {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.ok(Object.keys(value).every((key) => allowed.includes(key)), `${label} contains unreviewed fields`);
}

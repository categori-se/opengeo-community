import assert from "node:assert/strict";

type Json = Record<string, any>;
export interface WorkerRoleBinding {readonly arn: string; readonly exportName: string;}

/** Move reviewed role definitions to the operator's stack, without changing grants.
 * Activation imports their ARNs; CloudFormation therefore prevents deleting the
 * controller's exports while a worker still uses them.
 */
export function retainWorkerRoles(input: Json, bindings: {
  task: WorkerRoleBinding; execution: WorkerRoleBinding;
}): {template: Json; roles: Array<{logicalId: string; definition: Json; binding: WorkerRoleBinding}>} {
  const template = structuredClone(input);
  const resources = template.Resources as Record<string, Json>;
  assert.ok(resources, "Worker resources required");
  const tasks = Object.values(resources).filter(r => r.Type === "AWS::ECS::TaskDefinition");
  assert.equal(tasks.length, 1, "Exactly one reviewed worker task definition required");
  const roles = [];
  const removed = new Set<string>();
  for (const [property, binding] of [["TaskRoleArn", bindings.task], ["ExecutionRoleArn", bindings.execution]] as const) {
    const arn = /^arn:aws:iam::([0-9]{12}):role\/([A-Za-z0-9+=,.@_-]+)$/.exec(binding.arn);
    assert.ok(arn && binding.exportName, "Exact retained role ARN and export required");
    const reference = tasks[0]!.Properties?.[property]?.["Fn::GetAtt"];
    assert.ok(Array.isArray(reference) && reference.length === 2 && reference[1] === "Arn", "Role must reference its reviewed IAM resource");
    const logicalId = reference[0];
    const role = resources[logicalId];
    assert.equal(role?.Type, "AWS::IAM::Role", "Reviewed role is missing");
    assert.ok(!removed.has(logicalId), "Task and execution roles must be distinct");
    assert.ok(!role.Properties.RoleName && !role.Properties.Path, "Named/path roles require separate migration review");
    const policies: Json[] = [...(role.Properties.Policies ?? [])];
    for (const [id, candidate] of Object.entries(resources)) {
      if (candidate.Type !== "AWS::IAM::Policy") continue;
      const targets = candidate.Properties?.Roles;
      if (!targets?.some((target: Json) => target.Ref === logicalId)) continue;
      assert.deepEqual(targets, [{Ref: logicalId}], "Shared role policy requires separate review");
      assert.ok(!candidate.Properties.Users && !candidate.Properties.Groups, "Non-role policy targets are unsupported");
      policies.push({PolicyName: candidate.Properties.PolicyName, PolicyDocument: candidate.Properties.PolicyDocument});
      removed.add(id);
    }
    assert.ok(policies.length, "Reviewed worker role must have explicit permissions");
    roles.push({logicalId, binding, definition: {
      ...role, Properties: {...role.Properties, RoleName: arn[2], Policies: policies}
    }});
    removed.add(logicalId);
    tasks[0]!.Properties[property] = {"Fn::ImportValue": binding.exportName};
  }
  for (const id of removed) delete resources[id];
  for (const resource of Object.values(resources)) {
    if (resource.DependsOn) {
      const original = Array.isArray(resource.DependsOn) ? resource.DependsOn : [resource.DependsOn];
      const remaining = original.filter((id: string) => !removed.has(id));
      if (remaining.length) resource.DependsOn = remaining;
      else delete resource.DependsOn;
    }
    assert.ok(!resource.Type.startsWith("AWS::IAM::"), "Activation must contain no remaining IAM resources");
  }
  // Fail instead of silently rewriting an unexpected Ref, GetAtt or Fn::Sub.
  function checkReferences(value: unknown): void {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {value.forEach(checkReferences); return;}
    const object = value as Json;
    const getAtt = object["Fn::GetAtt"];
    const target = Array.isArray(getAtt) ? getAtt[0] : typeof getAtt === "string" ? getAtt.split(".")[0] : undefined;
    const sub = Array.isArray(object["Fn::Sub"]) ? object["Fn::Sub"][0] : object["Fn::Sub"];
    for (const id of removed) {
      assert.ok(object.Ref !== id && target !== id
        && !(typeof sub === "string" && (sub.includes(`\${${id}}`) || sub.includes(`\${${id}.`))),
      `Unexpected remaining reference to ${id}`);
    }
    Object.values(object).forEach(checkReferences);
  }
  checkReferences(template);
  return {template, roles};
}

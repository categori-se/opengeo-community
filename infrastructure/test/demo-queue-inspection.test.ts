import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {describe, it} from "node:test";
import {fileURLToPath} from "node:url";

const policy = JSON.parse(readFileSync(new URL("../bootstrap/opengeo-production-demo-queue-inspection-policy.json", import.meta.url), "utf8"));
const queue = "arn:aws:sqs:us-east-1:111111111111:OpenGeo-demo-Foundation-ProcessingQueue6DC600C3-vynY8GXl8D5b";

describe("proposed one-receive demo queue inspection", () => {
  it("limits reception to the existing processing queue and blocks all other write families", () => {
    const boundary = policy.Statement.find((value: any) => value.Sid === "InspectionActionsOnly");
    assert.equal(boundary.Effect, "Deny");
    assert.equal(boundary.Resource, "*");
    const allowed = policy.Statement.filter((value: any) => value.Effect === "Allow");
    assert.deepEqual(allowed.filter((s: any) => s.Action === "sqs:ReceiveMessage"), [{Sid: "InspectOnlyExactProcessingQueue", Effect: "Allow", Action: "sqs:ReceiveMessage", Resource: queue}]);
    assert.ok(allowed.every((s: any) => (Array.isArray(s.Action) ? s.Action : [s.Action]).every((action: string) => boundary.NotAction.includes(action))));
    assert.ok(boundary.NotAction.every((action: string) => /^(sts:GetCallerIdentity|iam:(GetRole|GetRolePolicy|ListRolePolicies|ListAttachedRolePolicies)|cloudformation:DescribeStacks|sqs:(GetQueueAttributes|ReceiveMessage)|budgets:ViewBudget)$/.test(action)));
    assert.ok(allowed.every((s: any) => ![s.Resource].flat().includes("*")));
    assert.ok(JSON.stringify(policy).length < 6144);
  });

  it("classifies only the exact test shape without exposing message bodies or authorizing disposal", () => {
    const script = fileURLToPath(new URL("../scripts/summarize-demo-queue-message.py", import.meta.url));
    const result = spawnSync("python3", ["-c", `
import importlib.util, hashlib, json, sys, tempfile, pathlib, subprocess, stat
spec=importlib.util.spec_from_file_location("inspection",sys.argv[1]); module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
payload={"Service":"Amazon S3","Event":"s3:TestEvent","Time":"2026-09-08T00:00:00Z","Bucket":"demo.storage.opengeo.tools","RequestId":"private-request","HostId":"private-host"}
def envelope(body):
 return {"Messages":[{"MessageId":"private-message-id","ReceiptHandle":"private-receipt","Body":body,"MD5OfBody":hashlib.md5(body.encode(),usedforsecurity=False).hexdigest(),"Attributes":{"ApproximateReceiveCount":"1"}}]}
for variant, expected in [(payload,"matches-demo-s3-test-shape"),({**payload,"Records":[{"private":"object-key"}]},"requires-review"),({**payload,"Bucket":"unrelated"},"requires-review"),({**payload,"Time":"not-a-dateZ"},"requires-review")]:
 output=module.summarize(envelope(json.dumps(variant)));assert output["classification"]==expected;assert output["deletionAuthorized"] is False;assert output["processingAuthorized"] is False;assert output["provenanceAuthenticated"] is False
 assert "private-" not in json.dumps(output)
assert module.summarize(envelope('{"Event":"x","Event":"s3:TestEvent"}'))["classification"]=="requires-review"
assert module.summarize(envelope('not-json'))["classification"]=="requires-review"
assert module.summarize({})["queueEmptyProven"] is False
for invalid in [{"Messages":[{},{}]},envelope("x")]:
 if len(invalid["Messages"])==1:invalid["Messages"][0]["MD5OfBody"]="0"*32
 try:module.summarize(invalid)
 except ValueError:pass
 else:raise AssertionError("invalid response accepted")
print("bounded classification cases passed")
with tempfile.TemporaryDirectory(prefix="opengeo-queue-classifier-test-") as temporary:
 root=pathlib.Path(temporary);source=root/"response.json";out=root/"summary.json"
 source.write_text(json.dumps(envelope(json.dumps(payload))))
 cli=subprocess.run([sys.executable,sys.argv[1],"--response",str(source),"--out",str(out)],capture_output=True,text=True,timeout=2)
 assert cli.returncode==0,cli.stderr
 assert json.loads(out.read_text())["classification"]=="matches-demo-s3-test-shape"
 assert stat.S_IMODE(out.stat().st_mode)==0o600
 assert "private-" not in cli.stdout+cli.stderr+out.read_text()
 original=out.read_bytes()
 duplicate=subprocess.run([sys.executable,sys.argv[1],"--response",str(source),"--out",str(out)],capture_output=True,text=True,timeout=2)
 assert duplicate.returncode!=0 and out.read_bytes()==original
 assert "private-" not in duplicate.stdout+duplicate.stderr
`, script], {encoding: "utf8", timeout: 5000});
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /bounded classification cases passed/);
  });
});

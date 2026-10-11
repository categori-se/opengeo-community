import assert from "node:assert/strict";
import {test} from "node:test";
import {OpenGeoApiClient} from "../src/lib/apiClient.js";

test("GitHub history validates and maps bounded retained log content", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  let logs = {state: "retained", text: "Compile failed", truncated: false,
    captured_at: "2026-09-10T00:00:00Z", checksum_sha256: "c".repeat(64)};
  const client = new OpenGeoApiClient({tokenProvider: () => "test-token", organizationProvider: () => id,
    fetchImplementation: async () => new Response(JSON.stringify([{
      build_job_id: id, source_project_id: id, stage: "failed", repository: "owner/private",
      workflow_sha: "a".repeat(40), source_commit: "b".repeat(40), run_id: 456, run_attempt: 1,
      run_status: "completed", run_conclusion: "failure", error_code: "github_run_failure",
      updated_at: "2026-09-10T00:00:00Z", retained_logs: logs
    }]), {headers: {"Content-Type": "application/json"}})});
  const [record] = await client.listObservableGitHubDispatches(id, id);
  assert.equal(record.retainedLogs.text, "Compile failed");
  assert.equal(record.retainedLogs.checksumSha256, logs.checksum_sha256);
  logs = {...logs, text: "x".repeat(24001)};
  await assert.rejects(client.listObservableGitHubDispatches(id, id), /Invalid retained GitHub logs/);
  logs = null;
  assert.equal((await client.listObservableGitHubDispatches(id, id))[0].retainedLogs, null);
});

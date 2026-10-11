import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
  loadWithWakeRetry,
  platformStartupMessage
} from "../src/lib/platformLoadRetry.js";

describe("bounded on-demand platform wake retry", () => {
  it("describes one request-driven startup without implying failed attempts", () => {
    const directory = platformStartupMessage("directory");
    const project = platformStartupMessage("project");
    const account = platformStartupMessage("account");

    assert.match(directory, /Loading your account and project index/);
    assert.match(project, /essential records/);
    assert.match(project, /does not mean your session was idle/);
    assert.match(account, /account tools/);
    assert.doesNotMatch(`${directory} ${project} ${account}`, /attempt|retry|failed/i);
    assert.throws(() => platformStartupMessage("unknown"), /account, directory, or project/);
  });

  it("recovers from retryable service startup without changing route state", async () => {
    const states = [
      {status: "error", retryable: true, requestId: "first"},
      {status: "error", retryable: true, requestId: "second"},
      {status: "ready", projects: ["retained"]}
    ];
    const waits = [];
    const retries = [];
    const result = await loadWithWakeRetry(
      async () => states.shift(),
      {
        delays: [10, 20, 30],
        sleep: async (delay) => waits.push(delay),
        onRetry: (attempt) => retries.push(attempt)
      }
    );

    assert.deepEqual(result, {status: "ready", projects: ["retained"]});
    assert.deepEqual(waits, [10, 20]);
    assert.deepEqual(retries.map(({attempt}) => attempt), [1, 2]);
  });

  it("does not retry authentication, authorization, missing data, or terminal errors", async () => {
    for (const state of [
      {status: "unauthenticated"},
      {status: "forbidden"},
      {status: "not_found"},
      {status: "error", retryable: false}
    ]) {
      let calls = 0;
      const result = await loadWithWakeRetry(async () => {
        calls += 1;
        return state;
      }, {delays: [0], sleep: async () => {}});
      assert.equal(result, state);
      assert.equal(calls, 1);
    }
  });

  it("stops after the declared retry budget and returns the final evidence", async () => {
    let calls = 0;
    const result = await loadWithWakeRetry(async () => ({
      status: "error",
      retryable: true,
      requestId: `request-${++calls}`
    }), {delays: [0, 0], sleep: async () => {}});
    assert.equal(calls, 3);
    assert.equal(result.requestId, "request-3");
  });
});

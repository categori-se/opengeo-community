import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {
  pollValue,
  cleanupPilot,
  capturePilotParticipants,
  requireCurrentPilotReviewer,
  requirePilotProjectAbsent,
  requireNewPilotReviewer,
  pilotSourceLayer,
  siteDraftFromRecord
} from "../scripts/run-v01-pilot-acceptance.mjs";

describe("v0.1 deployed pilot runner boundaries", () => {
  it("derives the PMTiles source layer from the exact inspected version rather than inventing a name", () => {
    const version = {id: "exact", state: "active", schemaDefinition: {layers: [{name: "source"}]}};
    assert.equal(pilotSourceLayer([version], "exact"), "source");
    assert.equal(pilotSourceLayer([{...version, schemaDefinition: {layers: [{name: "Named watersheds"}]}}], "exact"), "Named watersheds");
    for (const versions of [[], [version, version], [{...version, id: "different"}],
      [{...version, state: "processing"}], [{...version, schemaDefinition: {}}],
      [{...version, schemaDefinition: {layers: [{name: "a"}, {name: "b"}]}}],
      ...["", " a", "-sql", "a\nb"].map((name) => [{...version, schemaDefinition: {layers: [{name}]}}])]) {
      assert.throws(() => pilotSourceLayer(versions, "exact"), /one inspected source layer/);
    }
  });

  function participants({mutate = () => {}, failReviewerLogin = false} = {}) {
    const calls = [];
    const sessions = {
      operator: {userId: "owner", email: "owner@example.com", memberships: [{organizationId: "pilot", role: "admin"}]},
      reviewer: {userId: "reviewer", email: "reviewer@example.com", memberships: []}
    };
    mutate(sessions);
    return {
      calls,
      args: {
        origin: "https://demo.studio.opengeo.tools", organizationId: "pilot",
        operatorEmail: "owner@example.com", reviewerEmail: "reviewer@example.com", timeoutMs: 1000,
        captureSession: async ({role, expectedEmail}) => {
          calls.push(`login:${role}:${expectedEmail}`);
          if (role === "reviewer" && failReviewerLogin) throw new Error("reviewer unavailable");
          return {token: role, session: {user_id: role === "operator" ? "owner" : "reviewer", email: expectedEmail},
            browser: {context: {close: async () => calls.push(`close-context:${role}`)},
              browser: {close: async () => calls.push(`close-browser:${role}`)}}};
        },
        createClient: ({token}) => new Proxy({}, {get(_target, name) {
          if (name !== "getSession") throw new Error("No other operation is allowed during participant preflight");
          return async () => {calls.push(`session:${token}`); return sessions[token];};
        }})
      }
    };
  }

  it("coordinates both expected identities with only session reads before any writes", async () => {
    const {args, calls} = participants();
    const ready = await capturePilotParticipants(args);
    assert.equal(ready.authoritativeOperator.userId, "owner");
    assert.equal(ready.reviewerSession.session.user_id, "reviewer");
    assert.deepEqual(calls, ["login:operator:owner@example.com", "session:operator",
      "login:reviewer:reviewer@example.com", "session:reviewer"]);
  });

  it("closes opened browsers if the reviewer is unavailable, wrong, or already a member", async () => {
    for (const option of [
      {failReviewerLogin: true},
      {mutate: (s) => {s.reviewer.userId = "another-user";}},
      {mutate: (s) => {s.reviewer.email = "another@example.com";}},
      {mutate: (s) => {s.reviewer.memberships = [{organizationId: "pilot", role: "guest"}];}},
      {mutate: (s) => {delete s.reviewer.memberships;}}
    ]) {
      const {args, calls} = participants(option);
      await assert.rejects(capturePilotParticipants(args));
      assert.ok(calls.includes("close-context:operator"));
      assert.ok(calls.includes("close-browser:operator"));
      if (!option.failReviewerLogin) {
        assert.ok(calls.includes("close-context:reviewer"));
        assert.ok(calls.includes("close-browser:reviewer"));
      }
    }
  });

  it("rejects wrong-owner and non-admin sessions before asking the reviewer to log in", async () => {
    for (const mutate of [
      (s) => {s.operator.userId = "another-user";},
      (s) => {s.operator.email = "another@example.com";},
      (s) => {s.operator.memberships[0].role = "member";},
      (s) => {s.operator.memberships[0].organizationId = "other";},
      (s) => {s.operator.memberships.push({...s.operator.memberships[0]});}
    ]) {
      const {args, calls} = participants({mutate});
      await assert.rejects(capturePilotParticipants(args));
      assert.equal(calls.some((c) => c.startsWith("login:reviewer")), false);
      assert.ok(calls.includes("close-browser:operator"));
    }
    const {args, calls} = participants();
    await assert.rejects(capturePilotParticipants({...args, reviewerEmail: "OWNER@example.com"}), /distinct/);
    assert.deepEqual(calls, []);
  });

  it("rejects a changed reviewer identity or newly acquired membership before invitation", () => {
    const captured = {session: {user_id: "reviewer", email: "reviewer@example.com"}};
    for (const current of [
      {userId: "different", email: "reviewer@example.com", memberships: []},
      {userId: "reviewer", email: "reviewer@example.com", memberships: [{organizationId: "pilot"}]}
    ]) assert.throws(() => requireCurrentPilotReviewer(current, captured, "reviewer@example.com", "owner", "pilot"));
  });

  it("checks every project page and refuses matching archived projects", async () => {
    const first = Array.from({length: 100}, (_,i) => ({id: String(i), name: `Existing ${i}`}));
    const calls = [];
    await requirePilotProjectAbsent({listProjects: async (page) => {
      calls.push(page); return page.offset === 0 ? first : [];
    }}, "New pilot");
    assert.deepEqual(calls, [{limit: 100, offset: 0}, {limit: 100, offset: 100}]);
    await assert.rejects(requirePilotProjectAbsent({listProjects: async ({offset}) => offset === 0 ? first
      : [{id: "archived", name: " NEW PILOT ", status: "archived"}]}, "New pilot"), /already exists/);
    await assert.rejects(requirePilotProjectAbsent({listProjects: async () => first}, "New pilot"), /pagination/);
    await assert.rejects(requirePilotProjectAbsent({listProjects: async () => null}, "New pilot"), /invalid/);
    await assert.rejects(requirePilotProjectAbsent({listProjects: async () => [{id: "missing-name"}]}, "New pilot"), /incomplete/);
  });

  it("preserves existing organization access and rejects incomplete reviewer inventory", () => {
    assert.doesNotThrow(() => requireNewPilotReviewer({user_id: "reviewer", memberships: []}, "owner", "pilot"));
    assert.doesNotThrow(() => requireNewPilotReviewer({user_id: "reviewer", memberships: [{organization_id: "another"}]}, "owner", "pilot"));
    for (const session of [
      {user_id: "owner", memberships: []},
      {user_id: "reviewer"},
      {user_id: "reviewer", memberships: [{}]},
      {user_id: "reviewer", memberships: [{organization_id: "pilot"}]}
    ]) assert.throws(() => requireNewPilotReviewer(session, "owner", "pilot"));
  });

  it("revokes only confirmed pilot memberships and reports ambiguous acceptance", async () => {
    for (const accepted of [false, true]) {
      const calls = [];
      const operatorClient = Object.fromEntries([
        "revokeProjectMember", "revokeOrganizationMember", "revokeInvitation", "updateProject"
      ].map((name) => [name, async (...args) => { calls.push([name, ...args]); }]));
      const state = {
        projectId: "pilot-project", invitationId: "pilot-invitation", reviewerUserId: "reviewer",
        invitationAcceptanceAttempted: true, invitationAccepted: accepted, cleanupErrors: []
      };
      await cleanupPilot({operatorClient, state});
      assert.deepEqual(calls, accepted ? [
        ["revokeProjectMember", "pilot-project", "reviewer"],
        ["revokeOrganizationMember", "reviewer"],
        ["updateProject", "pilot-project", {status: "archived"}]
      ] : [
        ["revokeInvitation", "pilot-invitation"],
        ["updateProject", "pilot-project", {status: "archived"}]
      ]);
      assert.deepEqual(state.cleanupErrors, accepted ? [] : ["membership_acceptance_unconfirmed"]);
    }
  });

  it("polls until one successful terminal state and rejects terminal failure", async () => {
    const states = ["queued", "running", "completed"];
    const completed = await pollValue({
      label: "test job",
      timeoutMs: 1_000,
      intervalMs: 0,
      load: async () => ({state: states.shift()}),
      done: ({state}) => ["completed", "failed"].includes(state),
      failed: ({state}) => state === "failed",
      wait: async () => {}
    });
    assert.equal(completed.state, "completed");
    await assert.rejects(pollValue({
      label: "test job",
      timeoutMs: 1_000,
      intervalMs: 0,
      load: async () => ({state: "failed"}),
      done: ({state}) => ["completed", "failed"].includes(state),
      failed: ({state}) => state === "failed",
      wait: async () => {}
    }), /terminal failure/);
  });

  it("carries exact site page pins into one reviewer revision", () => {
    const draft = siteDraftFromRecord({
      title: "Pilot site",
      language: "en",
      theme: "atlas",
      themeOptions: {accentColor: "#155e63"},
      printLayout: {schemaVersion: "opengeo.print-layout.1.1.0", pages: []},
      pages: [
        {
          slug: "story",
          navigationLabel: "Story",
          resourceId: "00000000-0000-4000-8000-000000000001",
          resourceVersionNumber: 3,
          isHome: true
        },
        {
          slug: "map",
          navigationLabel: "Map",
          resourceId: "00000000-0000-4000-8000-000000000002",
          resourceVersionNumber: 5,
          isHome: false
        }
      ]
    }, {
      expectedVersion: 7,
      description: "One reviewer edit",
      changeMessage: "Reviewer acceptance edit"
    });

    assert.equal(draft.expectedVersion, 7);
    assert.equal(draft.pages.length, 2);
    assert.deepEqual(draft.pages.map(({resourceVersion}) => resourceVersion), [3, 5]);
    assert.equal(draft.pages[0].isHome, true);
    assert.equal(draft.description, "One reviewer edit");
  });
});

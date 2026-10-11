import assert from "node:assert/strict";
import {afterEach, beforeEach, it} from "node:test";
import {JSDOM} from "jsdom";
import {platformStatePanel} from "../src/components/PlatformDirectory.js";

let dom;
let previous;
beforeEach(() => {
  dom = new JSDOM("<!doctype html><body></body>");
  previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {configurable: true, value: dom.window.document});
});
afterEach(() => {
  if (previous) Object.defineProperty(globalThis, "document", previous);
  else delete globalThis.document;
  dom.window.close();
});

function state() {
  return {
    status: "forbidden", code: "organization_membership_required",
    session: {email: "reviewer+<private>@example.com"}, adapter: {kind: "api"}
  };
}
function button(panel, name) {
  return [...panel.querySelectorAll("button")].find(({textContent}) => textContent === name);
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

it("explains missing membership without starting sign-in, granting access, or checking on its own", async () => {
  let checks = 0;
  let signOuts = 0;
  const panel = platformStatePanel(state(), async () => { checks++; }, {
    returnTo: "/workspaces", autoSignIn: true,
    auth: {beginSignIn() { assert.fail("Already authenticated"); }, async signOut() { signOuts++; }}
  });
  await tick();
  assert.match(panel.textContent, /No workspace access yet/);
  assert.match(panel.textContent, /Signed in as reviewer\+<private>@example.com/);
  assert.equal(panel.querySelector("private"), null);
  assert.equal(checks, 0);
  assert.equal(signOuts, 0);
  button(panel, "Check invitations").click();
  assert.equal(button(panel, "Check invitations").disabled, true);
  await tick();
  assert.equal(checks, 1);
  assert.equal(signOuts, 0);
  button(panel, "Sign out").click();
  await tick();
  assert.equal(signOuts, 1);
});

it("keeps both recovery actions usable after failures and does not display exception details", async () => {
  const fail = async () => { throw new Error("sensitive internal details"); };
  const panel = platformStatePanel(state(), fail, {returnTo: "/workspaces", auth: {signOut: fail}});
  button(panel, "Check invitations").click();
  await tick();
  assert.equal(button(panel, "Check invitations").disabled, false);
  assert.match(panel.querySelector('[role="status"]').textContent, /could not be checked/);
  button(panel, "Sign out").click();
  await tick();
  assert.equal(button(panel, "Sign out").disabled, false);
  assert.match(panel.querySelector('[role="status"]').textContent, /could not finish/);
  assert.doesNotMatch(panel.textContent, /sensitive internal/);
});

it("does not mistake an unrelated forbidden response for an empty invitation list", () => {
  const panel = platformStatePanel({...state(), code: "project_access_required"}, () => {}, {returnTo: "/workspaces"});
  assert.match(panel.textContent, /Access unavailable/);
  assert.doesNotMatch(panel.textContent, /No pending invitations|Signed in as/);
  assert.equal(button(panel, "Check invitations"), undefined);
});

it("does not log out the real identity from explicit fixture mode", () => {
  const panel = platformStatePanel({...state(), adapter: {kind: "fixture"}}, () => {}, {
    returnTo: "/workspaces", auth: {signOut() { assert.fail("Fixture cannot sign out real session"); }}
  });
  assert.ok(button(panel, "Check invitations"));
  assert.equal(button(panel, "Sign out"), undefined);
});


it("keeps denied Publication identity and recovery distinct from Projects", () => {
  const panel = platformStatePanel({status: "not_found", scope: "project", adapter: {kind: "api"}}, () => {},
    {returnTo: "/workspaces?publication=unavailable", resourceKind: "publication"});
  assert.equal(panel.querySelector("h2").textContent, "Publication not found");
  assert.equal(panel.querySelector("a").textContent, "View all publications");
  assert.equal(panel.querySelector("a").getAttribute("href"), "/workspaces?view=publishing");
  assert.doesNotMatch(panel.textContent, /Project not found|Create a project/);
});

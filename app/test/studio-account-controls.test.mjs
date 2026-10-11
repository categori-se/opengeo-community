import assert from "node:assert/strict";
import {beforeEach, afterEach, it} from "node:test";
import {JSDOM} from "jsdom";
import {StudioAccountControls} from "../src/components/StudioAccountControls.js";

let dom, previous;
beforeEach(() => {
  dom = new JSDOM("<!doctype html><body></body>");
  previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {configurable: true, value: dom.window.document});
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event("close")); };
});
afterEach(() => {
  if (previous) Object.defineProperty(globalThis, "document", previous);
  else delete globalThis.document;
  dom.window.close();
});
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

it("goes straight to sign-in for an unchanged map without saving", async () => {
  const calls = [];
  const root = StudioAccountControls({hasUnsavedChanges: () => false,
    auth: {beginSignIn: async path => calls.push(path)}, saveDraft: () => {throw Error("must not save");}});
  document.body.append(root);
  root.querySelector(".gis-account-command").click();
  await tick();
  assert.deepEqual(calls, ["/"]);
  assert.equal(root.querySelector("dialog").open, false);
});

it("reports direct navigation failure inline, never opens a save dialog, and can retry", async () => {
  let attempts = 0;
  let saves = 0;
  const root = StudioAccountControls({hasUnsavedChanges: () => false,
    auth: {beginSignIn: async () => {if (++attempts === 1) throw Error("private detail");}},
    saveDraft: () => {saves++; return true;}});
  document.body.append(root);
  root.querySelector(".gis-account-command").click();
  await tick();
  assert.equal(root.querySelector("dialog").open, false);
  assert.match(root.querySelector('[role="alert"]').textContent, /Your map is unchanged/);
  assert.equal(root.querySelector('[role="alert"]').hidden, false);
  assert.doesNotMatch(root.textContent, /private detail/);
  assert.equal(root.querySelector(".gis-account-command").disabled, false);
  root.querySelector(".gis-account-command").click();
  await tick();
  assert.equal(attempts, 2);
  assert.equal(saves, 0);
  assert.equal(root.querySelector("dialog").open, false);
  assert.equal(root.querySelector('[role="alert"]').hidden, true);
});

it("keeps account navigation deliberate, saves first and returns sign-in to the root map", async () => {
  const calls = [];
  const root = StudioAccountControls({auth: {beginSignIn: async path => calls.push(path)}, saveDraft: () => { calls.push("save"); return true; }});
  document.body.append(root);
  root.querySelector(".gis-account-command").click();
  assert.equal(root.querySelector("dialog").open, true);
  const [cancel, proceed] = root.querySelectorAll("dialog button");
  cancel.click();
  assert.deepEqual(calls, []);
  assert.equal(document.activeElement, root.querySelector(".gis-account-command"));
  root.querySelector(".gis-account-command").click();
  proceed.click();
  await tick();
  assert.deepEqual(calls, ["save", "/"]);
});

it("does not leave if the browser cannot save, and renders identity safely", async () => {
  let signouts = 0;
  const root = StudioAccountControls({signedIn: true, session: {displayName: "<img>"}, auth: {signOut: () => signouts++}, saveDraft: () => false});
  document.body.append(root);
  assert.equal(root.querySelector(".gis-account-command").textContent, "Sign out");
  assert.equal(root.querySelector("img"), null);
  root.querySelector(".gis-account-command").click();
  root.querySelector("dialog button:last-child").click();
  await tick();
  assert.equal(signouts, 0);
  assert.match(root.textContent, /could not be saved/);
});

it("uses existing sign-out and recovers from account navigation failure without losing the map", async () => {
  const calls = [];
  const root = StudioAccountControls({signedIn: true, auth: {signOut: async () => { calls.push("signout"); throw Error("private diagnostic"); }}, saveDraft: () => { calls.push("save"); return true; }});
  document.body.append(root);
  root.querySelector(".gis-account-command").click();
  root.querySelector("dialog button:last-child").click();
  await tick();
  assert.deepEqual(calls, ["save", "signout"]);
  assert.match(root.textContent, /Your map is still here/);
  assert.doesNotMatch(root.textContent, /private diagnostic/);
  assert.equal(root.querySelector("dialog button").disabled, false);
});

it("saves before signing back in to the requested Project", async () => {
  const calls = [];
  const target = "/workspaces?composition=retained-project";
  const root = StudioAccountControls({returnTo: target,
    auth: {beginSignIn: async path => calls.push(path)},
    saveDraft: () => {calls.push("save"); return true;}});
  document.body.append(root);
  root.querySelector(".gis-account-command").click();
  root.querySelector("dialog button:last-child").click();
  await tick();
  assert.deepEqual(calls, ["save", target]);
});

import assert from "node:assert/strict";
import {test} from "node:test";
import {JSDOM} from "jsdom";
import {SessionPanel} from "../src/components/SessionPanel.js";

async function withPanel(run, {state = {status: "signed_out"}, requestAccount, beginSignIn,
  url = "https://studio.opengeo.tools/login?returnTo=%2Fworkspaces%3Fnew%3D1",
  initialize = async () => state, signOut = async () => {}} = {}) {
  const dom = new JSDOM("<!doctype html><body></body>", {
    url
  });
  const previous = Object.fromEntries(["document", "location"].map(key =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of ["document", "location"]) {
    Object.defineProperty(globalThis, key, {
      value: dom.window[key], configurable: true, writable: true
    });
  }
  try {
    const root = SessionPanel({
      adapter: {kind: "api", requestAccount},
      auth: {initialize, beginSignIn, signOut}
    });
    document.body.append(root);
    await tick();
    await run(root, dom.window);
  } finally {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    dom.window.close();
  }
}

const tick = () => new Promise(resolve => setImmediate(resolve));

function fillRequest(root) {
  root.querySelector('[name="displayName"]').value = "Example applicant";
  root.querySelector('[name="email"]').value = "applicant@example.test";
  root.querySelector('[name="purpose"]').value = "Map local environmental observations.";
  return root.querySelector("form");
}

test("branded sign-in keeps the protected return destination", async () => {
  let destination;
  await withPanel(async root => {
    assert.equal(root.querySelector(".platform-signin-home strong").textContent, "OpenGeo Studio");
    assert.equal(root.querySelector(".platform-signin-home").getAttribute("href"), "/");
    assert.equal(root.querySelector(".platform-mode"), null);
    assert.match(root.textContent, /Your password stays with the secure sign-in service/);
    assert.equal(root.querySelector(".platform-auth-managed-account button").textContent, "Clear OpenGeo sign-in session");
    assert.doesNotMatch(root.textContent, /auth\.categori\.se/);
    root.querySelector(".platform-actions button").click();
    await tick();
    assert.equal(destination, "/workspaces?new=1");
  }, {beginSignIn: async returnTo => {destination = returnTo;}});
});

test("request access submits once and displays pending review without signing in", async () => {
  const calls = [];
  let finish;
  await withPanel(async (root, window) => {
    const form = fillRequest(root);
    form.dispatchEvent(new window.Event("submit", {cancelable: true}));
    form.dispatchEvent(new window.Event("submit", {cancelable: true}));
    assert.equal(calls.length, 1);
    assert.equal(form.querySelector('button[type="submit"]').disabled, true);
    assert.deepEqual(calls[0], {displayName: "Example applicant", email: "applicant@example.test", purpose: "Map local environmental observations.", website: ""});
    finish({status: "pending"});
    await tick();
    assert.match(form.textContent, /pending review/);
    assert.match(form.textContent, /Once approved, sign in to accept your invitation\. New accounts receive an email to finish setup\./);
    assert.equal(root.querySelector('[data-auth-state="signed_out"]') !== null, true);
    assert.equal(form.querySelector("input"), null);
  }, {requestAccount: request => {calls.push(request); return new Promise(resolve => {finish = resolve;});}});
});

test("request failures preserve fields and offer a deliberate retry", async () => {
  await withPanel(async (root, window) => {
    const form = fillRequest(root);
    form.dispatchEvent(new window.Event("submit", {cancelable: true}));
    await tick();
    assert.match(form.querySelector('[role="status"]').textContent, /wait a few minutes/);
    assert.equal(form.querySelector('button[type="submit"]').disabled, false);
    assert.equal(form.querySelector('[name="email"]').value, "applicant@example.test");
    assert.equal(document.activeElement, form.querySelector('[role="status"]'));
  }, {requestAccount: async () => {throw {code: "account_request_rate_limited", status: 429};}});
});

test("an explicit access request stays available to a signed-in identity without redirect or sign-out", async () => {
  let initialized = 0, signedOut = 0, requests = 0;
  const url = "https://studio.opengeo.tools/login?request=account&returnTo=%2Fworkspaces%3Fnew%3D1";
  await withPanel(async (root, window) => {
    assert.equal(initialized, 0, "Access requests do not inspect the authenticated session");
    assert.equal(signedOut, 0);
    assert.equal(window.location.href, url);
    assert.equal(root.querySelector('[data-auth-state="account_request"]') !== null, true);
    assert.equal(root.querySelector("details").open, true);
    assert.equal(root.querySelector(".platform-auth-managed-account"), null);
    assert.match(root.textContent, /Studio access is granted separately/);
    assert.equal(root.querySelector('a[href^="/login"]').getAttribute("href"), "/login?returnTo=%2Fworkspaces%3Fnew%3D1");
    fillRequest(root).dispatchEvent(new window.Event("submit", {cancelable: true}));
    await tick();
    assert.equal(requests, 1);
    assert.match(root.textContent, /pending review/);
    assert.equal(window.location.href, url);
  }, {url, initialize: async () => {initialized++;return {status: "signed_in"};},
    signOut: async () => {signedOut++;}, requestAccount: async () => {requests++;return {status: "pending"};}});
});

test("configuration errors and expired sessions retain their recovery controls", async () => {
  await withPanel(async root => {
    assert.match(root.querySelector("h2").textContent, /not configured/);
    assert.equal(root.querySelector("form"), null);
    assert.equal(root.querySelector(".platform-signin-brand") !== null, true);
    assert.doesNotMatch(root.textContent, /auth\.categori\.se/);
  }, {state: {status: "configuration_error"}});
  await withPanel(async root => {
    assert.match(root.querySelector("h2").textContent, /Session expired/);
    assert.match(root.querySelector(".platform-actions button").textContent, /Sign in/);
    assert.equal(root.querySelector(".platform-auth-managed-account summary") !== null, true);
  }, {state: {status: "expired"}});
});

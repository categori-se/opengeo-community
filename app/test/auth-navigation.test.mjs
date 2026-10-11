import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {
  currentProtectedReturnTo,
  publicStudioEntryDestination,
  loginHrefForReturnTo,
  normalizeAuthReturnTo,
  requestedAuthReturnTo
} from "../src/lib/authNavigation.js";

const ORIGIN = "https://studio.opengeo.tools";

describe("authentication return navigation", () => {
  it("retains a protected project, map, panel, and fragment exactly", () => {
    const href = `${ORIGIN}/workspaces?project=6ea563fe-920a-480f-8cab-9ac481de3a88&map=a6d1d11d-0cda-4b49-ac36-9be25be9a36d&panel=data#connections`;
    assert.equal(
      currentProtectedReturnTo(location(href)),
      "/workspaces?project=6ea563fe-920a-480f-8cab-9ac481de3a88&map=a6d1d11d-0cda-4b49-ac36-9be25be9a36d&panel=data#connections"
    );
  });

  it("round-trips a selected destination through the login URL", () => {
    const returnTo = "/workspaces?new=1#teams";
    const href = loginHrefForReturnTo(returnTo, location(`${ORIGIN}/workspaces`));
    assert.equal(href, "/login?returnTo=%2Fworkspaces%3Fnew%3D1%23teams");
    assert.equal(requestedAuthReturnTo(location(`${ORIGIN}${href}`)), returnTo);
  });

  it("rejects cross-origin, login-loop, protocol-relative, control, and oversized targets", () => {
    for (const value of [
      "https://attacker.example/workspaces",
      "/login",
      "//attacker.example/workspaces",
      "/workspaces\nnext",
      `/${"x".repeat(2048)}`
    ]) {
      assert.throws(() => normalizeAuthReturnTo(value, ORIGIN), /Return location is invalid/);
    }
  });

  it("falls back to Projects for invalid or missing requested destinations", () => {
    assert.equal(
      requestedAuthReturnTo(location(`${ORIGIN}/login?returnTo=https%3A%2F%2Fattacker.example%2F`)),
      "/workspaces"
    );
    assert.equal(requestedAuthReturnTo(location(`${ORIGIN}/login`)), "/workspaces");
    assert.equal(
      currentProtectedReturnTo(location("https://attacker.example/workspaces")),
      "/workspaces"
    );
  });
});

function location(href) {
  return {href, origin: ORIGIN};
}


describe("public Studio entry", () => {
  const now = 1800000000000;
  const storage = entries => {const values = new Map(Object.entries(entries));return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};};
  it("sends missing, expired and malformed sessions to the fixed demo", () => {
    for (const entries of [{}, {"opengeo.accessToken":"a.b.c","opengeo.accessTokenExpiresAt":String(now-1)}, {"opengeo.accessToken":"invalid","opengeo.accessTokenExpiresAt":String(now+60000)}]) {
      assert.equal(publicStudioEntryDestination({locationImplementation:location(`${ORIGIN}/?entry=public&returnTo=https://attacker.example`),storage:storage(entries),now}),"https://demo.studio.opengeo.tools/");
    }
  });
  it("keeps a current Studio session in Studio", () => {
    assert.equal(publicStudioEntryDestination({locationImplementation:location(`${ORIGIN}/?entry=public`),storage:storage({"opengeo.accessToken":"a.b.c","opengeo.accessTokenExpiresAt":String(now+60000)}),now}),null);
  });
  it("preserves direct Studio, login and protected resource navigation", () => {
    for(const path of ["/","/login?entry=public","/workspaces?entry=public","/layers?id=example"])assert.equal(publicStudioEntryDestination({locationImplementation:location(ORIGIN+path),storage:storage({}),now}),null);
  });
});

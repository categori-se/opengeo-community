import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {localFixtureWorkspaceHref} from "../src/lib/localDevelopment.js";

describe("local fixture entry boundary", () => {
  for (const origin of [
    "http://localhost:3000/login",
    "http://127.0.0.1:3000/login",
    "http://[::1]:3000/login",
    "https://localhost/login"
  ]) {
    it(`offers memory-only fixture work at ${origin}`, () => {
      assert.equal(localFixtureWorkspaceHref(origin), "/workspaces?adapter=fixture");
    });
  }

  for (const location of [
    "https://studio.opengeo.tools/login",
    "https://demo.studio.opengeo.tools/login",
    "https://localhost.attacker.example/login",
    "http://127.0.0.1.attacker.example/login",
    "http://localhost@attacker.example/login",
    "file:///tmp/opengeo/login.html",
    "not a URL",
    ""
  ]) {
    it(`does not expose fixture entry at ${location || "an empty location"}`, () => {
      assert.equal(localFixtureWorkspaceHref(location), null);
    });
  }
});

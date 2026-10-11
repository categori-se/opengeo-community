import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {
  readWorkspaceUiState,
  workspaceUiStateKey,
  writeWorkspaceUiState
} from "../src/lib/workspaceUiState.js";

describe("workspace UI context", () => {
  it("retains the quick toolbar choice across other panel changes", () => {
    const storage = memoryStorage();
    writeWorkspaceUiState("project-1", {quickToolsOpen: false}, storage);
    writeWorkspaceUiState("project-1", {rightOpen: true}, storage);
    assert.equal(readWorkspaceUiState("project-1", storage).quickToolsOpen, false);
    assert.equal(readWorkspaceUiState("project-1", storage).rightOpen, true);
    assert.equal(readWorkspaceUiState("project-2", storage), null);
  });
  it("round-trips bounded disclosure and panel preferences", () => {
    const storage = memoryStorage();
    writeWorkspaceUiState("project-1", {
      activePanel: "add",
      leftPanelMode: "browser",
      leftOpen: false,
      rightOpen: true,
      managementOpen: true,
      ignored: "not persisted"
    }, storage);

    assert.deepEqual(readWorkspaceUiState("project-1", storage), {
      activePanel: "add",
      leftPanelMode: "layers",
      leftOpen: false,
      rightOpen: true,
      managementOpen: true
    });
    assert.doesNotMatch(storage.getItem(workspaceUiStateKey("project-1")), /ignored/);
  });

  it("fails closed to safe defaults for malformed stored preferences", () => {
    const storage = memoryStorage();
    storage.setItem(workspaceUiStateKey("project-1"), JSON.stringify({
      activePanel: "execute-code",
      leftPanelMode: "secrets",
      leftOpen: "yes",
      rightOpen: 1,
      managementOpen: null
    }));

    assert.deepEqual(readWorkspaceUiState("project-1", storage), {
      activePanel: "style",
      leftPanelMode: "layers",
      leftOpen: true,
      rightOpen: false,
      managementOpen: false
    });
    assert.equal(readWorkspaceUiState("../escape", storage), null);
  });

  it("upgrades retired Places and Browser modes to the unified layer workflow", () => {
    const storage = memoryStorage();
    writeWorkspaceUiState("project-1", {leftPanelMode: "places"}, storage);
    assert.equal(readWorkspaceUiState("project-1", storage).leftPanelMode, "layers");
    storage.setItem(workspaceUiStateKey("project-1"), JSON.stringify({leftPanelMode: "browser"}));
    assert.equal(readWorkspaceUiState("project-1", storage).leftPanelMode, "layers");
  });
});

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value))
  };
}

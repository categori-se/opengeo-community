import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {
  MAX_MARKDOWN_SOURCE_CHARACTERS,
  applyMarkdownSource,
  markdownBlocks,
  markdownDownloadFilename,
  markdownPreviewTokens,
  validateMarkdownSource
} from "../src/lib/markdownSource.js";

describe("Markdown page source", () => {
  it("updates one Markdown block without moving or changing other governed blocks", () => {
    const content = {blocks: [
      {id: "introduction", type: "markdown", markdown: "# Old"},
      {id: "project-map", type: "map", resourceId: "a map", caption: null},
      {id: "methods", type: "markdown", markdown: "## Methods"}
    ]};

    const result = applyMarkdownSource(content, {
      blockId: "introduction",
      source: "# New\n\nUpdated source."
    });

    assert.equal(result.blockId, "introduction");
    assert.deepEqual(result.content.blocks.map(({id}) => id), ["introduction", "project-map", "methods"]);
    assert.equal(result.content.blocks[0].markdown, "# New\n\nUpdated source.");
    assert.strictEqual(result.content.blocks[1], content.blocks[1]);
    assert.equal(content.blocks[0].markdown, "# Old");
  });

  it("appends a valid unique Markdown block", () => {
    const content = {blocks: [
      {id: "page", type: "markdown", markdown: "Existing"},
      {id: "page-2", type: "map", resourceId: "map"}
    ]};
    const result = applyMarkdownSource(content, {source: "# Added"});

    assert.equal(result.blockId, "page-3");
    assert.deepEqual(result.content.blocks.at(-1), {
      id: "page-3",
      type: "markdown",
      markdown: "# Added"
    });
    assert.deepEqual(markdownBlocks(result.content).map(({id}) => id), ["page", "page-3"]);
  });

  it("rejects empty, oversized, and unavailable Markdown source edits", () => {
    assert.throws(() => validateMarkdownSource("  \n"), /must not be empty/);
    assert.throws(
      () => validateMarkdownSource("a".repeat(MAX_MARKDOWN_SOURCE_CHARACTERS + 1)),
      /exceeds 8000/
    );
    assert.throws(
      () => applyMarkdownSource({blocks: []}, {blockId: "missing", source: "Valid"}),
      /unavailable/
    );
  });

  it("tokenizes raw HTML and fenced JavaScript as inert preview text", () => {
    const tokens = markdownPreviewTokens([
      "# Safety",
      "",
      '<img src=x onerror="globalThis.compromised=true">',
      "",
      "```js",
      "globalThis.compromised = true;",
      "```"
    ].join("\n"));

    assert.deepEqual(tokens, [
      {type: "heading", level: 1, text: "Safety"},
      {type: "paragraph", text: '<img src=x onerror="globalThis.compromised=true">'},
      {type: "code", language: "js", text: "globalThis.compromised = true;"}
    ]);
  });

  it("creates bounded human-readable Markdown filenames", () => {
    assert.equal(markdownDownloadFilename("Nepal Energy / Access"), "nepal-energy-access.md");
    assert.equal(markdownDownloadFilename("***"), "opengeo-page.md");
    assert.ok(markdownDownloadFilename("a".repeat(200)).length <= 83);
  });
});

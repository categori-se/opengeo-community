import {
  MAX_MARKDOWN_SOURCE_CHARACTERS,
  MAX_MARKDOWN_SOURCE_FILE_BYTES,
  applyMarkdownSource,
  markdownBlocks,
  markdownDownloadFilename,
  markdownPreviewTokens,
  validateMarkdownSource
} from "../lib/markdownSource.js";

const NEW_BLOCK = "__new_markdown_block__";

export function MarkdownSourceEditor({
  contentControl,
  resourceSlug,
  validateContent,
  initialSourceArtifact = null
}) {
  const studio = document.createElement("section");
  studio.className = "markdown-source-studio";
  studio.dataset.state = "ready";
  studio.dataset.unapplied = "false";

  const heading = document.createElement("header");
  heading.append(
    text("h5", "Markdown page source"),
    text("span", ".md import/export · inert syntax outline", "project-resources-boundary")
  );
  const intro = text(
    "p",
    "Write the page here, then apply it to the draft. Save new version remains the explicit, immutable commit.",
    "project-resource-feedback"
  );

  const selector = document.createElement("select");
  selector.ariaLabel = "Markdown block";
  const source = document.createElement("textarea");
  source.ariaLabel = "Markdown source";
  source.maxLength = MAX_MARKDOWN_SOURCE_CHARACTERS;
  source.spellcheck = true;

  const preview = document.createElement("div");
  preview.className = "markdown-source-preview";
  preview.ariaLabel = "Inert Markdown syntax outline";
  preview.ariaLive = "polite";

  const sourcePanel = document.createElement("section");
  sourcePanel.className = "markdown-source-pane";
  sourcePanel.append(text("h6", "Source"), source);
  const previewPanel = document.createElement("section");
  previewPanel.className = "markdown-source-pane";
  previewPanel.append(text("h6", "Syntax outline"), preview);

  const importControl = document.createElement("input");
  importControl.type = "file";
  importControl.accept = ".md,.markdown,text/markdown,text/plain";
  importControl.ariaLabel = "Import Markdown file";
  const apply = text("button", "Apply Markdown to draft", "platform-button");
  apply.type = "button";
  const download = text("button", "Download .md", "platform-button secondary");
  download.type = "button";
  const feedback = text(
    "p",
    "This local outline renders a bounded Markdown subset as text. Use the pinned page preview for publication-equivalent output; HTML and Observable JavaScript are never executed here.",
    "project-resource-feedback"
  );
  feedback.ariaLive = "polite";

  const controls = document.createElement("div");
  controls.className = "markdown-source-controls";
  controls.append(labeled("Markdown block", selector), labeled("Import .md", importControl), apply, download);
  const panes = document.createElement("div");
  panes.className = "markdown-source-panes";
  panes.append(sourcePanel, previewPanel);
  studio.append(heading, intro, controls, panes, feedback);
  let loadedSelection = null;
  let loadedSource = "";

  function currentContent() {
    return validateContent(contentControl.value);
  }

  function populateSelector(selected = null) {
    const blocks = markdownBlocks(currentContent());
    selector.replaceChildren();
    for (const block of blocks) {
      const option = document.createElement("option");
      option.value = block.id;
      option.textContent = block.id;
      selector.append(option);
    }
    const add = document.createElement("option");
    add.value = NEW_BLOCK;
    add.textContent = "+ New Markdown block";
    selector.append(add);
    selector.value = selected && [...selector.options].some(({value}) => value === selected)
      ? selected
      : blocks[0]?.id ?? NEW_BLOCK;
    loadSelectedSource();
  }

  function loadSelectedSource() {
    const selected = markdownBlocks(currentContent()).find(({id}) => id === selector.value);
    source.value = selected?.markdown ?? "# Untitled page\n\nStart writing here.";
    loadedSelection = selector.value;
    loadedSource = source.value;
    studio.dataset.unapplied = "false";
    renderPreview(preview, source.value);
    feedback.textContent = selected
      ? `Editing ${selected.id}. Apply the source, then save a new resource version.`
      : "A new Markdown block will be appended when you apply this source.";
  }

  function restoreSourceArtifact(artifact) {
    if (!artifact || typeof artifact.sourceMarkdown !== "string") return;
    const selected = artifact.sourceBlockId === null
      ? null
      : markdownBlocks(currentContent()).find(({id}) => id === artifact.sourceBlockId);
    selector.value = selected ? selected.id : NEW_BLOCK;
    loadedSelection = selector.value;
    loadedSource = selected?.markdown ?? "# Untitled page\n\nStart writing here.";
    source.value = artifact.sourceMarkdown;
    const unapplied = !selected || selected.markdown !== artifact.sourceMarkdown;
    studio.dataset.unapplied = String(unapplied);
    studio.dataset.state = "recovered";
    renderPreview(preview, source.value);
    feedback.textContent = unapplied
      ? "Recovered private Markdown changes are not applied to mixed content yet."
      : `Recovered ${selected.id} from the private working draft.`;
  }

  selector.addEventListener("change", () => {
    try {
      if (studio.dataset.unapplied === "true") {
        selector.value = loadedSelection;
        studio.dataset.state = "dirty";
        feedback.textContent = "Apply the current Markdown source to the draft before switching blocks.";
        return;
      }
      loadSelectedSource();
      studio.dataset.state = "ready";
    } catch (error) {
      reportError(error);
    }
  });
  source.addEventListener("input", () => {
    renderPreview(preview, source.value);
    const dirty = source.value !== loadedSource;
    studio.dataset.unapplied = String(dirty);
    studio.dataset.state = dirty ? "dirty" : "ready";
    feedback.textContent = dirty
      ? "Editor changes are local. Apply them to the draft before saving or switching blocks."
      : "The editor matches the current draft.";
  });
  apply.addEventListener("click", () => {
    try {
      const result = applyMarkdownSource(currentContent(), {
        blockId: selector.value === NEW_BLOCK ? null : selector.value,
        source: source.value
      });
      const validated = validateContent(JSON.stringify(result.content));
      contentControl.value = JSON.stringify(validated, null, 2);
      contentControl.dispatchEvent(new Event("input", {bubbles: true}));
      populateSelector(result.blockId);
      studio.dataset.state = "applied";
      studio.dataset.unapplied = "false";
      feedback.textContent = `${result.blockId} is in the draft. Save new version to commit it.`;
    } catch (error) {
      reportError(error);
    }
  });
  importControl.addEventListener("change", async () => {
    try {
      const file = importControl.files?.[0];
      if (!file) return;
      if (file.size > MAX_MARKDOWN_SOURCE_FILE_BYTES
        || !/\.(?:md|markdown)$/i.test(file.name)) {
        throw new TypeError(`Markdown files must use .md or .markdown and be at most ${MAX_MARKDOWN_SOURCE_FILE_BYTES} bytes`);
      }
      const imported = validateMarkdownSource(await file.text());
      source.value = imported;
      renderPreview(preview, imported);
      studio.dataset.state = "imported";
      studio.dataset.unapplied = "true";
      feedback.textContent = `${file.name} is loaded locally. Apply it to the draft, then save a new version.`;
      studio.dispatchEvent(new Event("draftchange", {bubbles: true}));
    } catch (error) {
      reportError(error);
    } finally {
      importControl.value = "";
    }
  });
  download.addEventListener("click", () => {
    try {
      validateMarkdownSource(source.value);
      const url = URL.createObjectURL(new Blob([source.value], {type: "text/markdown;charset=utf-8"}));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = markdownDownloadFilename(resourceSlug);
      anchor.click();
      URL.revokeObjectURL(url);
      studio.dataset.state = "downloaded";
      feedback.textContent = `${anchor.download} downloaded from the current editor source.`;
    } catch (error) {
      reportError(error);
    }
  });

  function reportError(error) {
    studio.dataset.state = "error";
    feedback.textContent = `Markdown change was not applied (${error?.message ?? "invalid source"}).`;
  }

  try {
    populateSelector();
    restoreSourceArtifact(initialSourceArtifact);
  } catch (error) {
    reportError(error);
    apply.disabled = true;
    download.disabled = true;
  }
  studio.getSourceArtifact = () => {
    if (studio.dataset.unapplied === "true") {
      throw new TypeError("apply the current Markdown source before saving");
    }
    const selected = markdownBlocks(currentContent()).find(({id}) => id === selector.value);
    if (!selected || selected.markdown !== source.value) {
      throw new TypeError("select and apply one Markdown block before saving");
    }
    return {sourceBlockId: selected.id, sourceMarkdown: selected.markdown};
  };
  studio.getRecoveryArtifact = () => ({
    sourceBlockId: selector.value === NEW_BLOCK ? null : selector.value,
    sourceMarkdown: source.value
  });
  return studio;
}

function renderPreview(container, source) {
  const fragment = document.createDocumentFragment();
  for (const token of markdownPreviewTokens(source)) {
    if (token.type === "heading") {
      fragment.append(text(`h${Math.min(token.level + 2, 6)}`, token.text));
    } else if (token.type === "paragraph") {
      fragment.append(text("p", token.text));
    } else if (token.type === "quote") {
      fragment.append(text("blockquote", token.text));
    } else if (token.type === "rule") {
      fragment.append(document.createElement("hr"));
    } else if (token.type === "code") {
      const code = text("code", token.text);
      if (token.language) code.dataset.language = token.language;
      const pre = document.createElement("pre");
      pre.append(code);
      fragment.append(pre);
    } else if (token.type === "list") {
      const list = document.createElement(token.ordered ? "ol" : "ul");
      for (const item of token.items) list.append(text("li", item));
      fragment.append(list);
    }
  }
  if (!fragment.childNodes.length) fragment.append(text("p", "Nothing to preview yet."));
  container.replaceChildren(fragment);
}

function labeled(value, control) {
  const label = document.createElement("label");
  label.append(text("span", value), control);
  return label;
}

function text(tag, content, className = null) {
  const element = document.createElement(tag);
  element.textContent = content;
  if (className) element.className = className;
  return element;
}

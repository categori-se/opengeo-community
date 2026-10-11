export const MAX_MARKDOWN_SOURCE_CHARACTERS = 8_000;
export const MAX_MARKDOWN_SOURCE_FILE_BYTES = 8_000;

const BLOCK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function markdownBlocks(content) {
  const blocks = contentBlocks(content);
  return blocks.filter((block) => block?.type === "markdown");
}

export function applyMarkdownSource(content, {blockId = null, source}) {
  const blocks = contentBlocks(content);
  const markdown = validateMarkdownSource(source);
  if (blockId === null) {
    if (blocks.length >= 24) throw new TypeError("mixed content already has 24 blocks");
    const id = nextMarkdownBlockId(blocks);
    return {
      blockId: id,
      content: {...content, blocks: [...blocks, {id, type: "markdown", markdown}]}
    };
  }

  validateBlockId(blockId);
  const index = blocks.findIndex((block) => block?.id === blockId);
  if (index < 0 || blocks[index]?.type !== "markdown") {
    throw new TypeError("selected Markdown block is unavailable");
  }
  const updated = blocks.slice();
  updated[index] = {...blocks[index], markdown};
  return {blockId, content: {...content, blocks: updated}};
}

export function validateMarkdownSource(source) {
  if (typeof source !== "string" || !source.trim()) {
    throw new TypeError("Markdown source must not be empty");
  }
  if (source.length > MAX_MARKDOWN_SOURCE_CHARACTERS) {
    throw new TypeError(`Markdown source exceeds ${MAX_MARKDOWN_SOURCE_CHARACTERS} characters`);
  }
  return source;
}

export function markdownDownloadFilename(slug) {
  const stem = String(slug ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return `${stem || "opengeo-page"}.md`;
}

export function markdownPreviewTokens(source) {
  if (typeof source !== "string") throw new TypeError("Markdown source must be a string");
  const tokens = [];
  const paragraph = [];
  let code = null;
  let list = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    tokens.push({type: "paragraph", text: paragraph.join(" ")});
    paragraph.length = 0;
  };
  const flushList = () => {
    if (!list) return;
    tokens.push(list);
    list = null;
  };

  for (const line of source.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")) {
    const fence = line.match(/^\s*```\s*([^\s`]*)\s*$/);
    if (fence) {
      flushParagraph();
      flushList();
      if (code) {
        tokens.push({type: "code", language: code.language, text: code.lines.join("\n")});
        code = null;
      } else {
        code = {language: fence[1] || null, lines: []};
      }
      continue;
    }
    if (code) {
      code.lines.push(line);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushParagraph();
      flushList();
      tokens.push({type: "heading", level: heading[1].length, text: heading[2]});
      continue;
    }
    const listItem = line.match(/^\s*(?:(\d+)[.)]|[-+*])\s+(.+)$/);
    if (listItem) {
      flushParagraph();
      const ordered = Boolean(listItem[1]);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = {type: "list", ordered, items: []};
      }
      list.items.push(listItem[2]);
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      flushList();
      tokens.push({type: "quote", text: quote[1]});
      continue;
    }
    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
      flushParagraph();
      flushList();
      tokens.push({type: "rule"});
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();
  if (code) tokens.push({type: "code", language: code.language, text: code.lines.join("\n")});
  return tokens;
}

function contentBlocks(content) {
  if (!content || typeof content !== "object" || Array.isArray(content)
    || !Array.isArray(content.blocks) || content.blocks.length > 24) {
    throw new TypeError("mixed content must contain at most 24 blocks");
  }
  return content.blocks;
}

function nextMarkdownBlockId(blocks) {
  const ids = new Set(blocks.map((block) => block?.id));
  let id = "page";
  let suffix = 2;
  while (ids.has(id)) {
    id = `page-${suffix}`;
    suffix += 1;
  }
  return id;
}

function validateBlockId(value) {
  if (typeof value !== "string" || value.length > 100 || !BLOCK_ID_PATTERN.test(value)) {
    throw new TypeError("Markdown block id is invalid");
  }
  return value;
}

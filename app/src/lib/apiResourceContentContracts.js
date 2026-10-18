/** Authored resource content parsing and serialization; no request or session state. */
import {
  assertUuid,
  uuid,
  boundedString,
  nullableBoundedString,
  positiveInteger,
  oneOf,
  object,
  boundedObject,
  parseArray,
  contract,
  exactKeys,
  integerBetween,
  publicSourceUrl
} from "./apiResponseContracts.js";

export function parseResourceContent(value) {
  const record = boundedObject(value, 16_384, "resource.content");
  exactKeys(record, ["blocks"], "resource.content");
  const blocks = parseArray(record.blocks, (value) => {
    const block = object(value, "resource content block");
    const type = oneOf(block.type, ["markdown", "heading", "callout", "navigation", "map", "dataset", "link", "citation", "table", "chart", "image", "file", "document", "preserved"], "resource content block.type");
    const id = boundedString(block.id, 100, "resource content block.id");
    if (type === "markdown") {
      exactKeys(block, ["id", "type", "markdown"], "markdown block");
      return {id, type, markdown: boundedString(block.markdown, 8_000, "markdown block.markdown")};
    }
    if (type === "heading") {
      exactKeys(block, ["id", "type", "level", "text"], "heading block");
      return {
        id,
        type,
        level: integerBetween(block.level, 2, 4, "heading block.level"),
        text: boundedString(block.text, 300, "heading block.text")
      };
    }
    if (type === "callout") {
      exactKeys(block, ["id", "type", "tone", "title", "markdown"], "callout block");
      return {
        id,
        type,
        tone: oneOf(block.tone, ["note", "tip", "warning", "important"], "callout block.tone"),
        title: boundedString(block.title, 300, "callout block.title"),
        markdown: boundedString(block.markdown, 2_000, "callout block.markdown")
      };
    }
    if (type === "navigation") {
      exactKeys(block, ["id", "type", "label", "heading_block_ids"], "navigation block");
      return {
        id,
        type,
        label: boundedString(block.label, 300, "navigation block.label"),
        headingBlockIds: parseHeadingBlockIds(block.heading_block_ids)
      };
    }
    if (type === "map" || type === "dataset") {
      const expected = ["id", "type", "resource_id"];
      if (block.resource_version_number !== undefined) expected.push("resource_version_number");
      if (block.caption !== undefined) expected.push("caption");
      exactKeys(block, expected, "resource reference block");
      return {
        id,
        type,
        resourceId: uuid(block.resource_id, "resource reference block.resource_id"),
        resourceVersionNumber: block.resource_version_number === undefined
          ? null
          : positiveInteger(
            block.resource_version_number,
            "resource reference block.resource_version_number"
          ),
        caption: block.caption === undefined ? null : nullableBoundedString(block.caption, 300, "resource reference block.caption")
      };
    }
    if (type === "link") {
      exactKeys(block, ["id", "type", "url", "label"], "resource link block");
      return {id, type, url: publicSourceUrl(block.url, "resource"), label: boundedString(block.label, 300, "resource link block.label")};
    }
    if (type === "citation") {
      exactKeys(block, ["id", "type", "title", "doi", "url"].filter((key) => block[key] !== undefined), "resource citation block");
      return {
        id,
        type,
        title: boundedString(block.title, 300, "resource citation block.title"),
        doi: block.doi === undefined ? null : nullableBoundedString(block.doi, 200, "resource citation block.doi"),
        url: block.url === undefined || block.url === null ? null : publicSourceUrl(block.url, "resource")
      };
    }
    if (type === "table") {
      exactKeys(block, ["id", "type", "caption", "columns", "rows"], "resource table block");
      return parseTableBlock({id, type, ...block});
    }
    if (type === "chart") {
      exactKeys(
        block,
        ["id", "type", "chart_type", "title", "alt_text", "table_block_id", "x_column", "y_columns"],
        "resource chart block"
      );
      return {
        id,
        type,
        chartType: oneOf(block.chart_type, ["bar", "line"], "chart block.chart_type"),
        title: boundedString(block.title, 300, "chart block.title"),
        altText: boundedString(block.alt_text, 1_000, "chart block.alt_text"),
        tableBlockId: boundedString(block.table_block_id, 100, "chart block.table_block_id"),
        xColumn: boundedString(block.x_column, 300, "chart block.x_column"),
        yColumns: parseChartColumns(block.y_columns)
      };
    }
    if (type === "image") {
      exactKeys(
        block,
        ["id", "type", "dataset_id", "dataset_version_id", "object_id", "alt_text", "caption"]
          .filter((key) => block[key] !== undefined),
        "resource image block"
      );
      return {
        id,
        type,
        datasetId: uuid(block.dataset_id, "image block.dataset_id"),
        datasetVersionId: uuid(block.dataset_version_id, "image block.dataset_version_id"),
        objectId: uuid(block.object_id, "image block.object_id"),
        altText: boundedString(block.alt_text, 1_000, "image block.alt_text"),
        caption: block.caption === undefined
          ? null
          : nullableBoundedString(block.caption, 300, "image block.caption")
      };
    }
    if (type === "file") {
      exactKeys(
        block,
        ["id", "type", "dataset_id", "dataset_version_id", "object_id", "label", "description"]
          .filter((key) => block[key] !== undefined),
        "resource file block"
      );
      return {
        id,
        type,
        datasetId: uuid(block.dataset_id, "file block.dataset_id"),
        datasetVersionId: uuid(block.dataset_version_id, "file block.dataset_version_id"),
        objectId: uuid(block.object_id, "file block.object_id"),
        label: boundedString(block.label, 300, "file block.label"),
        description: block.description === undefined
          ? null
          : nullableBoundedString(block.description, 1_000, "file block.description")
      };
    }
    if (type === "document") {
      exactKeys(
        block,
        ["id", "type", "dataset_id", "dataset_version_id", "object_id", "label"],
        "resource document block"
      );
      return {
        id,
        type,
        datasetId: uuid(block.dataset_id, "document block.dataset_id"),
        datasetVersionId: uuid(block.dataset_version_id, "document block.dataset_version_id"),
        objectId: uuid(block.object_id, "document block.object_id"),
        label: boundedString(block.label, 300, "document block.label")
      };
    }
    exactKeys(block, ["id", "type", "namespace", "label"], "preserved resource block");
    return {
      id,
      type,
      namespace: boundedString(block.namespace, 100, "preserved block.namespace"),
      label: boundedString(block.label, 300, "preserved block.label")
    };
  }, "resource.content.blocks");
  if (blocks.length > 24 || new Set(blocks.map((block) => block.id)).size !== blocks.length) {
    contract("resource.content.blocks is invalid");
  }
  validateParsedCharts(blocks);
  validateParsedStructure(blocks);
  return {blocks};
}

export function serializeResourceContent(value) {
  const record = object(value, "resource content");
  exactKeys(record, ["blocks"], "resource content");
  if (!Array.isArray(record.blocks) || record.blocks.length > 24) {
    throw new TypeError("resource content blocks are invalid");
  }
  const ids = new Set();
  const result = record.blocks.map((value) => {
    const block = object(value, "resource content block");
    const type = oneOf(
      block.type,
      ["markdown", "heading", "callout", "navigation", "map", "dataset", "link", "citation", "table", "chart", "image", "file", "document", "preserved"],
      "resource content block.type"
    );
    const id = contentBlockId(block.id);
    if (ids.has(id)) throw new TypeError("resource content block ids must be unique");
    ids.add(id);
    if (type === "markdown") {
      exactKeys(block, ["id", "type", "markdown"], "markdown block");
      return {id, type, markdown: boundedString(block.markdown, 8_000, "markdown block.markdown")};
    }
    if (type === "heading") {
      exactKeys(block, ["id", "type", "level", "text"], "heading block");
      return {
        id,
        type,
        level: integerBetween(block.level, 2, 4, "heading block.level"),
        text: boundedString(block.text, 300, "heading block.text")
      };
    }
    if (type === "callout") {
      exactKeys(block, ["id", "type", "tone", "title", "markdown"], "callout block");
      return {
        id,
        type,
        tone: oneOf(block.tone, ["note", "tip", "warning", "important"], "callout block.tone"),
        title: boundedString(block.title, 300, "callout block.title"),
        markdown: boundedString(block.markdown, 2_000, "callout block.markdown")
      };
    }
    if (type === "navigation") {
      exactKeys(block, ["id", "type", "label", "headingBlockIds"], "navigation block");
      return {
        id,
        type,
        label: boundedString(block.label, 300, "navigation block.label"),
        heading_block_ids: parseHeadingBlockIds(block.headingBlockIds)
      };
    }
    if (type === "map" || type === "dataset") {
      exactKeys(
        block,
        ["id", "type", "resourceId", "resourceVersionNumber", "caption"]
          .filter((key) => block[key] !== undefined),
        "resource reference block"
      );
      return {
        id,
        type,
        resource_id: assertUuid(block.resourceId, "resource reference block.resourceId"),
        ...(block.resourceVersionNumber === undefined || block.resourceVersionNumber === null
          ? {}
          : {
            resource_version_number: positiveInteger(
              block.resourceVersionNumber,
              "resource reference block.resourceVersionNumber"
            )
          }),
        ...(block.caption === undefined || block.caption === null
          ? {}
          : {caption: boundedString(block.caption, 300, "resource reference block.caption")})
      };
    }
    if (type === "link") {
      exactKeys(block, ["id", "type", "url", "label"], "resource link block");
      return {
        id,
        type,
        url: publicSourceUrl(block.url, "resource"),
        label: boundedString(block.label, 300, "resource link block.label")
      };
    }
    if (type === "citation") {
      exactKeys(
        block,
        ["id", "type", "title", "doi", "url"].filter((key) => block[key] !== undefined),
        "resource citation block"
      );
      const doi = block.doi === undefined || block.doi === null
        ? null
        : boundedString(block.doi, 200, "resource citation block.doi");
      const url = block.url === undefined || block.url === null
        ? null
        : publicSourceUrl(block.url, "resource");
      if (doi === null && url === null) throw new TypeError("citation requires a DOI or URL");
      return {
        id,
        type,
        title: boundedString(block.title, 300, "resource citation block.title"),
        doi,
        url
      };
    }
    if (type === "table") {
      exactKeys(block, ["id", "type", "caption", "columns", "rows"], "resource table block");
      const parsed = parseTableBlock({id, type, ...block});
      return {
        id,
        type,
        caption: parsed.caption,
        columns: parsed.columns,
        rows: parsed.rows
      };
    }
    if (type === "chart") {
      exactKeys(
        block,
        ["id", "type", "chartType", "title", "altText", "tableBlockId", "xColumn", "yColumns"],
        "resource chart block"
      );
      return {
        id,
        type,
        chart_type: oneOf(block.chartType, ["bar", "line"], "chart block.chartType"),
        title: boundedString(block.title, 300, "chart block.title"),
        alt_text: boundedString(block.altText, 1_000, "chart block.altText"),
        table_block_id: contentBlockId(block.tableBlockId),
        x_column: boundedString(block.xColumn, 300, "chart block.xColumn"),
        y_columns: parseChartColumns(block.yColumns)
      };
    }
    if (type === "image") {
      exactKeys(
        block,
        ["id", "type", "datasetId", "datasetVersionId", "objectId", "altText", "caption"]
          .filter((key) => block[key] !== undefined),
        "resource image block"
      );
      return {
        id,
        type,
        dataset_id: assertUuid(block.datasetId, "image block.datasetId"),
        dataset_version_id: assertUuid(block.datasetVersionId, "image block.datasetVersionId"),
        object_id: assertUuid(block.objectId, "image block.objectId"),
        alt_text: boundedString(block.altText, 1_000, "image block.altText"),
        ...(block.caption === undefined || block.caption === null
          ? {}
          : {caption: boundedString(block.caption, 300, "image block.caption")})
      };
    }
    if (type === "file") {
      exactKeys(
        block,
        ["id", "type", "datasetId", "datasetVersionId", "objectId", "label", "description"]
          .filter((key) => block[key] !== undefined),
        "resource file block"
      );
      return {
        id,
        type,
        dataset_id: assertUuid(block.datasetId, "file block.datasetId"),
        dataset_version_id: assertUuid(block.datasetVersionId, "file block.datasetVersionId"),
        object_id: assertUuid(block.objectId, "file block.objectId"),
        label: boundedString(block.label, 300, "file block.label"),
        ...(block.description === undefined || block.description === null
          ? {}
          : {description: boundedString(block.description, 1_000, "file block.description")})
      };
    }
    if (type === "document") {
      exactKeys(
        block,
        ["id", "type", "datasetId", "datasetVersionId", "objectId", "label"],
        "resource document block"
      );
      return {
        id,
        type,
        dataset_id: assertUuid(block.datasetId, "document block.datasetId"),
        dataset_version_id: assertUuid(block.datasetVersionId, "document block.datasetVersionId"),
        object_id: assertUuid(block.objectId, "document block.objectId"),
        label: boundedString(block.label, 300, "document block.label")
      };
    }
    exactKeys(block, ["id", "type", "namespace", "label"], "preserved resource block");
    return {
      id,
      type,
      namespace: boundedString(block.namespace, 100, "preserved block.namespace"),
      label: boundedString(block.label, 300, "preserved block.label")
    };
  });
  validateSerializedCharts(result);
  validateSerializedStructure(result);
  const serialized = {blocks: result};
  boundedObject(serialized, 16_384, "resource content");
  return serialized;
}

function validateSerializedCharts(blocks) {
  const tables = new Map(
    blocks.filter((block) => block.type === "table").map((block) => [block.id, block])
  );
  for (const chart of blocks.filter((block) => block.type === "chart")) {
    const table = tables.get(chart.table_block_id);
    if (!table) throw new TypeError("chart must reference a table block");
    const columns = new Map(
      table.columns.map((column, index) => [column.toLowerCase(), index])
    );
    const xIndex = columns.get(chart.x_column.toLowerCase());
    const yIndexes = chart.y_columns.map((column) => columns.get(column.toLowerCase()));
    if (xIndex === undefined || yIndexes.some((index) => index === undefined)
      || chart.y_columns.some((column) => column.toLowerCase() === chart.x_column.toLowerCase())) {
      throw new TypeError("chart columns are invalid");
    }
    for (const index of yIndexes) {
      const values = table.rows.map((row) => row[index]).filter((value) => value !== null);
      if (!values.length || values.some((value) => typeof value !== "number")) {
        throw new TypeError("chart value columns must contain only numbers");
      }
    }
  }
}

function parseTableBlock(block) {
  const columns = parseArray(
    block.columns,
    (value) => boundedString(value, 300, "table block column"),
    "table block.columns"
  );
  if (!columns.length || columns.length > 12
    || new Set(columns.map((value) => value.toLowerCase())).size !== columns.length) {
    contract("table block columns are invalid");
  }
  if (!Array.isArray(block.rows) || block.rows.length > 50) {
    contract("table block rows are invalid");
  }
  const rows = block.rows.map((row) => {
    if (!Array.isArray(row) || row.length !== columns.length) {
      contract("table block row width is invalid");
    }
    return row.map(tableCell);
  });
  return {
    id: contentBlockId(block.id),
    type: "table",
    caption: boundedString(block.caption, 300, "table block.caption"),
    columns,
    rows
  };
}

function tableCell(value) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string" && value.length <= 300) return value;
  if (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e15) {
    return value;
  }
  contract("table cell is invalid");
}

function parseChartColumns(value) {
  const columns = parseArray(
    value,
    (column) => boundedString(column, 300, "chart value column"),
    "chart value columns"
  );
  if (!columns.length || columns.length > 4
    || new Set(columns.map((column) => column.toLowerCase())).size !== columns.length) {
    contract("chart value columns are invalid");
  }
  return columns;
}

function parseHeadingBlockIds(value) {
  const targets = parseArray(
    value,
    (target) => contentBlockId(target),
    "navigation heading targets"
  );
  if (!targets.length || targets.length > 12 || new Set(targets).size !== targets.length) {
    contract("navigation heading targets are invalid");
  }
  return targets;
}

function contentBlockId(value) {
  const id = boundedString(value, 100, "resource content block.id");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) contract("resource content block.id is invalid");
  return id;
}

function validateParsedCharts(blocks) {
  const tables = new Map(
    blocks.filter((block) => block.type === "table").map((block) => [block.id, block])
  );
  for (const chart of blocks.filter((block) => block.type === "chart")) {
    const table = tables.get(chart.tableBlockId);
    if (!table) contract("chart table reference is invalid");
    const columns = new Map(
      table.columns.map((column, index) => [column.toLowerCase(), index])
    );
    const xIndex = columns.get(chart.xColumn.toLowerCase());
    const yIndexes = chart.yColumns.map((column) => columns.get(column.toLowerCase()));
    if (xIndex === undefined || yIndexes.some((index) => index === undefined)
      || chart.yColumns.some((column) => column.toLowerCase() === chart.xColumn.toLowerCase())) {
      contract("chart columns are invalid");
    }
    for (const index of yIndexes) {
      const values = table.rows.map((row) => row[index]).filter((value) => value !== null);
      if (!values.length || values.some((value) => typeof value !== "number")) {
        contract("chart value columns are invalid");
      }
    }
  }
}

function validateParsedStructure(blocks) {
  validateStructure(
    blocks,
    (navigation) => navigation.headingBlockIds,
    (message) => contract(message)
  );
}

function validateSerializedStructure(blocks) {
  validateStructure(
    blocks,
    (navigation) => navigation.heading_block_ids,
    (message) => {
      throw new TypeError(message);
    }
  );
}

function validateStructure(blocks, targetsFor, fail) {
  const headings = new Map();
  let previousLevel = null;
  for (const [position, block] of blocks.entries()) {
    if (block.type !== "heading") continue;
    if (previousLevel === null && block.level !== 2) {
      fail("the first structural heading must be level 2");
    }
    if (previousLevel !== null && block.level > previousLevel + 1) {
      fail("structural heading levels cannot be skipped");
    }
    previousLevel = block.level;
    headings.set(block.id, position);
  }
  for (const navigation of blocks.filter((block) => block.type === "navigation")) {
    const targets = targetsFor(navigation);
    if (targets.some((target) => !headings.has(target))) {
      fail("navigation must target headings in the same resource");
    }
    const positions = targets.map((target) => headings.get(target));
    if (positions.some((position, index) => index && position < positions[index - 1])) {
      fail("navigation headings must preserve document order");
    }
  }
}

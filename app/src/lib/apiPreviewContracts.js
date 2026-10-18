/** Bounded spatial and document preview response contracts; no request or session state. */
import {
  uuid,
  string,
  boundedString,
  boolean,
  nonNegativeInteger,
  oneOf,
  object,
  boundedObject,
  parseArray,
  contract,
  exactKeys,
  integerBetween,
  sha256Checksum
} from "./apiResponseContracts.js";

export function parseSpatialPreview(value) {
  const record = boundedObject(value, 4_300_000, "spatial preview");
  exactKeys(record, [
    "schema_version", "dataset_version_id", "number_returned",
    "number_matched", "may_be_truncated", "geojson"
  ], "spatial preview");
  if (record.schema_version !== "opengeo.spatial-preview.1.0.0") {
    contract("spatial preview schema is unsupported");
  }
  const numberReturned = integerBetween(
    record.number_returned, 0, 5_000, "spatial preview.number_returned"
  );
  const numberMatched = record.number_matched === null
    ? null
    : nonNegativeInteger(record.number_matched, "spatial preview.number_matched");
  const mayBeTruncated = boolean(
    record.may_be_truncated, "spatial preview.may_be_truncated"
  );
  if (
    (numberMatched !== null && numberReturned > numberMatched)
    || mayBeTruncated !== (numberMatched === null || numberReturned < numberMatched)
  ) {
    contract("spatial preview counts are inconsistent");
  }
  const geojson = spatialPreviewGeojson(record.geojson);
  if (geojson.features.length !== numberReturned) {
    contract("spatial preview feature count is inconsistent");
  }
  return {
    schemaVersion: record.schema_version,
    datasetVersionId: uuid(record.dataset_version_id, "spatial preview.dataset_version_id"),
    numberReturned,
    numberMatched,
    mayBeTruncated,
    geojson
  };
}

export function spatialPreviewGeojson(value) {
  const collection = boundedObject(value, 4_194_304, "spatial preview GeoJSON");
  const keys = Object.keys(collection);
  if (keys.some((key) => !["type", "name", "bbox", "features"].includes(key))) {
    contract("spatial preview GeoJSON has unsupported members");
  }
  if (collection.type !== "FeatureCollection") {
    contract("spatial preview GeoJSON type is invalid");
  }
  if (collection.name !== undefined) {
    boundedString(collection.name, 300, "spatial preview GeoJSON name");
  }
  if (collection.bbox !== undefined) spatialPreviewBbox(collection.bbox);
  const budget = {positions: 0, nodes: 0};
  const features = parseArray(
    collection.features,
    (feature) => spatialPreviewFeature(feature, budget),
    "spatial preview GeoJSON features"
  );
  if (features.length > 5_000) contract("spatial preview has too many features");
  return structuredClone({...collection, features});
}

function spatialPreviewFeature(value, budget) {
  const feature = object(value, "spatial preview feature");
  if (Object.keys(feature).some(
    (key) => !["type", "id", "bbox", "geometry", "properties"].includes(key)
  ) || feature.type !== "Feature" || !("geometry" in feature) || !("properties" in feature)) {
    contract("spatial preview feature is invalid");
  }
  if (feature.id !== undefined && (
    !["string", "number"].includes(typeof feature.id)
    || (typeof feature.id === "number" && !Number.isFinite(feature.id))
    || (typeof feature.id === "string" && (!feature.id.length || feature.id.length > 512))
  )) contract("spatial preview feature id is invalid");
  if (feature.bbox !== undefined) spatialPreviewBbox(feature.bbox);
  const geometry = feature.geometry === null
    ? null
    : spatialPreviewGeometry(feature.geometry, budget, 0);
  const properties = boundedObject(feature.properties, 262_144, "spatial preview properties");
  if (Object.keys(properties).length > 256) contract("spatial preview has too many properties");
  spatialPreviewJson(properties, budget, 0);
  return structuredClone({...feature, geometry, properties});
}

function spatialPreviewGeometry(value, budget, depth) {
  const geometry = object(value, "spatial preview geometry");
  if (depth > 2 || Object.keys(geometry).some(
    (key) => !["type", "bbox", "coordinates", "geometries"].includes(key)
  )) contract("spatial preview geometry is invalid");
  if (geometry.bbox !== undefined) spatialPreviewBbox(geometry.bbox);
  const kind = oneOf(geometry.type, [
    "Point", "MultiPoint", "LineString", "MultiLineString",
    "Polygon", "MultiPolygon", "GeometryCollection"
  ], "spatial preview geometry type");
  if (kind === "GeometryCollection") {
    if ("coordinates" in geometry) contract("spatial preview geometry is invalid");
    const geometries = parseArray(
      geometry.geometries,
      (item) => spatialPreviewGeometry(item, budget, depth + 1),
      "spatial preview geometries"
    );
    if (geometries.length > 64) contract("spatial preview has too many geometries");
    return structuredClone({...geometry, geometries});
  }
  if ("geometries" in geometry || !("coordinates" in geometry)) {
    contract("spatial preview geometry is invalid");
  }
  spatialPreviewCoordinates(kind, geometry.coordinates, budget);
  return structuredClone(geometry);
}

function spatialPreviewCoordinates(kind, coordinates, budget) {
  if (kind === "Point") return spatialPreviewPosition(coordinates, budget);
  const level = (values, child) => {
    if (!Array.isArray(values) || values.length > 200_000) {
      contract("spatial preview coordinates are invalid");
    }
    for (const value of values) child(value);
  };
  if (kind === "MultiPoint" || kind === "LineString") {
    level(coordinates, (value) => spatialPreviewPosition(value, budget));
    if (kind === "LineString" && coordinates.length < 2) {
      contract("spatial preview line is invalid");
    }
    return;
  }
  if (kind === "MultiLineString" || kind === "Polygon") {
    level(coordinates, (values) => {
      level(values, (value) => spatialPreviewPosition(value, budget));
      if (values.length < (kind === "Polygon" ? 4 : 2)) {
        contract("spatial preview coordinate group is invalid");
      }
      if (kind === "Polygon" && !samePreviewPosition(values[0], values.at(-1))) {
        contract("spatial preview polygon is not closed");
      }
    });
    return;
  }
  level(coordinates, (groups) => level(groups, (values) => {
    level(values, (value) => spatialPreviewPosition(value, budget));
    if (values.length < 4 || !samePreviewPosition(values[0], values.at(-1))) {
      contract("spatial preview polygon is invalid");
    }
  }));
}

function spatialPreviewPosition(value, budget) {
  if (
    !Array.isArray(value)
    || ![2, 3].includes(value.length)
    || !value.every(Number.isFinite)
    || value[0] < -180 || value[0] > 180
    || value[1] < -90 || value[1] > 90
  ) contract("spatial preview position is invalid");
  budget.positions += 1;
  if (budget.positions > 200_000) contract("spatial preview has too many positions");
}

function samePreviewPosition(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left[0] === right[0] && left[1] === right[1];
}

function spatialPreviewBbox(value) {
  if (
    !Array.isArray(value) || ![4, 6].includes(value.length)
    || !value.every(Number.isFinite)
  ) contract("spatial preview bbox is invalid");
  const half = value.length / 2;
  if (value[0] < -180 || value[1] < -90 || value[half] > 180 || value[half + 1] > 90) {
    contract("spatial preview bbox is outside WGS84");
  }
  for (let index = 0; index < half; index += 1) {
    if (value[index] > value[index + half]) contract("spatial preview bbox is unordered");
  }
}

function spatialPreviewJson(value, budget, depth) {
  if (depth > 8 || ++budget.nodes > 400_000) {
    contract("spatial preview properties are too complex");
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value === "string" && value.length <= 8_192 && !value.includes("\0")) return;
  if (Array.isArray(value)) {
    if (value.length > 1_024) contract("spatial preview property array is too large");
    for (const item of value) spatialPreviewJson(item, budget, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length > 256) contract("spatial preview property object is too large");
    for (const [key, item] of entries) {
      if (!key.length || key.length > 256 || key.includes("\0")) {
        contract("spatial preview property name is invalid");
      }
      spatialPreviewJson(item, budget, depth + 1);
    }
    return;
  }
  contract("spatial preview property is invalid");
}

export function parseDocumentPreview(value) {
  const record = boundedObject(value, 4_194_304, "document preview");
  let variant;
  let isOcrPdf = false;
  let isVisualPdf = false;
  if (
    record.schemaVersion === "opengeo.document-preview.1.0.0"
    && record.sourceFormat === "odt"
  ) {
    exactKeys(
      record,
      ["schemaVersion", "sourceFormat", "odfVersion", "title", "language", "pages"],
      "document preview"
    );
    variant = {
      schemaVersion: oneOf(
        record.schemaVersion,
        ["opengeo.document-preview.1.0.0"],
        "document preview schema"
      ),
      sourceFormat: oneOf(record.sourceFormat, ["odt"], "document preview source format"),
      odfVersion: oneOf(record.odfVersion, ["1.2", "1.3", "1.4"], "ODF version")
    };
  } else if (
    [
      "opengeo.document-preview.2.0.0",
      "opengeo.document-preview.3.0.0",
      "opengeo.pdf-visual-presentation.1.0.0",
      "opengeo.pdf-visual-presentation.2.0.0"
    ]
      .includes(record.schemaVersion)
    && record.sourceFormat === "pdf"
  ) {
    isOcrPdf = [
      "opengeo.document-preview.3.0.0",
      "opengeo.pdf-visual-presentation.2.0.0"
    ].includes(record.schemaVersion);
    isVisualPdf = [
      "opengeo.pdf-visual-presentation.1.0.0",
      "opengeo.pdf-visual-presentation.2.0.0"
    ].includes(record.schemaVersion);
    exactKeys(
      record,
      [
        "schemaVersion", "sourceFormat", "pdfVersion", "title", "language", "extraction",
        ...(isVisualPdf ? ["rendering"] : []),
        "pages"
      ],
      "document preview"
    );
    const extraction = object(record.extraction, "PDF text extraction");
    exactKeys(
      extraction,
      isOcrPdf
        ? [
            "engine", "mode", "ocrPerformed", "ocrEngine", "ocrEngineVersion", "ocrModel",
            "ocrPageLimit", "ocrPages", "ocrPixelLimit", "ocrMaximumDimension",
            "ocrTotalPixels", "ocrTruncated", "readingOrder", "tagged", "textAvailable"
          ]
        : ["engine", "mode", "ocrPerformed", "readingOrder", "tagged", "textAvailable"],
      "PDF text extraction"
    );
    let parsedExtraction;
    if (isOcrPdf) {
      const ocrEngineVersion = string(extraction.ocrEngineVersion, "PDF OCR engine version");
      if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+._A-Za-z0-9]{0,24})?$/.test(ocrEngineVersion)) {
        contract("PDF OCR engine version is invalid");
      }
      const ocrPages = parseArray(
        extraction.ocrPages,
        (page) => integerBetween(page, 1, 200, "PDF OCR page"),
        "PDF OCR pages"
      );
      if (
        !ocrPages.length
        || ocrPages.length > 32
        || ocrPages.some((page, index) => index > 0 && page <= ocrPages[index - 1])
      ) {
        contract("PDF OCR pages are invalid");
      }
      parsedExtraction = {
        engine: oneOf(extraction.engine, ["poppler-pdftotext+tesseract"], "PDF extraction engine"),
        mode: oneOf(extraction.mode, ["layout+page-ocr"], "PDF extraction mode"),
        ocrPerformed: oneOf(extraction.ocrPerformed, [true], "PDF OCR state"),
        ocrEngine: oneOf(extraction.ocrEngine, ["tesseract"], "PDF OCR engine"),
        ocrEngineVersion,
        ocrModel: oneOf(extraction.ocrModel, [
          "eng", "Arabic", "Bengali", "Cyrillic", "Devanagari", "Ethiopic", "Greek",
          "Hangul", "HanS", "HanT", "Hebrew", "Japanese", "Latin", "Thai"
        ], "PDF OCR model"),
        ocrPageLimit: oneOf(extraction.ocrPageLimit, [32], "PDF OCR page limit"),
        ocrPages,
        ocrPixelLimit: oneOf(extraction.ocrPixelLimit, [32_000_000], "PDF OCR pixel limit"),
        ocrMaximumDimension: integerBetween(
          extraction.ocrMaximumDimension, 300, 1_600, "PDF OCR maximum dimension"
        ),
        ocrTotalPixels: integerBetween(
          extraction.ocrTotalPixels, 1, 32_000_000, "PDF OCR total pixels"
        ),
        ocrTruncated: boolean(extraction.ocrTruncated, "PDF OCR truncation state"),
        readingOrder: oneOf(extraction.readingOrder, ["heuristic"], "PDF reading order"),
        tagged: boolean(extraction.tagged, "PDF tagged state"),
        textAvailable: boolean(extraction.textAvailable, "PDF text availability")
      };
    } else {
      parsedExtraction = {
        engine: oneOf(extraction.engine, ["poppler-pdftotext"], "PDF extraction engine"),
        mode: oneOf(extraction.mode, ["layout"], "PDF extraction mode"),
        ocrPerformed: oneOf(extraction.ocrPerformed, [false], "PDF OCR state"),
        readingOrder: oneOf(extraction.readingOrder, ["heuristic"], "PDF reading order"),
        tagged: boolean(extraction.tagged, "PDF tagged state"),
        textAvailable: boolean(extraction.textAvailable, "PDF text availability")
      };
    }
    let rendering;
    if (isVisualPdf) {
      const source = object(record.rendering, "PDF visual rendering");
      exactKeys(source, [
        "engine", "mediaType", "annotationsHidden", "colorSpace", "pageCount",
        "targetMaximumDimension", "totalPixels", "totalImageBytes"
      ], "PDF visual rendering");
      rendering = {
        engine: oneOf(source.engine, ["poppler-pdftoppm"], "PDF visual rendering engine"),
        mediaType: oneOf(source.mediaType, ["image/jpeg"], "PDF visual rendering media type"),
        annotationsHidden: oneOf(
          source.annotationsHidden,
          [true],
          "PDF visual rendering annotation policy"
        ),
        colorSpace: oneOf(source.colorSpace, ["rgb"], "PDF visual rendering color space"),
        pageCount: integerBetween(source.pageCount, 1, 200, "PDF visual page count"),
        targetMaximumDimension: integerBetween(
          source.targetMaximumDimension,
          64,
          1_000,
          "PDF visual maximum dimension"
        ),
        totalPixels: integerBetween(
          source.totalPixels,
          1,
          20_000_000,
          "PDF visual total pixels"
        ),
        totalImageBytes: integerBetween(
          source.totalImageBytes,
          1,
          2_400_000,
          "PDF visual total image bytes"
        )
      };
    }
    variant = {
      schemaVersion: oneOf(
        record.schemaVersion,
        [
          "opengeo.document-preview.2.0.0",
          "opengeo.document-preview.3.0.0",
          "opengeo.pdf-visual-presentation.1.0.0",
          "opengeo.pdf-visual-presentation.2.0.0"
        ],
        "document preview schema"
      ),
      sourceFormat: oneOf(record.sourceFormat, ["pdf"], "document preview source format"),
      pdfVersion: oneOf(
        record.pdfVersion,
        ["1.0", "1.1", "1.2", "1.3", "1.4", "1.5", "1.6", "1.7", "2.0"],
        "PDF version"
      ),
      extraction: parsedExtraction,
      ...(rendering ? {rendering} : {})
    };
  } else {
    contract("document preview schema or source format is invalid");
  }
  const title = record.title === null ? null : documentText(record.title, 300, "document title");
  const language = record.language === null ? null : string(record.language, "document language");
  if (language !== null && !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(language)) {
    contract("document language is invalid");
  }
  let blockTotal = 0;
  let characterTotal = 0;
  let tableCells = 0;
  let visualPixels = 0;
  let visualBytes = 0;
  const pages = parseArray(record.pages, (value, index) => {
    const page = object(value, "document page");
    exactKeys(page, [
      "number",
      ...(isOcrPdf ? ["textSource"] : []),
      ...(isVisualPdf ? ["width", "height", "imageBase64", "imageSha256"] : []),
      "blocks"
    ], "document page");
    const number = integerBetween(page.number, 1, 200, "document page number");
    if (number !== index + 1) contract("document page sequence is invalid");
    const textSource = isOcrPdf
      ? oneOf(page.textSource, ["embedded", "ocr", "none"], "document page text source")
      : undefined;
    let visual;
    if (isVisualPdf) {
      const width = integerBetween(
        page.width,
        1,
        variant.rendering.targetMaximumDimension,
        "PDF visual page width"
      );
      const height = integerBetween(
        page.height,
        1,
        variant.rendering.targetMaximumDimension,
        "PDF visual page height"
      );
      const imageBase64 = documentPreviewJpeg(page.imageBase64);
      visualPixels += width * height;
      visualBytes += decodedBase64Length(imageBase64);
      visual = {
        width,
        height,
        imageBase64,
        imageSha256: sha256Checksum(page.imageSha256, "PDF visual page checksum")
      };
    }
    const blocks = parseArray(page.blocks, (value) => {
      const block = object(value, "document block");
      blockTotal += 1;
      if (blockTotal > 2_000) contract("document preview has too many blocks");
      const type = string(block.type, "document block type");
      if (type === "heading") {
        exactKeys(block, ["type", "level", "text"], "document heading");
        const text = documentText(block.text, 8_000, "document heading text");
        characterTotal += text.length;
        return {
          type,
          level: integerBetween(block.level, 1, 10, "document heading level"),
          text
        };
      }
      if (type === "paragraph") {
        exactKeys(block, ["type", "text"], "document paragraph");
        const text = documentText(block.text, 8_000, "document paragraph text");
        characterTotal += text.length;
        return {type, text};
      }
      if (type === "list") {
        exactKeys(block, ["type", "ordered", "items"], "document list");
        const items = parseArray(
          block.items,
          (item) => documentText(item, 1_000, "document list item"),
          "document list items"
        );
        if (!items.length || items.length > 500) contract("document list is invalid");
        characterTotal += items.reduce((total, item) => total + item.length, 0);
        return {type, ordered: boolean(block.ordered, "document list ordered"), items};
      }
      if (type === "table") {
        const keys = Object.hasOwn(block, "label")
          ? ["type", "label", "headerRows", "rows"]
          : ["type", "headerRows", "rows"];
        exactKeys(block, keys, "document table");
        const rows = parseArray(block.rows, (value) => {
          const row = parseArray(
            value,
            (cell) => documentText(cell, 1_000, "document table cell", true),
            "document table row"
          );
          if (!row.length || row.length > 20) contract("document table row is invalid");
          tableCells += row.length;
          characterTotal += row.reduce((total, cell) => total + cell.length, 0);
          return row;
        }, "document table rows");
        if (!rows.length || rows.length > 200 || rows.some((row) => row.length !== rows[0].length)) {
          contract("document table is invalid");
        }
        const headerRows = integerBetween(block.headerRows, 0, rows.length, "document table header rows");
        return {
          type,
          ...(Object.hasOwn(block, "label")
            ? {label: documentText(block.label, 300, "document table label")}
            : {}),
          headerRows,
          rows
        };
      }
      contract("document block type is invalid");
    }, "document blocks");
    return {
      ...(isOcrPdf ? {textSource} : {}),
      ...(visual ?? {}),
      number,
      blocks
    };
  }, "document pages");
  if (!pages.length || pages.length > 200 || tableCells > 5_000 || characterTotal > 200_000) {
    contract("document preview limits are exceeded");
  }
  if (
    variant.sourceFormat === "pdf"
    && variant.extraction.textAvailable !== (characterTotal > 0)
  ) {
    contract("PDF text availability does not match its content");
  }
  if (isOcrPdf) {
    const ocrPages = pages.filter((page) => page.textSource === "ocr").map((page) => page.number);
    const hasUnprocessedPage = pages.some((page) => page.textSource === "none");
    if (
      JSON.stringify(ocrPages) !== JSON.stringify(variant.extraction.ocrPages)
      || pages.some((page) => page.textSource === "embedded" && !page.blocks.length)
      || pages.some((page) => page.textSource === "none" && page.blocks.length)
      || variant.extraction.ocrTruncated !== hasUnprocessedPage
      || (variant.extraction.ocrTruncated && ocrPages.length !== 32)
    ) {
      contract("PDF OCR page provenance is inconsistent");
    }
  }
  if (isVisualPdf && (
    variant.rendering.pageCount !== pages.length
    || variant.rendering.totalPixels !== visualPixels
    || variant.rendering.totalImageBytes !== visualBytes
  )) {
    contract("PDF visual rendering totals are inconsistent");
  }
  return {
    ...variant,
    title,
    language,
    pages
  };
}

function documentPreviewJpeg(value) {
  const encoded = boundedString(value, 700_000, "PDF visual page image");
  if (
    encoded.length < 4
    || encoded.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
    || decodedBase64Length(encoded) > 512 * 1024
    || !encoded.startsWith("/9j/")
  ) {
    contract("PDF visual page image is invalid");
  }
  return encoded;
}

function decodedBase64Length(value) {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return value.length / 4 * 3 - padding;
}

function documentText(value, maximum, label, allowEmpty = false) {
  const result = string(value, label);
  if ((!allowEmpty && !result.length) || result.length > maximum || result.includes("\0")) {
    contract(`${label} is invalid`);
  }
  return result;
}

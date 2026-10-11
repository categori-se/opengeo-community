const PAGE_MM = Object.freeze({
  letter: [215.9, 279.4],
  legal: [215.9, 355.6],
  tabloid: [279.4, 431.8],
  a4: [210, 297],
  a3: [297, 420],
  a2: [420, 594],
  a1: [594, 841],
  a0: [841, 1189]
});

const ELEMENT_KEYS = Object.freeze({
  text: new Set(["type", "x", "y", "text", "size", "color", "font", "fontStyle"]),
  map: new Set(["type", "x", "y", "width", "height"]),
  legend: new Set(["type", "x", "y"]),
  image: new Set(["type", "x", "y", "width", "height", "image_data", "imageData"]),
  rect: new Set([
    "type", "x", "y", "width", "height", "fill", "stroke", "strokeWidth", "filled"
  ]),
  ellipse: new Set([
    "type", "x", "y", "rx", "ry", "fill", "stroke", "strokeWidth", "filled"
  ])
});

export const GEOMOOSE_PRINT_CONVERSION_LIMITS = Object.freeze({
  maximumBytes: 32_768,
  maximumElements: 32,
  maximumTextCharacters: 1_000,
  supportedUnits: Object.freeze(["in", "mm", "pt"]),
  supportedPages: Object.freeze(Object.keys(PAGE_MM))
});

function invalid(message) {
  throw new TypeError(`GeoMoose print layout ${message}`);
}

function plainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(`${label} is invalid`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${label} is invalid`);
  return value;
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) invalid(`${label} key is unsupported`);
}

function requiredString(value, maximum, label, pattern = null) {
  if (typeof value !== "string" || value !== value.trim() || !value.length
    || value.length > maximum || (pattern && !pattern.test(value))) invalid(`${label} is invalid`);
  return value;
}

function number(value, label, {minimum = 0, maximum = 100_000, required = true} = {}) {
  if (!required && value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    invalid(`${label} is invalid`);
  }
  return value;
}

function color(value, label) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== 3
    || value.some((component) => !Number.isInteger(component) || component < 0 || component > 255)) {
    invalid(`${label} is invalid`);
  }
  return value;
}

function uuid(value, label) {
  return requiredString(
    value,
    36,
    label,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  ).toLowerCase();
}

function identifier(value, label) {
  return requiredString(value, 64, label, /^[a-z][a-z0-9_-]{0,63}$/);
}

function pageSlug(value) {
  return requiredString(
    value,
    160,
    "site page slug",
    /^[a-z0-9](?:[a-z0-9-]{0,158}[a-z0-9])?$/
  );
}

function byteLength(value) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    invalid("cannot be serialized");
  }
  if (typeof encoded !== "string") invalid("cannot be serialized");
  const bytes = new TextEncoder().encode(encoded).byteLength;
  if (bytes > GEOMOOSE_PRINT_CONVERSION_LIMITS.maximumBytes) invalid("is too large");
  return bytes;
}

function unitScale(unit) {
  return {in: 25.4, mm: 1, pt: 25.4 / 72}[unit];
}

function normalized(valueMm, extentMm, minimum = 0) {
  return Math.max(minimum, Math.min(1000, Math.round(valueMm / extentMm * 1000)));
}

function frame(xMm, yMm, widthMm, heightMm, pageWidthMm, pageHeightMm) {
  const x = normalized(xMm, pageWidthMm);
  const y = normalized(yMm, pageHeightMm);
  const width = Math.max(10, normalized(widthMm, pageWidthMm, 10));
  const height = Math.max(10, normalized(heightMm, pageHeightMm, 10));
  if (x >= 1000 || y >= 1000 || x + width > 1000 || y + height > 1000) {
    invalid("element falls outside its page");
  }
  return {x, y, width, height, rotation: 0, clip: true};
}

function dimensions(page, orientation) {
  const portrait = PAGE_MM[page];
  if (!portrait) invalid("page size is unsupported");
  return orientation === "portrait" ? portrait : [portrait[1], portrait[0]];
}

function parseElement(value, index, pageWidthMm, pageHeightMm, scale) {
  const element = plainObject(value, `element ${index}`);
  const type = requiredString(element.type, 16, `element ${index} type`);
  const keys = ELEMENT_KEYS[type];
  if (!keys) invalid(`element ${index} type is unsupported`);
  exactKeys(element, keys, `element ${index}`);
  const coordinate = (name, required = true, minimum = 0) => number(
    element[name],
    `element ${index} ${name}`,
    {
      minimum,
      maximum: Math.max(pageWidthMm, pageHeightMm) / scale * 4,
      required
    }
  );
  const parsed = {type, x: coordinate("x"), y: coordinate("y")};
  if (["map", "image", "rect"].includes(type)) {
    parsed.width = coordinate("width", type !== "image", Number.EPSILON);
    parsed.height = coordinate("height", type !== "image", Number.EPSILON);
    if ((parsed.width === undefined) !== (parsed.height === undefined)) {
      invalid(`element ${index} image dimensions are incomplete`);
    }
  }
  if (type === "ellipse") {
    parsed.rx = coordinate("rx", true, Number.EPSILON);
    parsed.ry = coordinate("ry", true, Number.EPSILON);
  }
  if (type === "text") {
    parsed.text = requiredString(
      element.text,
      GEOMOOSE_PRINT_CONVERSION_LIMITS.maximumTextCharacters,
      `element ${index} text`
    );
    parsed.size = number(element.size, `element ${index} size`, {
      minimum: 1,
      maximum: 144,
      required: false
    }) ?? 13;
    parsed.color = color(element.color, `element ${index} color`) ?? [0, 0, 0];
    parsed.font = element.font === undefined
      ? "NotoSans"
      : requiredString(element.font, 80, `element ${index} font`);
    parsed.fontStyle = element.fontStyle === undefined
      ? "regular"
      : requiredString(element.fontStyle, 24, `element ${index} font style`);
  }
  if (["rect", "ellipse"].includes(type)) {
    parsed.fill = color(element.fill, `element ${index} fill`);
    parsed.stroke = color(element.stroke, `element ${index} stroke`);
    parsed.strokeWidth = number(element.strokeWidth, `element ${index} stroke width`, {
      maximum: 1_000,
      required: false
    });
    if (element.filled !== undefined && typeof element.filled !== "boolean") {
      invalid(`element ${index} filled is invalid`);
    }
    parsed.filled = element.filled === true;
  }
  if (type === "image") {
    if (element.imageData !== undefined && element.image_data !== undefined) {
      invalid(`element ${index} has duplicate image data`);
    }
    const data = element.imageData ?? element.image_data;
    if (data !== undefined && typeof data !== "string") {
      invalid(`element ${index} image data is invalid`);
    }
    parsed.hasInlineData = typeof data === "string" && data.length > 0;
  }
  return parsed;
}

function substituteText(text, title, printedOn) {
  const date = printedOn === null ? null : new Date(printedOn);
  if (date && Number.isNaN(date.valueOf())) invalid("printed date is invalid");
  const values = {
    title,
    year: date ? String(date.getUTCFullYear()) : null,
    month: date ? String(date.getUTCMonth() + 1) : null,
    day: date ? String(date.getUTCDate()) : null
  };
  const unresolved = new Set();
  const converted = text.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (match, key) => {
    if (values[key] !== undefined && values[key] !== null) return values[key];
    unresolved.add(key);
    return match;
  });
  if ((converted.includes("{{") || converted.includes("}}")) && !unresolved.size) {
    unresolved.add("unsupported template syntax");
  }
  return {text: converted, unresolved: [...unresolved].sort()};
}

function textStyle(element) {
  if (element.size >= 17 || element.fontStyle === "bold" && element.size >= 16) return "title";
  if (element.size >= 14 || element.fontStyle === "bold") return "heading";
  if (element.size <= 9) return "note";
  return "body";
}

function containingRectangle(elements, anchor) {
  return elements
    .filter(({type, x, y, width, height}) => type === "rect"
      && x <= anchor.x && y <= anchor.y && x + width >= anchor.x && y + height >= anchor.y)
    .sort((left, right) => left.width * left.height - right.width * right.height)[0] ?? null;
}

function loss(index, type, code, detail) {
  return {sourceElementIndex: index, sourceType: type, code, detail};
}

/**
 * Convert one bounded GeoMoose 3.15.2 print-layout object into OpenGeo's sealed,
 * normalized positioned-page contract. This function never reads image bytes,
 * opens URLs, executes templates, or performs network requests.
 */
export function convertGeoMoosePrintLayout(value, {
  sitePageSlug,
  mapResourceId,
  title = "Untitled map",
  printedOn = null,
  imageBlockIds = {}
} = {}) {
  const sourceBytes = byteLength(value);
  const source = plainObject(value, "document");
  exactKeys(source, new Set(["label", "orientation", "page", "units", "elements"]), "document");
  const label = requiredString(source.label, 160, "label");
  const orientation = requiredString(source.orientation, 16, "orientation");
  if (!["portrait", "landscape"].includes(orientation)) invalid("orientation is unsupported");
  const page = requiredString(source.page, 16, "page size").toLowerCase();
  const units = requiredString(source.units, 8, "units");
  if (!GEOMOOSE_PRINT_CONVERSION_LIMITS.supportedUnits.includes(units)) invalid("units are unsupported");
  if (!Array.isArray(source.elements) || !source.elements.length
    || source.elements.length > GEOMOOSE_PRINT_CONVERSION_LIMITS.maximumElements) {
    invalid("element count is invalid");
  }
  const slug = pageSlug(sitePageSlug);
  const resourceId = uuid(mapResourceId, "map resource id");
  const safeTitle = requiredString(title, 300, "title");
  const bindings = plainObject(imageBlockIds, "image block bindings");
  for (const key of Object.keys(bindings)) {
    if (!/^(?:0|[1-9]|[12][0-9]|3[01])$/.test(key)) invalid("image block binding key is invalid");
  }
  const [pageWidthMm, pageHeightMm] = dimensions(page, orientation);
  const scale = unitScale(units);
  const elements = source.elements.map((element, index) =>
    parseElement(element, index, pageWidthMm, pageHeightMm, scale)
  );
  for (const key of Object.keys(bindings)) {
    if (elements[Number(key)]?.type !== "image") invalid("image block binding target is invalid");
  }
  const mapIds = new Map();
  let mapNumber = 0;
  elements.forEach((element, index) => {
    if (element.type === "map") mapIds.set(index, `map_${++mapNumber}`);
  });
  if (!mapIds.size) invalid("must contain a map element");
  const primaryMapId = mapIds.values().next().value;
  const output = [];
  const outcomes = [];
  const losses = [];
  const counts = {map: 0, text: 0, legend: 0, image: 0};
  const target = (type, geometry, binding = {}) => {
    const id = `${type.replace("_frame", "")}_${++counts[type.replace("_frame", "")]}`;
    return {id, type, ...geometry, ...binding};
  };
  for (const [index, element] of elements.entries()) {
    const targetIds = [];
    if (element.type === "map") {
      const geometry = frame(
        element.x * scale,
        element.y * scale,
        element.width * scale,
        element.height * scale,
        pageWidthMm,
        pageHeightMm
      );
      const converted = {
        id: mapIds.get(index),
        type: "map_frame",
        ...geometry,
        resourceId,
        fit: "cover"
      };
      output.push(converted);
      targetIds.push(converted.id);
    } else if (element.type === "text") {
      const substitution = substituteText(element.text, safeTitle, printedOn);
      const lineHeightMm = element.size * 25.4 / 72 * 1.35;
      const topMm = Math.max(0, element.y * scale - lineHeightMm);
      const estimatedWidthMm = Math.max(
        pageWidthMm * 0.01,
        Math.min(pageWidthMm - element.x * scale, substitution.text.length * element.size * 25.4 / 72 * 0.58)
      );
      const converted = target(
        "text",
        frame(
          element.x * scale,
          topMm,
          estimatedWidthMm,
          lineHeightMm,
          pageWidthMm,
          pageHeightMm
        ),
        {text: substitution.text, style: textStyle(element)}
      );
      output.push(converted);
      targetIds.push(converted.id);
      if (substitution.unresolved.length) {
        losses.push(loss(
          index,
          element.type,
          "template_tokens_unresolved",
          `OpenGeo retained unsupported template tokens literally: ${substitution.unresolved.join(", ")}.`
        ));
      }
      if (element.size !== 13 || element.font !== "NotoSans"
        || element.fontStyle !== "regular" || element.color.some((value) => value !== 0)) {
        losses.push(loss(
          index,
          element.type,
          "text_style_coarsened",
          "Font family, exact point size, color, and face were mapped to one semantic OpenGeo text style."
        ));
      }
    } else if (element.type === "legend") {
      const bounds = containingRectangle(elements, element);
      const xMm = (bounds?.x ?? element.x) * scale;
      const yMm = (bounds?.y ?? element.y) * scale;
      const widthMm = bounds ? bounds.width * scale : Math.max(pageWidthMm - xMm, pageWidthMm * 0.1);
      const heightMm = bounds ? bounds.height * scale : Math.max(pageHeightMm - yMm, pageHeightMm * 0.1);
      const converted = target(
        "legend_frame",
        frame(xMm, yMm, widthMm, heightMm, pageWidthMm, pageHeightMm),
        {mapFrameId: primaryMapId}
      );
      output.push(converted);
      targetIds.push(converted.id);
      losses.push(loss(
        index,
        element.type,
        "legend_source_governed",
        "GeoMoose's live legend images were replaced by the exact legend sealed with the OpenGeo map snapshot."
      ));
    } else if (element.type === "image") {
      const blockId = Object.hasOwn(bindings, index) ? bindings[index] : undefined;
      if (blockId !== undefined && element.width !== undefined) {
        const converted = target(
          "image_frame",
          frame(
            element.x * scale,
            element.y * scale,
            element.width * scale,
            element.height * scale,
            pageWidthMm,
            pageHeightMm
          ),
          {blockId: identifier(blockId, `image block binding ${index}`), fit: "contain"}
        );
        output.push(converted);
        targetIds.push(converted.id);
        if (element.hasInlineData) losses.push(loss(
          index,
          element.type,
          "inline_image_replaced",
          "Untrusted inline image bytes were ignored in favor of the explicitly bound sealed content block."
        ));
      } else {
        losses.push(loss(
          index,
          element.type,
          "image_omitted_unsealed",
          "The image was omitted because no sealed content-block binding with explicit dimensions was supplied."
        ));
      }
    } else {
      losses.push(loss(
        index,
        element.type,
        "drawing_omitted",
        `OpenGeo print-layout 1.1 has no ${element.type} drawing frame; the shape was not approximated.`
      ));
    }
    outcomes.push({
      sourceElementIndex: index,
      sourceType: element.type,
      disposition: targetIds.length ? "converted" : "omitted",
      targetElementIds: targetIds,
      lossCodes: losses
        .filter(({sourceElementIndex}) => sourceElementIndex === index)
        .map(({code}) => code)
    });
  }
  return {
    printLayout: {
      schemaVersion: "opengeo.print-layout.1.1.0",
      pages: [{sitePageSlug: slug, elements: output}]
    },
    themeOptions: {
      printPageSize: page,
      printOrientation: orientation,
      printLayout: "map-sheet",
      printLegend: String(elements.some(({type}) => type === "legend")),
      printNorthArrow: "false",
      printScaleBar: "false"
    },
    report: {
      schemaVersion: "opengeo.geomoose-print-conversion.1.0.0",
      sourceLabel: label,
      sourceBytes,
      sourcePage: page,
      sourceOrientation: orientation,
      sourceUnits: units,
      sourceElementCount: elements.length,
      convertedElementCount: output.length,
      omittedElementCount: outcomes.filter(({disposition}) => disposition === "omitted").length,
      sourceElementOutcomes: outcomes,
      losses,
      externalContextLosses: [
        {
          code: "runtime_resolution_not_converted",
          detail: "GeoMoose's interactive print-resolution multiplier is runtime state outside the layout object."
        },
        {
          code: "runtime_selection_not_converted",
          detail: "GeoMoose's include-selection choice is runtime state outside the layout object."
        },
        {
          code: "portal_scale_line_not_converted",
          detail: "GeoMoose's optional scale line comes from portal map configuration, not the layout object."
        },
        {
          code: "geopdf_extent_not_converted",
          detail: "GeoMoose's jsPDF GeoArea extent is not represented by OpenGeo print-layout 1.1."
        }
      ],
      networkRequests: 0,
      inlineImageBytesRead: false,
      externalResourcesOpened: false
    }
  };
}

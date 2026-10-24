// Text and LaTeX source are data: no executable expression or external asset fields.
export const PRINT_TEXT_FRAME_KEYS = ["id", "type", "title", "text", "xMm", "yMm", "widthMm", "heightMm", "fontSizePt", "color", "background", "alignment"];
const forbiddenControls = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/u;

/** Validate the closed, page-bounded text frames without changing caller data. */
export function validatePrintTextFrames(frames, page, existingIds = []) {
  array(frames);
  const ids = new Set(existingIds);
  number(page?.widthMm, 50, 1189);number(page?.heightMm, 50, 1189);
  for (const frame of frames) {
    validateFrame(frame);
    if (ids.has(frame.id)) throw Error("Print frame identities must be unique.");
    ids.add(frame.id);
    number(frame.xMm, 0, page.widthMm);number(frame.yMm, 0, page.heightMm);
    number(frame.widthMm, 10, page.widthMm);number(frame.heightMm, 5, page.heightMm);
    if (frame.xMm + frame.widthMm > page.widthMm + 0.001 || frame.yMm + frame.heightMm > page.heightMm + 0.001) throw Error("Keep each text frame inside its page.");
  }
  return structuredClone(frames);
}

/**
 * Return flat literal lines at absolute page millimeters. The measurement callback
 * must use the output font and return millimeters. The codepoint bound is only a
 * conservative DOMless-fixture fallback, never a claim of actual font metrics.
 */
export function layoutPrintTextFrame(frame, measureWidth = (text, fontSizeMm) => Array.from(text).length * fontSizeMm) {
  validateFrame(frame);
  if (frame.type === "math") throw Error("Math frames require the real LaTeX typesetter. Use the Print math output path.");
  if (typeof measureWidth !== "function") throw Error("Measure the Print text with its output font.");
  const fontSizeMm = frame.fontSizePt * 25.4 / 72, lineHeightMm = fontSizeMm * 1.3;
  const innerWidth = frame.widthMm - 2, innerHeight = frame.heightMm - 2;
  const measure = text => {
    const width = measureWidth(text, fontSizeMm);
    if (typeof width !== "number" || !Number.isFinite(width) || width < 0) throw Error("Print text measurement must be a finite nonnegative width.");
    return width;
  };
  const fits = text => measure(text) <= innerWidth + 1e-9;
  const texts = [];
  for (const paragraph of frame.text.split("\n")) {
    let line = "";
    for (const token of paragraph.match(/ +|[^ ]+/gu) ?? []) {
      if (fits(line + token)) {line += token;continue;}
      if (line) {texts.push(line);line = "";}
      if (fits(token)) {line = token;continue;}
      for (const point of token) {
        if (!fits(line + point)) {
          if (!line || !fits(point)) throw Error("A text character is wider than its frame. Widen the frame or reduce the font size.");
          texts.push(line);line = "";
        }
        line += point;
      }
    }
    texts.push(line);
  }
  if (texts.length * lineHeightMm > innerHeight + 1e-9) throw Error("Text exceeds its frame height. Enlarge the frame or reduce the font size.");
  const lines = texts.map((text, index) => {
    const remaining = Math.max(0, innerWidth - measure(text));
    const offset = frame.alignment === "center" ? remaining / 2 : frame.alignment === "right" ? remaining : 0;
    return {text, x: frame.xMm + 1 + offset, y: frame.yMm + 1 + fontSizeMm + index * lineHeightMm};
  });
  return {lines, fontSizeMm, lineHeightMm};
}

function validateFrame(frame) {
  if (!frame || typeof frame !== "object" || Array.isArray(frame) || ![Object.prototype, null].includes(Object.getPrototypeOf(frame))
    || Reflect.ownKeys(frame).length !== PRINT_TEXT_FRAME_KEYS.length
    || Reflect.ownKeys(frame).some(key => typeof key !== "string" || !PRINT_TEXT_FRAME_KEYS.includes(key)
      || !Object.getOwnPropertyDescriptor(frame, key)?.enumerable || !Object.hasOwn(Object.getOwnPropertyDescriptor(frame, key), "value"))) throw Error("Invalid or unsupported Print text frame fields.");
  text(frame.id, 100);text(frame.title, 200);text(frame.text, 4000, true, true);
  if (!["text", "math"].includes(frame.type)) throw Error("Choose a literal Print text or math frame.");
  number(frame.xMm, 0, 1189);number(frame.yMm, 0, 1189);
  number(frame.widthMm, 10, 1189);number(frame.heightMm, 5, 1189);
  number(frame.fontSizePt, 6, 48);
  if (typeof frame.color !== "string" || typeof frame.background !== "string" || !/^#[\da-f]{6}$/i.test(frame.color) || !(frame.background === "none" || /^#[\da-f]{6}$/i.test(frame.background))
    || !["left", "center", "right"].includes(frame.alignment)) throw Error("Choose a supported Print text color, background and alignment.");
}
function array(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 8
    || Reflect.ownKeys(value).length !== value.length + 1
    || Array.from({length: value.length}, (_, index) => Object.getOwnPropertyDescriptor(value, String(index))).some(descriptor => !descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))) throw Error("A layout supports up to eight text and math frames combined.");
}
function text(value, maximum, empty = false, multiline = false) {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > maximum || forbiddenControls.test(value)
    || (!multiline && value.includes("\n"))) throw Error("Use bounded literal Print text with LF line breaks and no other controls.");
}
function number(value, minimum, maximum) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw Error("Invalid Print text dimensions or font size.");
}

import {mapFontSha256} from "./mapFonts.js";

export const PRINT_FONT_FAMILY = "OpenGeoPrintSans";
export const PRINT_FONT_FACES_NOTICE_SHA256 = "cfce8910a917d231befccb1b8e9f8291d4b7b7abb475c222c80d7a53240d179e";
export const PRINT_FONT_FACES = Object.freeze({
  regular: Object.freeze({file: "OpenSans-Regular.ttf", sha256: "8ab4aa561e7db0eb3e1af8b0bed2a315e0a33fe2ed3070e645d1b89f8efc1d5c", weight: "400", style: "normal", pdfStyle: "normal"}),
  bold: Object.freeze({file: "OpenSans-Bold.ttf", sha256: "1a6bc6775358bfed0e4191b6f2c4d7d75d122f0c6e5a255f264ab455c67237b7", weight: "700", style: "normal", pdfStyle: "bold"}),
  italic: Object.freeze({file: "OpenSans-Italic.ttf", sha256: "e5178be12cd740aeafebea15ec563fe577bbb4fab42d9e40500bd49ec8c9ce16", weight: "400", style: "italic", pdfStyle: "italic"}),
  bolditalic: Object.freeze({file: "OpenSans-BoldItalic.ttf", sha256: "b5c44af3cb55f65fadb2f1b20edc38e1008bb71388d04ad127c5ad340c9329f2", weight: "700", style: "italic", pdfStyle: "bolditalic"})
});
function faceName(value = "regular") {
  if (typeof value !== "string" || !Object.hasOwn(PRINT_FONT_FACES, value)) throw Error("Choose a packaged Print font face.");
  return value;
}
function familyName(value) {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(value)) throw Error("The Print font family is invalid.");
  return value;
}
export function usedPrintFontFaces(layout) {
  const faces = new Set(["regular"]);
  for (const frame of layout?.textFrames ?? []) {
    if (frame.type !== "text") {
      if (frame.fontFace !== undefined) throw Error("Only literal Print text can choose a font face.");
      continue;
    }
    faces.add(faceName(frame.fontFace));
  }
  return Object.keys(PRINT_FONT_FACES).filter(face => faces.has(face));
}
export function printFontFaceAttributes(face = "regular", {family = PRINT_FONT_FAMILY} = {}) {
  const record = PRINT_FONT_FACES[faceName(face)];
  return {"font-family": familyName(family), "font-weight": record.weight, "font-style": record.style};
}
function assetBytes(value, maximum, label) {
  const bytes = value instanceof Uint8Array ? value : value instanceof ArrayBuffer ? new Uint8Array(value) : null;
  if (!bytes?.length || bytes.length > maximum) throw Error(`The ${label} bytes are unavailable or exceed their limit.`);
  return bytes;
}
// Exact cmap ranges generated once from the four pinned local TTFs with fontTools.
const PRINT_FONT_FACE_COVERAGE = Object.freeze({"regular":[[32,126],[160,383],[402,402],[416,417],[431,432],[496,496],[506,511],[536,539],[567,567],[700,700],[710,711],[713,713],[728,733],[755,755],[768,769],[771,771],[777,777],[783,783],[803,803],[900,906],[908,908],[910,929],[931,974],[977,978],[982,982],[1024,1158],[1160,1299],[7680,7681],[7742,7743],[7808,7813],[7840,7929],[8013,8013],[8192,8203],[8211,8213],[8215,8222],[8224,8226],[8230,8230],[8240,8240],[8242,8243],[8249,8250],[8252,8252],[8260,8260],[8304,8304],[8308,8313],[8319,8319],[8355,8356],[8359,8359],[8363,8364],[8453,8453],[8467,8467],[8470,8470],[8480,8480],[8482,8482],[8486,8486],[8494,8494],[8539,8542],[8706,8706],[8710,8710],[8719,8719],[8721,8722],[8730,8730],[8734,8734],[8747,8747],[8776,8776],[8800,8800],[8804,8805],[9674,9674],[64256,64260],[65279,65279],[65532,65533]],"bold":[[32,126],[160,383],[402,402],[416,417],[431,432],[496,496],[506,511],[536,539],[567,567],[700,700],[710,711],[713,713],[728,733],[755,755],[768,769],[771,771],[777,777],[783,783],[803,803],[900,906],[908,908],[910,929],[931,974],[977,978],[982,982],[1024,1158],[1160,1299],[7680,7681],[7742,7743],[7808,7813],[7840,7929],[8013,8013],[8192,8203],[8211,8213],[8215,8222],[8224,8226],[8230,8230],[8240,8240],[8242,8243],[8249,8250],[8252,8252],[8260,8260],[8304,8304],[8308,8313],[8319,8319],[8355,8356],[8359,8359],[8363,8364],[8453,8453],[8467,8467],[8470,8470],[8480,8480],[8482,8482],[8486,8486],[8494,8494],[8539,8542],[8706,8706],[8710,8710],[8719,8719],[8721,8722],[8730,8730],[8734,8734],[8747,8747],[8776,8776],[8800,8800],[8804,8805],[9674,9674],[64256,64260],[65279,65279],[65532,65533]],"italic":[[32,126],[160,383],[402,402],[416,417],[431,432],[496,496],[506,511],[536,539],[567,567],[700,700],[710,711],[713,713],[728,733],[755,755],[768,769],[771,771],[777,777],[783,783],[803,803],[900,906],[908,908],[910,929],[931,974],[977,978],[982,982],[1024,1158],[1160,1299],[7680,7681],[7742,7743],[7808,7813],[7840,7929],[8013,8013],[8192,8203],[8211,8213],[8215,8222],[8224,8226],[8230,8230],[8240,8240],[8242,8243],[8249,8250],[8252,8252],[8260,8260],[8304,8304],[8308,8313],[8319,8319],[8355,8356],[8359,8359],[8363,8364],[8453,8453],[8467,8467],[8470,8470],[8480,8480],[8482,8482],[8486,8486],[8494,8494],[8539,8542],[8706,8706],[8710,8710],[8719,8719],[8721,8722],[8730,8730],[8734,8734],[8747,8747],[8776,8776],[8800,8800],[8804,8805],[9674,9674],[64256,64260],[65279,65279],[65532,65533]],"bolditalic":[[32,126],[160,383],[402,402],[416,417],[431,432],[496,496],[506,511],[536,539],[567,567],[700,700],[710,711],[713,713],[728,733],[755,755],[768,769],[771,771],[777,777],[783,783],[803,803],[900,906],[908,908],[910,929],[931,974],[977,978],[982,982],[1024,1158],[1160,1299],[7680,7681],[7742,7743],[7808,7813],[7840,7929],[8013,8013],[8192,8203],[8211,8213],[8215,8222],[8224,8226],[8230,8230],[8240,8240],[8242,8243],[8249,8250],[8252,8252],[8260,8260],[8304,8304],[8308,8313],[8319,8319],[8355,8356],[8359,8359],[8363,8364],[8453,8453],[8467,8467],[8470,8470],[8480,8480],[8482,8482],[8486,8486],[8494,8494],[8539,8542],[8706,8706],[8710,8710],[8719,8719],[8721,8722],[8730,8730],[8734,8734],[8747,8747],[8776,8776],[8800,8800],[8804,8805],[9674,9674],[64256,64260],[65279,65279],[65532,65533]]});

// Recheck edited text even when the exact face assets are already loaded.
// This is pure metadata admission: no hashing, asset reads or font reloads.
export function assertPrintFontFaceCoverage(layout) {
  usedPrintFontFaces(layout);
  for (const frame of layout?.textFrames ?? []) {
    if (frame.type !== "text") continue;
    if (typeof frame.text !== "string" || frame.text.length > 4000) throw Error("Use bounded literal Print text.");
    const face = frame.fontFace ?? "regular";
    for (const character of frame.text) if (character !== "\n" && !PRINT_FONT_FACE_COVERAGE[face].some(([first, last]) => character.codePointAt(0) >= first && character.codePointAt(0) <= last)) {
      throw Error(`The packaged Print ${face} font does not cover U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}.`);
    }
  }
}

export async function validatePrintFontFaceAssets(layout, {faceBytes, noticeBytes} = {}) {
  const faces = {};
  for (const name of usedPrintFontFaces(layout)) {
    const bytes = assetBytes(faceBytes?.[name], 1024 * 1024, `Print ${name} font`);
    if (await mapFontSha256(bytes) !== PRINT_FONT_FACES[name].sha256) throw Error(`The packaged Print ${name} font failed its checksum check.`);
    faces[name] = new Uint8Array(bytes);
  }
  assertPrintFontFaceCoverage(layout);
  let notice = null;
  if (Object.keys(faces).length > 1) {
    notice = assetBytes(noticeBytes, 32768, "Print font faces notice");
    if (await mapFontSha256(notice) !== PRINT_FONT_FACES_NOTICE_SHA256) throw Error("The packaged Print font faces notice failed its checksum check.");
    notice = new Uint8Array(notice);
  }
  return {faces, noticeBytes: notice};
}
function base64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(binary);
}
export function printFontFacesSvgCss(prepared, {family = PRINT_FONT_FAMILY} = {}) {
  familyName(family);
  const legal = prepared.legalFiles?.map(file => `${file.name}\n${new TextDecoder().decode(file.bytes)}`).join("\n\n") ?? "";
  // Trusted pinned legal text is escaped only for the CSS comment delimiter.
  const comment = legal ? `/*\n${legal.replaceAll("*/", "* /")}\n*/\n` : "";
  return comment + Object.entries(prepared.faces).map(([name, bytes]) => {
    const face = PRINT_FONT_FACES[faceName(name)];
    return `@font-face{font-family:"${family}";font-style:${face.style};font-weight:${face.weight};src:url(data:font/ttf;base64,${base64(bytes)}) format("truetype");}`;
  }).join("\n");
}
export async function preparePrintFontFaces(layout, {document, signal, family = PRINT_FONT_FAMILY, faceBytes, noticeBytes, licenseBytes, regularNoticeBytes} = {}) {
  familyName(family);
  const check = () => {if (signal?.aborted) throw signal.reason ?? new DOMException("Print font loading was cancelled.", "AbortError");};
  check();
  if (!faceBytes) {
    const {loadPrintFontFaceAttachments} = await import("./printFontAttachments.js");
    ({faceBytes, noticeBytes, fontLicenseBytes: licenseBytes, fontNoticeBytes: regularNoticeBytes} = await loadPrintFontFaceAttachments(usedPrintFontFaces(layout)));
    check();
  }
  const prepared = await validatePrintFontFaceAssets(layout, {faceBytes, noticeBytes});
  const license = assetBytes(licenseBytes, 32768, "Print font license");
  const regularNotice = assetBytes(regularNoticeBytes, 32768, "Print font notice");
  if (await mapFontSha256(license) !== "3ddf9be5c28fe27dad143a5dc76eea25222ad1dd68934a047064e56ed2fa40c5"
    || await mapFontSha256(regularNotice) !== "50abb8dfaa45dfa4c9167dff20766e459ced61c64ee8f97fcdedafc53e6b6f4a") throw Error("The packaged Print font license or notice failed its checksum check.");
  prepared.legalFiles = [{name: "OpenSans-LICENSE.txt", bytes: new Uint8Array(license)}, {name: "OpenSans-NOTICE.txt", bytes: new Uint8Array(regularNotice)},
    ...(prepared.noticeBytes ? [{name: "OpenSans-FACES-NOTICE.txt", bytes: prepared.noticeBytes}] : [])];
  check();
  const view = document?.defaultView, fontSet = document?.fonts, installed = [];
  if (typeof view?.FontFace !== "function" || !fontSet?.add || !fontSet?.delete) throw Error("This browser cannot load the exact packaged Print font faces.");
  const dispose = () => {for (const face of installed) fontSet.delete(face);installed.length = 0;};
  try {
    for (const [name, bytes] of Object.entries(prepared.faces)) {
      const record = PRINT_FONT_FACES[name];
      const face = new view.FontFace(family, bytes.slice().buffer, {style: record.style, weight: record.weight});
      await face.load();check();fontSet.add(face);installed.push(face);
    }
    return {...prepared, family, css: printFontFacesSvgCss(prepared, {family}), dispose};
  } catch (error) {dispose();throw error;}
}

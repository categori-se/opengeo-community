import {FileAttachment} from "observablehq:stdlib";
import {usedPrintFontFaces} from "./printFontFaces.js";

// These literal paths let the maintained Studio builder package each exact asset.
export async function loadPrintFontFaceAttachments(faces = ["regular"], {includeLegal = true} = {}) {
  const faceBytes = {};
  for (const face of faces) {
    if (face === "regular") faceBytes.regular = await FileAttachment("../assets/render-fonts/opengeo-open-sans-v1/1/OpenSans-Regular.ttf").arrayBuffer();
    else if (face === "bold") faceBytes.bold = await FileAttachment("../assets/print-fonts/open-sans-v1/OpenSans-Bold.ttf").arrayBuffer();
    else if (face === "italic") faceBytes.italic = await FileAttachment("../assets/print-fonts/open-sans-v1/OpenSans-Italic.ttf").arrayBuffer();
    else if (face === "bolditalic") faceBytes.bolditalic = await FileAttachment("../assets/print-fonts/open-sans-v1/OpenSans-BoldItalic.ttf").arrayBuffer();
    else throw Error("Choose a packaged Print font face.");
  }
  const noticeBytes = faces.some(face => face !== "regular")
    ? await FileAttachment("../assets/print-fonts/open-sans-v1/FACES-NOTICE.txt").arrayBuffer() : undefined;
  const [fontLicenseBytes, fontNoticeBytes] = includeLegal ? await Promise.all([
    FileAttachment("../assets/render-fonts/opengeo-open-sans-v1/1/LICENSE.txt").arrayBuffer(),
    FileAttachment("../assets/render-fonts/opengeo-open-sans-v1/1/NOTICE.txt").arrayBuffer()
  ]) : [];
  return {faceBytes, noticeBytes, fontLicenseBytes, fontNoticeBytes};
}

// The no-argument Regular font/manifest/license/notice contract remains unchanged.
export async function printFontAttachments(layout) {
  const [fontBytes, manifestBytes, fontLicenseBytes, fontNoticeBytes] = await Promise.all([
    FileAttachment("../assets/render-fonts/opengeo-open-sans-v1/1/OpenSans-Regular.ttf").arrayBuffer(),
    FileAttachment("../assets/render-fonts/opengeo-open-sans-v1/1/manifest.json").arrayBuffer(),
    FileAttachment("../assets/render-fonts/opengeo-open-sans-v1/1/LICENSE.txt").arrayBuffer(),
    FileAttachment("../assets/render-fonts/opengeo-open-sans-v1/1/NOTICE.txt").arrayBuffer()
  ]);
  const result = {fontBytes, fontManifest: JSON.parse(new TextDecoder().decode(manifestBytes)), manifestBytes, fontLicenseBytes, fontNoticeBytes};
  const faces = usedPrintFontFaces(layout);
  if (faces.length > 1) {
    const {faceBytes, noticeBytes} = await loadPrintFontFaceAttachments(faces.filter(face => face !== "regular"), {includeLegal: false});
    result.fontFaceBytes = {regular: fontBytes, ...faceBytes};
    result.fontFacesNoticeBytes = noticeBytes;
  }
  return result;
}

export const printFontLicense = FileAttachment("../assets/render-fonts/opengeo-open-sans-v1/1/LICENSE.txt");
export const printFontNotice = FileAttachment("../assets/render-fonts/opengeo-open-sans-v1/1/NOTICE.txt");

import {FileAttachment} from "observablehq:stdlib";

// Resolve only after an explicit PDF output request. The retained font, license
// and notice already belong to the version-pinned map-font source offer.
export async function printFontAttachments() {
  const [fontBytes, manifestBytes, fontLicenseBytes, fontNoticeBytes] = await Promise.all([
    FileAttachment("../assets/render-fonts/opengeo-open-sans-v1/1/OpenSans-Regular.ttf").arrayBuffer(),
    FileAttachment("../assets/render-fonts/opengeo-open-sans-v1/1/manifest.json").arrayBuffer(),
    FileAttachment("../assets/render-fonts/opengeo-open-sans-v1/1/LICENSE.txt").arrayBuffer(),
    FileAttachment("../assets/render-fonts/opengeo-open-sans-v1/1/NOTICE.txt").arrayBuffer()
  ]);
  return {fontBytes, fontManifest: JSON.parse(new TextDecoder().decode(manifestBytes)), manifestBytes, fontLicenseBytes, fontNoticeBytes};
}

export const printFontLicense = FileAttachment("../assets/render-fonts/opengeo-open-sans-v1/1/LICENSE.txt");
export const printFontNotice = FileAttachment("../assets/render-fonts/opengeo-open-sans-v1/1/NOTICE.txt");

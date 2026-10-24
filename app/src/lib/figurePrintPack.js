import {zipSync, strToU8} from "fflate";
import {canonicalJson} from "./artifactCanonicalJson.js";
import {assertPrintDataFrameSnapshot} from "./printDataFrames.js";
import {continuousLegendGroups} from "./printContinuousLegend.js";
import {rasterLegendGroups} from "./printRasterLegend.js";
import {printCaptureOutputSignature} from "./printLayouts.js";

const LIMIT = 32 * 1024 * 1024;
const sha = async bytes => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");

// The same object/offset/xref structure as site_print.py, with one browser-encoded
// RGB JPEG page. Furniture is rasterized with the page; this is not vector PDF.
export function rasterPagePdf(jpeg, {width, height, widthMm, heightMm}) {
  if (!(jpeg instanceof Uint8Array) || jpeg.length > LIMIT || jpeg[0] !== 255 || jpeg[1] !== 216
    || jpeg.at(-2) !== 255 || jpeg.at(-1) !== 217
    || ![width, height].every(value => Number.isSafeInteger(value) && value > 0) || width * height > 20_000_000
    || ![widthMm, heightMm].every(value => Number.isFinite(value) && value >= 50 && value <= 1189)) throw Error("The page image or paper dimensions are invalid.");
  const w = (widthMm * 72 / 25.4).toFixed(4), h = (heightMm * 72 / 25.4).toFixed(4);
  const content = `q\n${w} 0 0 ${h} 0 0 cm\n/PageImage Do\nQ\n`;
  const objects = [
    [strToU8("<< /Type /Catalog /Pages 2 0 R >>")],
    [strToU8("<< /Type /Pages /Count 1 /Kids [3 0 R] >>")],
    [strToU8(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /PageImage 5 0 R >> >> /Contents 4 0 R >>`)],
    [strToU8(`<< /Length ${content.length} >>\nstream\n${content}endstream`)],
    [strToU8(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, strToU8("\nendstream")]
  ];
  const chunks = [strToU8("%PDF-1.4\n%"), Uint8Array.of(226, 227, 207, 211, 10)], offsets = [0];
  let length = chunks.reduce((sum, bytes) => sum + bytes.length, 0);
  const append = bytes => {chunks.push(bytes);length += bytes.length;};
  for (const [index, parts] of objects.entries()) {
    offsets.push(length);append(strToU8(`${index + 1} 0 obj\n`));
    for (const bytes of parts) append(bytes);
    append(strToU8("\nendobj\n"));
  }
  const xref = length;
  append(strToU8(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    + offsets.slice(1).map(value => `${String(value).padStart(10, "0")} 00000 n \n`).join("")
    + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  const result = new Uint8Array(length);let position = 0;
  for (const bytes of chunks) {result.set(bytes, position);position += bytes.length;}
  return result;
}

export async function compileFigurePrintPack({layout, layoutId, captures, svg, html, png, jpeg, width, height}) {
  if (layout.id !== layoutId || !layout.frames?.length || layout.frames.length > 2) throw Error("Choose the captured print layout.");
  if (png.type !== "image/png" || jpeg.type !== "image/jpeg" || png.size + jpeg.size > LIMIT) throw Error("The page images exceed the figure pack limit. Choose a lower DPI.");
  const image = new Uint8Array(await jpeg.arrayBuffer());
  const files = {"page.svg": strToU8(svg), "print.html": strToU8(html),
    "page.png": new Uint8Array(await png.arrayBuffer()), "page.jpg": image,
    "page.pdf": rasterPagePdf(image, {width, height, widthMm: layout.page.widthMm, heightMm: layout.page.heightMm}),
    "layout.json": strToU8(JSON.stringify(layout, null, 2))};
  const frames = [];
  for (const [index, frame] of layout.frames.entries()) {
    const capture = captures.get(`${layoutId}:${frame.id}`);
    if (!capture || capture.signature !== canonicalJson({view: frame.view, presentation: frame.presentation})
      || capture.outputSignature !== undefined && capture.outputSignature !== printCaptureOutputSignature(frame, layout.dpi)
      || !/^data:image\/png;base64,/.test(capture.dataUrl) || capture.dataUrl.length > 11_184_836) throw Error("Capture every map frame with its current settings before downloading the pack.");
    const path = `frames/${index + 1}.png`, bytes = Uint8Array.from(atob(capture.dataUrl.split(",")[1]), char => char.charCodeAt(0));
    if (await sha(bytes) !== capture.imageSha256) throw Error("A captured map image changed. Capture the frame again.");
    files[path] = bytes;
    const dataFrames = (layout.dataFrames ?? []).filter(item => item.mapFrameId === frame.id).map(item =>
      assertPrintDataFrameSnapshot(item, capture.dataFrames?.find(snapshot => snapshot.frameId === item.id), capture.presentation));
    frames.push({frameId: frame.id, path, projectId: capture.projectId, projectVersion: capture.projectVersion,
      width: capture.width, height: capture.height, cssWidth: capture.cssWidth, cssHeight: capture.cssHeight,
      view: capture.view, presentation: capture.presentation, imageSha256: capture.imageSha256,
      legend: capture.legend, numericLegends: capture.numericLegends ?? [],
      continuousLegends: [...continuousLegendGroups(capture).values()], dataFrames,
      ...(capture.rasterLegends?.length ? {rasterLegends: [...rasterLegendGroups(capture).values()]} : {}),
      attribution: capture.attribution, sourceMetadata: capture.sourceMetadata ?? [],
      flat: capture.flat, metresPerPixel: capture.metresPerPixel, graticule: capture.lines});
  }
  files["map-context.json"] = strToU8(JSON.stringify({schemaVersion: "opengeo.figure-context.1.0.0", frames}, null, 2));
  if (files["map-context.json"].byteLength > 1024 * 1024) throw Error("The figure metadata exceeds 1 MiB. Select fewer Layers.");
  files["README.txt"] = strToU8(`OpenGeo figure and print pack

page.png and page.jpg are the composed page. page.pdf places the same JPEG at
the layout's exact paper dimensions. It is a raster PDF, without selectable text,
vector geometry or geographic registration. DPI sets page dimensions; captured
map detail remains limited to its original pixels. JPEG uses quality0.92.

Open print.html locally to view or print the self-contained SVG page. page.svg,
layout.json, map-context.json and frames/ retain the layout, frame pixels, camera,
presentation, source metadata, captured table/chart values and attribution needed
to reproduce this captured figure. System fonts may differ between devices; the supplied PNG/JPEG/PDF have
fixed pixels. Keep recorded credits and review data/styling rights before sharing.

This pack contains captured output, not the original data, editable Project,
upstream services, credentials or a complete offline source archive. Save an
editable Project backup separately to continue GIS editing. All included figure
outputs work offline. manifest.json records file hashes and dependency scope.
`);
  const bytes = Object.values(files).reduce((sum, file) => sum + file.byteLength, 0);
  if (bytes > LIMIT - 65536) throw Error("This figure pack exceeds 32 MiB. Choose a lower output DPI.");
  const manifest = {schemaVersion: "opengeo.figure-print-pack.1.0.0", title: layout.title, layoutId,
    page: {...layout.page, dpi: layout.dpi, widthPixels: width, heightPixels: height}, fullyOffline: true,
    pdf: {path: "page.pdf", representation: "raster-page", image: "page.jpg", selectableText: false, georeferenced: false},
    dependencies: {included: frames.map(frame => ({kind: "captured-map-image", path: frame.path, checksumSha256: frame.imageSha256})), live: [],
      excluded: ["original-source-data", "editable-project", "upstream-services", "private-configuration"], environment: ["system-fonts-for-SVG-and-HTML"]},
    rights: {license: null, redistributionAllowed: null},
    files: await Promise.all(Object.entries(files).map(async ([path, data]) => ({path, sizeBytes: data.length, checksumSha256: await sha(data)})))};
  files["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));
  if (files["manifest.json"].length > 65536 || bytes + files["manifest.json"].length > LIMIT) throw Error("The figure pack manifest exceeds its limit.");
  const archive = zipSync(Object.fromEntries(Object.entries(files).map(([path, data]) => [path, [data, {mtime: new Date("2020-01-01T00:00:00Z")}]])), {level: 6});
  return {blob: new Blob([archive], {type: "application/zip"}), manifest};
}

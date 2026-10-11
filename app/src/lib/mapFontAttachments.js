import {FileAttachment} from "observablehq:stdlib";

const ranges = {
  "0-255": FileAttachment("../assets/render-fonts/opengeo-open-sans-v1/1/0-255.pbf"),
  "256-511": FileAttachment("../assets/render-fonts/opengeo-open-sans-v1/1/256-511.pbf"),
  "512-767": FileAttachment("../assets/render-fonts/opengeo-open-sans-v1/1/512-767.pbf"),
  "768-1023": FileAttachment("../assets/render-fonts/opengeo-open-sans-v1/1/768-1023.pbf"),
  "1024-1279": FileAttachment("../assets/render-fonts/opengeo-open-sans-v1/1/1024-1279.pbf"),
  "1280-1535": FileAttachment("../assets/render-fonts/opengeo-open-sans-v1/1/1280-1535.pbf"),
  "7680-7935": FileAttachment("../assets/render-fonts/opengeo-open-sans-v1/1/7680-7935.pbf"),
  "7936-8191": FileAttachment("../assets/render-fonts/opengeo-open-sans-v1/1/7936-8191.pbf"),
  "8192-8447": FileAttachment("../assets/render-fonts/opengeo-open-sans-v1/1/8192-8447.pbf"),
  "8448-8703": FileAttachment("../assets/render-fonts/opengeo-open-sans-v1/1/8448-8703.pbf"),
  "8704-8959": FileAttachment("../assets/render-fonts/opengeo-open-sans-v1/1/8704-8959.pbf"),
  "9472-9727": FileAttachment("../assets/render-fonts/opengeo-open-sans-v1/1/9472-9727.pbf"),
  "64256-64511": FileAttachment("../assets/render-fonts/opengeo-open-sans-v1/1/64256-64511.pbf"),
  "65024-65279": FileAttachment("../assets/render-fonts/opengeo-open-sans-v1/1/65024-65279.pbf"),
  "65280-65535": FileAttachment("../assets/render-fonts/opengeo-open-sans-v1/1/65280-65535.pbf"),
};

// Literal attachments register immutable build assets without fetching them.
export const mapFontAttachments = {
  manifest: () => FileAttachment("../assets/render-fonts/opengeo-open-sans-v1/1/manifest.json").arrayBuffer(),
  range: range => attachment(range).arrayBuffer(),
  rangeUrl: range => attachment(range).url()
};
function attachment(range) {
  if (!Object.hasOwn(ranges, range)) throw new Error("map_font_range_unregistered");
  return ranges[range];
}
// Retain the redistributable license in the built source bundle.
export const mapFontLicense = FileAttachment("../assets/render-fonts/opengeo-open-sans-v1/1/LICENSE.txt");
export const mapFontNotice = FileAttachment("../assets/render-fonts/opengeo-open-sans-v1/1/NOTICE.txt");

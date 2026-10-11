import {FileAttachment} from "observablehq:stdlib";

export async function loadCogReader() {
  const url = await FileAttachment("../assets/cog-reader-3.1.0-beta.0.js").url();
  return import(url);
}

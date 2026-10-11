import config, {studioPwaHead} from "../observablehq.config.js";

// This build is an anonymous product surface, not a Studio route. Its staged
// source contains only the reviewed workbench components and public data.
export default {
  ...config,
  title: "OpenGeo.Tools GIS Workbench Demo",
  root: "dist/demo-source",
  output: "dist/demo-build",
  theme: ["near-midnight", "wide"],
  head: studioPwaHead,
  pages: [{name: "GIS Workbench Demo", path: "/"}],
  sidebar: false,
  search: false,
  pager: false,
  footer: "OpenGeo.Tools · anonymous browser-only GIS workbench demo"
};

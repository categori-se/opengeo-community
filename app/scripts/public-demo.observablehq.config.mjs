import config from "../observablehq.config.js";

// Build a publication-side handoff page. The actual anonymous workbench is a
// separately sealed artifact at demo.studio.opengeo.tools.
export default {
  ...config,
  title: "OpenGeo Studio Demo Handoff",
  root: "dist/public-demo-source",
  output: "dist/public-demo-build",
  head: '<meta name="referrer" content="strict-origin-when-cross-origin"><link rel="stylesheet" href="/style.css">',
  pages: [{name: "Public Workbench Demo", path: "/public-demo"}],
  sidebar: false,
  search: false,
  pager: false,
  footer: "OpenGeo.Tools · published with Observable Framework"
};

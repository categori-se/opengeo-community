import config from "../observablehq.config.js";

// Observable Framework's default footer embeds the wall-clock build time in
// every HTML page. The release tree is content-addressed, so keep the Studio
// footer stable while preserving the application-owned configuration.
export default {
  ...config,
  footer: "OpenGeo Studio · GIS workbench for opengeo.tools"
};

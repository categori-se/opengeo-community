import config from "../observablehq.config.js";

// Compile the anonymous workbench root and authenticated managed-site routes
// together so every page uses one consistent set of shared runtime modules.
export default {
  ...config,
  title: "OpenGeo public demo",
  root: "dist/managed-demo-source",
  output: "dist/managed-demo-build",
  footer: "OpenGeo.Tools · managed public demonstration site"
};

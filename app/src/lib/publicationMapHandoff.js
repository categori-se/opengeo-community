import {createPublicationSourceArchive} from "./publicationSourceArchive.js";
import {verifyPortableMapArtifact} from "./portableMapArtifact.js";

/** Use the existing reviewed source import, without an account call or upload. */
export async function compilePublicationMapHandoff({html, manifest, payload}) {
  await verifyPortableMapArtifact(new Blob([html]), manifest);
  const file = (relativePath, body, contentType) => ({relativePath, contentType, blob: new Blob([body], {type: contentType})});
  return createPublicationSourceArchive({metadata: {title: payload.title, entryPath: "index.html", lockfilePath: null,
    publicationFormat: "map", rightsStatus: "unreviewed"}, files: [
    file("index.html", html, "text/html"),
    file("index.html.artifact.json", JSON.stringify(manifest, null, 2), "application/json"),
    file("opengeo.publication.json", JSON.stringify({schema: "opengeo.publication.1", format: "map", entry: "index.html"}, null, 2), "application/json")
  ]});
}

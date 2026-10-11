import {readProviderJson} from "../lib/providerJson.js";

function element(tag, value, className = "") {
  const node = document.createElement(tag);
  node.textContent = value;
  node.className = className;
  return node;
}

export function sourceLinks(sourceUrl) {
  const url = new URL(sourceUrl);
  if (url.protocol !== "https:" || url.username || url.password ||
      [...url.searchParams.keys()].some(key => /token|key|signature|credential|password/i.test(key))) {
    throw new TypeError("Source links must be credential-free HTTPS URLs");
  }
  const service = new URL(url);
  service.pathname = service.pathname.replace("/arcgis/services/", "/arcgis/rest/services/");
  const match = service.pathname.match(/^(.*\/(?:ImageServer|MapServer|FeatureServer))(?:\/.*)?$/i);
  if (!match) return {provider: url.href};
  const layerNumber = service.pathname.slice(match[1].length).match(/^\/(\d+)\/?$/)?.[1];
  service.pathname = match[1]; service.search = ""; service.hash = "";
  const directory = new URL(service);
  directory.pathname = directory.pathname.replace(/\/[^/]+\/(?:ImageServer|MapServer|FeatureServer)$/i, "/");
  if (layerNumber !== undefined) service.pathname += `/${layerNumber}`;
  const metadata = new URL(service); metadata.searchParams.set("f", "json");
  const viewer = new URL("https://www.arcgis.com/apps/mapviewer/index.html");
  viewer.searchParams.set("url", service.href); viewer.searchParams.set("source", "sd");
  return {provider: service.href, directory: directory.href, metadata: metadata.href, viewer: viewer.href};
}

export async function readSourceMetadata(url, {fetchImplementation = globalThis.fetch, signal} = {}) {
  return (await readProviderJson(url, {fetchImplementation, signal})).data;
}

export function SourceDetails({source, dataset, snapshots = null, fetchImplementation = globalThis.fetch, onRetainMetadata}) {
  const root = element("section", "", "source-details");
  let disposed = false, activeController, activeTimeout;
  root.dispose = () => {disposed = true; activeController?.abort(); clearTimeout(activeTimeout);};
  root.append(element("h3", dataset.name), element("p", dataset.description || "No description saved for this layer."));
  const facts = element("dl", "", "project-repository-source-facts");
  const fact = (label, value) => {facts.append(element("dt", label), element("dd", value ?? "Not recorded"));};
  fact("Source type", source.sourceType); fact("Saved revision", source.versionNumber);
  fact("Connection validation", source.verificationState === "syntax_only" ? "Address checked; availability not checked" : source.verificationState);
  root.append(facts);
  root.append(element("h4", "Display and backup policy"), element("p", "This connection displays the provider's live service. Selecting or checking this layer does not serve an archived copy. Backup display is not enabled here; a provider outage does not automatically switch to S3."),
    element("p", "Backup use requires an explicit project-development opt-in and a verified matching snapshot. Capturing a backup is separate from enabling its display."));
  const links = sourceLinks(source.sourceUrl);
  const navigation = element("nav", "", "platform-actions");
  navigation.setAttribute("aria-label", "Provider references");
  for (const [key, label] of Object.entries({provider: "Provider service", directory: "Service directory", viewer: "Provider map viewer", metadata: "Original metadata JSON"})) {
    if (!links[key]) continue;
    const anchor = element("a", label, "platform-button platform-button-secondary");
    anchor.href = links[key]; anchor.target = "_blank"; anchor.rel = "noopener noreferrer";
    navigation.append(anchor);
  }
  root.append(navigation, element("h4", "Source availability"));
  const status = element("p", "Not checked in this visit. A saved connection is not evidence that the source is available.");
  status.setAttribute("role", "status");
  root.append(status);
  if (links.metadata) {
    const check = element("button", "Check source and read metadata", "platform-button"); check.type = "button";
    const content = element("section", "", "source-provider-metadata");
    check.addEventListener("click", async () => {
      if (disposed || check.disabled) return;
      check.disabled = true; status.textContent = "Reading provider metadata…";
      const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15_000);
      activeController = controller; activeTimeout = timeout;
      const checkedAt = () => new Date().toLocaleString();
      try {
        const response = await readProviderJson(links.metadata, {fetchImplementation, signal: controller.signal});
        if (disposed || controller.signal.aborted) return;
        const metadata = response.data;
        status.textContent = `Metadata reachable · checked ${checkedAt()}. Map images and original downloads have not been tested.`;
        content.replaceChildren(element("h4", "Provider metadata"));
        content.append(element("h5", "Attribution and rights"), element("p", metadata.copyrightText || "The service does not report copyright text. Check the acquisition's original metadata for citation, access and use constraints; a public URL is not a license."));
        const list = element("dl", "", "project-repository-source-facts");
        for (const [key, value] of Object.entries(metadata)) {
          list.append(element("dt", key));
          const description = element("dd", "");
          if (value !== null && typeof value === "object") {
            const details = element("details", "");
            details.append(element("summary", Array.isArray(value) ? `${value.length} entries` : "View details"), element("pre", JSON.stringify(value, null, 2)));
            description.append(details);
          } else description.textContent = String(value ?? "Not reported");
          list.append(description);
        }
        content.append(list);
        const original = element("details", "");
        original.append(element("summary", "Exact retrieved metadata text"), element("pre", response.text));
        content.append(original, element("p", `Retrieved ${response.retrievedAt} · ${response.bytes} bytes · ${response.contentType}`));
        const download = element("button", "Download metadata JSON", "platform-button secondary"); download.type = "button";
        download.addEventListener("click", () => {
          if (disposed) return;
          const url = URL.createObjectURL(new Blob([response.text], {type: response.contentType}));
          try {const anchor = element("a", ""); anchor.href = url; anchor.download = "provider-metadata.json"; anchor.click();}
          finally {setTimeout(() => URL.revokeObjectURL(url), 1000);}
        });
        content.append(download);
        if (typeof onRetainMetadata === "function") {
          const retain = element("button", "Use metadata in draft", "platform-button secondary"); retain.type = "button";
          const retained = element("p", "Review the original source entry below, add it to the draft, then save a metadata revision."); retained.setAttribute("role", "status");
          if (response.bytes > 49_152) {
            retain.disabled = true;
            retained.textContent = "This metadata exceeds the 48 KiB record limit. Inspect or download the complete text; it cannot be staged here and is never truncated.";
          }
          retain.addEventListener("click", async () => {
            if (disposed || retain.disabled) return;
            retain.disabled = true; check.disabled = true;
            try {
              await onRetainMetadata({sourceUrl: links.metadata, retrievedAt: response.retrievedAt, mediaType: response.contentType, content: response.text});
              if (!disposed) retained.textContent = "Metadata is pending in the original source form. Review it, add it to the draft, then save a metadata revision.";
            } catch (error) {
              if (!disposed) retained.textContent = error.message || "The metadata could not be staged. Your existing draft is retained.";
            } finally {if (!disposed) {retain.disabled = false; check.disabled = false;}}
          });
          content.append(retain, retained);
        }
      } catch {
        if (disposed) return;
        status.textContent = `Could not check this source · ${checkedAt()}. The provider may be unavailable or may block browser access. Use the provider links to check directly.`;
      } finally {clearTimeout(timeout); if (!disposed) check.disabled = false; activeController = null; activeTimeout = null;}
    });
    root.append(check, content);
  }
  root.append(element("h4", "Archive snapshots"));
  if (snapshots === null) root.append(element("p", "Archive snapshots have not been inspected here. Use the Catalog Layer's preserved data inventory and archive inspection to review recorded copies. Provider metadata reachability does not verify backup availability or equivalent content."));
  else if (!snapshots.length) root.append(element("p", "No archive snapshot is linked to this layer. A separate S3 backup may exist; it must be registered and verified before Studio can report its status."));
  for (const snapshot of snapshots ?? []) {
    const item = element("article", "");
    item.append(element("strong", snapshot.label), element("p", `${snapshot.state} · ${snapshot.fileCount} files · ${snapshot.totalBytes} bytes`),
      element("p", `Verified: ${snapshot.verifiedAt || "not verified"}`), element("p", `Storage: ${snapshot.storageClass || "not recorded"}`));
    root.append(item);
  }
  return root;
}

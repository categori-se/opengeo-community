import {ArtifactReleases} from "./ArtifactReleases.js";
import {portableArtifactUpload} from "../lib/portableArtifactUpload.js";
import {readPortableMapManifest} from "../lib/portableMapArtifact.js";
export function ProjectArtifactVersions({adapter, projectId, resourceId, canEdit = false}) {
  const panel = document.createElement("section");
  panel.className = "project-artifact-versions";
  const heading = document.createElement("h4");
  heading.textContent = "Project Artifact editions";
  const explanation = document.createElement("p");
  explanation.textContent = "Retain a completed image as an immutable edition, then choose its current version explicitly. These actions reuse the image without rebuilding or publishing it.";
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  const controls = document.createElement("div");
  controls.className = "platform-actions";
  panel.append(heading, explanation, controls, status);
  if (typeof adapter.readArtifactEdition !== "function") {
    status.textContent = "Artifact edition management is unavailable in this adapter.";
    return panel;
  }
  const releases = typeof adapter.listArtifactReleases === "function" ? ArtifactReleases({adapter}) : null;
  if (releases) panel.append(releases);
  let revision = null, selectedVersion = null, busy = false;
  const representation = document.createElement("select");
  representation.setAttribute("aria-label", "Artifact representation");
  for (const [value, label] of [["saved-map-image", "Saved map image"], ["portable-map-html", "Portable interactive HTML"]]) {
    const option = document.createElement("option"); option.value = value; option.textContent = label;
    representation.append(option);
  }
  controls.append(representation);
  const downloadLink = document.createElement("p");
  panel.append(downloadLink);
  const manifestSummary = document.createElement("p");
  panel.append(manifestSummary);
  const portable = () => representation.value === "portable-map-html";
  const read = (number, metadata = false) => portable()
    ? adapter.readArtifactEdition(projectId, resourceId, number, metadata, representation.value)
    : adapter.readArtifactEdition(projectId, resourceId, number, metadata);
  let previousRepresentation = representation.value;
  representation.addEventListener("change", () => {
    if (releases?.checkDraft()) {representation.value = previousRepresentation; return;}
    previousRepresentation = representation.value;
    downloadLink.replaceChildren();
    releases?.setTarget(null);
    revision = selectedVersion = null; version.value = "1"; manifestSummary.textContent = "";
    explanation.textContent = portable()
      ? "Inspect retained portable snapshots and choose their current edition. Choose exported HTML and its matching manifest to register an edition when storage is enabled. These actions do not rebuild or publish output."
      : "Retain a completed image as an immutable edition, then choose its current version explicitly. These actions reuse the image without rebuilding or publishing it.";
    status.textContent = "Load Artifact state for this representation.";
    update();
  });
  const button = (label, action) => {
    const element = document.createElement("button");
    element.type = "button";
    element.className = "platform-button secondary";
    element.textContent = label;
    element.addEventListener("click", async () => {
      if (busy || releases?.checkDraft()) return;
      busy = true;
      downloadLink.replaceChildren();
      update();
      try { await action(); }
      catch (error) {
        releases?.setTarget(null);
        revision = null;
        selectedVersion = null;
        manifestSummary.textContent = "";
        status.textContent = `Artifact action could not complete (${error?.code ?? error?.message ?? "unexpected_error"}). Reload current state before changing it. No build was started.`;
      } finally { busy = false; update(); }
    });
    controls.append(element);
    return element;
  };
  const show = record => {
    releases?.setTarget(record);
    manifestSummary.textContent = record.manifest
      ? `${record.manifest.representation} · ${record.manifest.output?.sizeBytes ?? "unknown"} bytes · ${record.manifest.dependencies?.length ?? 0} recorded dependencies${record.manifest.build?.inputScope === "reviewed-browser-snapshot" ? " · reviewed browser snapshot, not an attested saved-Project build" : ""}.`
      : "";
    revision = record.revision;
    selectedVersion = record.version_number;
    if (record.editions?.length) version.value = String(record.editions[0].version_number);
    status.textContent = `Artifact ${record.id} · revision ${record.revision} · current ${record.current_version_number == null ? "not selected" : `v${record.current_version_number}`}${selectedVersion == null ? "" : ` · inspected v${selectedVersion}`}.`;
  };
  button("Load Artifact state", async () => {
    try { show(await read(null, true)); }
    catch (error) {
      if (error.status !== 404) throw error;
      revision = 0;
      selectedVersion = null;
      status.textContent = portable() ? "No portable Artifact is registered. HTML downloads and Publication insertion remain available; choose exported HTML and its manifest to retain an edition when storage is enabled." : "No Artifact is registered. Choose a completed image to retain its first edition.";
    }
  });
  const version = document.createElement("input");
  version.type = "number";
  version.min = "1";
  version.max = "2147483647";
  version.step = "1";
  version.value = "1";
  version.setAttribute("aria-label", "Artifact version");
  controls.append(version);
  button("Inspect Artifact version", async () => {
    const number = Number(version.value);
    if (!Number.isSafeInteger(number) || number < 1 || number > 2147483647) throw new Error("Choose a version number");
    show(await read(number));
  });
  if (typeof adapter.downloadPortableArtifact === "function") {
    const download = button("Authorize portable HTML download", async () => {
      const ticket = await adapter.downloadPortableArtifact(projectId, resourceId, selectedVersion);
      const link = document.createElement("a");
      link.textContent = `Download portable edition v${selectedVersion}`;
      link.href = ticket.url;
      link.rel = "noopener noreferrer";
      link.referrerPolicy = "no-referrer";
      downloadLink.append(link);
      status.textContent = `Download authorized until ${ticket.expiresAt ?? ticket.expires_at}. The link retrieves the retained edition without rebuilding it.`;
    });
    download.portableOnly = true;
    download.isUnavailable = () => selectedVersion == null;
  }
  let register, setCurrent;
  if (canEdit) {
    if (typeof adapter.requestPortableArtifactUpload === "function") {
      let uploadSession = null;
      const htmlFile = document.createElement("input"); htmlFile.type = "file"; htmlFile.accept = ".html,text/html";
      htmlFile.setAttribute("aria-label", "Portable Artifact HTML"); htmlFile.portableOnly = true;
      const manifestFile = document.createElement("input"); manifestFile.type = "file"; manifestFile.accept = ".json,application/json";
      manifestFile.setAttribute("aria-label", "Portable Artifact manifest"); manifestFile.portableOnly = true;
      controls.append(htmlFile, manifestFile);
      for (const input of [htmlFile, manifestFile]) input.addEventListener("change", () => {uploadSession = null; update();});
      const upload = button("Upload and register portable edition", async () => {
        if (!uploadSession) uploadSession = portableArtifactUpload({adapter, projectId, resourceId,
          blob: htmlFile.files[0], manifest: await readPortableMapManifest(manifestFile.files[0])});
        show(await uploadSession.register(revision));
      });
      upload.portableOnly = true;
      upload.isUnavailable = () => revision == null || !htmlFile.files?.length || !manifestFile.files?.length;
    }
    const images = document.createElement("select");
    images.setAttribute("aria-label", "Image to register as Artifact edition");
    images.imageOnly = true;
    controls.append(images);
    const findImages = button("Find completed images", async () => {
      const jobs = await adapter.listResourceRenders(projectId, resourceId);
      images.replaceChildren();
      for (const job of jobs.filter(job => job.state === "completed" && job.savedMapSnapshot)) {
        const option = document.createElement("option");
        option.value = job.id;
        option.textContent = `Map v${job.savedMapSnapshot.mapVersion} · ${job.width} × ${job.height} · ${job.id}`;
        images.append(option);
      }
      status.textContent = images.options.length ? "Choose an image; registration does not select it as current." : "No completed saved-map images are available.";
    });
    images.addEventListener("change", () => update());
    register = button("Register image edition", async () => {
      show(await adapter.registerArtifactEdition(projectId, resourceId, images.value, revision));
    });
    setCurrent = button("Use inspected edition as current", async () => {
      show(await adapter.selectArtifactCurrent(projectId, resourceId, selectedVersion, revision, ...(portable() ? [representation.value] : [])));
    });
    findImages.imageOnly = register.imageOnly = true;
    register.isUnavailable = () => revision == null || !images.value;
    setCurrent.isUnavailable = () => revision == null || selectedVersion == null;
  }
  function update() {
    for (const control of controls.querySelectorAll("button, input, select")) {
      control.hidden = Boolean((control.imageOnly && portable()) || (control.portableOnly && !portable()));
      control.disabled = control.hidden || busy || Boolean(control.isUnavailable?.());
    }
  }
  update();
  return panel;
}

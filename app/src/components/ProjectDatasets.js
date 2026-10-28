import {documentPreview} from "./DocumentPreview.js";
import {FeatureAttachmentPicker} from "./FeatureAttachmentPicker.js";
import {validateCalculation, evaluateCalculation} from "../lib/fieldCalculations.js";
import {featureFieldVisible} from "../lib/featureFieldVisibility.js";
import {ArchiveFolderUpload} from "./ArchiveFolderUpload.js";
import {FeatureCanvas, canvasEditingSupported, previewSharedPolygonVertexMove} from "./FeatureCanvas.js";
import {MapView} from "./MapView.js";
import {DatasetInspectionPanels} from "./DatasetInspectionPanels.js";
import {DatasetAccess} from "./DatasetAccess.js";
import {ProjectFederations} from "./ProjectFederations.js";
import {SourceArchivePanel} from "./SourceArchivePanel.js";
import {SourceDetails} from "./SourceDetails.js";
import {SourceEditor} from "./SourceEditor.js";
import {hasSourceArchiveWorkflow} from "../lib/sourceArchival.js";
import {directoryHref, projectHref} from "../lib/applicationRoutes.js";
import {pmtilesOptionsSummary,createPmtilesConversionDraft,pmtilesRequestIntent,pmtilesConversionAvailability,pmtilesUnconfirmedRetry} from '../lib/pmtilesOptions.js';
import {PmtilesConversionEditor} from './PmtilesConversionEditor.js';
import {
  OfflineCaptureQueue,
  OfflineAttachmentFiles,
  pendingDeviceAttachments,
  currentGpsPoint,
  offlineCaptureAllowed,
  syncCaptureQueue
} from "../lib/offlineCapture.js";
import {
  MANAGED_FILE_ACCEPT,
  MANAGED_FORMATS,
  MANAGED_UPLOAD_ERROR_MESSAGES,
  inferManagedFormat,
  ingestManagedFile,
  sha256Hex
} from "../lib/managedUpload.js";
import {scheduleCaptureSync, subscribeCaptureSync} from "../lib/studioPwa.js";

const FORMAT_LABELS = Object.freeze({
  ...Object.fromEntries(Object.entries(MANAGED_FORMATS).map(([key, value]) => [key, value.label])),
  xyz: "XYZ tiles",
  wms: "OGC WMS",
  mapserver: "ArcGIS MapServer",
  imageserver: "ArcGIS ImageServer"
});

const EDITABLE_VECTOR_FORMATS = new Set(["geojson", "shapefile", "geopackage", "geoparquet"]);
const SPATIAL_PREVIEW_FORMATS = new Set([
  "geojson", "csv", "shapefile", "geopackage", "geoparquet"
]);
const FEATURE_GEOMETRY_TYPES = [
  "Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"
];
const FEATURE_FIELD_TYPES = ["string", "integer", "number", "boolean", "group"];
const FEATURE_FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]{0,99}$/;
const FEATURE_FIELD_RESERVED_NAMES = new Set([
  "opengeo_created_at", "opengeo_updated_at", "opengeo_version"
]);
const MAX_FEATURE_FIELDS = 64;

const PROCESSING_MESSAGES = Object.freeze({
  dataset_magic_mismatch: "The file contents do not match the selected dataset format. Select the correct format or upload a different file.",
  dataset_format_mismatch: "The GIS driver identified a different format. Check the export format and upload the source again.",
  cog_layout_required: "This TIFF is not cloud optimized. Convert it to a COG, then upload the converted file.",
  shapefile_components_invalid: "The ZIP must contain exactly one matching .shp, .shx, and .dbf set.",
  archive_entry_unsafe: "The ZIP contains an unsupported or unsafe entry. Rebuild a flat archive from the source shapefile.",
  archive_entry_count_invalid: "The ZIP has an unsupported number of entries. Remove unrelated files and upload it again.",
  archive_expanded_size_exceeded: "The expanded ZIP exceeds the processing limit. Split or simplify the dataset.",
  archive_compression_ratio_exceeded: "The ZIP compression ratio exceeds the safety limit. Rebuild the archive with normal compression.",
  media_source_too_large: "Images are limited to 16 MiB before processing.",
  media_dimensions_exceeded: "The image dimensions or decoded pixel count exceed the safety limit.",
  media_structure_invalid: "The image structure is invalid or contains unsupported trailing data.",
  media_signature_blocked: "The image contains a blocked safety-test signature.",
  media_metadata_invalid: "The image decoder could not read safe bounded metadata from this file.",
  media_derivative_generation_failed: "A safe publishable image derivative could not be generated.",
  document_source_too_large: "PDF and OpenDocument text files are limited to 32 MiB before processing.",
  document_structure_invalid: "The document structure, page count, package, or page geometry is invalid.",
  document_active_content_blocked: "The document contains active, embedded, external, encrypted, or otherwise unsupported content.",
  document_metadata_invalid: "The isolated document inspector could not read bounded document metadata.",
  document_archive_invalid: "The OpenDocument package is malformed, encrypted, or outside the bounded portable subset.",
  document_content_limit_exceeded: "The OpenDocument text, page, block, table, or expanded-package limit was exceeded.",
  document_preview_generation_failed: "The isolated renderer could not create a bounded first-page preview.",
  malware_detected: "The malware scanner blocked this file. Contact an administrator if you believe this is an error.",
  malware_scanner_unavailable: "The malware scanner is unavailable. Processing will retry without activating the file.",
  gis_dataset_invalid: "The GIS toolchain could not read or normalize this file. Validate the source in a GIS tool and upload a corrected export.",
  source_object_facts_mismatch: "The stored object no longer matches the verified upload. Start a new upload.",
  source_object_too_large: "The stored source exceeds the processing limit. Split or simplify the dataset.",
  gis_command_timeout: "Processing exceeded its bounded runtime. Simplify or split the dataset and upload it again."
});

export function ProjectDatasets({state, refresh, featureTarget = null}) {
  const section = document.createElement("section");
  section.className = "project-datasets";
  section.id = "project-datasets";
  section.dataset.state = "ready";

  const heading = document.createElement("header");
  heading.className = "project-datasets-heading";
  const summary = document.createElement("div");
  const count = text(
    "p",
    `${state.datasets.length} dataset${state.datasets.length === 1 ? "" : "s"} · original objects remain private`,
    "platform-subtitle"
  );
  summary.append(
    text("p", "Managed data", "platform-eyebrow"),
    text("h2", "Project datasets"),
    count
  );
  heading.append(summary, statusLegend());
  const catalog = datasetCatalog(state.datasets, state, refresh, featureTarget);
  section.append(
    heading,
    ProjectFederations({state}),
    projectConnectionCatalog(state, refresh),
    existingDatasetPicker(state, refresh),
    catalogFilters(state, catalog, count),
    catalog
  );

  if (canUpload(state)) {
    section.append(uploadForm(state, refresh, section));
    if (typeof state.adapter.archiveUploads === "function") section.append(ArchiveFolderUpload({state}));
  } else {
    section.append(text(
      "p",
      "Your role can inspect this catalog. Dataset uploads require project owner or editor access.",
      "project-datasets-readonly"
    ));
  }
  return section;
}

function projectConnectionCatalog(state, refresh) {
  const panel = document.createElement("section");
  panel.className = "project-connection-catalog";
  const connections = state.datasetConnectionBindings ?? [];
  const basemapConnections = state.basemapConnectionBindings ?? [];
  const connectionCount = connections.length + basemapConnections.length;
  const heading = document.createElement("header");
  heading.append(
    text("h3", "Reusable project connections"),
    text(
      "p",
      `${connectionCount} explicit project binding${connectionCount === 1 ? "" : "s"} · credentials are not copied into this project`,
      "platform-subtitle"
    )
  );
  const manage = document.createElement("a");
  manage.className = "platform-button secondary";
  manage.href = directoryHref({view: "sources", adapterKind: state.adapter?.kind});
  manage.textContent = "Manage my connections";
  heading.append(manage);
  panel.append(heading);
  if (!connectionCount) {
    panel.append(text(
      "p",
      "No reusable connection is attached. Add one from your account connections; maps and style definitions remain project-specific.",
      "project-datasets-empty"
    ));
    return panel;
  }
  const list = document.createElement("div");
  list.className = "project-connection-list";
  for (const binding of connections) {
    const record = document.createElement("article");
    record.className = "project-connection-record";
    const connection = binding.connection;
    const identity = document.createElement("div");
    identity.append(
      text("strong", binding.displayName),
      text(
        "span",
        `s3://${connection.bucketName}/${connection.objectPrefix} · ${connection.regionName}`
      )
    );
    record.append(
      identity,
      badge(connection.status),
      text("span", connection.credentialMode.replaceAll("_", " "))
    );
    if (
      connection.ownedByCaller
      || state.organization.callerRole === "admin"
      || state.project.callerRole === "owner"
    ) {
      const remove = text("button", "Remove from project", "platform-button secondary");
      remove.type = "button";
      remove.addEventListener("click", async () => {
        remove.disabled = true;
        try {
          await state.adapter.removeProjectDatasetConnectionBinding(
            state.project.id,
            binding.id
          );
          await refresh();
        } catch (error) {
          record.append(text(
            "p",
            `Connection was not removed (${error?.code ?? "unexpected_error"}).`,
            "project-resource-feedback"
          ));
          remove.disabled = false;
        }
      });
      record.append(remove);
    }
    list.append(record);
  }
  for (const binding of basemapConnections) {
    const record = document.createElement("article");
    record.className = "project-connection-record";
    const connection = binding.connection;
    const identity = document.createElement("div");
    identity.append(
      text("strong", binding.displayName),
      text("span", `Protomaps basemaps · ${connection.allowedOrigins.join(", ")}`)
    );
    record.append(
      identity,
      badge(connection.status),
      text("span", "client-visible browser key")
    );
    if (
      connection.ownedByCaller
      || state.organization.callerRole === "admin"
      || state.project.callerRole === "owner"
    ) {
      const remove = text("button", "Remove from project", "platform-button secondary");
      remove.type = "button";
      remove.addEventListener("click", async () => {
        remove.disabled = true;
        try {
          await state.adapter.removeProjectBasemapConnectionBinding(
            state.project.id,
            binding.id
          );
          await refresh();
        } catch (error) {
          record.append(text(
            "p",
            `Basemap connection was not removed (${error?.code ?? "unexpected_error"}).`,
            "project-resource-feedback"
          ));
          remove.disabled = false;
        }
      });
      record.append(remove);
    }
    list.append(record);
  }
  panel.append(list);
  return panel;
}

function existingDatasetPicker(state, refresh) {
  const panel = document.createElement("details");
  panel.className = "project-dataset-picker";
  const summary = document.createElement("summary");
  summary.append(
    text("strong", "Add an existing dataset"),
    text("span", "Reuse governed data; keep this project's layers and styles independent")
  );
  panel.append(summary);
  if (!canUpload(state) || typeof state.adapter.searchDatasets !== "function"
    || typeof state.adapter.attachDataset !== "function") {
    panel.append(text(
      "p",
      "Project owner or editor access is required to attach an existing dataset.",
      "project-datasets-readonly"
    ));
    return panel;
  }

  const form = document.createElement("form");
  form.className = "project-dataset-picker-form";
  const query = input("search", "Find an existing organization dataset");
  query.placeholder = "Search dataset name, description, or tag";
  query.maxLength = 200;
  const submit = text("button", "Find datasets", "platform-button secondary");
  submit.type = "submit";
  const feedback = text(
    "p",
    "Searches only datasets you are authorized to discover. Attaching copies no data or credentials.",
    "project-catalog-feedback"
  );
  feedback.ariaLive = "polite";
  const results = document.createElement("div");
  results.className = "project-dataset-picker-results";
  form.append(field("Find reusable data", query), submit, feedback, results);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    feedback.textContent = "Searching authorized organization datasets…";
    results.replaceChildren();
    try {
      const currentIds = new Set(state.datasets.map(({id}) => id));
      const records = (await state.adapter.searchDatasets({
        query: query.value.trim() || null,
        limit: 50
      })).filter(({id}) => !currentIds.has(id));
      renderDatasetChoices(records, {state, refresh, results, feedback});
      feedback.textContent = records.length
        ? `${records.length} reusable dataset${records.length === 1 ? "" : "s"} found.`
        : "No additional authorized datasets match this search.";
    } catch (error) {
      feedback.textContent = `Dataset discovery failed safely (${error?.code ?? "unexpected_error"}).`;
    } finally {
      submit.disabled = false;
    }
  });
  panel.append(form);
  return panel;
}

function renderDatasetChoices(records, {state, refresh, results, feedback}) {
  for (const dataset of records) {
    const record = document.createElement("article");
    record.className = "project-dataset-picker-record";
    const identity = document.createElement("div");
    identity.append(
      text("strong", dataset.name),
      text("span", [dataset.format, dataset.geometryType, dataset.classification]
        .filter(Boolean).join(" · "))
    );
    const attach = text(
      "button",
      dataset.capabilities.managePermissions ? "Add to project" : "Owner approval required",
      "platform-button secondary"
    );
    attach.type = "button";
    attach.disabled = !dataset.capabilities.managePermissions;
    attach.addEventListener("click", async () => {
      attach.disabled = true;
      feedback.textContent = `Adding ${dataset.name} to this project…`;
      try {
        await state.adapter.attachDataset(state.project.id, dataset.id);
        feedback.textContent = `${dataset.name} is now available to this project. Its source data was not copied.`;
        await refresh();
      } catch (error) {
        feedback.textContent = `Dataset was not added (${error?.code ?? "unexpected_error"}).`;
        attach.disabled = false;
      }
    });
    record.append(identity, attach);
    results.append(record);
  }
}

function datasetCatalog(datasets, state, refresh, featureTarget = null) {
  const container = document.createElement("div");
  container.className = "project-dataset-catalog";
  if (!datasets.length) {
    container.append(text("p", "No managed datasets have been registered for this project.", "project-datasets-empty"));
    return container;
  }

  for (const dataset of datasets) {
    const preservedOriginal = dataset.currentVersionState === "preserved";
    const externalSource = state.sources?.find((source) => source.datasetId === dataset.id) ?? null;
    const repositorySource = dataset.sourceType === "repository";
    const card = document.createElement("article");
    card.className = "project-dataset-card";
    card.id = `dataset-${dataset.id}`;
    card.dataset.datasetId = dataset.id;
    const identity = document.createElement("div");
    identity.append(
      text("h3", dataset.name),
      text("p", dataset.description ?? "No description", "project-dataset-description")
    );
    const badges = document.createElement("div");
    badges.className = "project-dataset-badges";
    badges.append(
      badge(dataset.status),
      badge(dataset.classification),
      badge(FORMAT_LABELS[dataset.format] ?? dataset.format)
    );
    const facts = document.createElement("dl");
    facts.append(
      fact("Version", externalSource
        ? `source r${externalSource.versionNumber}`
        : repositorySource
        ? "exact provider version"
        : dataset.currentVersionNumber
        ? `v${dataset.currentVersionNumber}`
        : "Awaiting upload"),
      fact("Processing", externalSource
        ? "browser-direct reference"
        : repositorySource
        ? "provider reference · not imported"
        : preservedOriginal ? "original preserved" : dataset.currentVersionState ?? "not queued"),
      fact("Features", externalSource
        ? "not server-inspected"
        : repositorySource
        ? "not imported"
        : dataset.featureCount === null
        ? preservedOriginal ? "not inspected" : "pending inspection"
        : dataset.featureCount.toLocaleString()),
      fact("CRS", externalSource?.configuration?.crs
        ?? dataset.crs
        ?? (externalSource ? "Web Mercator tiles" : repositorySource || preservedOriginal ? "not inspected" : "pending inspection"))
    );
    const tags = document.createElement("p");
    tags.className = "project-dataset-tags";
    tags.textContent = dataset.tags.length ? dataset.tags.map((tag) => `#${tag}`).join(" ") : "No tags";
    const actions = document.createElement("div");
    actions.className = "project-dataset-actions";
    const history = text(
      "button",
      externalSource ? "Source revisions" : repositorySource ? "Source details" : "Version history",
      "platform-button secondary"
    );
    history.type = "button";
    const panels = DatasetInspectionPanels({datasetId: dataset.id, datasetName: dataset.name});
    const details = panels.element;
    panels.bind("history", history, (details) => externalSource
      ? loadSourceRevisions({state, dataset, details, history})
      : repositorySource
      ? loadRepositorySource({state, dataset, details, history})
      : loadDatasetVersions({state, dataset, details, history}));
    actions.append(history);
    if (externalSource) {
      const sourceDetails = text("button", "Source details", "platform-button secondary");
      sourceDetails.type = "button";
      panels.bind("source-details", sourceDetails, (details) => {
        details.hidden = false;
        const current = state.sources?.find((source) => source.datasetId === dataset.id) ?? externalSource;
        details.replaceChildren(SourceDetails({source: current, dataset}), SourceEditor({adapter: state.adapter,
          source: current, organizationId: state.organization.id, userId: state.session.userId,
          onSaved: async (updated) => {
            state.sources = state.sources.map((source) => source.datasetId === updated.datasetId ? updated : source);
            state.datasets = state.datasets.map((row) => row.id === updated.datasetId ? {...row, classification: updated.classification} : row);
            await refresh();
          }}));
      });
      actions.append(sourceDetails);
    }
    if (externalSource && canUpload(state) && hasSourceArchiveWorkflow(state.adapter)) {
      const archive = text("button", "Archive source", "platform-button secondary");
      archive.type = "button";
      panels.bind("source-archive", archive, (details) => details.replaceChildren(SourceArchivePanel({
        adapter: state.adapter,
        context: {organizationId: state.organization.id, projectId: state.project.id,
          sourceDatasetId: dataset.id, sourceRevisionNumber: externalSource.versionNumber}
      })), {editable: true});
      actions.append(archive);
    }
    if (spatialPreviewAllowed(state, dataset, externalSource)) {
      const preview = text("button", "View preview", "platform-button secondary");
      preview.type = "button";
      panels.bind("preview", preview, (details) => loadSpatialPreview({
        state, dataset, details, preview
      }));
      actions.append(preview);
    }
    const mapHandoff = datasetMapHandoff({state, dataset, externalSource});
    if (mapHandoff) actions.append(mapHandoff);
    if(canUpload(state)&&dataset.capabilities.edit&&dataset.sourceType==='upload'&&dataset.currentVersionId
      &&((dataset.status==='active'&&dataset.currentVersionState==='active'&&SPATIAL_PREVIEW_FORMATS.has(dataset.format))
        ||(dataset.status==='draft'&&preservedOriginal&&dataset.format==='geojson'&&dataset.processingJobState==null))
      &&[state.adapter.createPmtilesDerivative,state.adapter.listPmtilesDerivatives].every(method=>typeof method==='function')){
      const convert=text('button','Create PMTiles','platform-button secondary');convert.type='button';
      let conversionDraft;
      panels.bind('pmtiles-conversion',convert,details=>{
        conversionDraft??=createPmtilesConversionDraft({datasetVersionId:dataset.currentVersionId,bounds:dataset.extent});
        details.replaceChildren(datasetPmtilesConversion({state,dataset,draft:conversionDraft}));
        details.hidden=false;
      },{editable:true});
      actions.append(convert);
    }
    if (
      repositorySource
      && canUpload(state)
      && typeof state.adapter.createRepositoryObjectCopyEstimate === "function"
    ) {
      const preserve = text("button", "Keep protected copy", "platform-button secondary");
      preserve.type = "button";
      panels.bind("protected-copy", preserve, (details) => openRepositoryProtectedCopy({
        state, dataset, details, preserve
      }), {editable: true});
      actions.append(preserve);
    }
    let featuresButton = null;
    if (featureEditingAllowed(dataset, externalSource)) {
      const features = text("button", "Edit features", "platform-button secondary");
      featuresButton = features;
      features.type = "button";
      panels.bind("features", features, (details, {initialFeatureId = null} = {}) => openFeatureEditing({
        state, dataset, details, features, initialFeatureId
      }), {editable: true});
      actions.append(features);
    }
    if (fieldCaptureAllowed(dataset, externalSource)) {
      const capture = text("button", "Field capture", "platform-button secondary");
      capture.type = "button";
      panels.bind("capture", capture, (details) => openFieldCapture({
        state, dataset, details, capture
      }), {editable: true});
      actions.append(capture);
    }
    if (dataset.capabilities.managePermissions) {
      const permissions = text("button", "Dataset access", "platform-button secondary");
      permissions.type = "button";
      panels.bind("permissions", permissions, (details) => loadDatasetPermissions({state, dataset, details, permissions}), {editable: true});
      actions.append(permissions);
    }
    if (
      canUpload(state)
      && typeof state.adapter.listResources === "function"
      && typeof state.adapter.createResource === "function"
    ) {
      const govern = text("button", "Metadata & publishing", "platform-button secondary");
      govern.type = "button";
      panels.bind("governance", govern, (details) => loadDatasetGovernance({
        state, dataset, details, govern
      }), {editable: true});
      actions.append(govern);
    }
    if (canUpload(state) && typeof state.adapter.detachDataset === "function") {
      const usedByMap = state.maps.some((map) => map.definition?.layers?.some(
        (layer) => layer?.datasetId === dataset.id
      ));
      const detach = text(
        "button",
        usedByMap ? "Used by a map" : "Remove from project",
        "platform-button secondary"
      );
      detach.type = "button";
      detach.disabled = usedByMap;
      if (usedByMap) {
        detach.ariaLabel = `Used by a map. Remove ${dataset.name} from every map before removing it from this project`;
      }
      detach.addEventListener("click", async () => {
        detach.disabled = true;
        try {
          await state.adapter.detachDataset(state.project.id, dataset.id);
          await refresh();
        } catch (error) {
          const errorNotice = text(
            "p",
            error?.code === "project_dataset_in_use"
              ? "Remove this dataset from every project map and publication before detaching it."
              : `The project reference was not removed (${error?.code ?? "unexpected_error"}).`,
            "project-catalog-error"
          );
          errorNotice.setAttribute("role", "alert");
          card.querySelector(".project-dataset-detach-error")?.remove();
          errorNotice.classList.add("project-dataset-detach-error");
          actions.after(errorNotice);
          detach.disabled = false;
        }
      });
      actions.append(detach);
    }
    card.append(identity, badges, facts, processingOutcome(dataset, refresh), tags, actions, details);
    container.append(card);
    if (featureTarget?.datasetId === dataset.id && featuresButton) {
      queueMicrotask(() => void panels.open("features", {
        initialFeatureId: featureTarget.featureId
      }));
    }
  }
  return container;
}

function datasetPmtilesConversion({state,dataset,draft}){
  const panel=document.createElement('section');panel.className='project-dataset-pmtiles';
  const version=dataset.currentVersionId;
  let jobs=[],busy=false,message='',capabilities,displayReview;
  const hasCapabilities=typeof state.adapter.getPmtilesConversionCapabilities==='function';
  const availability=()=>hasCapabilities?pmtilesConversionAvailability(dataset.format,capabilities):{allowed:true,message:''};
  const current=()=>{
    const latest=state.datasets.find(row=>row.id===dataset.id);
    return latest?.currentVersionId===version&&latest.status!=='archived'&&canUpload(state)&&latest.capabilities.edit;
  };
  const render=()=>{
    const editor=PmtilesConversionEditor({draft,versionLabel:`v${dataset.currentVersionNumber}`,busy,jobs,availability:availability(),onSubmit:()=>void submit()});
    const refresh=text('button','Refresh saved PMTiles jobs','platform-button secondary');refresh.type='button';refresh.disabled=busy;refresh.addEventListener('click',()=>void readJobs());
    const status=text('p',message);status.setAttribute('role','status');
    const history=document.createElement('div');history.className='project-pmtiles-job-list';
    for(const job of jobs){
      const row=document.createElement('article');row.dataset.jobId=job.jobId;
      row.append(text('strong',`${job.state} · ${job.jobId}`),text('p',job.options?pmtilesOptionsSummary(job.options):'GDAL default conversion'));
      if(Number.isFinite(job.outputSizeBytes))row.append(text('p',`Stored PMTiles: ${formatBytes(job.outputSizeBytes)}`));
      if(job.errorCode)row.append(text('p',`Conversion stopped: ${job.errorCode}. Review settings before deliberately retrying.`));
      if(job.state==='completed'&&typeof state.adapter.getPmtilesDisplayReview==='function'){
        const review=text('button','Review tiled display','platform-button secondary');review.type='button';review.disabled=busy;
        review.addEventListener('click',()=>void readDisplayReview(job));row.append(review);
        if(displayReview?.job.jobId===job.jobId)row.append(displayReviewForm());
      }
      history.append(row);
    }
    if(!jobs.length)history.append(text('p','No saved PMTiles conversion is listed for this version.'));
    panel.replaceChildren(editor,refresh,status,history);
  };
  const checkJob=job=>{if(job.projectId!==state.project.id||job.datasetId!==dataset.id||job.datasetVersionId!==version)throw Error('The saved conversion identity changed');return job;};
  async function readJobs(){
    if(busy)return;busy=true;message='Loading saved conversion metadata…';render();
    try{if(!current())throw Error('Dataset version changed');
      const results=await Promise.allSettled([state.adapter.listPmtilesDerivatives(state.project.id,dataset.id,version,{limit:100}),hasCapabilities?state.adapter.getPmtilesConversionCapabilities():Promise.resolve(null)]);
      if(results[1].status==='fulfilled')capabilities=results[1].value;else capabilities=null;
      if(results[0].status==='rejected')throw results[0].reason;
      if(!current())throw Error('Dataset version or access changed');
      jobs=results[0].value.map(checkJob);message='Saved jobs refreshed. No stored tile data was downloaded.';}
    catch(error){message=`Saved conversion jobs could not load (${error?.code??'unavailable'}). Existing records and your settings are retained.`;}
    finally{busy=false;render();}
  }
  async function submit(){
    if(busy)return;
    let intent;try{if(!current())throw Error('Dataset version changed');if(!availability().allowed&&!pmtilesUnconfirmedRetry(draft,jobs))throw Error(availability().message);intent=pmtilesRequestIntent(draft,jobs);}catch(error){message=error.message;render();return;}
    if(intent.existing){message=`A matching conversion is ${intent.existing.state}. Review its saved job below.`;render();return;}
    busy=true;message='Queuing conversion…';render();
    try{const job=checkJob(await state.adapter.createPmtilesDerivative(state.project.id,dataset.id,version,intent.request));jobs=[job,...jobs.filter(row=>row.jobId!==job.jobId)];message=`PMTiles conversion ${job.state}. Refresh saved jobs to check its progress.`;}
    catch(error){message=`Submission could not be confirmed (${error?.code??'unavailable'}). Refresh saved jobs or retry unchanged settings with the same request key.`;}
    finally{busy=false;render();}
  }
  async function readDisplayReview(job){
    if(busy)return;
    busy=true;message='Loading tiled display metadata…';
    displayReview={job,title:dataset.name,rightsBasis:'',attribution:'',acknowledged:false};render();
    const model=displayReview;
    try{
      if(!current())throw Error('Dataset version or access changed');
      checkJob(job);
      const review=await state.adapter.getPmtilesDisplayReview(state.project.id,dataset.id,version,job.jobId);
      if(!current()||displayReview!==model)throw Error('Dataset version or access changed');
      if(review.jobId!==job.jobId||review.datasetId!==dataset.id||review.datasetVersionId!==version
        ||!/^[a-f0-9]{64}$/.test(review.reviewSha256))throw Error('The display review identity changed');
      model.review=review;
      if(review.displayId===job.jobId)model.admitted={displayId:review.displayId,datasetId:dataset.id,datasetVersionId:version};
      message='Display metadata loaded. No map data was downloaded.';
    }catch(error){model.error=error.message;message='The tiled display could not be reviewed.';}
    finally{busy=false;render();}
  }
  function displayReviewForm(){
    const model=displayReview,section=document.createElement('section');section.className='project-pmtiles-display-review';
    section.append(text('h4','Tiled display review'));
    if(model.error)section.append(text('p',model.error,'project-catalog-error'));
    const review=model.review;if(!review)return section;
    section.append(text('p',`${formatBytes(review.downloadBytes)} · zoom ${review.minZoom}–${review.maxZoom} · ${review.reportedFragmentCount.toLocaleString()} reported tile fragments`));
    if(!review.eligible){section.append(text('p','This output cannot be added to a map. The completed conversion and original remain available.'));return section;}
    if(model.admitted){
      section.append(text('p','Tiled display is available. Choose a map, then confirm Add and Save. Tile downloads require separate consent.'));
      const handoff=datasetMapHandoff({state,dataset,externalSource:null,reviewedDisplay:model.admitted});
      if(handoff)section.append(handoff);
      return section;
    }
    section.append(text('p','Display geometry is clipped, quantized and may be simplified. Tile fragments are not source records; properties and feature IDs may differ from the original.'));
    const title=input('text','Tiled display title'),rights=textarea('Display rights basis'),attribution=textarea('Display attribution');
    title.value=model.title;title.maxLength=200;rights.value=model.rightsBasis;rights.maxLength=2000;attribution.value=model.attribution;attribution.maxLength=2000;
    for(const [control,key] of [[title,'title'],[rights,'rightsBasis'],[attribution,'attribution']]){
      control.disabled=busy;control.addEventListener('input',()=>{model[key]=control.value;});
    }
    const acknowledge=input('checkbox','I reviewed the conversion limits');acknowledge.checked=model.acknowledged;acknowledge.disabled=busy;
    acknowledge.addEventListener('change',()=>{model.acknowledged=acknowledge.checked;});
    const admit=text('button',busy?'Admitting tiled display…':'Admit tiled display','platform-button secondary');admit.type='button';
    admit.disabled=busy||typeof state.adapter.admitPmtilesDisplayReview!=='function';
    admit.addEventListener('click',()=>void admitDisplay(model));
    section.append(field('Title',title),field('Rights basis',rights),field('Attribution',attribution),field('I reviewed the conversion limits',acknowledge),admit);
    return section;
  }
  async function admitDisplay(model){
    if(busy||displayReview!==model)return;
    if(!model.title.trim()||!model.rightsBasis.trim()||!model.attribution.trim()||!model.acknowledged){
      model.error='Enter a title, rights basis and attribution, and acknowledge the conversion limits.';render();return;
    }
    busy=true;delete model.error;render();
    try{
      if(!current())throw Error('Dataset version or access changed');
      const admitted=await state.adapter.admitPmtilesDisplayReview(state.project.id,dataset.id,version,model.job.jobId,{
        expectedReviewSha256:model.review.reviewSha256,title:model.title.trim(),rightsBasis:model.rightsBasis.trim(),
        attribution:model.attribution.trim(),acknowledgeConversionLimits:true
      });
      if(!current()||displayReview!==model)throw Error('Dataset version or access changed');
      if(admitted.jobId!==model.job.jobId||admitted.displayId!==model.job.jobId||admitted.datasetId!==dataset.id
        ||admitted.datasetVersionId!==version||admitted.reviewSha256!==model.review.reviewSha256)throw Error('The admitted display identity changed');
      model.admitted=admitted;message='Tiled display admitted. No map data was downloaded.';
    }catch(error){model.error=error.message;message='The display admission could not be confirmed. Review it again before retrying.';}
    finally{busy=false;render();}
  }
  render();void readJobs();return panel;
}

function datasetMapHandoff({state, dataset, externalSource, reviewedDisplay = null}) {
  const displayAllowed=reviewedDisplay?.displayId&&reviewedDisplay.datasetId===dataset.id
    &&reviewedDisplay.datasetVersionId===dataset.currentVersionId&&dataset.capabilities.edit
    &&dataset.sourceType==='upload'&&['active','draft'].includes(dataset.status);
  if (!canUpload(state) || (!displayAllowed && !spatialPreviewAllowed(state, dataset, externalSource)
    && !managedCogMapAllowed(state, dataset, externalSource))) return null;
  const disclosure = document.createElement("details");
  disclosure.className = "project-dataset-map-handoff";
  const summary = text("summary", "Add to map…", "platform-button secondary");
  const choices = document.createElement("div");
  choices.className = "project-dataset-map-choices";
  choices.append(text(
    "p",
    `Choose a map for exact dataset v${dataset.currentVersionNumber}. Nothing changes until you confirm Add in the map and then Save.`,
    "project-catalog-feedback"
  ));
  const maps = [...(state.maps ?? [])]
    .filter(({status}) => status !== "archived")
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  if (!maps.length) {
    choices.append(text(
      "p",
      "Create a project map before adding this dataset to a composition.",
      "project-datasets-readonly"
    ));
  }
  for (const map of maps) {
    const alreadyUsed = map.definition?.layers?.some(({datasetId}) => datasetId === dataset.id) === true;
    const target = document.createElement("a");
    target.className = "platform-button secondary";
    target.href = alreadyUsed
      ? projectHref(state.project.id, {
          adapterKind: state.adapter.kind,
          mapId: map.id,
          fragment: "map-workspace"
        })
      : projectHref(state.project.id, {
          adapterKind: state.adapter.kind,
          mapDatasetTarget: {
            mapId: map.id,
            datasetId: dataset.id,
            datasetVersionId: dataset.currentVersionId
          },
          fragment: "map-workspace"
        });
    target.textContent = alreadyUsed ? `Open ${map.name} · already used` : `Add to ${map.name}`;
    target.dataset.mapId = map.id;
    target.dataset.handoff = alreadyUsed ? "open" : "add";
    choices.append(target);
  }
  disclosure.append(summary, choices);
  return disclosure;
}

async function loadDatasetGovernance({state, dataset, details, govern}) {
  details.hidden = false;
  details.dataset.panel = "governance";
  details.replaceChildren(text(
    "p",
    "Checking this project's governed catalog…",
    "project-catalog-feedback"
  ));
  govern.disabled = true;
  try {
    const resources = await state.adapter.listResources(state.project.id, {
      kind: "dataset",
      limit: 100
    });
    const existing = resources.find((resource) => resource.datasetId === dataset.id) ?? null;
    if (existing) {
      renderGovernedDatasetReady({state, dataset, resource: existing, details});
    } else {
      renderGovernedDatasetForm({state, dataset, resources, details});
    }
  } catch (error) {
    details.replaceChildren(text(
      "p",
      `The governed catalog could not be checked (${error?.code ?? "unexpected_error"}).`,
      "project-catalog-error"
    ));
  } finally {
    govern.disabled = false;
  }
}

function renderGovernedDatasetForm({state, dataset, resources, details}) {
  const form = document.createElement("form");
  form.className = "project-dataset-governance-form";
  form.noValidate = true;
  const slug = input("text", "Governed dataset slug");
  slug.value = availableResourceSlug(dataset, resources);
  slug.maxLength = 160;
  slug.pattern = "[a-z0-9](?:[a-z0-9-]{0,158}[a-z0-9])?";
  slug.required = true;
  const title = input("text", "Governed dataset title");
  title.value = dataset.name;
  title.maxLength = 300;
  title.required = true;
  const abstract = textarea("Governed dataset abstract", dataset.description ?? "");
  abstract.maxLength = 10_000;
  abstract.rows = 3;
  const license = input("text", "Governed dataset license");
  license.placeholder = "For example, CC-BY-4.0";
  license.maxLength = 200;
  license.required = true;
  const attribution = input("text", "Governed dataset attribution");
  attribution.placeholder = "Required before publication";
  attribution.maxLength = 1_000;
  attribution.required = true;
  const visibility = select("Governed dataset visibility", [
    ["restricted", "Restricted"],
    ["organization", "Organization"]
  ]);
  const feedback = text(
    "p",
    "This creates one draft catalog identity bound to the current project dataset. Publication remains a separate reviewed action.",
    "project-catalog-feedback"
  );
  feedback.ariaLive = "polite";
  const submit = text("button", "Create governed catalog record", "platform-button");
  submit.type = "submit";
  form.append(
    text("h4", "Prepare metadata and publishing"),
    field("Persistent URL name", slug),
    field("Title", title),
    field("Abstract", abstract),
    field("License", license),
    field("Attribution", attribution),
    field("Initial visibility", visibility),
    feedback,
    submit
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    submit.disabled = true;
    feedback.textContent = "Creating the versioned metadata identity…";
    try {
      const externalSource = state.sources?.find((source) => source.datasetId === dataset.id);
      const resource = await state.adapter.createResource(state.project.id, {
        kind: "dataset",
        slug: slug.value.trim().toLowerCase(),
        datasetId: dataset.id,
        visibility: visibility.value,
        metadata: {
          title: title.value.trim(),
          abstract: abstract.value.trim() || null,
          language: "en",
          license: license.value.trim(),
          attribution: attribution.value.trim(),
          keywords: [...new Set(dataset.tags ?? [])],
          spatialExtent: dataset.extent ?? null,
          profile: "opengeo.core.v1",
          extensions: {},
          translations: {}
        },
        content: {blocks: []},
        provenance: {
          source: "project_dataset",
          datasetId: dataset.id,
          datasetVersionId: dataset.currentVersionId ?? null,
          datasetVersionNumber: dataset.currentVersionNumber ?? null,
          sourceType: dataset.sourceType,
          ...(externalSource ? {externalSourceVersion: externalSource.versionNumber,
            externalSourceUrl: externalSource.sourceUrl} : {}),
          format: dataset.format
        }
      });
      renderGovernedDatasetReady({state, dataset, resource, details});
    } catch (error) {
      if (error?.code === "resource_conflict" || error?.code === "http_409") {
        const current = await state.adapter.listResources(state.project.id, {
          kind: "dataset",
          limit: 100
        });
        const existing = current.find((resource) => resource.datasetId === dataset.id) ?? null;
        if (existing) {
          renderGovernedDatasetReady({state, dataset, resource: existing, details});
          return;
        }
      }
      feedback.textContent = `The catalog record was not created (${error?.code ?? "invalid_metadata"}).`;
      feedback.className = "project-catalog-error";
      submit.disabled = false;
    }
  });
  details.replaceChildren(form);
}

function renderGovernedDatasetReady({state, dataset, resource, details}) {
  const open = document.createElement("a");
  open.className = "platform-button";
  open.href = projectHref(state.project.id, {
    adapterKind: state.adapter.kind,
    management: "resources",
    fragment: `resource-${resource.id}`
  });
  open.textContent = "Open metadata, styles & publishing";
  details.replaceChildren(
    text("h4", "Governed catalog record ready"),
    text(
      "p",
      `${dataset.name} is bound to ${resource.slug} · v${resource.versionNumber} · ${resource.state}.`,
      "project-catalog-feedback"
    ),
    open
  );
}

function availableResourceSlug(dataset, resources) {
  const fallback = `dataset-${String(dataset.id).slice(0, 8).toLowerCase()}`;
  const base = String(dataset.name ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 150)
    .replace(/-+$/g, "") || fallback;
  const used = new Set(resources.map(({slug}) => slug));
  if (!used.has(base)) return base;
  for (let suffix = 2; suffix <= 999; suffix += 1) {
    const candidate = `${base.slice(0, 155 - String(suffix).length).replace(/-+$/g, "")}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${fallback}-${String(dataset.id).slice(-8).toLowerCase()}`;
}

function catalogFilters(state, catalog, count) {
  const form = document.createElement("form");
  form.className = "project-catalog-filters";
  form.noValidate = true;
  const query = input("search", "Search datasets");
  query.placeholder = "Search name, description, or tags";
  query.maxLength = 200;
  const classification = select("Filter sensitivity", [["", "All sensitivity"], "public", "internal", "confidential", "restricted"]);
  const format = select("Filter format", [["", "All formats"], ...Object.entries(FORMAT_LABELS)]);
  const sourceType = select("Filter source", [["", "All sources"], ["upload", "Upload"], ["repository", "Connected repository"], ["xyz", "XYZ"], ["wms", "WMS"], ["imageserver", "ArcGIS ImageServer"], ["pmtiles", "PMTiles"]]);
  const tag = input("text", "Filter tag");
  tag.placeholder = "Tag";
  tag.maxLength = 64;
  const geometryType = input("text", "Filter geometry");
  geometryType.placeholder = "Geometry";
  geometryType.maxLength = 100;
  const ownerUserId = input("text", "Filter owner user ID");
  ownerUserId.placeholder = "Owner UUID";
  const updatedAfter = input("date", "Updated after");
  const updatedBefore = input("date", "Updated before");
  const submit = text("button", "Apply filters", "platform-button");
  submit.type = "submit";
  const clear = text("button", "Clear", "platform-button secondary");
  clear.type = "reset";
  const feedback = text("p", "PostgreSQL catalog search · results remain permission scoped", "project-catalog-feedback");
  feedback.ariaLive = "polite";
  form.append(query, classification, format, sourceType, tag, geometryType, ownerUserId, updatedAfter, updatedBefore, submit, clear, feedback);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    feedback.textContent = "Searching authorized catalog records…";
    try {
      const records = await state.adapter.listDatasets(state.project.id, {
        limit: 100,
        query: query.value.trim() || null,
        classification: classification.value || null,
        format: format.value || null,
        sourceType: sourceType.value || null,
        tag: tag.value.trim().toLowerCase() || null,
        geometryType: geometryType.value.trim() || null,
        ownerUserId: ownerUserId.value.trim() || null,
        updatedAfter: updatedAfter.value ? `${updatedAfter.value}T00:00:00Z` : null,
        updatedBefore: updatedBefore.value ? `${updatedBefore.value}T23:59:59Z` : null
      });
      const replacement = datasetCatalog(records, state, () => location.reload());
      catalog.replaceChildren(...replacement.childNodes);
      count.textContent = `${records.length} matching dataset${records.length === 1 ? "" : "s"} · permission scoped`;
      feedback.textContent = "Catalog filters applied.";
    } catch (error) {
      feedback.textContent = `Catalog search failed safely (${error?.code ?? "unexpected_error"}).`;
    } finally {
      submit.disabled = false;
    }
  });
  clear.addEventListener("click", () => location.reload());
  return form;
}

async function loadDatasetVersions({state, dataset, details, history}) {
  history.disabled = true;
  details.hidden = false;
  details.dataset.mode = "versions";
  details.replaceChildren(text("p", "Loading authorized logical versions…", "project-catalog-feedback"));
  try {
    const versions = await state.adapter.listDatasetVersions(state.project.id, dataset.id, {limit: 50});
    details.replaceChildren(versionHistory(state, dataset, versions));
  } catch (error) {
    details.replaceChildren(text("p", `Version history is unavailable (${error?.code ?? "unexpected_error"}).`, "project-catalog-error"));
  } finally {
    history.disabled = false;
  }
}

async function loadSourceRevisions({state, dataset, details, history}) {
  history.disabled = true;
  details.hidden = false;
  details.dataset.mode = "source-revisions";
  details.replaceChildren(text("p", "Loading append-only source revisions…", "project-catalog-feedback"));
  try {
    const revisions = await state.adapter.listSourceRevisions(
      state.project.id, dataset.id, {limit: 50}
    );
    const content = document.createElement("div");
    content.className = "project-version-history";
    content.append(text("h4", "External source revision history"));
    for (const revision of revisions) {
      const item = document.createElement("section");
      item.className = "project-version-record";
      item.append(
        text("strong", `r${revision.versionNumber}`),
        text("span", `${revision.verificationState.replace("_", " ")} · ${new Date(revision.createdAt).toLocaleString()}`),
        text("p", revision.changeMessage ?? "No change message"),
        text("p", `${new URL(revision.sourceUrl).hostname} · anonymous browser-direct`, "project-catalog-feedback")
      );
      content.append(item);
    }
    if (!revisions.length) content.append(text("p", "No source revisions exist.", "project-catalog-feedback"));
    details.replaceChildren(content);
  } catch (error) {
    details.replaceChildren(text("p", `Source history is unavailable (${error?.code ?? "unexpected_error"}).`, "project-catalog-error"));
  } finally {
    history.disabled = false;
  }
}

async function loadRepositorySource({state, dataset, details, history}) {
  history.disabled = true;
  details.hidden = false;
  details.dataset.mode = "repository-source";
  details.replaceChildren(text(
    "p",
    "Loading exact source metadata…",
    "project-catalog-feedback"
  ));
  try {
    const source = await state.adapter.getRepositoryObjectSource(
      state.project.id,
      dataset.id
    );
    const content = document.createElement("div");
    content.className = "project-version-history";
    content.append(
      text("h4", "Connected repository source"),
      text(
        "p",
        "OpenGeo Studio registered this exact provider version without copying its bytes. Import or preservation remains a separate reviewed action.",
        "project-catalog-feedback"
      )
    );
    const facts = document.createElement("dl");
    facts.className = "project-repository-source-facts";
    for (const [label, value] of [
      ["Repository", `s3://${source.bucketName}/${source.objectPrefix}`],
      ["Object", source.relativePath],
      ["Provider version", source.providerVersionId],
      ["Connection revision", source.connectionTargetRevision],
      ["Size", repositorySize(source.sizeBytes)],
      ["Modified at source", new Date(source.lastModified).toLocaleString()],
      ["Media type", source.contentType ?? "Not reported"],
      ["Storage class", source.storageClass ?? "Not reported"],
      ["ETag", source.etag],
      ["Provider SHA-256", source.providerChecksumSha256 ?? "Not reported"]
    ]) {
      facts.append(fact(label, value));
    }
    content.append(facts);
    details.replaceChildren(content);
  } catch (error) {
    details.replaceChildren(text(
      "p",
      `Source details are unavailable (${error?.code ?? "unexpected_error"}).`,
      "project-catalog-error"
    ));
  } finally {
    history.disabled = false;
  }
}

async function openRepositoryProtectedCopy({state, dataset, details, preserve}) {
  preserve.disabled = true;
  details.hidden = false;
  details.dataset.mode = "repository-copy";
  details.replaceChildren(text(
    "p",
    "Loading exact source and protected-copy history…",
    "project-catalog-feedback"
  ));
  try {
    await loadRepositoryProtectedCopyPanel({state, dataset, details});
  } catch (error) {
    details.replaceChildren(text(
      "p",
      `Protected-copy review is unavailable (${error?.code ?? "unexpected_error"}).`,
      "project-catalog-error"
    ));
  } finally {
    preserve.disabled = false;
  }
}

async function loadRepositoryProtectedCopyPanel({state, dataset, details, estimate = null, message = null}) {
  const [source, jobs] = await Promise.all([
    state.adapter.getRepositoryObjectSource(state.project.id, dataset.id),
    state.adapter.listRepositoryObjectProtectedCopies(
      state.project.id, dataset.id, {limit: 50}
    )
  ]);
  renderRepositoryProtectedCopyPanel({
    state, dataset, details, source, jobs, estimate, message
  });
}

function renderRepositoryProtectedCopyPanel({
  state, dataset, details, source, jobs, estimate, message
}) {
  const content = document.createElement("div");
  content.className = "project-version-history project-repository-copy-panel";
  content.append(
    text("h4", "Protected repository copy"),
    text(
      "p",
      "Keep the live, exact provider reference and create a separate immutable managed version. OpenGeo Studio fetches only the registered S3 VersionId, verifies its recorded facts, stores it with KMS encryption, and sends it through ordinary dataset validation.",
      "project-catalog-feedback"
    )
  );
  const sourceFacts = document.createElement("dl");
  sourceFacts.className = "project-repository-source-facts";
  for (const [label, value] of [
    ["Object", source.relativePath],
    ["Provider version", source.providerVersionId],
    ["Size", repositorySize(source.sizeBytes)],
    ["Format", FORMAT_LABELS[dataset.format] ?? dataset.format],
    ["Requests", "1 exact-version read"]
  ]) sourceFacts.append(fact(label, value));
  content.append(sourceFacts);

  if (message) {
    const feedback = text("p", message, "project-catalog-feedback");
    feedback.ariaLive = "polite";
    content.append(feedback);
  }

  if (estimate === null) {
    const review = text("button", "Review size, cost, and rights", "platform-button");
    review.type = "button";
    review.addEventListener("click", async () => {
      review.disabled = true;
      try {
        const sealed = await state.adapter.createRepositoryObjectCopyEstimate(
          state.project.id, dataset.id
        );
        renderRepositoryProtectedCopyPanel({
          state, dataset, details, source, jobs, estimate: sealed, message: null
        });
      } catch (error) {
        review.disabled = false;
        content.append(text(
          "p",
          `The server could not seal an estimate (${error?.code ?? "unexpected_error"}).`,
          "project-catalog-error"
        ));
      }
    });
    content.append(review);
  } else {
    content.append(repositoryCopyAcceptanceForm({
      state, dataset, details, source, jobs, estimate
    }));
  }

  const history = document.createElement("section");
  history.className = "project-repository-copy-history";
  history.append(text("h5", "Copy history"));
  if (!jobs.length) {
    history.append(text(
      "p", "No protected copy has been requested for this source.",
      "project-catalog-feedback"
    ));
  }
  for (const job of jobs) {
    const item = document.createElement("article");
    item.className = "project-version-record";
    item.append(
      text("strong", job.destinationName),
      text("span", `${job.state} · ${repositorySize(job.maximumOutputBytes)}`),
      text("p", `Provider version ${job.providerVersionId}`),
      text(
        "p",
        job.state === "completed"
          ? "Immutable copy stored; managed validation was queued separately."
          : job.errorCode ?? `Requested ${new Date(job.createdAt).toLocaleString()}`,
        "project-catalog-feedback"
      )
    );
    if (job.state === "completed" && job.destinationDatasetId) {
      const open = document.createElement("a");
      open.className = "platform-button secondary";
      open.href = projectHref(state.project.id, {
        adapterKind: state.adapter?.kind,
        management: "data",
        datasetId: job.destinationDatasetId
      });
      open.textContent = "Review copied dataset";
      item.append(open);
    }
    if (job.cancellable) {
      const cancel = text("button", "Cancel queued copy", "platform-button secondary");
      cancel.type = "button";
      cancel.addEventListener("click", async () => {
        cancel.disabled = true;
        try {
          await state.adapter.cancelRepositoryObjectProtectedCopy(
            state.project.id, dataset.id, job.jobId
          );
          await loadRepositoryProtectedCopyPanel({
            state, dataset, details, message: "The queued copy was cancelled."
          });
        } catch (error) {
          cancel.disabled = false;
          item.append(text(
            "p",
            `Cancellation was not accepted (${error?.code ?? "unexpected_error"}).`,
            "project-catalog-error"
          ));
        }
      });
      item.append(cancel);
    }
    history.append(item);
  }
  content.append(history);
  details.replaceChildren(content);
}

function repositoryCopyAcceptanceForm({state, dataset, details, source, jobs, estimate}) {
  const form = document.createElement("form");
  form.className = "project-upload-form project-repository-copy-form";
  form.noValidate = true;
  const estimateFacts = document.createElement("dl");
  estimateFacts.className = "project-repository-source-facts";
  for (const [label, value] of [
    ["Sealed size", repositorySize(estimate.maximumOutputBytes)],
    ["Maximum requests", estimate.maximumRequests],
    ["Estimated OpenGeo Studio cost", `$${Number(estimate.estimatedCostUsd).toFixed(6)}`],
    ["Estimate expires", new Date(estimate.expiresAt).toLocaleString()]
  ]) estimateFacts.append(fact(label, value));

  const name = input("text", "Protected copy dataset name");
  name.value = `${dataset.name} protected copy`;
  name.required = true;
  name.maxLength = 200;
  const classification = select(
    "Protected copy classification",
    ["internal", "restricted", "confidential", "public"]
  );
  const rightsBasis = textarea("Rights basis for copying this source");
  rightsBasis.required = true;
  rightsBasis.maxLength = 500;
  rightsBasis.rows = 2;
  const attribution = textarea("Required source attribution");
  attribution.required = true;
  attribution.maxLength = 1000;
  attribution.rows = 2;
  const acceptEstimate = input("checkbox", "Accept the sealed size and cost estimate");
  const confirmRights = input("checkbox", "Confirm authority to preserve this exact object");
  const fields = document.createElement("div");
  fields.className = "project-upload-fields";
  fields.append(
    field("Dataset name", name),
    field("Classification", classification),
    field("Rights or license basis", rightsBasis),
    field("Attribution", attribution),
    field("I accept the sealed size, request count, and estimated cost", acceptEstimate),
    field("I confirm authority to preserve this exact provider version", confirmRights)
  );
  const feedback = text(
    "p",
    "Review and confirm both statements before creating the copy.",
    "project-catalog-feedback"
  );
  feedback.ariaLive = "polite";
  const controls = document.createElement("div");
  controls.className = "project-dataset-actions";
  const back = text("button", "Back", "platform-button secondary");
  back.type = "button";
  back.addEventListener("click", () => renderRepositoryProtectedCopyPanel({
    state, dataset, details, source, jobs, estimate: null, message: null
  }));
  const submit = text("button", "Create protected copy", "platform-button");
  submit.type = "submit";
  controls.append(back, submit);
  form.append(estimateFacts, fields, feedback, controls);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (
      !acceptEstimate.checked
      || !confirmRights.checked
      || !name.value.trim()
      || !rightsBasis.value.trim()
      || !attribution.value.trim()
    ) {
      feedback.textContent = "Complete the required fields and both confirmations.";
      feedback.className = "project-catalog-error";
      return;
    }
    submit.disabled = true;
    feedback.className = "project-catalog-feedback";
    feedback.textContent = "Creating the durable job and dispatching its UUID…";
    try {
      const job = await state.adapter.createRepositoryObjectProtectedCopy(
        state.project.id,
        dataset.id,
        {
          idempotencyKey: crypto.randomUUID(),
          estimate: {
            estimateId: estimate.estimateId,
            estimateChecksumSha256: estimate.estimateChecksumSha256,
            accepted: true
          },
          rights: {
            confirmed: true,
            basis: rightsBasis.value.trim(),
            attribution: attribution.value.trim()
          },
          destination: {
            name: name.value.trim(),
            description: `Protected exact-version copy of ${source.relativePath}`,
            classification: classification.value
          }
        }
      );
      await loadRepositoryProtectedCopyPanel({
        state,
        dataset,
        details,
        message: `${job.destinationName} is ${job.state}. The live reference remains unchanged.`
      });
    } catch (error) {
      submit.disabled = false;
      feedback.className = "project-catalog-error";
      feedback.textContent = `The protected copy was not accepted (${error?.code ?? "unexpected_error"}).`;
    }
  });
  return form;
}

async function openFeatureEditing({
  state,
  dataset,
  details,
  features,
  initialFeatureId = null
}) {
  features.disabled = true;
  details.hidden = false;
  details.dataset.mode = "features";
  details.replaceChildren(text(
    "p",
    "Loading authoritative features and optimistic versions…",
    "project-catalog-feedback"
  ));
  await loadFeatureEditing(state, dataset, details, initialFeatureId);
  features.disabled = false;
}

async function loadSpatialPreview({state, dataset, details, preview}) {
  preview.disabled = true;
  details.hidden = false;
  details.dataset.mode = "spatial-preview";
  details.replaceChildren(text(
    "p",
    "Loading the exact validated preview derivative…",
    "project-catalog-feedback"
  ));
  try {
    const result = await state.adapter.getDatasetSpatialPreview(
      state.project.id, dataset.id, dataset.currentVersionId
    );
    const panel = document.createElement("section");
    panel.className = "project-spatial-preview";
    const count = result.numberMatched === null
      ? `${result.numberReturned.toLocaleString()} preview features · source count unavailable`
      : `${result.numberReturned.toLocaleString()} of ${result.numberMatched.toLocaleString()} features`;
    panel.append(
      text("h4", `${dataset.name} · validated preview`),
      text(
        "p",
        `${count}${result.mayBeTruncated ? " · bounded preview" : " · complete preview"}. This exact derived object is read with project authorization and does not expose storage coordinates.`,
        "project-catalog-feedback"
      ),
      MapView({
        geojson: result.geojson,
        geometryType: dataset.geometryType,
        height: "22rem"
      })
    );
    details.replaceChildren(panel);
  } catch (error) {
    details.replaceChildren(text(
      "p",
      `Spatial preview is unavailable (${error?.code ?? "unexpected_error"}).`,
      "project-catalog-error"
    ));
  } finally {
    preview.disabled = false;
  }
}

async function loadFeatureEditing(state, dataset, details, initialFeatureId = null) {
  destroyFeatureCanvases(details);
  try {
    const [page, featureLocks, tombstones, initialFeature] = await Promise.all([
      state.adapter.listFeatures(state.project.id, dataset.id, {limit: 100}),
      state.adapter.listFeatureLocks(state.project.id, dataset.id),
      featureTombstonesForEditor(state, dataset),
      initialFeatureId && typeof state.adapter.getFeature === "function"
        ? state.adapter.getFeature(state.project.id, dataset.id, initialFeatureId)
        : Promise.resolve(null)
    ]);
    const visiblePage = featurePageWithTarget(page, initialFeature);
    details.replaceChildren(featureEditor(
      state,
      dataset,
      details,
      visiblePage,
      featureLocks,
      tombstones,
      initialFeatureId
    ));
  } catch (error) {
    if (error?.code === "feature_collection_not_found") {
      details.replaceChildren(featureCollectionInitializer(state, dataset, details));
      return;
    }
    details.replaceChildren(text(
      "p",
      `Feature editing is unavailable (${error?.code ?? "unexpected_error"}).`,
      "project-catalog-error"
    ));
  }
}

export async function featureTombstonesForEditor(state, dataset) {
  const empty = {
    tombstones: [],
    numberMatched: 0,
    numberReturned: 0,
    limit: 100,
    offset: 0
  };
  if (typeof state.adapter.listFeatureTombstones !== "function") return empty;
  try {
    return await state.adapter.listFeatureTombstones(
      state.project.id, dataset.id, {limit: 100}
    );
  } catch (error) {
    // Static Studio and API releases are independently reversible. During a
    // brief forward-static/previous-API window, keep ordinary feature editing
    // available while the additive recovery panel remains absent.
    if (error?.status === 404 || error?.code === "http_404") return empty;
    throw error;
  }
}

export function featurePageWithTarget(page, targetFeature) {
  if (!targetFeature || page.features.some(({id}) => id === targetFeature.id)) return page;
  const features = [targetFeature, ...page.features.slice(0, 99)];
  return {...page, features, numberReturned: features.length};
}

async function openFieldCapture({state, dataset, details, capture}) {
  capture.disabled = true;
  details.hidden = false;
  details.dataset.mode = "field-capture";
  details.replaceChildren(text(
    "p",
    "Loading capture form and review queue…",
    "project-catalog-feedback"
  ));
  await loadFieldCapture(state, dataset, details);
  capture.disabled = false;
}

export async function loadFieldCapture(state, dataset, details, {notice = null} = {}) {
  destroyFeatureCanvases(details);
  try {
    const [forms, submissions, featurePage] = await Promise.all([
      state.adapter.listFieldForms(state.project.id, dataset.id),
      state.adapter.listFieldSubmissions(state.project.id, dataset.id, {limit: 100}),
      state.adapter.listFeatures(state.project.id, dataset.id, {limit: 100})
    ]);
    details.replaceChildren(fieldCapturePanel(
      state,
      dataset,
      details,
      forms,
      submissions,
      featurePage,
      notice
    ));
  } catch (error) {
    details.replaceChildren(text(
      "p",
      `Field capture is unavailable (${error?.code ?? "unexpected_error"}).`,
      "project-catalog-error"
    ));
  }
}

function fieldCapturePanel(state, dataset, details, forms, submissions, featurePage, notice) {
  const panel = document.createElement("div");
  panel.className = "project-field-capture";
  panel.append(
    text("h4", "Capture a field observation"),
    text(
      "p",
      "Set the location, fill in the survey fields, and submit for review. An authorized reviewer must accept the observation before it changes this layer.",
      "project-catalog-feedback"
    )
  );
  if (!forms.length) {
    panel.append(canEditDataset(state, dataset)
      ? fieldFormCreator(state, dataset, details)
      : text("p", "No survey form is available. Someone with layer edit access must create one."));
    return panel;
  }
  const form = forms[0];
  panel.append(fieldFormSummary(form));
  if (canEditDataset(state, dataset)) {
    panel.append(fieldObservationForm(
      state, dataset, details, form, submissions, featurePage, notice
    ));
  }
  panel.append(fieldSubmissionReview(state, dataset, details, submissions));
  return panel;
}

function fieldFormCreator(state, dataset, details) {
  const form = document.createElement("form");
  form.className = "project-field-form-creator";
  const title = input("text", "Field form title");
  title.value = `${dataset.name} field survey`;
  title.maxLength = 200;
  title.required = true;
  const instructions = textarea(
    "Field form instructions",
    "Set the location, describe what you observed, and submit it for review."
  );
  instructions.maxLength = 4000;
  const save = text("button", "Create survey form", "platform-button");
  save.type = "submit";
  const feedback = text(
    "p",
    "The survey uses this layer’s location type and fields. Changes to its structure require a new form version.",
    "project-catalog-feedback"
  );
  form.append(field("Title", title), field("Instructions", instructions), save, feedback);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    save.disabled = true;
    try {
      await state.adapter.createFieldForm(state.project.id, dataset.id, {
        title: title.value,
        instructions: instructions.value || null
      });
      await loadFieldCapture(state, dataset, details);
    } catch (error) {
      feedback.className = "project-catalog-error";
      feedback.textContent = `Field form was not created (${error?.code ?? "unexpected_error"}).`;
      save.disabled = false;
    }
  });
  return form;
}

function fieldFormSummary(form) {
  const summary = document.createElement("section");
  summary.className = "project-field-form-summary";
  const fieldCount = countFeatureFieldDefinitions(form.fields);
  const version = document.createElement("details");
  version.append(
    text("summary", "Form version details"),
    text("p", `Form v${form.version} · ${form.geometryType} · ${fieldCount} field${fieldCount === 1 ? "" : "s"} · collection generation ${form.collectionGeneration}`, "project-catalog-feedback")
  );
  summary.append(text("strong", form.title));
  if (form.instructions) summary.append(text("p", form.instructions));
  summary.append(version);
  return summary;
}

function countFeatureFieldDefinitions(fields) {
  return fields.reduce(
    (count, definition) => count + 1 + (
      definition.type === "group" ? countFeatureFieldDefinitions(definition.fields ?? []) : 0
    ),
    0
  );
}

function fieldObservationForm(
  state, dataset, details, formDefinition, submissions, featurePage, notice
) {
  const form = document.createElement("form");
  form.className = "project-field-observation-form";
  let canvas = null;
  const geometry = textarea(
    "Field observation GeoJSON geometry",
    JSON.stringify(defaultGeometry(formDefinition.geometryType), null, 2)
  );
  geometry.rows = 5;
  const setGeometry = (draft) => {
    geometry.value = JSON.stringify(draft, null, 2);
    canvas?.resetGeometry?.(draft);
  };
  const properties = featurePropertyFields(formDefinition.fields, {adapter: state.adapter, projectId: state.project.id, classification: dataset.classification, deviceScope: {organizationId: state.organization.id, userId: state.session.userId}, captureStorage: state.captureStorage});
  const target = select("Field capture target", [["", "New feature"]]);
  const availableFeatures = new Map(featurePage.features.map((feature) => [feature.id, feature]));
  for (const feature of featurePage.features) {
    const option = document.createElement("option");
    option.value = feature.id;
    option.textContent = `${feature.id.slice(0, 8)} · v${feature.version}`;
    target.append(option);
  }
  target.addEventListener("change", () => {
    const selected = availableFeatures.get(target.value);
    if (!selected) {
      setGeometry(defaultGeometry(formDefinition.geometryType));
      properties.write({});
      feedback.textContent = "The next observation will create a new feature after review.";
      return;
    }
    setGeometry(selected.geometry);
    properties.write(selected.properties);
    feedback.textContent = `Editing ${selected.id} from authoritative version ${selected.version}. Acceptance requires that exact base version.`;
  });
  const gps = text("button", "Use current GPS", "platform-button secondary");
  gps.type = "button";
  const queue = state.captureStorage?.queue ?? new OfflineCaptureQueue();
  const attachmentFiles = state.captureStorage?.files ?? new OfflineAttachmentFiles();
  const scope = {
    organizationId: state.organization.id,
    userId: state.session.userId
  };
  const offlineAllowed = offlineCaptureAllowed(dataset.classification);
  const saveOffline = text("button", "Save to device queue", "platform-button secondary");
  saveOffline.type = "button";
  saveOffline.disabled = !offlineAllowed;
  const submitNow = text("button", "Submit now", "platform-button");
  submitNow.type = "submit";
  const sync = text("button", "Sync device queue", "platform-button secondary");
  sync.type = "button";
  let supersedesSubmissionId = null;
  const feedback = text(
    "p",
    notice ?? (state.demoCapture ? "Temporary tab storage. Save keeps a draft in this tab; submit, sync and review are simulated. Reloading clears your work." : offlineAllowed
      ? "Save to device queue keeps a draft here for this account. Saved drafts sync automatically while this signed-in page is open and online. Sync device queue sends them now."
      : "Device saving is disabled for confidential/restricted layers. Submit through your signed-in connection."),
    "project-catalog-feedback"
  );
  const captureDraft = ({allowDeviceFiles = false} = {}) => {
    const submissionId = crypto.randomUUID();
    const targetFeature = availableFeatures.get(target.value) ?? null;
    const correction = submissions.find((item) => item.id === supersedesSubmissionId);
    if (correction && (
      correction.operation !== (targetFeature ? "update" : "create")
      || correction.targetFeatureId !== (targetFeature?.id ?? null)
    )) {
      throw codedError("field_correction_target_mismatch");
    }
    const geometryDraft = parseJsonObject(geometry.value, "field_geometry_invalid");
    if (geometryDraft.type !== formDefinition.geometryType) {
      throw codedError("field_geometry_type_mismatch");
    }
    const values = properties.read({allowDeviceFiles});
    return {
      deviceAttachments: pendingDeviceAttachments(formDefinition.fields, values),
      projectId: state.project.id,
      datasetId: dataset.id,
      formId: formDefinition.id,
      formVersion: formDefinition.version,
      submissionId,
      supersedesSubmissionId,
      operation: targetFeature ? "update" : "create",
      targetFeatureId: targetFeature?.id ?? null,
      targetFeatureVersion: targetFeature?.version ?? null,
      feature: {
        type: "Feature",
        id: targetFeature?.id ?? submissionId,
        geometry: geometryDraft,
        properties: values
      }
    };
  };
  const submitDraft = (draft) => state.adapter.createFieldSubmission(
    draft.projectId,
    draft.datasetId,
    draft.formId,
    draft.formVersion,
    {
      submissionId: draft.submissionId,
      supersedesSubmissionId: draft.supersedesSubmissionId,
      operation: draft.operation,
      targetFeatureId: draft.targetFeatureId,
      targetFeatureVersion: draft.targetFeatureVersion,
      feature: draft.feature
    }
  );
  let syncPromise = null;
  const replayDeviceQueue = ({interactive = false} = {}) => {
    if (syncPromise) return syncPromise;
    syncPromise = (async () => {
      const records = await queue.list(scope);
      if (!records.length) return null;
      sync.disabled = true;
      if (interactive) feedback.textContent = state.demoCapture ? "Sending tab drafts to the demo review queue…" : "Sending saved device drafts for review…";
      const result = await syncCaptureQueue(queue, scope, submitDraft, {resolveDeviceAttachment: async (localId, projectId) => {
        const file = (await attachmentFiles.list(scope, projectId)).find(item => item.id === localId);
        if (!file) throw codedError("offline_attachment_pending");
        if (!file.registeredVersionId && file.uploadId) {
          try {
            const completed = await state.adapter.completeUpload(projectId, file.uploadId);
            await attachmentFiles.register(scope, file.id, completed.datasetVersionId);
            file.registeredVersionId = completed.datasetVersionId;
          } catch (error) {
            if ([404, 409, 422].includes(error?.status)) throw codedError("offline_attachment_pending");
            throw error;
          }
        }
        if (!file.registeredVersionId) throw codedError("offline_attachment_pending");
        try {
          const ref = await state.adapter.resolveFeatureAttachment(file.registeredVersionId);
          if (ref.versionId !== file.registeredVersionId) throw codedError("offline_attachment_pending");
          return ref.versionId;
        } catch (error) {
          if (error?.status === 404) throw codedError("offline_attachment_pending");
          throw error;
        }
      }});
      feedback.className = "project-catalog-feedback";
      feedback.textContent = `${result.synced} sent for ${state.demoCapture ? "demo " : ""}review · ${result.pending} still on ${state.demoCapture ? "this tab" : "this device"} · ${result.conflicts.length} conflict${result.conflicts.length === 1 ? "" : "s"}.`;
      const stoppedMessage = {
        attachment_pending: " A device attachment is not registered and accessible yet. Register the retained file, wait for processing, then sync again. Your observation remains on this device.",
        authentication_required: " Sign in again to continue. Your drafts remain on this device.",
        access_denied: " Access to a submission or attached file was refused. Restore access or correct the draft before retrying; your drafts remain on this device.",
        validation_failed: " A draft no longer meets its form rules. Correct it before retrying; your drafts remain on this device."
      }[result.stoppedReason];
      if (stoppedMessage) feedback.textContent += stoppedMessage;
      if (result.synced) {
        await loadFieldCapture(state, dataset, details, {
          notice: feedback.textContent
        });
      }
      return result;
    })().catch((error) => {
      feedback.className = "project-catalog-error";
      feedback.textContent = `Device sync is unavailable (${error?.code ?? "unexpected_error"}).`;
      return null;
    }).finally(() => {
      sync.disabled = false;
      syncPromise = null;
    });
    return syncPromise;
  };
  const stopCaptureSync = subscribeCaptureSync(
    () => replayDeviceQueue(),
    {onError: () => {}}
  );
  queueMicrotask(() => {
    const CaptureObserver = globalThis.MutationObserver ?? document?.defaultView?.MutationObserver;
    if (typeof CaptureObserver !== "function" || !document?.documentElement) return;
    const observer = new CaptureObserver(() => {
      if (form.isConnected) return;
      stopCaptureSync();
      canvas?.__destroy?.();
      observer.disconnect();
    });
    observer.observe(document.documentElement, {childList: true, subtree: true});
  });
  gps.addEventListener("click", async () => {
    gps.disabled = true;
    feedback.textContent = "Finding your current location…";
    try {
      const point = await currentGpsPoint();
      setGeometry(point.geometry);
      feedback.textContent = `Current location set · reported accuracy ${point.accuracyMeters.toFixed(1)} m. Check the location before submitting.`;
    } catch (error) {
      feedback.className = "project-catalog-error";
      feedback.textContent = `GPS position was not captured (${error?.code ?? "gps_unavailable"}).`;
    } finally {
      gps.disabled = false;
    }
  });
  saveOffline.addEventListener("click", async () => {
    saveOffline.disabled = true;
    try {
      const record = await queue.enqueue(scope, captureDraft({allowDeviceFiles: true}));
      const pending = await queue.list(scope);
      const scheduled = state.demoCapture ? {mode: "tab"} : await scheduleCaptureSync();
      feedback.className = "project-catalog-feedback";
      feedback.textContent = state.demoCapture
        ? `Draft saved in this tab · ${pending.length} pending. Sync device queue sends drafts to the simulated review queue; reloading clears them.`
        : `Draft saved on this device · ${pending.length} pending. ${scheduled.mode === "background-sync" ? "Sync is scheduled for a signed-in client." : "Sync can run while this signed-in page is open."}`;
      supersedesSubmissionId = null;
    } catch (error) {
      feedback.className = "project-catalog-error";
      feedback.textContent = `Observation was not queued (${error?.code ?? "invalid_observation"}).`;
    } finally {
      saveOffline.disabled = !offlineAllowed;
    }
  });
  sync.addEventListener("click", async () => {
    await replayDeviceQueue({interactive: true});
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submitNow.disabled = true;
    try {
      const receipt = await submitDraft(captureDraft());
      feedback.textContent = state.demoCapture ? "Observation sent to the simulated review queue." : "Observation submitted for review. This layer changes only after acceptance.";
      await loadFieldCapture(state, dataset, details, {notice: feedback.textContent});
    } catch (error) {
      feedback.className = "project-catalog-error";
      feedback.textContent = `Observation was not submitted (${error?.code ?? "invalid_observation"}).`;
      submitNow.disabled = false;
    }
  });
  for (const submission of submissions.filter((item) => item.state === "changes_requested")) {
    const correct = text(
      "button",
      `Correct ${submission.id.slice(0, 8)}`,
      "platform-button secondary"
    );
    correct.type = "button";
    correct.addEventListener("click", () => {
      supersedesSubmissionId = submission.id;
      target.value = submission.operation === "update"
        && availableFeatures.has(submission.targetFeatureId)
        ? submission.targetFeatureId
        : "";
      setGeometry(submission.feature.geometry);
      properties.write(submission.feature.properties);
      const updateNote = submission.operation === "update"
        ? (target.value
          ? ` The target has been reloaded at authoritative version ${availableFeatures.get(target.value).version}.`
          : " The target is outside this bounded feature page; reload or edit it from the feature interface before correcting.")
        : "";
      feedback.textContent = `The next submission will supersede ${submission.id}; the reviewed payload remains immutable.${updateNote}`;
      geometry.focus();
    });
    form.append(correct);
  }
  const targetField = field("New observation or existing feature", target);
  targetField.append(text(
    "small",
    `Existing features available here: ${featurePage.features.length}. Updates are checked against the version you opened.`,
    "project-catalog-feedback"
  ));
  const location = document.createElement("section");
  location.className = "project-field-location";
  location.append(text("h5", "1. Set the location"));
  location.append(text("p", formDefinition.geometryType === "Point"
    ? "Use current GPS, place a point on the map, or enter coordinates. GPS access is requested only when you choose it."
    : `Draw the ${formDefinition.geometryType === "Polygon" || formDefinition.geometryType === "MultiPolygon" ? "area" : formDefinition.geometryType === "LineString" || formDefinition.geometryType === "MultiLineString" ? "line" : "points"} on the map, or enter its coordinates. This survey uses ${formDefinition.geometryType}; its location type is fixed.`, "project-catalog-feedback"));
  if (formDefinition.geometryType === "Point") location.append(gps);
  if (canvasEditingSupported(formDefinition.geometryType)) {
    const drawLabel = {Point: "Place point on map", MultiPoint: "Place points on map", LineString: "Draw line on map", MultiLineString: "Draw lines on map", Polygon: "Draw area on map", MultiPolygon: "Draw areas on map"}[formDefinition.geometryType];
    const draw = text("button", drawLabel, "platform-button secondary");
    draw.type = "button";
    draw.setAttribute("aria-expanded", "false");
    const drawing = document.createElement("div");
    drawing.hidden = true;
    draw.addEventListener("click", () => {
      if (!drawing.hidden) {
        drawing.hidden = true;
        draw.textContent = drawLabel;
        draw.setAttribute("aria-expanded", "false");
        return;
      }
      try {
        if (!canvas) {
          canvas = FeatureCanvas({
            collection: {...featurePage.collection, geometryType: formDefinition.geometryType},
            features: featurePage.features,
            initialGeometry: parseJsonObject(geometry.value, "field_geometry_invalid"),
            onGeometryChange: (draft) => { geometry.value = JSON.stringify(draft, null, 2); },
            onSelectFeature: (feature) => {
              target.value = feature.id;
              geometry.value = JSON.stringify(feature.geometry, null, 2);
              properties.write(feature.properties);
              feedback.textContent = `Editing ${feature.id} from authoritative version ${feature.version}. Acceptance requires that exact base version.`;
            }
          });
          canvas.querySelector("h5").textContent = "Draw the observation location";
          canvas.querySelector("p").textContent = "Choose Draw new, mark the location, then Finish geometry. Drawing updates this observation; submit it for review below.";
          drawing.append(canvas);
        }
        drawing.hidden = false;
        draw.textContent = "Hide drawing map";
        draw.setAttribute("aria-expanded", "true");
        queueMicrotask(() => canvas?.__resize?.());
      } catch (error) {
        feedback.className = "project-catalog-error";
        feedback.textContent = "The drawing map could not open. Enter coordinates below or try the map again.";
      }
    });
    location.append(draw, drawing);
  }
  geometry.addEventListener("change", () => {
    try {
      const draft = parseJsonObject(geometry.value, "field_geometry_invalid");
      if (draft.type !== formDefinition.geometryType) throw codedError("field_geometry_type_mismatch");
      canvas?.resetGeometry?.(draft);
    } catch (error) {
      feedback.className = "project-catalog-error";
      feedback.textContent = `Coordinates do not match this survey (${error?.code ?? "field_geometry_invalid"}). Correct them before saving.`;
    }
  });
  const coordinates = document.createElement("details");
  coordinates.append(text("summary", "Enter or inspect coordinates (GeoJSON)"), field("Geometry (longitude, latitude)", geometry));
  location.append(coordinates);
  const actions = document.createElement("div");
  actions.className = "project-dataset-actions";
  actions.append(submitNow, saveOffline, sync);
  const destination = text("p", state.demoCapture
    ? "Submit now sends this observation to demo review. Save keeps a draft in this tab; Sync sends saved drafts to demo review. Nothing reaches an account."
    : "Submit now sends this observation for review. Save keeps a device draft that syncs automatically while this signed-in page is open and online. Sync device queue sends saved drafts now. Acceptance makes the reviewed observation part of this layer.", "project-catalog-feedback");
  form.append(targetField, location, text("h5", "2. Describe the observation"), properties.element, text("h5", "3. Save or submit"), destination, actions, feedback);
  queue.list(scope).then((records) => {
    if (!notice && records.length) feedback.textContent = `${records.length} submission${records.length === 1 ? "" : "s"} pending on this device.`;
  }).catch(() => {});
  return form;
}

function fieldSubmissionReview(state, dataset, details, submissions) {
  const section = document.createElement("section");
  section.className = "project-field-review";
  section.append(text("h5", `Review queue · ${submissions.length} submission${submissions.length === 1 ? "" : "s"}`));
  if (!submissions.length) {
    section.append(text("p", "No field submissions have synced."));
    return section;
  }
  for (const submission of submissions) {
    const item = document.createElement("article");
    item.className = "project-feature-record project-field-submission";
    item.dataset.state = submission.state;
    const operation = submission.operation === "update"
      ? `update ${submission.targetFeatureId} from v${submission.targetFeatureVersion}`
      : "create new feature";
    item.append(
      text("strong", `${submission.id} · ${operation} · ${submission.state.replace("_", " ")} · rv${submission.reviewVersion}`),
      text("pre", JSON.stringify(submission.feature, null, 2))
    );
    if (submission.reviewMessage) item.append(text("p", submission.reviewMessage));
    if (canReviewCapture(state, dataset)
      && ["submitted", "in_review"].includes(submission.state)) {
      const message = input("text", `Review message for ${submission.id}`);
      message.maxLength = 2000;
      message.placeholder = "Required when requesting changes or rejecting";
      const actions = document.createElement("div");
      actions.className = "project-dataset-actions";
      const decisions = submission.state === "submitted"
        ? [["start_review", "Start review"]]
        : [["accept", "Accept and promote"], ["request_changes", "Request changes"], ["reject", "Reject"]];
      for (const [decision, label] of decisions) {
        const button = text("button", label, decision === "accept" ? "platform-button" : "platform-button secondary");
        button.type = "button";
        button.addEventListener("click", async () => {
          button.disabled = true;
          try {
            await state.adapter.reviewFieldSubmission(
              state.project.id,
              dataset.id,
              submission.id,
              {
                expectedVersion: submission.reviewVersion,
                decision,
                message: message.value.trim() || null
              }
            );
            await loadFieldCapture(state, dataset, details);
          } catch (error) {
            item.append(text(
              "p",
              `Review action failed (${error?.code ?? "unexpected_error"}).`,
              "project-catalog-error"
            ));
            button.disabled = false;
          }
        });
        actions.append(button);
      }
      item.append(message, actions);
    }
    section.append(item);
  }
  return section;
}

function featureFieldDraft(value = {}) {
  const type = FEATURE_FIELD_TYPES.includes(value.type) ? value.type : "string";
  return {
    name: typeof value.name === "string" ? value.name : "",
    type,
    required: value.required === true,
    label: typeof value.label === "string" ? value.label : "",
    description: typeof value.description === "string" ? value.description : "",
    choicesText: Array.isArray(value.choices) ? value.choices.join("\n") : "",
    minimum: value.minimum === null || value.minimum === undefined ? "" : String(value.minimum),
    maximum: value.maximum === null || value.maximum === undefined ? "" : String(value.maximum),
    minLength: value.minLength === null || value.minLength === undefined
      ? ""
      : String(value.minLength),
    maxLength: value.maxLength === null || value.maxLength === undefined
      ? ""
      : String(value.maxLength),
    visibleWhenField: typeof value.visibleWhen?.field === "string"
      ? value.visibleWhen.field
      : "",
    attachment: value.attachment === true,
    calculationText: value.calculation == null ? "" : JSON.stringify(value.calculation),
    visibleWhenOperator: value.visibleWhen?.operator ?? "eq",
    visibleWhenValueField: value.visibleWhen?.value_field ?? "",
    visibleWhenEquals: value.visibleWhen?.equals === null
      || value.visibleWhen?.equals === undefined
      ? ""
      : String(value.visibleWhen.equals),
    fields: Array.isArray(value.fields) ? value.fields.map(featureFieldDraft) : [],
    repeat: value.repeat === true,
    minItems: value.minItems === null || value.minItems === undefined
      ? ""
      : String(value.minItems),
    maxItems: value.maxItems === null || value.maxItems === undefined
      ? ""
      : String(value.maxItems)
  };
}

function featureConditionDefault(draft) {
  if (draft.type === "group") return "";
  if (draft.type === "boolean") return "false";
  if (["integer", "number"].includes(draft.type)) return draft.minimum || "0";
  return draft.choicesText.split(/\r?\n/u).map((value) => value.trim()).find(Boolean) ?? "value";
}

function featureConditionValue(value, controller, position) {
  if (controller.type === "boolean") {
    if (!["true", "false"].includes(value)) {
      throw featureSchemaError(`${position} needs a true or false visibility value.`);
    }
    return value === "true";
  }
  if (["integer", "number"].includes(controller.type)) {
    if (value === "") {
      throw featureSchemaError(`${position} needs a visibility value.`);
    }
    const parsed = optionalNumericBound(value, controller.type, `${position} visibility value`);
    if (
      (controller.minimum !== undefined && parsed < controller.minimum)
      || (controller.maximum !== undefined && parsed > controller.maximum)
    ) throw featureSchemaError(`${position} visibility value is outside its controller's range.`);
    return parsed;
  }
  if (!value) throw featureSchemaError(`${position} needs a visibility value.`);
  if (
    value.length < (controller.minLength ?? 1)
    || value.length > (controller.maxLength ?? 2_000)
    || (controller.choices?.length && !controller.choices.includes(value))
  ) throw featureSchemaError(`${position} visibility value violates its controller's rules.`);
  return value;
}

function featureSchemaError(message) {
  const error = codedError("feature_schema_invalid");
  error.userMessage = message;
  return error;
}

function optionalPositiveInteger(value, label) {
  if (value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 2_000) {
    throw featureSchemaError(`${label} must be a whole number from 1 through 2,000.`);
  }
  return parsed;
}

function optionalNumericBound(value, type, label) {
  if (value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (type === "integer" && !Number.isSafeInteger(parsed))) {
    throw featureSchemaError(
      `${label} must be ${type === "integer" ? "a safe whole number" : "a finite number"}.`
    );
  }
  return parsed;
}

function nextFeatureFieldName(drafts) {
  const names = new Set(drafts.map(({name}) => name.trim().toLocaleLowerCase()));
  for (let index = 1; index <= MAX_FEATURE_FIELDS; index += 1) {
    const candidate = `field_${index}`;
    if (!names.has(candidate)) return candidate;
  }
  return "field";
}

function optionalRepeatBound(value, label, minimum) {
  if (value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > 20) {
    throw featureSchemaError(`${label} must be a whole number from ${minimum} through 20.`);
  }
  return parsed;
}

function featureFieldDraftSnapshot(draft) {
  const {_childDesigner, ...plain} = draft;
  const fields = draft._childDesigner
    ? draft._childDesigner.snapshot()
    : draft.fields.map(featureFieldDraftSnapshot);
  return {
    ...plain,
    fields
  };
}

function featureFieldDraftsRead(drafts, {depth = 0, counter = {value: 0}} = {}) {
  const seen = new Set();
  const parsedByName = new Map();
  return drafts.map((draft, index) => {
    counter.value += 1;
    if (counter.value > MAX_FEATURE_FIELDS) {
      throw featureSchemaError(
        `A schema may contain at most ${MAX_FEATURE_FIELDS} fields across all groups.`
      );
    }
    const position = `${depth ? "Nested " : ""}field ${index + 1}`;
    const name = draft.name.trim();
    if (!FEATURE_FIELD_NAME.test(name)) {
      throw featureSchemaError(
        `${position} needs a stable name beginning with a letter or underscore.`
      );
    }
    const folded = name.toLocaleLowerCase();
    if (FEATURE_FIELD_RESERVED_NAMES.has(folded)) {
      throw featureSchemaError(`${position} uses a reserved OpenGeo Studio field name.`);
    }
    if (seen.has(folded)) {
      throw featureSchemaError(`${position} duplicates another stable field name in its group.`);
    }
    seen.add(folded);
    const label = draft.label.trim();
    const description = draft.description.trim();
    if (label.length > 100 || description.length > 500) {
      throw featureSchemaError(`${position} has label or help text beyond its limit.`);
    }
    const result = {name, type: draft.type, required: draft.required};
    if (draft.attachment) {
      if (draft.type !== "string") throw featureSchemaError(`${position} attachment must be a string field.`);
      result.attachment = true;
    }
    if (label) result.label = label;
    if (description) result.description = description;
    if (draft.type === "group") {
      if (depth >= 3) throw featureSchemaError("Groups may be nested at most three levels.");
      result.fields = featureFieldDraftsRead(draft.fields, {
        depth: depth + 1,
        counter
      });
      if (!result.fields.length) throw featureSchemaError(`${position} needs at least one field.`);
      if (draft.repeat) {
        const minItems = optionalRepeatBound(
          draft.minItems,
          `${position} minimum repetitions`,
          0
        ) ?? 0;
        const maxItems = optionalRepeatBound(
          draft.maxItems,
          `${position} maximum repetitions`,
          1
        ) ?? 20;
        if (minItems > maxItems) {
          throw featureSchemaError(`${position} minimum repetitions exceeds its maximum.`);
        }
        result.repeat = true;
        result.minItems = minItems;
        result.maxItems = maxItems;
      }
    } else if (draft.type === "string" && !draft.attachment) {
      const choices = draft.choicesText
        .split(/\r?\n/u)
        .map((value) => value.trim())
        .filter(Boolean);
      if (
        choices.length > 32
        || choices.some((value) => value.length > 200)
        || new Set(choices).size !== choices.length
      ) {
        throw featureSchemaError(
          `${position} choices must contain at most 32 unique lines of 200 characters.`
        );
      }
      const minLength = optionalPositiveInteger(draft.minLength, `${position} minimum length`);
      const maxLength = optionalPositiveInteger(draft.maxLength, `${position} maximum length`);
      const effectiveMinimum = minLength ?? 1;
      const effectiveMaximum = maxLength ?? 2_000;
      if (effectiveMinimum > effectiveMaximum) {
        throw featureSchemaError(`${position} minimum length exceeds its maximum length.`);
      }
      if (choices.some((value) => (
        value.length < effectiveMinimum || value.length > effectiveMaximum
      ))) {
        throw featureSchemaError(`${position} has a choice outside its length limits.`);
      }
      if (choices.length) result.choices = choices;
      if (minLength !== null) result.minLength = minLength;
      if (maxLength !== null) result.maxLength = maxLength;
    } else if (["integer", "number"].includes(draft.type)) {
      const minimum = optionalNumericBound(
        draft.minimum,
        draft.type,
        `${position} minimum value`
      );
      const maximum = optionalNumericBound(
        draft.maximum,
        draft.type,
        `${position} maximum value`
      );
      if (minimum !== null && maximum !== null && minimum > maximum) {
        throw featureSchemaError(`${position} minimum value exceeds its maximum value.`);
      }
      if (minimum !== null) result.minimum = minimum;
      if (maximum !== null) result.maximum = maximum;
    }
    if (draft.calculationText.trim()) {
      if (!["integer", "number"].includes(draft.type)) throw featureSchemaError(`${position} calculated field must be numeric.`);
      try {
        result.calculation = validateCalculation(JSON.parse(draft.calculationText),
          new Set([...parsedByName.values()].filter(item => ["integer", "number"].includes(item.type)).map(item => item.name)));
      } catch (error) { throw featureSchemaError(`${position}: ${error.message}`); }
    }
    if (draft.visibleWhenField) {
      const controller = parsedByName.get(draft.visibleWhenField);
      if (!controller || controller.type === "group") {
        throw featureSchemaError(
          `${position} visibility rule must reference a field above it, and that field must be scalar.`
        );
      }
      const operator = draft.visibleWhenOperator ?? "eq";
      if (!["eq", "ne", "gt", "gte", "lt", "lte"].includes(operator)
          || (!["eq", "ne"].includes(operator)
            && !["integer", "number"].includes(controller.type))) {
        throw featureSchemaError(`${position} visibility comparison is invalid for this field.`);
      }
      const other = draft.visibleWhenValueField
        ? parsedByName.get(draft.visibleWhenValueField) : null;
      if (draft.visibleWhenValueField && (!other || other.type === "group"
          || (other.type !== controller.type
            && ![other.type, controller.type].every((type) => ["integer", "number"].includes(type))))) {
        throw featureSchemaError(`${position} comparison requires a compatible earlier field.`);
      }
      result.visibleWhen = {
        ...(operator === "eq" ? {} : {operator}),
        field: controller.name,
        ...(other ? {value_field: other.name}
          : {equals: featureConditionValue(draft.visibleWhenEquals, controller, position)})
      };
    }
    parsedByName.set(name, result);
    return result;
  });
}

export function featureFieldDesigner(initialFields = [], {depth = 0} = {}) {
  if (!Array.isArray(initialFields) || initialFields.length > MAX_FEATURE_FIELDS) {
    throw featureSchemaError(`A schema may contain at most ${MAX_FEATURE_FIELDS} fields.`);
  }
  let drafts = initialFields.map(featureFieldDraft);
  const element = document.createElement("fieldset");
  element.className = "project-feature-schema-designer";
  const legend = text("legend", "Property fields");
  const guidance = text(
    "p",
    "Define stable field names and optional capture guidance. Rules become immutable when the collection is created.",
    "project-catalog-feedback"
  );
  const list = document.createElement("div");
  list.className = "project-feature-schema-list";
  const toolbar = document.createElement("div");
  toolbar.className = "project-feature-schema-toolbar";
  const count = document.createElement("output");
  count.className = "project-catalog-feedback";
  count.setAttribute("aria-live", "polite");
  const add = text("button", "Add field", "platform-button secondary");
  add.type = "button";
  toolbar.append(count, add);
  element.append(legend, guidance, list, toolbar);

  const render = (focusIndex = null, focusSelector = "input") => {
    drafts = drafts.map(featureFieldDraftSnapshot);
    list.replaceChildren();
    drafts.forEach((draft, index) => {
      const row = document.createElement("fieldset");
      row.className = "project-feature-schema-row";
      row.dataset.fieldIndex = String(index);
      row.append(text("legend", `Field ${index + 1}`));
      const identity = document.createElement("div");
      identity.className = "project-feature-schema-grid";
      const name = input("text", `Field ${index + 1} stable name`);
      name.value = draft.name;
      name.required = true;
      name.maxLength = 100;
      name.pattern = FEATURE_FIELD_NAME.source.slice(1, -1);
      name.autocomplete = "off";
      name.placeholder = "e.g. inspection_status";
      name.addEventListener("input", () => {
        const previousName = draft.name.trim();
        draft.name = name.value;
        for (const dependent of drafts) {
          if (dependent.visibleWhenValueField === previousName) {
            dependent.visibleWhenValueField = name.value.trim();
          }
          if (dependent.visibleWhenField === previousName) {
            dependent.visibleWhenField = name.value.trim();
          }
        }
      });
      const type = select(
        `Field ${index + 1} type`,
        depth >= 3 ? FEATURE_FIELD_TYPES.filter((candidate) => candidate !== "group") : FEATURE_FIELD_TYPES
      );
      type.value = draft.type;
      type.addEventListener("change", () => {
        draft.type = type.value;
        if (draft.type === "group" && !draft.fields.length) {
          draft.fields = [featureFieldDraft({name: "value", type: "string"})];
        }
        render(index, "select");
      });
      const label = input("text", `Field ${index + 1} display label`);
      label.value = draft.label;
      label.maxLength = 100;
      label.placeholder = "Optional display label";
      label.addEventListener("input", () => {
        draft.label = label.value;
      });
      const description = input("text", `Field ${index + 1} help text`);
      description.value = draft.description;
      description.maxLength = 500;
      description.placeholder = "Optional instructions for editors";
      description.addEventListener("input", () => {
        draft.description = description.value;
      });
      const required = input("checkbox", `Field ${index + 1} is required`);
      required.checked = draft.required;
      required.addEventListener("change", () => {
        draft.required = required.checked;
      });
      const requiredField = field("Required", required);
      requiredField.className = "project-feature-schema-required";
      identity.append(
        field("Stable name", name),
        field("Type", type),
        field("Display label", label),
        field("Help text", description),
        requiredField
      );
      row.append(identity);
      if (draft.type === "string") {
        const attachment = input("checkbox", `Field ${index + 1} is an attachment`);
        attachment.checked = draft.attachment;
        attachment.addEventListener("change", () => {
          draft.attachment = attachment.checked;
          render(index);
        });
        row.append(field("Attach a catalog file version", attachment));
      }
      if (["integer", "number"].includes(draft.type)) {
        const calculation = textarea(`Field ${index + 1} calculation`, draft.calculationText);
        calculation.maxLength = 8192;
        calculation.placeholder = '{"*": [{"var": "quantity"}, {"var": "unit_cost"}]}';
        calculation.addEventListener("input", () => { draft.calculationText = calculation.value; });
        row.append(field("Calculation (optional numeric JsonLogic)", calculation), text("small",
          "Use earlier numeric fields with var and +, -, *, /, min or max. Calculated values are read-only; leave blank for manual entry."));
      }

      if (index > 0) {
        const condition = document.createElement("div");
        condition.className = "project-feature-schema-condition";
        const priorDrafts = drafts.slice(0, index).filter((candidate) => candidate.type !== "group");
        const options = [
          ["", "Always visible"],
          ...priorDrafts
            .map((candidate) => candidate.name.trim())
            .filter(Boolean)
            .map((candidate) => [candidate, `When ${candidate} equals…`])
        ];
        if (
          draft.visibleWhenField
          && !options.some(([value]) => value === draft.visibleWhenField)
        ) {
          options.push([
            draft.visibleWhenField,
            `${draft.visibleWhenField} (move its controller above this field)`
          ]);
        }
        const controllerSelect = select(`Field ${index + 1} visibility`, options);
        controllerSelect.className = "project-feature-condition-field";
        controllerSelect.value = draft.visibleWhenField;
        controllerSelect.addEventListener("change", () => {
          draft.visibleWhenField = controllerSelect.value;
          draft.visibleWhenOperator = "eq";
          draft.visibleWhenValueField = "";
          const controller = priorDrafts.find(
            (candidate) => candidate.name.trim() === controllerSelect.value
          );
          draft.visibleWhenEquals = controller ? featureConditionDefault(controller) : "";
          render(index, ".project-feature-condition-field");
        });
        condition.append(field("Display rule", controllerSelect));
        if (draft.visibleWhenField) {
          const controller = priorDrafts.find(
            (candidate) => candidate.name.trim() === draft.visibleWhenField
          );
          const operators = [["eq", "Equals"], ["ne", "Does not equal"]];
          if (["integer", "number"].includes(controller?.type)) {
            operators.push(["gt", "Greater than"], ["gte", "At least"],
              ["lt", "Less than"], ["lte", "At most"]);
          }
          const comparison = select(`Field ${index + 1} visibility comparison`, operators);
          comparison.value = draft.visibleWhenOperator ?? "eq";
          comparison.addEventListener("change", () => {
            draft.visibleWhenOperator = comparison.value;
          });
          condition.append(field("Comparison", comparison));
          const operandOptions = [["", "Fixed value"], ...priorDrafts
            .filter((candidate) => candidate.type !== "group"
              && (candidate.type === controller?.type
                || [candidate.type, controller?.type].every((type) => ["integer", "number"].includes(type))))
            .map((candidate) => [candidate.name.trim(), candidate.label || candidate.name.trim()])];
          if (draft.visibleWhenValueField
              && !operandOptions.some(([value]) => value === draft.visibleWhenValueField)) {
            operandOptions.push([draft.visibleWhenValueField, `${draft.visibleWhenValueField} (invalid)`]);
          }
          const operand = select(`Field ${index + 1} comparison source`, operandOptions);
          operand.value = draft.visibleWhenValueField;
          operand.addEventListener("change", () => {
            draft.visibleWhenValueField = operand.value;
            render(index);
          });
          condition.append(field("Compare with", operand));
          if (!draft.visibleWhenValueField) {
            let equals;
            if (controller?.type === "boolean") {
              equals = select(`Field ${index + 1} visibility value`, [
                ["false", "false"],
                ["true", "true"]
              ]);
            } else {
              const choices = controller?.type === "string"
                ? controller.choicesText.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean)
                : [];
              if (choices.length) {
                const values = choices.map((value) => [value, value]);
                if (draft.visibleWhenEquals && !choices.includes(draft.visibleWhenEquals)) {
                  values.push([draft.visibleWhenEquals, `${draft.visibleWhenEquals} (invalid)`]);
                }
                equals = select(`Field ${index + 1} visibility value`, values);
              } else {
                equals = input(
                  ["integer", "number"].includes(controller?.type) ? "number" : "text",
                  `Field ${index + 1} visibility value`
                );
                if (controller?.type === "integer") equals.step = "1";
                if (controller?.type === "number") equals.step = "any";
              }
            }
            equals.value = draft.visibleWhenEquals;
            equals.addEventListener("input", () => {
              draft.visibleWhenEquals = equals.value;
            });
            equals.addEventListener("change", () => {
              draft.visibleWhenEquals = equals.value;
            });
            condition.append(field("Value", equals));
          }
        }
        row.append(condition);
      }

      if (draft.type === "group") {
        const rules = document.createElement("div");
        rules.className = "project-feature-schema-rules project-feature-group-rules";
        const repeat = input("checkbox", `Field ${index + 1} repeats`);
        repeat.checked = draft.repeat;
        repeat.addEventListener("change", () => {
          draft.repeat = repeat.checked;
          render(index, ".project-feature-group-repeat");
        });
        repeat.className = "project-feature-group-repeat";
        rules.append(field("Allow repeated records", repeat));
        if (draft.repeat) {
          const minimum = input("number", `Field ${index + 1} minimum repetitions`);
          minimum.min = "0";
          minimum.max = "20";
          minimum.step = "1";
          minimum.value = draft.minItems;
          minimum.placeholder = draft.required ? "1" : "0";
          minimum.addEventListener("input", () => {
            draft.minItems = minimum.value;
          });
          const maximum = input("number", `Field ${index + 1} maximum repetitions`);
          maximum.min = "1";
          maximum.max = "20";
          maximum.step = "1";
          maximum.value = draft.maxItems;
          maximum.placeholder = "20";
          maximum.addEventListener("input", () => {
            draft.maxItems = maximum.value;
          });
          rules.append(field("Minimum records", minimum), field("Maximum records", maximum));
        }
        const nested = featureFieldDesigner(draft.fields, {depth: depth + 1});
        draft._childDesigner = nested;
        rules.append(nested.element);
        row.append(rules);
      } else if (draft.type === "string" && !draft.attachment) {
        const rules = document.createElement("div");
        rules.className = "project-feature-schema-rules";
        const choices = textarea(`Field ${index + 1} choices`, draft.choicesText);
        choices.rows = 2;
        choices.maxLength = 6_432;
        choices.placeholder = "Optional choices, one per line";
        choices.addEventListener("input", () => {
          draft.choicesText = choices.value;
        });
        const minLength = input("number", `Field ${index + 1} minimum length`);
        minLength.min = "1";
        minLength.max = "2000";
        minLength.step = "1";
        minLength.value = draft.minLength;
        minLength.placeholder = "1";
        minLength.addEventListener("input", () => {
          draft.minLength = minLength.value;
        });
        const maxLength = input("number", `Field ${index + 1} maximum length`);
        maxLength.min = "1";
        maxLength.max = "2000";
        maxLength.step = "1";
        maxLength.value = draft.maxLength;
        maxLength.placeholder = "2000";
        maxLength.addEventListener("input", () => {
          draft.maxLength = maxLength.value;
        });
        const choicesField = field("Choices", choices);
        choicesField.className = "project-feature-schema-choices";
        rules.append(
          choicesField,
          field("Minimum length", minLength),
          field("Maximum length", maxLength)
        );
        row.append(rules);
      } else if (["integer", "number"].includes(draft.type)) {
        const rules = document.createElement("div");
        rules.className = "project-feature-schema-rules";
        const minimum = input("number", `Field ${index + 1} minimum value`);
        minimum.step = draft.type === "integer" ? "1" : "any";
        minimum.value = draft.minimum;
        minimum.placeholder = "Optional";
        minimum.addEventListener("input", () => {
          draft.minimum = minimum.value;
        });
        const maximum = input("number", `Field ${index + 1} maximum value`);
        maximum.step = draft.type === "integer" ? "1" : "any";
        maximum.value = draft.maximum;
        maximum.placeholder = "Optional";
        maximum.addEventListener("input", () => {
          draft.maximum = maximum.value;
        });
        rules.append(field("Minimum value", minimum), field("Maximum value", maximum));
        row.append(rules);
      }

      const actions = document.createElement("div");
      actions.className = "project-feature-schema-actions";
      const up = text("button", "Move up", "platform-button secondary");
      up.type = "button";
      up.disabled = index === 0;
      up.ariaLabel = `Move field ${index + 1} up`;
      up.addEventListener("click", () => {
        [drafts[index - 1], drafts[index]] = [drafts[index], drafts[index - 1]];
        render(index - 1);
      });
      const down = text("button", "Move down", "platform-button secondary");
      down.type = "button";
      down.disabled = index === drafts.length - 1;
      down.ariaLabel = `Move field ${index + 1} down`;
      down.addEventListener("click", () => {
        [drafts[index], drafts[index + 1]] = [drafts[index + 1], drafts[index]];
        render(index + 1);
      });
      const remove = text("button", "Remove", "platform-button secondary");
      remove.type = "button";
      remove.ariaLabel = `Remove field ${index + 1}`;
      remove.addEventListener("click", () => {
        drafts.splice(index, 1);
        render(Math.min(index, drafts.length - 1));
      });
      actions.append(up, down, remove);
      row.append(actions);
      list.append(row);
    });
    const total = countFeatureFieldDrafts(drafts);
    count.value = `${total} of ${MAX_FEATURE_FIELDS} fields${total === drafts.length
      ? ""
      : " across this level and its groups"}`;
    count.textContent = count.value;
    add.disabled = drafts.length >= MAX_FEATURE_FIELDS;
    if (focusIndex !== null && focusIndex >= 0) {
      list.querySelector(`[data-field-index="${focusIndex}"] ${focusSelector}`)?.focus();
    }
  };

  add.addEventListener("click", () => {
    if (drafts.length >= MAX_FEATURE_FIELDS) return;
    drafts.push(featureFieldDraft({name: nextFeatureFieldName(drafts), type: "string"}));
    render(drafts.length - 1);
  });

  const snapshot = () => drafts.map(featureFieldDraftSnapshot);
  const read = () => featureFieldDraftsRead(snapshot());

  render();
  return {element, read, snapshot};
}

function countFeatureFieldDrafts(drafts) {
  return drafts.reduce((sum, draft) => (
    sum + 1 + (draft.type === "group" ? countFeatureFieldDrafts(draft.fields) : 0)
  ), 0);
}

export function featureCollectionInitializer(state, dataset, details) {
  const content = document.createElement("div");
  content.className = "project-feature-editor";
  content.append(
    text("h4", "Initialize authoritative feature storage"),
    text(
      "p",
      "Choose one immutable geometry type and define its fields. This schema becomes fixed when the collection is created; features retain stable IDs and append-only history.",
      "project-catalog-feedback"
    )
  );
  const form = document.createElement("form");
  const geometryType = select("Collection geometry type", FEATURE_GEOMETRY_TYPES);
  if (FEATURE_GEOMETRY_TYPES.includes(dataset.geometryType)) geometryType.value = dataset.geometryType;
  const fields = featureFieldDesigner([{
    name: "status",
    type: "string",
    required: true,
    label: "Status",
    description: "Current review status",
    choices: ["Open", "Closed"]
  }]);
  const submit = text("button", "Create empty feature collection", "platform-button");
  submit.type = "submit";
  const feedback = text(
    "p",
    "This adds database rows only; it does not add an always-on service or fixed idle cost.",
    "project-catalog-feedback"
  );
  form.append(
    field("Geometry type", geometryType),
    fields.element,
    submit,
    feedback
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    feedback.textContent = "Creating governed collection…";
    try {
      const schema = fields.read();
      await state.adapter.createFeatureCollection(state.project.id, dataset.id, {
        geometryType: geometryType.value,
        fields: schema,
        features: []
      });
      await loadFeatureEditing(state, dataset, details);
    } catch (error) {
      feedback.className = "project-catalog-error";
      feedback.textContent = error?.userMessage
        ? `Collection was not created. ${error.userMessage}`
        : `Collection was not created (${error?.code ?? "invalid_schema"}).`;
      submit.disabled = false;
    }
  });
  content.append(form);
  return content;
}

export function featureEditor(
  state,
  dataset,
  details,
  page,
  featureLocks,
  tombstones,
  initialFeatureId = null,
  createCanvas = FeatureCanvas
) {
  const content = document.createElement("div");
  content.className = "project-feature-editor";
  const locksByFeature = new Map(
    featureLocks.map((featureLock) => [featureLock.featureId, featureLock])
  );
  const title = text(
    "h4",
    `${page.collection.geometryType} features · generation ${page.collection.generation}`
  );
  const summary = text(
    "p",
    `${page.numberMatched} live feature${page.numberMatched === 1 ? "" : "s"} · ${featureLocks.length} active edit reservation${featureLocks.length === 1 ? "" : "s"} · EPSG:4326 GeoJSON · each save requires the version currently shown`,
    "project-catalog-feedback"
  );
  const form = document.createElement("form");
  form.className = "project-feature-form";
  const initialGeometry = defaultGeometry(page.collection.geometryType);
  const geometry = textarea(
    "GeoJSON geometry",
    JSON.stringify(initialGeometry, null, 2)
  );
  geometry.rows = 5;
  const properties = featurePropertyFields(page.collection.fields, {adapter: state.adapter, projectId: state.project.id, classification: dataset.classification});
  const message = input("text", "Feature change message");
  message.maxLength = 500;
  message.placeholder = "Why this feature changed (recommended)";
  const save = text("button", "Create feature", "platform-button");
  save.type = "submit";
  const cancel = text("button", "Cancel edit", "platform-button secondary");
  cancel.type = "button";
  cancel.hidden = true;
  const feedback = text(
    "p",
    "New features receive a stable UUID. Existing features use conflict-safe full replacement.",
    "project-catalog-feedback"
  );
  let selected = null;
  let canvas = null;
  let formDirty = false;
  let selectedPropertySnapshot = null;
  let cutPending = false;
  const propertySnapshot = () => {
    try {return JSON.stringify(properties.read());} catch {return null;}
  };
  let initialPropertySnapshot = propertySnapshot();
  const markDirty = event => {if (event.target !== message) formDirty = true;};
  form.addEventListener("input", markDirty);
  form.addEventListener("change", markDirty);
  const reset = () => {
    if (cutPending) return;
    selected = null;
    formDirty = false;
    selectedPropertySnapshot = null;
    save.textContent = "Create feature";
    cancel.hidden = true;
    geometry.value = JSON.stringify(initialGeometry, null, 2);
    properties.write(defaultPropertyValues(page.collection.fields));
    initialPropertySnapshot = propertySnapshot();
    message.value = "";
    canvas?.resetGeometry?.(initialGeometry);
  };
  const selectForEdit = (feature, syncCanvas = true, focusEditor = true) => {
    if (cutPending) return;
    const featureLock = locksByFeature.get(feature.id);
    if (featureLock && !featureLock.heldByCurrentUser) {
      feedback.className = "project-catalog-error";
      feedback.textContent = "Another editor has a short reservation on this feature. Inspect and history remain available; editing resumes automatically after release or expiry.";
      return;
    }
    selected = feature;
    formDirty = false;
    geometry.value = JSON.stringify(feature.geometry, null, 2);
    properties.write(feature.properties);
    selectedPropertySnapshot = propertySnapshot();
    save.textContent = `Save v${feature.version + 1}`;
    cancel.hidden = false;
    if (syncCanvas) canvas?.selectFeature?.(feature);
    if (focusEditor) geometry.focus();
  };
  const selectRevisionForRestore = (feature, revision) => {
    if (cutPending) return;
    const featureLock = locksByFeature.get(feature.id);
    if (featureLock && !featureLock.heldByCurrentUser) {
      feedback.className = "project-catalog-error";
      feedback.textContent = "Another editor has a short reservation on this feature. Its immutable history can be inspected now, but restoring it waits for release or expiry.";
      return;
    }
    const draft = featureRevisionRestoreDraft(feature, revision);
    selected = feature;
    formDirty = true;
    geometry.value = JSON.stringify(draft.geometry, null, 2);
    properties.write(draft.properties);
    message.value = draft.changeMessage;
    save.textContent = `Restore v${revision.version} as v${feature.version + 1}`;
    cancel.hidden = false;
    canvas?.selectFeature?.({
      ...feature,
      geometry: draft.geometry,
      properties: draft.properties
    });
    // Canvas selection reports its input back to the form; the historical
    // snapshot still needs Save before any operation on the persisted head.
    formDirty = true;
    feedback.className = "project-catalog-feedback";
    feedback.textContent = `Reviewing the immutable v${revision.version} snapshot. Saving will append v${feature.version + 1}; it will not erase newer history.`;
    geometry.focus();
  };
  cancel.addEventListener("click", reset);
  form.append(
    field("Geometry (GeoJSON)", geometry),
    properties.element,
    field("Change message", message),
    save,
    cancel,
    feedback
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (cutPending) return;
    save.disabled = true;
    feedback.className = "project-catalog-feedback";
    feedback.textContent = selected ? "Saving version-checked replacement…" : "Saving feature…";
    try {
      const geometryDraft = parseJsonObject(geometry.value, "feature_geometry_invalid");
      const propertyDraft = properties.read();
      if (geometryDraft.type !== page.collection.geometryType) {
        throw codedError("feature_geometry_type_mismatch");
      }
      if (selected) {
        await state.adapter.updateFeature(state.project.id, dataset.id, selected.id, {
          expectedVersion: selected.version,
          geometry: geometryDraft,
          properties: propertyDraft,
          changeMessage: message.value.trim() || null,
          lockToken: locksByFeature.get(selected.id)?.heldByCurrentUser
            ? locksByFeature.get(selected.id).lockToken
            : null
        });
      } else {
        await state.adapter.createFeature(
          state.project.id,
          dataset.id,
          {geometry: geometryDraft, properties: propertyDraft},
          message.value.trim() || null
        );
      }
      await loadFeatureEditing(state, dataset, details);
    } catch (error) {
      feedback.className = "project-catalog-error";
      feedback.textContent = featureMutationError(
        error,
        "Feature was not saved"
      );
      save.disabled = false;
    }
  });

  canvas = createCanvas({
    collection: page.collection,
    features: page.features,
    initialGeometry,
    onGeometryChange: (draft) => {
      geometry.value = JSON.stringify(draft, null, 2);
      formDirty = true;
    },
    onSelectFeature: (feature) => selectForEdit(feature, false),
    ...(typeof state.adapter.cutMultipolygonFeature === "function" ? {
      onCutLine: async ({feature, partIndex, cutLine}) => {
        if (cutPending || !details.isConnected || !details.contains(content) || selected?.id !== feature.id
          || selected.version !== feature.version) {
          throw new Error("The selected feature changed. Reload it before cutting.");
        }
        if (formDirty || selectedPropertySnapshot === null
          || propertySnapshot() !== selectedPropertySnapshot) {
          throw new Error("Save or cancel the feature changes before cutting.");
        }
        const featureLock = locksByFeature.get(feature.id);
        if (featureLock && !featureLock.heldByCurrentUser) {
          throw new Error("Another editor holds this feature’s reservation.");
        }
        cutPending = true;
        const controls = [...form.querySelectorAll("input, textarea, select, button")]
          .map(control => [control, control.disabled]);
        for (const [control] of controls) control.disabled = true;
        feedback.className = "project-catalog-feedback";
        feedback.textContent = "Cutting the selected polygon in one version-checked transaction…";
        try {
          await state.adapter.cutMultipolygonFeature(state.project.id, dataset.id, {
            featureId: feature.id, expectedVersion: feature.version, partIndex, cutLine,
            changeMessage: message.value.trim() || "Cut polygon along a drawn line in Studio",
            ...(featureLock?.heldByCurrentUser ? {lockToken: featureLock.lockToken} : {})
          });
          if (details.isConnected && details.contains(content)) await loadFeatureEditing(state, dataset, details);
        } catch (error) {
          feedback.className = "project-catalog-error";
          feedback.textContent = featureMutationError(error, "Polygon was not cut");
          throw new Error(feedback.textContent);
        } finally {
          cutPending = false;
          if (details.isConnected && details.contains(content)) {
            for (const [control, disabled] of controls) control.disabled = disabled;
          }
        }
      }
    } : {}),
    ...(typeof state.adapter.moveSharedPolygonVertex === "function" ? {
      onSharedVertexMove: async ({feature, features, fromPosition, toPosition, isCurrent = () => true}) => {
        const current = () => isCurrent() && details.isConnected && details.contains(content)
          && selected?.id === feature.id && selected?.version === feature.version;
        if (cutPending || !current()) throw new Error("The selected feature changed. Reload before moving a shared vertex.");
        if (formDirty || selectedPropertySnapshot === null || propertySnapshot() !== selectedPropertySnapshot
          || JSON.stringify(parseJsonObject(geometry.value, "feature_geometry_invalid")) !== JSON.stringify(feature.geometry)) {
          throw new Error("Save or cancel the feature changes before moving a shared vertex.");
        }
        const saved = new Map(page.features.map(item => [item.id, item]));
        if (!Array.isArray(features) || !features.some(item => item.id === feature.id)
          || features.some(item => {
            const original = saved.get(item.id);
            return !original || original.version !== item.version
              || JSON.stringify(original.geometry) !== JSON.stringify(item.geometry)
              || JSON.stringify(original.properties) !== JSON.stringify(item.properties);
          })) throw new Error("The shared vertex participants changed. Reload their saved versions.");
        const previews = previewSharedPolygonVertexMove(features, fromPosition, toPosition);
        if (previews.length !== features.length) throw new Error("Every shared vertex participant must contain the source vertex.");
        const expected = new Map(previews.map(item => [item.id, item]));
        const participants = features.map(item => {
          const lock = locksByFeature.get(item.id);
          if (lock && !lock.heldByCurrentUser) throw new Error("Another editor holds a shared vertex participant's reservation.");
          return {featureId: item.id, expectedVersion: item.version,
            ...(lock?.heldByCurrentUser ? {lockToken: lock.lockToken} : {})};
        });
        cutPending = true;
        const controls = [...form.querySelectorAll("input, textarea, select, button")].map(control => [control, control.disabled]);
        const inertElements = [canvas, list, polygonStructure?.element].filter(Boolean).map(element => [element, element.inert]);
        for (const [control] of controls) control.disabled = true;
        for (const [element] of inertElements) element.inert = true;
        feedback.className = "project-catalog-feedback";
        feedback.textContent = `Moving a shared vertex across ${participants.length} saved features in one transaction…`;
        try {
          const result = await state.adapter.moveSharedPolygonVertex(state.project.id, dataset.id, {
            features: participants, fromPosition: [...fromPosition], toPosition: [...toPosition],
            changeMessage: message.value.trim() || "Moved a shared polygon vertex in Studio"
          });
          if (!current()) return result;
          if (result?.operation !== "move_shared_vertex" || !Array.isArray(result.updatedFeatures)
            || result.updatedFeatures.length !== expected.size
            || new Set(result.updatedFeatures.map(item => item.id)).size !== expected.size
            || result.updatedFeatures.some(item => {
              const original = saved.get(item.id), preview = expected.get(item.id);
              return !original || !preview || item.version !== original.version + 1
                || item.geometry.type !== original.geometry.type
                || JSON.stringify(item.geometry) !== JSON.stringify(preview.geometry)
                || JSON.stringify(item.properties) !== JSON.stringify(original.properties);
            })) throw new Error("The shared move response changed participant identities, versions, geometry or attributes. Reload current data.");
          await loadFeatureEditing(state, dataset, details);
          return result;
        } catch (error) {
          if (current()) {
            feedback.className = "project-catalog-error";
            feedback.textContent = featureMutationError(error, "Shared vertex was not moved");
          }
          throw error;
        } finally {
          cutPending = false;
          if (details.isConnected && details.contains(content)) {
            for (const [control, disabled] of controls) control.disabled = disabled;
            for (const [element, inert] of inertElements) element.inert = inert;
          }
        }
      }
    } : {})
  });

  const polygonStructure = ["Polygon", "MultiPolygon"].includes(page.collection.geometryType)
    ? multipolygonStructureEditor(state, dataset, details, locksByFeature, {
      geometryType: page.collection.geometryType,
      ...(page.collection.geometryType === "Polygon" ? {beforeMutation: () => {
        if (cutPending || !details.isConnected || !details.contains(content)) {
          throw codedError("feature_editor_changed");
        }
        if (formDirty || propertySnapshot() !== (selected ? selectedPropertySnapshot : initialPropertySnapshot)) {
          throw codedError("feature_editor_dirty");
        }
        cutPending = true;
        const controls = [...form.querySelectorAll("input, textarea, select, button")]
          .map(control => [control, control.disabled]);
        for (const [control] of controls) control.disabled = true;
        const inertElements = [canvas, list].map(element => [element, element.inert]);
        for (const [element] of inertElements) element.inert = true;
        return () => {
          cutPending = false;
          if (details.isConnected && details.contains(content)) {
            for (const [control, disabled] of controls) control.disabled = disabled;
            for (const [element, inert] of inertElements) element.inert = inert;
          }
        };
      }} : {})
    })
    : null;

  const list = document.createElement("div");
  list.className = "project-feature-list";
  if (!page.features.length) {
    list.append(text("p", "No live features yet. Capture the first feature above."));
  }
  for (const feature of page.features) {
    const featureLock = locksByFeature.get(feature.id) ?? null;
    const heldByAnother = Boolean(featureLock && !featureLock.heldByCurrentUser);
    const item = document.createElement("section");
    item.className = "project-feature-record";
    item.dataset.featureId = feature.id;
    const identity = text("strong", `${feature.id} · v${feature.version}`);
    const preview = text("pre", JSON.stringify({
      geometry: feature.geometry,
      properties: feature.properties
    }, null, 2));
    const edit = text("button", "Edit", "platform-button secondary");
    edit.type = "button";
    edit.disabled = heldByAnother;
    edit.addEventListener("click", () => selectForEdit(feature));
    const history = text("button", "History", "platform-button secondary");
    history.type = "button";
    const historyPanel = document.createElement("div");
    historyPanel.className = "project-feature-history";
    historyPanel.hidden = true;
    history.addEventListener("click", async () => {
      if (!historyPanel.hidden) {
        historyPanel.hidden = true;
        history.textContent = "History";
        return;
      }
      history.disabled = true;
      try {
        const result = await state.adapter.listFeatureHistory(
          state.project.id, dataset.id, feature.id, {limit: 100}
        );
        const historyView = document.createElement("ol");
        for (const revision of result.revisions) {
          const revisionItem = document.createElement("li");
          const revisionHeading = document.createElement("div");
          revisionHeading.className = "project-feature-history-heading";
          revisionHeading.append(text(
            "span",
            `v${revision.version} ${revision.operation} · ${revision.changeMessage ?? "No message"}`
          ));
          if (revision.version < feature.version && revision.operation !== "delete") {
            const restore = text(
              "button",
              `Restore content from v${revision.version}`,
              "platform-button secondary"
            );
            restore.type = "button";
            restore.addEventListener("click", () => selectRevisionForRestore(feature, revision));
            revisionHeading.append(restore);
          } else if (revision.version === feature.version) {
            revisionHeading.append(text("span", "Current", "badge active"));
          }
          const snapshot = document.createElement("details");
          snapshot.append(
            text("summary", "Inspect snapshot"),
            text("pre", JSON.stringify({
              geometry: revision.geometry,
              properties: revision.properties
            }, null, 2))
          );
          revisionItem.append(revisionHeading, snapshot);
          historyView.append(revisionItem);
        }
        historyPanel.replaceChildren(
          text(
            "p",
            "Restoring copies an earlier immutable snapshot into a new version. Existing versions remain available for audit.",
            "project-catalog-feedback"
          ),
          historyView
        );
        historyPanel.hidden = false;
        history.textContent = "Hide history";
      } catch (error) {
        historyPanel.replaceChildren(text(
          "p",
          `History unavailable (${error?.code ?? "unexpected_error"}).`,
          "project-catalog-error"
        ));
        historyPanel.hidden = false;
      } finally {
        history.disabled = false;
      }
    });
    const remove = text("button", "Delete", "platform-button secondary");
    remove.type = "button";
    remove.disabled = heldByAnother;
    remove.addEventListener("click", async () => {
      if (globalThis.confirm && !globalThis.confirm(`Delete feature ${feature.id}?`)) return;
      remove.disabled = true;
      try {
        await state.adapter.deleteFeature(
          state.project.id,
          dataset.id,
          feature.id,
          feature.version,
          "Deleted from browser feature editor",
          featureLock?.heldByCurrentUser ? featureLock.lockToken : null
        );
        await loadFeatureEditing(state, dataset, details);
      } catch (error) {
        item.append(text(
          "p",
          `Feature was not deleted (${error?.code ?? "unexpected_error"}).`,
          "project-catalog-error"
        ));
        remove.disabled = false;
      }
    });
    const actions = document.createElement("div");
    actions.className = "project-dataset-actions";
    if (polygonStructure) actions.append(polygonStructure.featureActions(feature));
    const discuss = featureDiscussionLinks(state, dataset, feature);
    actions.append(
      featureLockControls(state, dataset, details, feature, featureLock),
      edit,
      history,
      ...[discuss].filter(Boolean),
      remove
    );
    item.append(identity, preview, actions, historyPanel);
    list.append(item);
  }
  content.append(title, summary);
  if (polygonStructure) content.append(polygonStructure.element);
  content.append(canvas, form, list);
  const deleted = deletedFeatureRecovery(state, dataset, details, tombstones);
  if (deleted) content.append(deleted);
  if (initialFeatureId) {
    const initial = page.features.find(({id}) => id === initialFeatureId);
    const record = list.querySelector(
      `[data-feature-id="${cssEscape(initialFeatureId)}"]`
    );
    if (initial && record) {
      queueMicrotask(() => {
        selectForEdit(initial, true, false);
        record.classList.add("project-route-target");
        record.tabIndex = -1;
        record.focus({preventScroll: true});
        record.scrollIntoView?.({block: "center"});
      });
    }
  }
  return content;
}

function deletedFeatureRecovery(state, dataset, details, page) {
  if (!page?.tombstones?.length) return null;
  const section = document.createElement("details");
  section.className = "project-feature-tombstones";
  section.append(text(
    "summary",
    `Deleted features (${page.numberMatched})`
  ));
  section.append(text(
    "p",
    "Restore appends a new live version from an immutable snapshot. The deletion and every earlier version remain in history.",
    "project-catalog-feedback"
  ));
  for (const tombstone of page.tombstones) {
    const item = document.createElement("section");
    item.className = "project-feature-tombstone";
    const identity = text(
      "strong",
      `${tombstone.featureId} · deleted at v${tombstone.deletedVersion}`
    );
    const facts = text(
      "span",
      `${new Date(tombstone.deletedAt).toLocaleString()} · by ${shortFeatureId(tombstone.deletedBy)}`,
      "project-feature-tombstone-facts"
    );
    const review = text("button", "Review history", "platform-button secondary");
    review.type = "button";
    const historyPanel = document.createElement("div");
    historyPanel.className = "project-feature-history";
    historyPanel.hidden = true;
    review.addEventListener("click", async () => {
      if (!historyPanel.hidden) {
        historyPanel.hidden = true;
        review.textContent = "Review history";
        return;
      }
      review.disabled = true;
      try {
        const history = await state.adapter.listFeatureHistory(
          state.project.id,
          dataset.id,
          tombstone.featureId,
          {limit: 100}
        );
        const list = document.createElement("ol");
        for (const revision of history.revisions) {
          const row = document.createElement("li");
          const heading = document.createElement("div");
          heading.className = "project-feature-history-heading";
          heading.append(text(
            "span",
            `v${revision.version} ${revision.operation} · ${revision.changeMessage ?? "No message"}`
          ));
          if (["create", "update", "restore"].includes(revision.operation)
            && revision.version < tombstone.deletedVersion) {
            const restore = text(
              "button",
              `Restore v${revision.version}`,
              "platform-button secondary"
            );
            restore.type = "button";
            restore.addEventListener("click", async () => {
              const request = deletedFeatureRestoreRequest(tombstone, revision);
              if (globalThis.confirm && !globalThis.confirm(
                `Restore feature ${shortFeatureId(tombstone.featureId)} from immutable v${revision.version} as v${tombstone.deletedVersion + 1}?`
              )) return;
              restore.disabled = true;
              try {
                await state.adapter.restoreFeature(
                  state.project.id,
                  dataset.id,
                  tombstone.featureId,
                  request
                );
                await loadFeatureEditing(
                  state, dataset, details, tombstone.featureId
                );
              } catch (error) {
                historyPanel.prepend(text(
                  "p",
                  featureMutationError(error, "Feature was not restored"),
                  "project-catalog-error"
                ));
                restore.disabled = false;
              }
            });
            heading.append(restore);
          }
          const snapshot = document.createElement("details");
          snapshot.append(
            text("summary", "Inspect snapshot"),
            text("pre", JSON.stringify({
              geometry: revision.geometry,
              properties: revision.properties
            }, null, 2))
          );
          row.append(heading, snapshot);
          list.append(row);
        }
        historyPanel.replaceChildren(list);
        historyPanel.hidden = false;
        review.textContent = "Hide history";
      } catch (error) {
        historyPanel.replaceChildren(text(
          "p",
          `Deleted feature history unavailable (${error?.code ?? "unexpected_error"}).`,
          "project-catalog-error"
        ));
        historyPanel.hidden = false;
      } finally {
        review.disabled = false;
      }
    });
    item.append(identity, facts, review, historyPanel);
    section.append(item);
  }
  if (page.numberMatched > page.numberReturned) {
    section.append(text(
      "p",
      `Showing ${page.numberReturned} of ${page.numberMatched} deleted features.`,
      "project-catalog-feedback"
    ));
  }
  return section;
}

function featureDiscussionLinks(state, dataset, feature) {
  const targets = state.maps.flatMap((map) => (
    (map.definition?.layers ?? [])
      .filter((layer) => layer?.datasetId === dataset.id && layer?.layerId)
      .map((layer) => ({
        mapId: map.id,
        mapVersion: map.version,
        mapName: map.name,
        layerId: layer.layerId,
        layerName: layer.title ?? layer.layerId,
        datasetId: dataset.id,
        featureId: feature.id
      }))
  ));
  if (!targets.length) return null;
  const links = document.createElement("span");
  links.className = "project-feature-discussion-links";
  for (const target of targets) {
    const link = text(
      "a",
      targets.length === 1 ? "Discuss" : `Discuss in ${target.mapName} · ${target.layerName}`,
      "platform-button secondary"
    );
    link.href = projectHref(state.project.id, {
      adapterKind: state.adapter?.kind,
      management: "discussions",
      featureTarget: target
    });
    links.append(link);
  }
  return links;
}

export function featureLockControls(state, dataset, details, feature, featureLock) {
  const controls = document.createElement("span");
  controls.className = "project-feature-lock-controls";
  const status = text("small", "", "project-feature-lock-status");
  status.ariaLive = "polite";
  controls.append(status);
  const expiration = featureLock
    ? new Intl.DateTimeFormat(undefined, {hour: "numeric", minute: "2-digit"})
      .format(new Date(featureLock.expiresAt))
    : null;

  if (featureLock && !featureLock.heldByCurrentUser) {
    status.textContent = `Reserved by another editor until ${expiration}`;
    controls.dataset.state = "other";
    return controls;
  }

  const changeReservation = async (operation, button) => {
    button.disabled = true;
    try {
      await operation();
      await loadFeatureEditing(state, dataset, details, feature.id);
    } catch (error) {
      status.className = "project-catalog-error project-feature-lock-status";
      status.textContent = featureMutationError(error, "Reservation was not changed");
      button.disabled = false;
    }
  };

  if (featureLock) {
    status.textContent = `Reserved by you until ${expiration}`;
    controls.dataset.state = "own";
    const renew = text("button", "Renew", "platform-button secondary");
    renew.type = "button";
    renew.addEventListener("click", () => changeReservation(
      () => state.adapter.acquireFeatureLock(
        state.project.id,
        dataset.id,
        feature.id,
        {
          expectedVersion: feature.version,
          lockToken: featureLock.lockToken,
          leaseSeconds: 120
        }
      ),
      renew
    ));
    const release = text("button", "Release", "platform-button secondary");
    release.type = "button";
    release.addEventListener("click", () => changeReservation(
      () => state.adapter.releaseFeatureLock(
        state.project.id, dataset.id, feature.id, featureLock.lockToken
      ),
      release
    ));
    controls.append(renew, release);
    return controls;
  }

  status.textContent = "Unreserved";
  controls.dataset.state = "available";
  const reserve = text("button", "Reserve edit", "platform-button secondary");
  reserve.type = "button";
  reserve.addEventListener("click", () => changeReservation(
    () => state.adapter.acquireFeatureLock(
      state.project.id,
      dataset.id,
      feature.id,
      {
        expectedVersion: feature.version,
        lockToken: crypto.randomUUID(),
        leaseSeconds: 120
      }
    ),
    reserve
  ));
  controls.append(reserve);
  return controls;
}

function featureMutationError(error, prefix) {
  if (error?.code === "feature_editor_changed") {
    return `${prefix}. The editor changed. Reload current data before trying again.`;
  }
  if (error?.code === "feature_editor_dirty") {
    return `${prefix}. Save or cancel the feature changes before dissolving boundaries.`;
  }
  if (error?.code === "feature_version_conflict") {
    return `${prefix}. A newer version (${error.currentVersion}) exists; reload current data before trying again.`;
  }
  if (error?.code === "feature_locked") {
    return `${prefix}. Another editor holds the active short reservation; reload after it is released or expires.`;
  }
  if (error?.code === "feature_lock_limit_reached") {
    return `${prefix}. Release one of your 25 active feature reservations first.`;
  }
  if (error?.code === "geometry_operation_unsupported") {
    return `${prefix}. Dissolving boundaries is unavailable in this workspace.`;
  }
  return `${prefix} (${error?.code ?? "unexpected_error"}).`;
}

export function multipolygonStructureEditor(state, dataset, details, locksByFeature = new Map(), {
  geometryType = "MultiPolygon", beforeMutation = null
} = {}) {
  if (!(locksByFeature instanceof Map)) locksByFeature = new Map();
  const polygonOnly = geometryType === "Polygon";
  let busy = false;
  const selectionControls = [];
  const selected = new Map();
  const element = document.createElement("details");
  element.className = "project-feature-polygon-structure";
  element.append(text("summary", polygonOnly ? "Dissolve polygon boundaries" : "Separate or merge polygon features"));
  const guidance = text(
    "p",
    polygonOnly
      ? "Select 2–20 touching or overlapping polygon features, then choose Dissolve selected. Their union must remain one connected Polygon. The retained feature keeps its ID and attributes; donor history remains as immutable tombstones."
      : "Separate turns each part into an independent feature and keeps the original ID on the chosen part. Merge combines 2–20 valid, non-overlapping features into one multipart feature. Select Dissolve boundaries to union touching or overlapping areas instead. Both retain the chosen feature’s ID and attributes and preserve donor history as tombstones.",
    "project-catalog-feedback"
  );
  const controls = document.createElement("div");
  controls.className = "project-feature-polygon-structure-controls";
  const retained = document.createElement("select");
  retained.ariaLabel = "Feature identity and attributes to retain when merging";
  retained.disabled = true;
  const merge = text("button", polygonOnly ? "Dissolve selected" : "Merge selected", "platform-button secondary");
  merge.type = "button";
  merge.disabled = true;
  const dissolveLabel = document.createElement("label");
  const dissolve = document.createElement("input");
  dissolve.type = "checkbox";
  dissolve.setAttribute("aria-label", "Dissolve boundaries");
  dissolve.checked = polygonOnly;
  dissolve.disabled = true;
  dissolveLabel.append(dissolve, document.createTextNode(" Dissolve boundaries"));
  const selectionStatus = text(
    "span",
    "Select at least two features below.",
    "project-feature-polygon-selection"
  );
  const feedback = text("p", "No polygon structure change is staged.", "project-catalog-feedback");
  feedback.ariaLive = "polite";
  controls.append(retained, dissolveLabel, merge, selectionStatus);
  element.append(guidance, controls, feedback);

  const updateSelection = () => {
    const previous = retained.value;
    retained.replaceChildren();
    for (const feature of selected.values()) {
      const option = document.createElement("option");
      option.value = feature.id;
      option.textContent = `${shortFeatureId(feature.id)} · v${feature.version}`;
      retained.append(option);
    }
    if (selected.has(previous)) retained.value = previous;
    retained.disabled = busy || selected.size < 2;
    merge.disabled = busy || selected.size < 2;
    dissolve.disabled = polygonOnly || busy || selected.size < 2;
    if (polygonOnly) dissolve.checked = true;
    for (const [checkbox, heldByAnother] of selectionControls) checkbox.disabled = busy || heldByAnother;
    selectionStatus.textContent = selected.size
      ? `${selected.size}/20 selected${selected.size >= 2 ? " · choose retained identity" : ""}`
      : "Select at least two features below.";
  };

  merge.addEventListener("click", async () => {
    if (busy || selected.size < 2 || !selected.has(retained.value)) return;
    const retainedFeature = selected.get(retained.value);
    const donorCount = selected.size - 1;
    const dissolving = polygonOnly || dissolve.checked;
    let finishMutation = null;
    try {
      busy = true;
      finishMutation = beforeMutation?.();
      updateSelection();
      if (globalThis.confirm && !globalThis.confirm(
        `${dissolving ? "Dissolve boundaries and union" : "Merge"} ${selected.size} features? ${dissolving ? "Touching and overlapping areas will become their union. " : "Polygon boundaries are kept. "}${shortFeatureId(retainedFeature.id)} keeps its ID and attributes; ${donorCount} donor feature${donorCount === 1 ? "" : "s"} become immutable tombstones.`
      )) return;
      feedback.className = "project-catalog-feedback";
      feedback.textContent = dissolving
        ? "Dissolving polygon boundaries in one version-checked transaction…"
        : "Merging polygon features in one version-checked transaction…";
      await state.adapter.mergeMultipolygonFeatures(state.project.id, dataset.id, {
        retainedFeatureId: retainedFeature.id,
        features: [...selected.values()].map((feature) => {
          const featureLock = locksByFeature.get(feature.id);
          return {
            featureId: feature.id,
            expectedVersion: feature.version,
            ...(featureLock?.heldByCurrentUser
              ? {lockToken: featureLock.lockToken}
              : {})
          };
        }),
        changeMessage: `${dissolving ? "Dissolved boundaries of" : "Merged"} ${selected.size} polygon features in Studio`,
        ...(dissolving ? {geometryOperation: "dissolve"} : {})
      });
      if (details.isConnected && details.contains(element)) await loadFeatureEditing(state, dataset, details);
    } catch (error) {
      feedback.className = "project-catalog-error";
      feedback.textContent = featureMutationError(
        error,
        dissolving ? "Polygon boundaries were not dissolved" : "Polygon features were not merged"
      );
    } finally {
      busy = false;
      finishMutation?.();
      updateSelection();
    }
  });

  const featureActions = (feature) => {
    const featureLock = locksByFeature.get(feature.id) ?? null;
    const heldByAnother = Boolean(featureLock && !featureLock.heldByCurrentUser);
    const actions = document.createElement("span");
    actions.className = "project-feature-polygon-actions";
    const label = document.createElement("label");
    label.className = "project-feature-polygon-select";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.disabled = heldByAnother;
    selectionControls.push([checkbox, heldByAnother]);
    checkbox.setAttribute("aria-label", `Select feature ${feature.id} for polygon merge`);
    checkbox.addEventListener("change", () => {
      if (busy) {
        checkbox.checked = selected.has(feature.id);
        return;
      }
      if (checkbox.checked && selected.size >= 20) {
        checkbox.checked = false;
        feedback.className = "project-catalog-error";
        feedback.textContent = "A single merge is limited to 20 features.";
        return;
      }
      if (checkbox.checked) selected.set(feature.id, feature);
      else selected.delete(feature.id);
      feedback.className = "project-catalog-feedback";
      feedback.textContent = "No polygon structure change is staged.";
      updateSelection();
    });
    label.append(checkbox, document.createTextNode(polygonOnly ? " Dissolve" : " Merge"));
    actions.append(label);

    const parts = Array.isArray(feature.geometry?.coordinates)
      ? feature.geometry.coordinates.length
      : 0;
    if (!polygonOnly && feature.geometry?.type === "MultiPolygon" && parts > 1) {
      const retainedPart = document.createElement("select");
      retainedPart.setAttribute("aria-label", `Part retaining feature ${feature.id}`);
      for (let index = 0; index < parts; index += 1) {
        const option = document.createElement("option");
        option.value = String(index);
        option.textContent = `Keep part ${index + 1}`;
        retainedPart.append(option);
      }
      const separate = text(
        "button",
        `Separate ${parts} parts`,
        "platform-button secondary"
      );
      separate.type = "button";
      separate.disabled = heldByAnother;
      separate.addEventListener("click", async () => {
        const retainedPartIndex = Number(retainedPart.value);
        if (globalThis.confirm && !globalThis.confirm(
          `Separate ${parts} polygon parts? Part ${retainedPartIndex + 1} keeps feature ${shortFeatureId(feature.id)}; every other part receives a new stable ID.`
        )) return;
        separate.disabled = true;
        retainedPart.disabled = true;
        feedback.className = "project-catalog-feedback";
        feedback.textContent = `Separating ${parts} polygon parts in one version-checked transaction…`;
        try {
          await state.adapter.separateMultipolygonParts(state.project.id, dataset.id, {
            featureId: feature.id,
            expectedVersion: feature.version,
            retainedPartIndex,
            changeMessage: `Separated ${parts} polygon parts in Studio`,
            ...(featureLock?.heldByCurrentUser
              ? {lockToken: featureLock.lockToken}
              : {})
          });
          await loadFeatureEditing(state, dataset, details);
        } catch (error) {
          feedback.className = "project-catalog-error";
          feedback.textContent = featureMutationError(
            error,
            "Polygon parts were not separated"
          );
          separate.disabled = false;
          retainedPart.disabled = false;
        }
      });
      actions.append(retainedPart, separate);
    }
    return actions;
  };

  updateSelection();
  return {element, featureActions};
}

function shortFeatureId(value) {
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

export function featureRevisionRestoreDraft(feature, revision) {
  if (!Number.isSafeInteger(feature?.version) || feature.version < 1) {
    throw codedError("feature_restore_current_version_invalid");
  }
  if (
    !Number.isSafeInteger(revision?.version)
    || revision.version < 1
    || revision.version >= feature.version
  ) {
    throw codedError("feature_restore_revision_invalid");
  }
  if (!["create", "update", "restore"].includes(revision.operation)) {
    throw codedError("feature_restore_deleted_revision_invalid");
  }
  if (
    !revision.geometry
    || typeof revision.geometry !== "object"
    || Array.isArray(revision.geometry)
  ) {
    throw codedError("feature_restore_geometry_invalid");
  }
  if (
    !revision.properties
    || typeof revision.properties !== "object"
    || Array.isArray(revision.properties)
  ) {
    throw codedError("feature_restore_properties_invalid");
  }
  return {
    expectedVersion: feature.version,
    geometry: structuredClone(revision.geometry),
    properties: structuredClone(revision.properties),
    changeMessage: `Restored content from immutable feature revision v${revision.version}`
  };
}

export function deletedFeatureRestoreRequest(tombstone, revision) {
  if (!Number.isSafeInteger(tombstone?.deletedVersion) || tombstone.deletedVersion < 2) {
    throw codedError("feature_restore_tombstone_invalid");
  }
  if (!Number.isSafeInteger(revision?.version)
    || revision.version < 1
    || revision.version >= tombstone.deletedVersion
    || !["create", "update", "restore"].includes(revision.operation)) {
    throw codedError("feature_restore_revision_invalid");
  }
  return {
    expectedVersion: tombstone.deletedVersion,
    revisionVersion: revision.version,
    changeMessage: `Restored deleted feature from immutable revision v${revision.version}`
  };
}

function defaultGeometry(geometryType) {
  return {
    Point: {type: "Point", coordinates: [0, 0]},
    MultiPoint: {type: "MultiPoint", coordinates: [[0, 0]]},
    LineString: {type: "LineString", coordinates: [[0, 0], [1, 1]]},
    MultiLineString: {type: "MultiLineString", coordinates: [[[0, 0], [1, 1]]]},
    Polygon: {type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]]},
    MultiPolygon: {
      type: "MultiPolygon",
      coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]]
    }
  }[geometryType];
}

function defaultPropertyValues(fields) {
  return Object.fromEntries(fields.map((field) => [
    field.name,
    defaultPropertyValue(field)
  ]));
}

function defaultPropertyValue(field) {
  if (field.attachment) return "";
  if (field.type === "group") {
    if (field.repeat) {
      const count = Math.max(field.minItems ?? 0, field.required ? 1 : 0);
      return Array.from({length: count}, () => defaultPropertyValues(field.fields));
    }
    return defaultPropertyValues(field.fields);
  }
  if (field.type === "boolean") return false;
  if (field.type === "string") {
    if (field.choices?.length) return field.choices[0];
    const minimumLength = field.minLength ?? 1;
    const maximumLength = field.maxLength ?? 2000;
    return "value".length >= minimumLength && "value".length <= maximumLength
      ? "value"
      : "x".repeat(Math.min(Math.max(minimumLength, 1), maximumLength));
  }
  if (field.minimum !== null && field.minimum !== undefined && field.minimum > 0) {
    return field.minimum;
  }
  if (field.maximum !== null && field.maximum !== undefined && field.maximum < 0) {
    return field.maximum;
  }
  return 0;
}

export function featurePropertyFields(fields, attachments = null) {
  return featurePropertyEditor(fields, {legend: "Schema-driven properties", attachments});
}

function featurePropertyEditor(fields, {legend, nested = false, attachments = null}) {
  const element = document.createElement("fieldset");
  element.className = `project-feature-fields${nested ? " nested" : ""}`;
  element.append(text("legend", legend));
  if (!nested) {
    element.append(text(
      "p",
      "Values are validated against the collection's immutable schema; repeated records remain ordered.",
      "project-catalog-feedback"
    ));
  }
  const controls = new Map();
  for (const definition of fields) {
    if (definition.type === "group") {
      const wrapper = document.createElement("fieldset");
      wrapper.className = "project-feature-group";
      wrapper.append(text(
        "legend",
        `${definition.label ?? definition.name}${definition.repeat ? " · repeating group" : " · group"}`
      ));
      if (definition.description) {
        wrapper.append(text("small", definition.description, "project-feature-field-help"));
      }
      if (definition.repeat) {
        const entries = [];
        const list = document.createElement("div");
        list.className = "project-feature-repeat-list";
        const actions = document.createElement("div");
        actions.className = "project-feature-repeat-actions";
        const add = text("button", `Add ${definition.label ?? definition.name}`, "platform-button secondary");
        add.type = "button";
        const minimum = Math.max(definition.minItems ?? 0, definition.required ? 1 : 0);
        const maximum = definition.maxItems ?? 20;
        const refresh = () => {
          entries.forEach((entry, index) => {
            entry.title.textContent = `${definition.label ?? definition.name} ${index + 1}`;
            entry.remove.disabled = wrapper.disabled || entries.length <= minimum;
          });
          add.disabled = wrapper.disabled || entries.length >= maximum;
        };
        const addEntry = (values = defaultPropertyValues(definition.fields)) => {
          if (entries.length >= maximum) return;
          const item = document.createElement("section");
          item.className = "project-feature-repeat-item";
          const header = document.createElement("div");
          header.className = "project-feature-repeat-header";
          const title = text("strong", "");
          const remove = text("button", "Remove", "platform-button secondary");
          remove.type = "button";
          const editor = featurePropertyEditor(definition.fields, {
            legend: `${definition.label ?? definition.name} fields`,
            nested: true, attachments
          });
          remove.addEventListener("click", () => {
            const index = entries.findIndex((entry) => entry.item === item);
            if (index < 0 || entries.length <= minimum) return;
            entries.splice(index, 1);
            item.remove();
            refresh();
          });
          header.append(title, remove);
          item.append(header, editor.element);
          list.append(item);
          entries.push({item, title, remove, editor});
          editor.write(values);
          refresh();
        };
        add.addEventListener("click", () => addEntry());
        actions.append(add, text(
          "small",
          `${minimum}–${maximum} ordered record${maximum === 1 ? "" : "s"}`,
          "project-catalog-feedback"
        ));
        wrapper.append(list, actions);
        const entry = {
          definition,
          wrapper,
          visible: true,
          peek: () => undefined,
          read: (options) => {
            if (entries.length < minimum || entries.length > maximum) {
              throw codedError("feature_properties_invalid");
            }
            return entries.map((item) => item.editor.read(options));
          },
          write: (value) => {
            list.replaceChildren();
            entries.splice(0);
            const records = Array.isArray(value) ? value.slice(0, maximum) : [];
            for (const record of records) addEntry(record);
            while (entries.length < minimum) addEntry();
            refresh();
          },
          setDisabled: (disabled) => {
            wrapper.disabled = disabled;
            refresh();
          }
        };
        controls.set(definition.name, entry);
        element.append(wrapper);
        continue;
      }
      const included = definition.required
        ? null
        : input("checkbox", `Include ${definition.label ?? definition.name}`);
      if (included) {
        included.addEventListener("change", () => {
          editor.element.disabled = !included.checked || wrapper.disabled;
        });
        wrapper.append(field("Include this group", included));
      }
      const editor = featurePropertyEditor(definition.fields, {
        legend: `${definition.label ?? definition.name} fields`,
        nested: true, attachments
      });
      wrapper.append(editor.element);
      const entry = {
        definition,
        wrapper,
        visible: true,
        peek: () => undefined,
        read: (options) => {
          if (included && !included.checked) return undefined;
          return editor.read(options);
        },
        write: (value) => {
          const active = definition.required || Boolean(value && typeof value === "object" && !Array.isArray(value));
          if (included) included.checked = active;
          editor.write(active ? value : defaultPropertyValues(definition.fields));
          editor.element.disabled = !active || wrapper.disabled;
        },
        setDisabled: (disabled) => {
          wrapper.disabled = disabled;
          if (included) included.disabled = disabled;
          editor.element.disabled = disabled || Boolean(included && !included.checked);
        }
      };
      controls.set(definition.name, entry);
      element.append(wrapper);
      continue;
    }
    let control;
    if (definition.type === "boolean") {
      control = select(`Feature property ${definition.name}`, definition.required
        ? [["false", "false"], ["true", "true"]]
        : [["", "unset"], ["false", "false"], ["true", "true"]]);
    } else if (definition.choices?.length) {
      control = select(
        `Feature property ${definition.name}`,
        [
          ...(definition.required ? [] : [["", "unset"]]),
          ...definition.choices.map((choice) => [choice, choice])
        ]
      );
    } else {
      control = input(definition.type === "string" ? "text" : "number", `Feature property ${definition.name}`);
      if (definition.type === "string") {
        control.minLength = definition.minLength ?? 1;
        control.maxLength = definition.maxLength ?? 2000;
      }
      if (definition.type === "integer") control.step = "1";
      if (definition.type === "number") control.step = "any";
      if (definition.minimum !== null && definition.minimum !== undefined) {
        control.min = String(definition.minimum);
      }
      if (definition.maximum !== null && definition.maximum !== undefined) {
        control.max = String(definition.maximum);
      }
    }
    if (definition.calculation != null) control.readOnly = true;
    control.required = definition.required;
    const wrapper = field(
      `${definition.label ?? definition.name} · ${definition.type}${definition.required
        ? definition.visibleWhen ? " · required when shown" : " · required"
        : ""}`,
      control
    );
    if (definition.attachment) {
      control.readOnly = true;
      if (attachments?.adapter?.resolveFeatureAttachment) {
        wrapper.append(FeatureAttachmentPicker({control, ...attachments}));
      } else {
        wrapper.append(text("small", "Saved attachment reference. Connect to Studio to choose or download files."));
      }
    }
    if (definition.description) {
      wrapper.append(text("small", definition.description, "project-feature-field-help"));
    }
    const scalarValue = () => {
      if (control.value === "") return undefined;
      if (definition.type === "string") return control.value;
      if (definition.type === "boolean") return control.value === "true";
      const value = Number(control.value);
      return Number.isFinite(value) ? value : undefined;
    };
    controls.set(definition.name, {
      control,
      definition,
      wrapper,
      visible: true,
      peek: scalarValue,
      read: (options) => scalarPropertyValue(control, definition, options),
      write: (value) => {
        control.value = value === null || value === undefined ? "" : String(value);
        if (definition.attachment) {
          control.dispatchEvent(new control.ownerDocument.defaultView.Event("attachmentreset"));
        }
      },
      setDisabled: (disabled) => {
        control.disabled = disabled;
        control.required = !disabled && definition.required;
      }
    });
    element.append(wrapper);
  }
  const updateVisibility = () => {
    const available = new Map();
    for (const [name, entry] of controls) {
      const {definition, wrapper} = entry;
      entry.visible = featureFieldVisible(definition.visibleWhen, available);
      wrapper.hidden = !entry.visible;
      entry.setDisabled(!entry.visible);
      if (entry.visible && definition.calculation != null) {
        try {
          entry.write(evaluateCalculation(definition.calculation, available));
          entry.calculationError = null;
        } catch (error) {
          entry.write(null);
          entry.calculationError = error.message;
        }
        entry.control.setCustomValidity(entry.calculationError ?? "");
      }
      if (entry.visible && definition.type !== "group") available.set(name, entry.peek());
    }
  };
  for (const {control} of [...controls.values()].filter((entry) => entry.control)) {
    control.addEventListener("input", updateVisibility);
    control.addEventListener("change", updateVisibility);
  }
  const write = (values) => {
    const defaults = defaultPropertyValues(fields);
    for (const [name, entry] of controls) {
      const {definition} = entry;
      const value = Object.hasOwn(values, name)
        ? values[name]
        : definition.required ? defaults[name] : "";
      entry.write(value);
    }
    updateVisibility();
  };
  const read = (options) => {
    updateVisibility();
    const values = {};
    for (const [name, entry] of controls) {
      const {definition, visible} = entry;
      if (!visible) continue;
      if (entry.calculationError) throw featureSchemaError(entry.calculationError);
      const value = entry.read(options);
      if (value === undefined) {
        if (definition.required) throw codedError("feature_properties_invalid");
        continue;
      }
      values[name] = value;
    }
    return values;
  };
  write(defaultPropertyValues(fields));
  return {element, read, write};
}

function scalarPropertyValue(control, definition, {allowDeviceFiles = false} = {}) {
  if (definition.attachment && allowDeviceFiles && /^device-file:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(control.value)) return control.value;
  if (control.value === "") {
    if (definition.required) throw codedError("feature_properties_invalid");
    return undefined;
  }
  let value;
  if (definition.type === "string") value = control.value;
  if (definition.attachment && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
    throw codedError("feature_properties_invalid");
  }
  if (definition.type === "boolean") value = control.value === "true";
  if (definition.type === "integer" || definition.type === "number") {
    value = Number(control.value);
    if (!Number.isFinite(value) || (definition.type === "integer" && !Number.isInteger(value))) {
      throw codedError("feature_properties_invalid");
    }
  }
  if (
    definition.type === "string"
    && (
      value.length < (definition.minLength ?? 1)
      || value.length > (definition.maxLength ?? 2000)
      || (definition.choices?.length && !definition.choices.includes(value))
    )
  ) throw codedError("feature_properties_invalid");
  if (
    ["integer", "number"].includes(definition.type)
    && (
      (definition.minimum !== null && definition.minimum !== undefined && value < definition.minimum)
      || (definition.maximum !== null && definition.maximum !== undefined && value > definition.maximum)
    )
  ) throw codedError("feature_properties_invalid");
  return value;
}

function destroyFeatureCanvases(container) {
  for (const canvas of container.querySelectorAll(".project-feature-canvas")) {
    canvas.__destroy?.();
  }
}

function parseJsonObject(value, code) {
  let result;
  try {
    result = JSON.parse(value);
  } catch {
    throw codedError(code);
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) throw codedError(code);
  return result;
}

function versionHistory(state, dataset, versions) {
  const content = document.createElement("div");
  content.className = "project-version-history";
  content.append(text("h4", "Logical version history"));
  if (!versions.length) {
    content.append(text("p", "No completed logical version exists yet.", "project-catalog-feedback"));
    return content;
  }
  for (const version of versions) {
    const item = document.createElement("section");
    item.className = "project-version-record";
    item.append(
      text("strong", `v${version.versionNumber}${version.current ? " · current" : ""}`),
      text("span", `${version.state} · ${new Date(version.createdAt).toLocaleString()}`),
      text("p", version.changeMessage ?? "No change message")
    );
    const objects = document.createElement("ul");
    for (const object of version.objects) {
      const row = document.createElement("li");
      row.append(text("span", `${object.role} · ${object.filename} · ${formatBytes(object.sizeBytes)}`));
      if (dataset.capabilities.download) {
        const download = text("button", "Download", "platform-button secondary project-object-download");
        download.type = "button";
        download.addEventListener("click", () => authorizeDownload({state, dataset, version, object, download, item}));
        row.append(download);
      } else {
        row.append(text("span", "Download permission required", "project-catalog-feedback"));
      }
      objects.append(row);
    }
    item.append(objects);
    if (typeof state.adapter.getDatasetVersionLineage === "function") {
      const lineageId = `dataset-lineage-${version.id}`;
      const lineage = text(
        "button",
        "Inspect lineage",
        "platform-button secondary project-dataset-lineage-toggle"
      );
      lineage.type = "button";
      lineage.setAttribute("aria-controls", lineageId);
      lineage.setAttribute("aria-expanded", "false");
      const lineageRegion = document.createElement("div");
      lineageRegion.id = lineageId;
      lineageRegion.className = "project-dataset-lineage";
      lineageRegion.hidden = true;
      lineage.addEventListener("click", () => toggleDatasetLineage({
        state, dataset, version, button: lineage, region: lineageRegion
      }));
      item.append(lineage, lineageRegion);
    }
    if (
      ["odt", "pdf"].includes(dataset.format)
      && version.state === "active"
      && (
        (
          dataset.format === "odt"
          && version.schemaDefinition?.document?.accessible_preview_schema
            === "opengeo.document-preview.1.0.0"
        )
        || (
          dataset.format === "pdf"
          && ["opengeo.document-preview.2.0.0", "opengeo.document-preview.3.0.0"].includes(
            version.schemaDefinition?.document?.accessible_preview_schema
          )
        )
      )
    ) {
      const previewId = `document-preview-${version.id}`;
      const preview = text(
        "button",
        "Read accessible preview",
        "platform-button secondary project-document-preview-toggle"
      );
      preview.type = "button";
      preview.setAttribute("aria-controls", previewId);
      preview.setAttribute("aria-expanded", "false");
      const previewRegion = document.createElement("div");
      previewRegion.id = previewId;
      previewRegion.className = "project-document-preview";
      previewRegion.hidden = true;
      preview.addEventListener("click", () => toggleDocumentPreview({
        state, dataset, version, button: preview, region: previewRegion
      }));
      item.append(preview, previewRegion);
    }
    content.append(item);
  }
  return content;
}

async function toggleDatasetLineage({state, dataset, version, button, region}) {
  if (!region.hidden) {
    region.hidden = true;
    button.setAttribute("aria-expanded", "false");
    button.textContent = "Inspect lineage";
    return;
  }
  region.hidden = false;
  button.setAttribute("aria-expanded", "true");
  button.textContent = "Hide lineage";
  if (region.dataset.loaded === "true") return;
  button.disabled = true;
  region.replaceChildren(text(
    "p", "Loading the immutable version lineage…", "project-catalog-feedback"
  ));
  try {
    const lineage = await state.adapter.getDatasetVersionLineage(
      state.project.id, dataset.id, version.id
    );
    renderDatasetLineage(region, lineage);
    region.dataset.loaded = "true";
  } catch (error) {
    region.replaceChildren(text(
      "p",
      `Lineage could not be loaded (${error?.code ?? "unexpected_error"}).`,
      "project-catalog-error"
    ));
  } finally {
    button.disabled = false;
  }
}

function renderDatasetLineage(region, lineage) {
  const heading = text("h5", `Version ${lineage.versionNumber} lineage`);
  const originsHeading = text("strong", "Acquisition");
  const origins = document.createElement("ul");
  origins.className = "project-dataset-lineage-records";
  if (!lineage.origins.length) {
    origins.append(text("li", "No acquisition lineage is recorded for this version."));
  }
  for (const origin of lineage.origins) {
    const item = document.createElement("li");
    const summary = origin.kind === "managed_upload"
      ? "Managed file upload"
      : origin.kind === "external_source_archive"
        ? `Protected snapshot of ${origin.sourceDatasetName} · source revision ${origin.sourceRevisionNumber}`
        : `Copy of ${origin.sourceDatasetName} from a connected repository`;
    item.append(
      text("span", `${summary} · acquired ${new Date(origin.acquiredAt).toLocaleString()}`),
      lineageFacts([
        ["Operation", origin.operationId],
        ["Input object", origin.inputObjectId]
      ])
    );
    origins.append(item);
  }
  const derivativesHeading = text("strong", "Derivatives");
  const derivatives = document.createElement("ul");
  derivatives.className = "project-dataset-lineage-records";
  if (!lineage.derivatives.length) {
    derivatives.append(text("li", "No derived objects are recorded for this version."));
  }
  for (const derivative of lineage.derivatives) {
    const item = document.createElement("li");
    item.append(
      text(
        "span",
        `PMTiles · ${derivative.recipe} · zoom ${derivative.minimumZoom}–${derivative.maximumZoom} · ${derivative.sourceLayer}`
      ),
      lineageFacts([
        ["Operation", derivative.operationId],
        ["Source object", derivative.sourceObjectId],
        ["Output object", derivative.outputObjectId],
        ["CRS84 bounds", derivative.bounds.join(", ")],
        ["Request checksum", derivative.requestChecksumSha256]
      ])
    );
    if(derivative.options)item.append(text('p',pmtilesOptionsSummary(derivative.options)));
    derivatives.append(item);
  }
  region.replaceChildren(heading, originsHeading, origins, derivativesHeading, derivatives);
  if (lineage.derivativesTruncated) {
    region.append(text(
      "p", "Showing the first 100 derivative records.", "project-catalog-feedback"
    ));
  }
}

function lineageFacts(entries) {
  const facts = document.createElement("dl");
  facts.className = "project-dataset-lineage-facts";
  for (const [label, value] of entries) {
    facts.append(text("dt", label), text("dd", value));
  }
  return facts;
}

async function toggleDocumentPreview({state, dataset, version, button, region}) {
  if (!region.hidden) {
    region.hidden = true;
    button.setAttribute("aria-expanded", "false");
    button.textContent = "Read accessible preview";
    return;
  }
  region.hidden = false;
  button.disabled = true;
  button.setAttribute("aria-expanded", "true");
  region.replaceChildren(text(
    "p",
    "Loading exact semantic document preview…",
    "project-catalog-feedback"
  ));
  try {
    const preview = await state.adapter.getDatasetDocumentPreview(
      state.project.id,
      dataset.id,
      version.id
    );
    region.replaceChildren(documentPreview(preview));
    button.textContent = "Hide accessible preview";
  } catch (error) {
    region.replaceChildren(text(
      "p",
      `Document preview is unavailable (${error?.code ?? "unexpected_error"}).`,
      "project-catalog-error"
    ));
  } finally {
    button.disabled = false;
  }
}

async function authorizeDownload({state, dataset, version, object, download, item}) {
  download.disabled = true;
  try {
    const ticket = await state.adapter.requestDatasetDownload(state.project.id, dataset.id, version.id, object.id);
    if (Date.parse(ticket.expiresAt) <= Date.now()) throw codedError("download_expired");
    if (ticket.url === "fixture://memory-only") {
      item.append(text("p", "Fixture download authorized in memory only.", "project-catalog-feedback"));
      return;
    }
    const link = document.createElement("a");
    link.href = ticket.url;
    link.download = object.filename;
    link.rel = "noopener noreferrer";
    link.referrerPolicy = "no-referrer";
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    item.append(text("p", "Short-lived exact-version download authorized.", "project-catalog-feedback"));
  } catch (error) {
    item.append(text("p", `Download was not authorized (${error?.code ?? "unexpected_error"}).`, "project-catalog-error"));
  } finally {
    download.disabled = false;
  }
}

async function loadDatasetPermissions({state, dataset, details, permissions}) {
  permissions.disabled = true;
  details.hidden = false;
  details.dataset.mode = "permissions";
  details.datasetAccess?.dispose();
  const editor = DatasetAccess({adapter: state.adapter, dataset,
    accountId: state.organization?.id, accountRole: state.organization?.callerRole});
  details.datasetAccess = editor;
  details.replaceChildren(editor);
  try {
    await editor.load();
  } catch (error) {
    details.replaceChildren(text("p", `Dataset access is unavailable (${error?.code ?? "unexpected_error"}).`, "project-catalog-error"));
  } finally {
    permissions.disabled = false;
  }
}

function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 ** 2).toFixed(1)} MiB`;
}

function processingOutcome(dataset, refresh) {
  const panel = document.createElement("div");
  panel.className = "project-dataset-quality";
  const state = dataset.processingJobState;
  panel.dataset.state = state ?? "not-queued";

  if (state === "failed" || dataset.status === "failed") {
    const code = dataset.processingErrorCode
      ?? dataset.qualityResults.errors[0]?.code
      ?? "processing_failed";
    panel.append(
      text("h4", "Processing needs attention"),
      text("p", PROCESSING_MESSAGES[code] ?? "Processing could not complete. Retry with a corrected source or give this error code to an administrator."),
      text("p", `Error code: ${code}`, "project-dataset-error-code")
    );
    return panel;
  }

  if (state === "queued" || state === "running") {
    panel.append(text(
      "p",
      state === "queued" ? "Waiting for an isolated GIS worker." : "An isolated GIS worker is inspecting and converting this version."
    ));
    const update = text("button", "Refresh processing status", "platform-button project-dataset-refresh");
    update.type = "button";
    update.addEventListener("click", async () => {
      update.disabled = true;
      update.textContent = "Refreshing…";
      await refresh();
    });
    panel.append(update);
    return panel;
  }

  if (state === "completed") {
    const passed = dataset.qualityResults.checks.filter((finding) => finding.status === "passed").length;
    panel.append(text("p", `${passed} quality check${passed === 1 ? "" : "s"} passed.`));
    for (const warning of dataset.qualityResults.warnings) {
      panel.append(text("p", `Warning: ${humanizeCode(warning.code)}`, "project-dataset-warning"));
    }
    return panel;
  }

  panel.hidden = true;
  return panel;
}

function humanizeCode(code) {
  return code.replaceAll("_", " ").replaceAll(".", " ").replaceAll("-", " ");
}

function repositorySize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (const candidate of units.slice(1)) {
    if (value < 1024) break;
    value /= 1024;
    unit = candidate;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${unit}`;
}

function uploadForm(state, refresh, section) {
  const form = document.createElement("form");
  form.className = "upload-panel project-upload-form";
  form.noValidate = true;
  const introduction = document.createElement("div");
  introduction.append(
    text("h3", "Register a dataset, image, or PDF"),
    text(
      "p",
      "Choose normal inspection or preserve a GeoJSON original for a separate PMTiles conversion. The browser hashes the file and uploads it to encrypted managed storage.",
      "note"
    )
  );

  const name = input("text", "Dataset, image, or document name");
  name.maxLength = 200;
  name.required = true;
  const description = document.createElement("textarea");
  description.ariaLabel = "Dataset description";
  description.maxLength = 10_000;
  description.rows = 2;
  const classification = select("Dataset classification", ["internal", "restricted", "confidential", "public"]);
  const format = select(
    "Dataset, image, or document format",
    Object.entries(MANAGED_FORMATS).map(([value, definition]) => [value, definition.label])
  );
  const purpose = select("Upload purpose", [["ingest", "Import and inspect"], ["pmtiles_original", "Preserve GeoJSON for PMTiles"]]);
  const purposeNote = text("p", "Import and inspect queues validation and spatial preparation.", "note");
  const tags = input("text", "Dataset tags");
  tags.placeholder = "transport, planning";
  const file = input("file", "Dataset, image, or document file");
  file.required = true;
  file.accept = MANAGED_FILE_ACCEPT;
  file.addEventListener("change", () => {
    const selectedFile = file.files?.[0];
    if (!selectedFile) return;
    const inferred = inferManagedFormat(selectedFile.name);
    if (inferred && purpose.value === "ingest") format.value = inferred;
    if (!name.value.trim()) name.value = selectedFile.name.replace(/\.[^.]+$/, "");
  });
  purpose.addEventListener("change", () => {
    const preserve = purpose.value === "pmtiles_original";
    if (preserve) format.value = "geojson";
    else {const inferred = inferManagedFormat(file.files?.[0]?.name); if (inferred) format.value = inferred;}
    format.disabled = preserve;
    file.accept = preserve ? MANAGED_FORMATS.geojson.extensions.join(",") : MANAGED_FILE_ACCEPT;
    purposeNote.textContent = preserve ? "GeoJSON up to 512 MiB. Preserve the original, then create PMTiles separately." : "Import and inspect queues validation and spatial preparation.";
  });

  const fields = document.createElement("div");
  fields.className = "project-upload-fields";
  fields.append(
    field("Dataset, image, or document name", name),
    field("Description", description),
    field("Classification", classification),
    field("Upload purpose", purpose),
    purposeNote,
    field("Format", format),
    field("Tags (comma-separated)", tags),
    field("Source file", file)
  );

  const feedback = text("p", "Ready for a source file.", "project-upload-feedback");
  feedback.ariaLive = "polite";
  feedback.dataset.state = "idle";
  const submit = text("button", "Hash and upload", "platform-button");
  submit.type = "submit";
  form.append(introduction, fields, feedback, submit);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const source = file.files?.[0];
    try {
      const completion = await ingestManagedFile({
        adapter: state.adapter,
        projectId: state.project.id,
        file: source,
        name: name.value.trim(),
        description: description.value.trim() || null,
        classification: classification.value,
        format: format.value,
        purpose: purpose.value,
        tags: tags.value,
        onStage: setStage
      });
      if (completion.purpose === "pmtiles_original") setStage("preserved", `${completion.dataset.name} is preserved as version ${completion.versionNumber}. Create PMTiles to make a map display.`);
      else setStage("queued", `${completion.dataset.name} is queued as version ${completion.versionNumber}.`);
      await refresh();
    } catch (error) {
      setStage("error", MANAGED_UPLOAD_ERROR_MESSAGES[error?.code] ?? "The dataset could not be uploaded. Check the file and try again.");
    }
  });
  return form;

  function setStage(stage, message) {
    section.dataset.state = stage;
    feedback.dataset.state = stage;
    feedback.textContent = message;
    submit.disabled = !["idle", "error", "queued", "preserved"].includes(stage);
  }
}

export {sha256Hex};

function canUpload(state) {
  return state.organization.callerRole === "admin" || ["owner", "editor"].includes(state.project.callerRole);
}

function featureEditingAllowed(dataset, externalSource) {
  return !externalSource
    && dataset.currentVersionState !== "preserved"
    && dataset.sourceType !== "repository"
    && dataset.capabilities.edit
    && ["draft", "active"].includes(dataset.status)
    && EDITABLE_VECTOR_FORMATS.has(dataset.format);
}

function spatialPreviewAllowed(state, dataset, externalSource) {
  return !externalSource
    && dataset.sourceType !== "repository"
    && dataset.capabilities.read
    && dataset.status === "active"
    && dataset.currentVersionState === "active"
    && typeof dataset.currentVersionId === "string"
    && Array.isArray(dataset.extent)
    && typeof dataset.geometryType === "string"
    && !["document", "image", "raster"].includes(dataset.geometryType)
    && SPATIAL_PREVIEW_FORMATS.has(dataset.format)
    && typeof state.adapter.getDatasetSpatialPreview === "function";
}

// Metadata admission only. The exact original and its private range transport
// are checked when the user deliberately adds this version in the map editor.
function managedCogMapAllowed(state, dataset, externalSource) {
  return !externalSource
    && dataset.sourceType === "upload"
    && dataset.capabilities.read === true
    && dataset.capabilities.download === true
    && dataset.status === "active"
    && dataset.currentVersionState === "active"
    && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(dataset.currentVersionId ?? "")
    && dataset.format === "cog"
    && String(dataset.geometryType).toLowerCase() === "raster"
    && Array.isArray(dataset.extent) && dataset.extent.length === 4
    && dataset.extent.every(Number.isFinite)
    && dataset.extent[0] < dataset.extent[2] && dataset.extent[1] < dataset.extent[3]
    && typeof state.adapter.listDatasetVersions === "function"
    && typeof state.adapter.requestDatasetDownload === "function";
}

function fieldCaptureAllowed(dataset, externalSource) {
  return !externalSource
    && dataset.currentVersionState !== "preserved"
    && dataset.sourceType !== "repository"
    && dataset.capabilities.read
    && ["draft", "active"].includes(dataset.status)
    && EDITABLE_VECTOR_FORMATS.has(dataset.format);
}

function canEditDataset(state, dataset) {
  return dataset.capabilities.edit
    || state.organization.callerRole === "admin"
    || ["owner", "editor"].includes(state.project.callerRole);
}

function canReviewCapture(state, dataset) {
  return dataset.capabilities.edit
    || state.organization.callerRole === "admin"
    || ["owner", "editor", "reviewer"].includes(state.project.callerRole);
}

function statusLegend() {
  const legend = document.createElement("p");
  legend.className = "project-datasets-legend";
  legend.textContent = "draft → processing → active";
  return legend;
}

function fact(label, value) {
  const fragment = document.createDocumentFragment();
  fragment.append(text("dt", label), text("dd", String(value)));
  return fragment;
}

function field(label, control) {
  const wrapper = document.createElement("label");
  wrapper.append(text("span", label), control);
  return wrapper;
}

function input(type, ariaLabel) {
  const control = document.createElement("input");
  control.type = type;
  control.ariaLabel = ariaLabel;
  return control;
}

function textarea(ariaLabel, value = "") {
  const control = document.createElement("textarea");
  control.ariaLabel = ariaLabel;
  control.value = value;
  return control;
}

function select(ariaLabel, values) {
  const control = document.createElement("select");
  control.ariaLabel = ariaLabel;
  for (const entry of values) {
    const [value, label] = Array.isArray(entry) ? entry : [entry, entry];
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    control.append(option);
  }
  return control;
}

function badge(value) {
  return text("span", value, `badge ${String(value).toLowerCase().replaceAll(" ", "-")}`);
}

function cssEscape(value) {
  if (globalThis.CSS?.escape) return globalThis.CSS.escape(String(value));
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

function text(tag, value, className = "") {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  return element;
}

function codedError(code) {
  return Object.assign(new Error(code), {code});
}

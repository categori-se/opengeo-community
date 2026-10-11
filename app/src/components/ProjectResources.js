import {ProjectArtifactVersions} from "./ProjectArtifactVersions.js";
import {MarkdownSourceEditor} from "./MarkdownSourceEditor.js";
import {ResourceStyleVersionEditor} from "./ResourceStyleVersionEditor.js";
import {ResourceMetadataExchange} from "./ResourceMetadataExchange.js";
import {ResourceCoverageEditor} from "./ResourceCoverageEditor.js";
import {projectHref} from "../lib/applicationRoutes.js";

const KINDS = ["dataset", "map", "document", "story", "dashboard", "service"];
const VISIBILITIES = ["restricted", "organization", "public"];
const STATES = ["draft", "review", "published", "archived"];
const PAGE_KINDS = new Set(["document", "story", "dashboard"]);

export function ProjectResources({state}) {
  const section = document.createElement("section");
  section.className = "project-resources";
  section.dataset.state = "ready";

  const heading = document.createElement("header");
  heading.className = "project-resources-heading";
  const identity = document.createElement("div");
  const count = text("p", resourceCount(state.resources), "platform-subtitle");
  identity.append(
    text("p", "Governed publishing", "platform-eyebrow"),
    text("h2", "Project resources"),
    count
  );
  heading.append(
    identity,
    text("p", "Standalone catalog · GeoNode 5.1 migration boundary", "project-resources-boundary")
  );

  const detail = resourceDetailShell();
  const catalog = resourceCatalog(state, state.resources ?? [], detail);
  section.append(
    heading,
    nativeResourceCreator(state, catalog, count, detail),
    recordCatalogPanel(state),
    metadataProfileManager(state),
    metadataImportPanel(state, catalog, count, detail),
    resourceFilters(state, catalog, count, detail),
    catalog,
    detail
  );
  return section;
}

function nativeResourceCreator(state, catalog, count, detail) {
  const allowed = state.organization.callerRole === "admin"
    || ["owner", "editor"].includes(state.project.callerRole);
  if (!allowed || typeof state.adapter.createResource !== "function") {
    return document.createDocumentFragment();
  }

  const panel = document.createElement("details");
  panel.className = "project-resource-native-create";
  const summary = document.createElement("summary");
  summary.append(
    text("strong", "New governed resource"),
    text("span", "Map, page, dashboard, or service")
  );
  const form = document.createElement("form");
  form.className = "project-resource-native-form";
  const kind = labeledSelect(
    "Resource type",
    ["document", "story", "dashboard", "map", "service"],
    "document"
  );
  const title = labeledInput("Resource title", `${state.project.name} overview`, 300);
  title.control.required = true;
  const slug = labeledInput("Persistent URL name", resourceSlug(title.control.value), 160);
  slug.control.required = true;
  slug.control.pattern = "[a-z0-9](?:[a-z0-9-]{0,158}[a-z0-9])?";
  const abstract = labeledTextarea(
    "Resource abstract",
    state.project.description ?? "",
    8_000
  );
  const license = labeledInput("License", "", 1_000);
  license.control.placeholder = "For example, CC-BY-4.0";
  license.control.required = true;
  const attribution = labeledInput("Attribution", "", 2_000);
  attribution.control.placeholder = "Required before publication";
  attribution.control.required = true;
  const visibility = labeledSelect(
    "Initial visibility",
    ["restricted", "organization"],
    "restricted"
  );
  const binding = document.createElement("select");
  binding.ariaLabel = "Bound project object";
  const bindingLabel = labeled("Project map or dataset", binding);
  const submit = text("button", "Create draft resource", "platform-button");
  submit.type = "submit";
  const feedback = text(
    "p",
    "Creates one private draft and opens its existing metadata, style, access, and publishing editor.",
    "project-resource-feedback"
  );
  feedback.ariaLive = "polite";
  let titleEdited = false;
  let slugEdited = false;

  function defaultsForKind() {
    const selectedKind = kind.control.value;
    const map = (state.maps ?? [])[0] ?? null;
    const dataset = (state.datasets ?? [])[0] ?? null;
    return {
      document: `${state.project.name} overview`,
      story: `${state.project.name} story`,
      dashboard: `${state.project.name} dashboard`,
      map: map?.name ?? `${state.project.name} map`,
      service: dataset ? `${dataset.name} service` : `${state.project.name} service`
    }[selectedKind];
  }

  function updateBinding() {
    const selectedKind = kind.control.value;
    const needsMap = selectedKind === "map";
    const needsDataset = selectedKind === "service";
    bindingLabel.hidden = !needsMap && !needsDataset;
    binding.replaceChildren();
    const records = needsMap ? state.maps ?? [] : needsDataset ? state.datasets ?? [] : [];
    for (const record of records) {
      const option = document.createElement("option");
      option.value = record.id;
      option.textContent = `${record.name} · ${needsMap ? `map v${record.version}` : record.format}`;
      binding.append(option);
    }
    binding.required = needsMap || needsDataset;
    const missing = (needsMap || needsDataset) && !records.length;
    submit.disabled = missing;
    if (missing) {
      feedback.textContent = needsMap
        ? "Create and save a project map in Maps before registering its governed publication identity."
        : "Attach a project dataset in Data before registering a service identity.";
    } else {
      feedback.textContent = "Creates one private draft and opens its existing metadata, style, access, and publishing editor.";
    }
  }

  kind.control.addEventListener("change", () => {
    if (!titleEdited) title.control.value = defaultsForKind();
    if (!slugEdited) slug.control.value = availableNativeResourceSlug(
      title.control.value,
      state.resources ?? []
    );
    updateBinding();
  });
  title.control.addEventListener("input", () => {
    titleEdited = true;
    if (!slugEdited) slug.control.value = availableNativeResourceSlug(
      title.control.value,
      state.resources ?? []
    );
  });
  slug.control.addEventListener("input", () => { slugEdited = true; });
  slug.control.addEventListener("blur", () => {
    slug.control.value = resourceSlug(slug.control.value);
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const selectedKind = kind.control.value;
    const mapId = selectedKind === "map" ? binding.value : null;
    const datasetId = selectedKind === "service" ? binding.value : null;
    const boundMap = mapId
      ? (state.maps ?? []).find((candidate) => candidate.id === mapId) ?? null
      : null;
    const existing = selectedKind === "map"
      ? (state.resources ?? []).find(
          (resource) => resource.kind === "map" && resource.mapId === mapId
        )
      : null;
    if (existing) {
      feedback.textContent = `This map is already governed as ${existing.slug}; opening that record.`;
      await openResourceDetail(state, existing.id, detail);
      panel.open = false;
      return;
    }
    submit.disabled = true;
    feedback.textContent = "Creating the governed draft and its immutable first version…";
    try {
      const resourceTitle = title.control.value.trim();
      const created = await state.adapter.createResource(state.project.id, {
        kind: selectedKind,
        slug: slug.control.value.trim().toLowerCase(),
        datasetId,
        mapId,
        ...(boundMap ? {expectedMapVersion: boundMap.version} : {}),
        visibility: visibility.control.value,
        metadata: {
          title: resourceTitle,
          abstract: abstract.control.value.trim() || null,
          language: "en",
          license: license.control.value.trim(),
          attribution: attribution.control.value.trim(),
          keywords: [selectedKind],
          spatialExtent: null,
          profile: "opengeo.core.v1",
          extensions: {},
          translations: {}
        },
        content: PAGE_KINDS.has(selectedKind)
          ? {blocks: [{id: "introduction", type: "markdown", markdown: `# ${resourceTitle}`}]}
          : {blocks: []},
        provenance: {
          source: "studio_native_resource",
          projectId: state.project.id,
          ...(mapId ? {mapId} : {}),
          ...(boundMap ? {mapVersion: boundMap.version} : {}),
          ...(datasetId ? {datasetId} : {})
        }
      });
      const records = await refreshedResources(state, created);
      catalog.replaceChildren(...resourceCatalog(state, records, detail).childNodes);
      count.textContent = resourceCount(records);
      feedback.textContent = `Created ${created.title} as a private draft.`;
      await openResourceDetail(state, created.id, detail);
      panel.open = false;
    } catch (error) {
      if (
        selectedKind === "map"
        && ["resource_conflict", "http_409"].includes(error?.code)
      ) {
        const records = await refreshedResources(state, null);
        const winner = records.find(
          (resource) => resource.kind === "map" && resource.mapId === mapId
        );
        if (winner) {
          catalog.replaceChildren(...resourceCatalog(state, records, detail).childNodes);
          count.textContent = resourceCount(records);
          feedback.textContent = `Another request registered this map as ${winner.slug}; opening that record.`;
          await openResourceDetail(state, winner.id, detail);
          panel.open = false;
          return;
        }
      }
      feedback.textContent = `The resource was not created (${error?.code ?? error?.message ?? "invalid_resource"}).`;
      submit.disabled = false;
    }
  });

  form.append(
    kind.label,
    title.label,
    slug.label,
    abstract.label,
    license.label,
    attribution.label,
    visibility.label,
    bindingLabel,
    submit,
    feedback
  );
  panel.append(summary, form);
  updateBinding();
  return panel;
}

async function refreshedResources(state, created) {
  try {
    if (typeof state.adapter.listResources === "function") {
      state.resources = await state.adapter.listResources(state.project.id, {limit: 100});
      return state.resources;
    }
  } catch {
    // Creation has already committed. Retain a truthful local catalog rather
    // than reporting that the mutation failed because its follow-up read did.
  }
  const records = [...(state.resources ?? [])];
  if (created && !records.some(({id}) => id === created.id)) records.push(created);
  state.resources = records;
  return records;
}

function availableNativeResourceSlug(value, resources) {
  const base = resourceSlug(value);
  const used = new Set(resources.map(({slug}) => slug));
  if (!used.has(base)) return base;
  for (let suffix = 2; suffix <= 999; suffix += 1) {
    const candidate = `${base.slice(0, 155 - String(suffix).length).replace(/-+$/g, "")}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base.slice(0, 150)}-${crypto.randomUUID().slice(0, 8)}`;
}

function resourceSlug(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160)
    .replace(/-+$/g, "") || "project-resource";
}

function recordCatalogPanel(state) {
  const panel = editorPanel(
    "OGC API Records catalog",
    "Project scoped · authenticated · GeoJSON · language negotiated"
  );
  const query = labeledInput("Record text query", "", 1_000);
  const language = labeledInput("Record language", "en", 40);
  const search = text("button", "Search interoperable records", "platform-button secondary");
  search.type = "button";
  search.disabled = typeof state.adapter.listProjectRecords !== "function";
  const result = document.createElement("div");
  result.className = "project-render-result";
  result.append(text(
    "p",
    "Searches use the OGC Records q and language parameters; each response contains one language and advertises alternates.",
    "project-resource-feedback"
  ));
  search.addEventListener("click", async () => {
    search.disabled = true;
    try {
      const collection = await state.adapter.listProjectRecords(state.project.id, {
        query: query.control.value.trim() || null,
        language: language.control.value.trim() || null,
        limit: 20
      });
      const list = document.createElement("ul");
      for (const record of collection.features) {
        list.append(text(
          "li",
          `${record.properties.title} · ${record.properties.language.code} · ${record.properties.type} · ${record.id}`
        ));
      }
      if (!collection.features.length) list.append(text("li", "No matching records."));
      result.replaceChildren(
        text(
          "p",
          `${collection.numberReturned} returned · ${collection.numberMatched} matched`,
          "project-resource-feedback"
        ),
        list
      );
    } catch (error) {
      result.replaceChildren(text(
        "p",
        `Record search failed safely (${error?.code ?? "invalid_record_query"}).`,
        "project-resource-feedback"
      ));
    } finally {
      search.disabled = false;
    }
  });
  panel.append(query.label, language.label, search, result);
  return panel;
}

function metadataImportPanel(state, catalog, count, detail) {
  const panel = editorPanel(
    "Import standards metadata",
    "DCAT 3 · STAC 1.1 · ISO 19115-3 · schema.org 30 · DataCite 4.7 · GeoDCAT-AP 3.1"
  );
  const allowed = state.organization.callerRole === "admin"
    || ["owner", "editor"].includes(state.project.callerRole);
  if (!allowed || typeof state.adapter.importResourceMetadata !== "function") {
    panel.append(text(
      "p",
      "A project owner or editor can create a review-state resource from checksum-pinned standards metadata.",
      "project-resource-feedback"
    ));
    return panel;
  }
  const format = labeledSelect("Metadata source format", [
    "stac_1_1",
    "dcat_3",
    "iso_19115_3",
    "schema_org_dataset",
    "datacite_4_7",
    "geodcat_ap_3_1"
  ], "stac_1_1");
  const namespace = labeledInput("Source namespace", "external.catalog", 100);
  const slug = labeledInput("New resource slug", "imported-metadata-resource", 160);
  const visibility = labeledSelect(
    "Imported resource visibility",
    ["restricted", "organization"],
    "restricted"
  );
  const managedProfile = document.createElement("select");
  managedProfile.ariaLabel = "Imported resource metadata profile";
  const core = document.createElement("option");
  core.value = "";
  core.textContent = "OpenGeo Studio core profile";
  managedProfile.append(core);
  for (const profile of state.metadataProfiles ?? []) {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = `${profile.title} · v${profile.versionNumber}`;
    managedProfile.append(option);
  }
  const source = labeledTextarea(
    "Canonical JSON or exact ISO XML source document",
    JSON.stringify(defaultStacImportDocument(), null, 2),
    49_152
  );
  const submit = text("button", "Import metadata resource", "platform-button");
  submit.type = "button";
  const result = document.createElement("div");
  result.className = "project-resource-feedback";
  result.textContent = "The browser hashes canonical JSON locally; the API rechecks it before one atomic resource/source commit.";
  format.control.addEventListener("change", () => {
    const template = defaultMetadataImportDocument(format.control.value);
    source.control.value = typeof template === "string"
      ? template
      : JSON.stringify(template, null, 2);
  });
  submit.addEventListener("click", async () => {
    submit.disabled = true;
    result.textContent = "Canonicalizing, hashing, validating, and importing metadata…";
    try {
      const documentValue = format.control.value === "iso_19115_3"
        ? source.control.value
        : JSON.parse(source.control.value);
      const selectedProfile = (state.metadataProfiles ?? []).find(
        (candidate) => candidate.id === managedProfile.value
      );
      const imported = await state.adapter.importResourceMetadata(
        state.project.id,
        format.control.value,
        {
          sourceNamespace: namespace.control.value.trim().toLowerCase(),
          slug: slug.control.value.trim().toLowerCase(),
          visibility: visibility.control.value,
          document: documentValue,
          sourceSha256: await metadataSourceSha256(documentValue),
          managedProfileId: selectedProfile?.id ?? null,
          managedProfileVersion: selectedProfile?.versionNumber ?? null
        }
      );
      state.resources = await state.adapter.listResources(state.project.id, {limit: 100});
      const replacement = resourceCatalog(state, state.resources, detail);
      catalog.replaceChildren(...replacement.childNodes);
      count.textContent = resourceCount(state.resources);
      result.replaceChildren(
        text(
          "span",
          `${imported.idempotent ? "Existing import reused" : "Imported"} · ${imported.source.sourceFormat} · ${imported.source.sourceIdentifier} · ${imported.source.checksumBasis} SHA-256 ${imported.source.sourceSha256}`
        ),
        text(
          "pre",
          JSON.stringify(imported.source.conversionReport, null, 2),
          "project-resource-metadata-export"
        )
      );
    } catch (error) {
      result.textContent = `Metadata import failed safely (${error?.code ?? "invalid_source_document"}).`;
    } finally {
      submit.disabled = false;
    }
  });
  panel.append(
    format.label,
    namespace.label,
    slug.label,
    visibility.label,
    labeled("Metadata profile", managedProfile),
    source.label,
    submit,
    result
  );
  return panel;
}

function defaultStacImportDocument() {
  return {
    type: "Collection",
    stac_version: "1.1.0",
    stac_extensions: [],
    id: "research-dataset",
    title: "Research dataset",
    description: "Describe this spatial dataset.",
    license: "CC-BY-4.0",
    keywords: ["research"],
    extent: {
      spatial: {bbox: [[-180, -90, 180, 90]]},
      temporal: {interval: [[null, null]]}
    },
    links: []
  };
}

function defaultDcatImportDocument() {
  return {
    "@context": {
      dcat: "http://www.w3.org/ns/dcat#",
      dct: "http://purl.org/dc/terms/",
      locn: "http://www.w3.org/ns/locn#"
    },
    "@id": "https://catalog.example.org/datasets/research-dataset",
    "@type": "dcat:Dataset",
    "dct:identifier": "research-dataset",
    "dct:title": {"@value": "Research dataset", "@language": "en"},
    "dct:language": "en",
    "dct:description": "Describe this spatial dataset.",
    "dct:license": "CC-BY-4.0",
    "dcat:keyword": ["research"]
  };
}

function defaultMetadataImportDocument(format) {
  if (format === "dcat_3") return defaultDcatImportDocument();
  if (format === "schema_org_dataset") return defaultSchemaOrgImportDocument();
  if (format === "datacite_4_7") return defaultDataCiteImportDocument();
  if (format === "geodcat_ap_3_1") return defaultGeoDcatImportDocument();
  if (format === "iso_19115_3") return defaultIsoImportDocument();
  return defaultStacImportDocument();
}

function defaultSchemaOrgImportDocument() {
  return {
    "@context": "https://schema.org/",
    "@type": "Dataset",
    identifier: "research-dataset",
    name: {"@value": "Research dataset", "@language": "en"},
    description: "Describe this spatial dataset.",
    inLanguage: "en",
    license: "CC-BY-4.0",
    keywords: ["research"]
  };
}

function defaultDataCiteImportDocument() {
  return {
    data: {
      id: "10.0000/example.dataset",
      type: "dois",
      attributes: {
        doi: "10.0000/example.dataset",
        schemaVersion: "http://datacite.org/schema/kernel-4",
        titles: [{title: "Research dataset", lang: "en"}],
        creators: [{name: "Research team", nameType: "Organizational"}],
        publisher: {name: "Research publisher"},
        publicationYear: new Date().getUTCFullYear(),
        types: {resourceTypeGeneral: "Dataset"},
        language: "en",
        subjects: [{subject: "research"}]
      }
    }
  };
}

function defaultGeoDcatImportDocument() {
  return {
    ...defaultDcatImportDocument(),
    "@context": {
      ...defaultDcatImportDocument()["@context"],
      geodcatap: "http://data.europa.eu/930/"
    },
    "geodcatap:resourceType": (
      "http://inspire.ec.europa.eu/metadata-codelist/ResourceType/dataset"
    )
  };
}

function defaultIsoImportDocument() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<mdb:MD_Metadata xmlns:mdb="http://standards.iso.org/iso/19115/-3/mdb/2.0" xmlns:mcc="http://standards.iso.org/iso/19115/-3/mcc/1.0" xmlns:mri="http://standards.iso.org/iso/19115/-3/mri/1.0" xmlns:cit="http://standards.iso.org/iso/19115/-3/cit/2.0" xmlns:lan="http://standards.iso.org/iso/19115/-3/lan/1.0" xmlns:gco="http://standards.iso.org/iso/19115/-3/gco/1.0">
  <mdb:metadataIdentifier><mcc:MD_Identifier><mcc:code><gco:CharacterString>research-dataset</gco:CharacterString></mcc:code></mcc:MD_Identifier></mdb:metadataIdentifier>
  <mdb:defaultLocale><lan:PT_Locale><lan:language><lan:LanguageCode codeList="https://schemas.isotc211.org/19115/resources/Codelist/lan/LanguageCode.xml" codeListValue="en">en</lan:LanguageCode></lan:language><lan:characterEncoding><lan:MD_CharacterSetCode codeList="https://schemas.isotc211.org/resources/codelists/codelists.xml#MD_CharacterSetCode" codeListValue="utf8">utf8</lan:MD_CharacterSetCode></lan:characterEncoding></lan:PT_Locale></mdb:defaultLocale>
  <mdb:contact><cit:CI_Responsibility><cit:role><cit:CI_RoleCode codeList="https://schemas.isotc211.org/resources/codelists/codelists.xml#CI_RoleCode" codeListValue="pointOfContact">pointOfContact</cit:CI_RoleCode></cit:role><cit:party><cit:CI_Organisation><cit:name><gco:CharacterString>Research team</gco:CharacterString></cit:name></cit:CI_Organisation></cit:party></cit:CI_Responsibility></mdb:contact>
  <mdb:dateInfo><cit:CI_Date><cit:date><gco:DateTime>2026-08-20T00:00:00Z</gco:DateTime></cit:date><cit:dateType><cit:CI_DateTypeCode codeList="https://schemas.isotc211.org/resources/codelists/codelists.xml#CI_DateTypeCode" codeListValue="creation">creation</cit:CI_DateTypeCode></cit:dateType></cit:CI_Date></mdb:dateInfo>
  <mdb:identificationInfo><mri:MD_DataIdentification><mri:citation><cit:CI_Citation><cit:title><gco:CharacterString>Research dataset</gco:CharacterString></cit:title></cit:CI_Citation></mri:citation><mri:abstract><gco:CharacterString>Describe this spatial dataset.</gco:CharacterString></mri:abstract></mri:MD_DataIdentification></mdb:identificationInfo>
</mdb:MD_Metadata>`;
}

export async function metadataSourceSha256(documentValue) {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto is required for metadata imports");
  const bytes = new TextEncoder().encode(
    typeof documentValue === "string" ? documentValue : metadataCanonicalJson(documentValue)
  );
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function metadataCanonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return canonicalDecimal(value);
  if (Array.isArray(value)) return `[${value.map(metadataCanonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort(compareUnicodeCodePoints)
      .map((key) => `${JSON.stringify(key)}:${metadataCanonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("metadata source must contain only JSON values");
}

function canonicalDecimal(value) {
  if (!Number.isFinite(value)) throw new TypeError("metadata source numbers must be finite");
  if (Object.is(value, -0) || value === 0) return "0";
  const rendered = String(value).toLowerCase();
  if (!rendered.includes("e")) return rendered;
  const [coefficient, exponentValue] = rendered.split("e");
  const negative = coefficient.startsWith("-");
  const unsigned = negative ? coefficient.slice(1) : coefficient;
  const decimalIndex = unsigned.indexOf(".");
  const digits = unsigned.replace(".", "");
  const originalPoint = decimalIndex === -1 ? digits.length : decimalIndex;
  const point = originalPoint + Number.parseInt(exponentValue, 10);
  const expanded = point <= 0
    ? `0.${"0".repeat(-point)}${digits}`
    : point >= digits.length
      ? `${digits}${"0".repeat(point - digits.length)}`
      : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return negative ? `-${expanded}` : expanded;
}

function compareUnicodeCodePoints(left, right) {
  const leftPoints = [...left].map((character) => character.codePointAt(0));
  const rightPoints = [...right].map((character) => character.codePointAt(0));
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index];
  }
  return leftPoints.length - rightPoints.length;
}

function metadataProfileManager(state) {
  const panel = editorPanel("Metadata profiles", "Organization governed · immutable revisions");
  const profiles = state.metadataProfiles ?? [];
  const list = document.createElement("ul");
  for (const profile of profiles) {
    list.append(text(
      "li",
      `${profile.title} · ${profile.slug} · v${profile.versionNumber} · ${profile.checksumSha256.slice(0, 12)}`
    ));
  }
  if (!profiles.length) list.append(text("li", "No managed metadata profile has been registered."));
  panel.append(
    text(
      "p",
      "Profiles govern required fields, controlled vocabularies, and namespaced extensions while preserving unregistered extension data with warnings.",
      "project-resource-feedback"
    ),
    list
  );
  if (
    state.organization.callerRole !== "admin"
    || typeof state.adapter.createMetadataProfile !== "function"
  ) return panel;

  const mode = document.createElement("select");
  mode.ariaLabel = "Metadata profile to curate";
  const createOption = document.createElement("option");
  createOption.value = "";
  createOption.textContent = "Create a profile";
  mode.append(createOption);
  for (const profile of profiles) {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = `Revise ${profile.title} · v${profile.versionNumber}`;
    mode.append(option);
  }
  const slug = labeledInput("Profile slug", "research.core", 100);
  const title = labeledInput("Profile title", "Research core", 300);
  const description = labeledTextarea("Description", "", 4_000);
  const definition = labeledTextarea(
    "Profile definition (JSON)",
    JSON.stringify(defaultMetadataDefinition(), null, 2),
    32_768
  );
  const save = text("button", "Create profile", "platform-button");
  save.type = "button";
  const feedback = text(
    "p",
    "Profile changes append an immutable version and never rewrite validation history.",
    "project-resource-feedback"
  );
  mode.addEventListener("change", () => {
    const selected = profiles.find((profile) => profile.id === mode.value);
    slug.control.value = selected?.slug ?? "research.core";
    slug.control.disabled = Boolean(selected);
    title.control.value = selected?.title ?? "Research core";
    description.control.value = selected?.description ?? "";
    definition.control.value = JSON.stringify(
      selected?.definition ?? defaultMetadataDefinition(),
      null,
      2
    );
    save.textContent = selected ? "Save profile revision" : "Create profile";
  });
  save.addEventListener("click", async () => {
    save.disabled = true;
    feedback.textContent = "Validating and saving the bounded profile definition…";
    try {
      const parsed = JSON.parse(definition.control.value);
      const selected = profiles.find((profile) => profile.id === mode.value);
      if (selected) {
        await state.adapter.updateMetadataProfile(selected.id, {
          expectedVersion: selected.versionNumber,
          title: title.control.value.trim(),
          description: description.control.value.trim() || null,
          definition: parsed,
          changeMessage: "Browser profile curation"
        });
      } else {
        await state.adapter.createMetadataProfile({
          slug: slug.control.value.trim(),
          title: title.control.value.trim(),
          description: description.control.value.trim() || null,
          definition: parsed
        });
      }
      state.metadataProfiles = await state.adapter.listMetadataProfiles();
      panel.replaceWith(metadataProfileManager(state));
    } catch (error) {
      feedback.textContent = `Profile save failed safely (${error?.code ?? "invalid_profile_json"}).`;
      save.disabled = false;
    }
  });
  panel.append(
    labeled("Curation action", mode),
    slug.label,
    title.label,
    description.label,
    definition.label,
    save,
    feedback
  );
  return panel;
}

function defaultMetadataDefinition() {
  return {
    schema_version: "1.0.0",
    required_core: ["title", "abstract", "license", "attribution"],
    required_languages: [],
    core_vocabularies: {license: ["CC-BY-4.0", "CC0-1.0"]},
    extension_fields: []
  };
}

function resourceFilters(state, catalog, count, detail) {
  const form = document.createElement("form");
  form.className = "project-resource-filters";
  form.noValidate = true;
  const query = input("search", "Search project resources", "Title, abstract, or keyword");
  query.maxLength = 200;
  const kind = select("Filter resource kind", "All kinds", KINDS);
  const visibility = select("Filter resource visibility", "All visibility", VISIBILITIES);
  const publicationState = select("Filter resource state", "All states", STATES);
  const bounds = input("text", "Resource bounds west,south,east,north", "west,south,east,north");
  bounds.maxLength = 100;
  const temporalStart = input("datetime-local", "Resource time from (UTC)", "");
  const temporalEnd = input("datetime-local", "Resource time through (UTC)", "");
  temporalStart.step = temporalEnd.step = "1";
  const advanced = document.createElement("details");
  advanced.className = "catalog-directory-filters";
  advanced.style.gridColumn = "1 / -1";
  advanced.append(text("summary", "Filter by area or time"),
    labeled("Bounds west,south,east,north", bounds),
    labeled("Time from (UTC)", temporalStart), labeled("Time through (UTC)", temporalEnd),
    text("p", "Optional longitude/latitude rectangle and recorded time interval. West must not exceed east. Times are UTC; blank endpoints stay open.", "project-resource-feedback"));
  const submit = text("button", "Search resources", "platform-button");
  submit.type = "submit";
  const clear = text("button", "Clear", "platform-button secondary");
  clear.type = "reset";
  const feedback = text("p", "Text, spatial, temporal, and faceted API filters remain project scoped.", "project-resource-feedback");
  feedback.ariaLive = "polite";
  form.append(query, kind, visibility, publicationState, submit, clear, advanced, feedback);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    feedback.textContent = "Searching authorized governed resources…";
    try {
      const bbox = bounds.value.trim() ? bounds.value.split(",").map(value => value.trim() ? Number(value) : NaN) : null;
      if (bbox && (bbox.length !== 4 || bbox.some(value => !Number.isFinite(value))
        || bbox[0] < -180 || bbox[2] > 180 || bbox[1] < -90 || bbox[3] > 90
        || bbox[0] > bbox[2] || bbox[1] > bbox[3])) {
        throw Object.assign(new Error(), {code: "resource_bbox_invalid"});
      }
      const from = temporalStart.value ? `${temporalStart.value}Z` : null;
      const through = temporalEnd.value ? `${temporalEnd.value}Z` : null;
      if ((from && !Number.isFinite(Date.parse(from))) || (through && !Number.isFinite(Date.parse(through)))
        || (from && through && Date.parse(from) > Date.parse(through))) {
        throw Object.assign(new Error(), {code: "resource_time_invalid"});
      }
      const records = await state.adapter.listResources(state.project.id, {
        limit: 100,
        query: query.value.trim() || null,
        kind: kind.value || null,
        visibility: visibility.value || null,
        state: publicationState.value || null,
        bbox,
        temporalStart: from,
        temporalEnd: through
      });
      const replacement = resourceCatalog(state, records, detail);
      catalog.replaceChildren(...replacement.childNodes);
      count.textContent = resourceCount(records, "matching");
      feedback.textContent = "Permission-scoped resource filters applied.";
    } catch (error) {
      feedback.textContent = `Resource search failed safely (${error?.code ?? "unexpected_error"}).`;
    } finally {
      submit.disabled = false;
    }
  });
  clear.addEventListener("click", () => location.reload());
  return form;
}

function resourceCatalog(state, resources, detail) {
  const catalog = document.createElement("div");
  catalog.className = "project-resource-catalog";
  if (!resources.length) {
    catalog.append(text("p", "No governed publishing resources match this project scope.", "project-resources-empty"));
    return catalog;
  }
  for (const resource of resources) {
    const card = document.createElement("article");
    card.className = "project-resource-card";
    card.id = `resource-${resource.id}`;
    card.dataset.resourceId = resource.id;
    const badges = document.createElement("div");
    badges.className = "project-resource-badges";
    badges.append(badge(resource.kind), badge(resource.state), badge(resource.visibility));
    const facts = document.createElement("dl");
    facts.append(
      fact("Version", `v${resource.versionNumber}`),
      fact("Origin", resource.originNamespace ? `${resource.originNamespace} · ${resource.originIdentifier}` : "OpenGeo Studio native"),
      fact("Relations", String(resource.relationshipCount)),
      fact("Extent", resource.spatialExtent ? resource.spatialExtent.join(", ") : "Not declared"),
      fact("Time", temporalLabel(resource))
    );
    const open = text("button", "Open resource", "platform-button secondary");
    open.type = "button";
    open.addEventListener("click", () => openResourceDetail(state, resource.id, detail));
    card.append(
      text("h3", resource.title),
      text("p", resource.abstract ?? "No abstract", "project-resource-abstract"),
      badges,
      facts,
      text("p", resource.keywords.length ? resource.keywords.map((keyword) => `#${keyword}`).join(" ") : "No keywords", "project-resource-keywords"),
      open
    );
    catalog.append(card);
  }
  return catalog;
}

function resourceDetailShell() {
  const detail = document.createElement("section");
  detail.className = "project-resource-detail";
  detail.dataset.state = "idle";
  detail.ariaLive = "polite";
  detail.append(
    text("p", "Resource editor", "platform-eyebrow"),
    text("p", "Open a governed resource to inspect metadata, bindings, access, styles, and editorial history.", "project-resource-feedback")
  );
  return detail;
}

function releaseDraftBlocksDetail(detail) {
  return [...detail.querySelectorAll(".artifact-releases")].some(panel => panel.checkDraft?.());
}

async function openResourceDetail(state, resourceId, detail) {
  if (releaseDraftBlocksDetail(detail)) return;
  state.pageDraftCleanup?.();
  state.pageDraftCleanup = null;
  detail.dataset.state = "loading";
  detail.replaceChildren(text("p", "Loading permission-scoped resource detail…", "project-resource-feedback"));
  try {
    const resourceSummary = (state.resources ?? []).find(({id}) => id === resourceId);
    const [resource, capabilities, styles, renderProfiles, workflow, permissions, pageVersions, workingDraft, rating] = await Promise.all([
      state.adapter.getResource(state.project.id, resourceId),
      optionalValue(state.adapter, "getResourceCapabilities", state.project.id, resourceId),
      optionalList(state.adapter, "listResourceStyles", state.project.id, resourceId),
      optionalList(state.adapter, "listRenderProfiles", state.project.id, resourceId),
      optionalList(state.adapter, "listResourceWorkflow", state.project.id, resourceId),
      optionalList(state.adapter, "listResourcePermissions", state.project.id, resourceId),
      optionalList(state.adapter, "listPageVersions", state.project.id, resourceId),
      resourceSummary === undefined || PAGE_KINDS.has(resourceSummary.kind)
        ? optionalValue(state.adapter, "getPageWorkingDraft", state.project.id, resourceId)
        : Promise.resolve(null),
      optionalValue(state.adapter, "getResourceRating", state.project.id, resourceId)
    ]);
    renderResourceDetail(
      state,
      resource,
      {
        capabilities: capabilities ?? inferredResourceCapabilities(state, resource, permissions),
        styles,
        renderProfiles,
        workflow,
        permissions,
        pageVersions,
        workingDraft,
        rating
      },
      detail
    );
    detail.dataset.state = "ready";
    detail.scrollIntoView?.({behavior: "smooth", block: "nearest"});
  } catch (error) {
    detail.dataset.state = "error";
    detail.replaceChildren(
      text("h3", "Resource unavailable"),
      text("p", `The detail request failed safely (${error?.code ?? "unexpected_error"}).`, "project-resource-feedback")
    );
  }
}

async function optionalList(adapter, method, ...parameters) {
  if (typeof adapter[method] !== "function") return [];
  try {
    return await adapter[method](...parameters);
  } catch (error) {
    if (["action_forbidden", "http_403"].includes(error?.code)) return [];
    throw error;
  }
}

async function optionalValue(adapter, method, ...parameters) {
  if (typeof adapter[method] !== "function") return null;
  try {
    return await adapter[method](...parameters);
  } catch (error) {
    if (["action_forbidden", "http_403"].includes(error?.code)) return null;
    throw error;
  }
}

function renderResourceDetail(state, resource, related, detail) {
  const heading = document.createElement("header");
  heading.className = "project-resource-detail-heading";
  const close = text("button", "Close", "platform-button secondary");
  close.type = "button";
  close.addEventListener("click", () => {
    if (releaseDraftBlocksDetail(detail)) return;
    state.pageDraftCleanup?.();
    state.pageDraftCleanup = null;
    detail.dataset.state = "idle";
    detail.replaceChildren(
      text("p", "Resource editor", "platform-eyebrow"),
      text("p", "Open a governed resource to inspect metadata, bindings, access, styles, and editorial history.", "project-resource-feedback")
    );
  });
  const title = document.createElement("div");
  title.append(
    text("p", `${resource.kind} · ${resource.slug}`, "platform-eyebrow"),
    text("h3", resource.title),
    text("p", `Version ${resource.versionNumber} · ${resource.state} · ${resource.visibility}`, "project-resource-feedback")
  );
  heading.append(title, close);
  const metadataPanel = resourceMetadataEditor(state, resource, detail, related.workingDraft, related.capabilities);
  detail.replaceChildren(
    heading,
    resourceRatingEditor(state, resource, related, detail),
    metadataPanel,
    pageSourceHistory(state, resource, related.pageVersions),
    resourceMetadataInteroperability(state, resource),
    resourceBindingEditor(state, resource, detail, related.capabilities, metadataPanel),
    resourceWorkflowEditor(state, resource, related.workflow, related.capabilities, detail),
    resourceStyleEditor(state, resource, related.styles, detail, related.capabilities),
    resourceRenderEditor(state, resource, related.styles, related.renderProfiles, detail),
    ...(resource.kind === "map" ? [ProjectArtifactVersions({
      adapter: state.adapter, projectId: state.project.id, resourceId: resource.id,
      canEdit: related.capabilities?.canUpdate === true
    })] : []),
    resourcePermissionEditor(
      state,
      resource,
      related.permissions,
      related.capabilities,
      detail
    ),
    resourceContentSummary(resource)
  );
}

function resourceRatingEditor(state, resource, related, detail) {
  const rating = related.rating;
  if (!rating || typeof state.adapter.setResourceRating !== "function") {
    return document.createDocumentFragment();
  }
  const panel = editorPanel("Member rating", "Private vote · public aggregate only");
  panel.classList.add("project-resource-rating");
  const aggregate = text(
    "p",
    rating.ratingCount === 0
      ? "No active ratings yet"
      : `${Number(rating.ratingAverage).toFixed(1)} of 5 · ${rating.ratingCount} ${rating.ratingCount === 1 ? "rating" : "ratings"}`,
    "project-resource-rating-summary"
  );
  const privacy = text(
    "small",
    "Your rating is private. Published catalog pages receive only the count and average; voter identities are never returned."
  );
  const form = document.createElement("form");
  form.className = "project-resource-rating-form";
  const score = document.createElement("select");
  score.ariaLabel = "Your rating";
  for (const [value, label] of [
    ["", "No rating"],
    ["5", "5 — Excellent"],
    ["4", "4 — Good"],
    ["3", "3 — Useful"],
    ["2", "2 — Limited"],
    ["1", "1 — Poor"]
  ]) {
    const choice = document.createElement("option");
    choice.value = value;
    choice.textContent = label;
    score.append(choice);
  }
  score.value = rating.callerScore === null ? "" : String(rating.callerScore);
  const save = text("button", rating.callerScore === null ? "Save rating" : "Update rating", "platform-button");
  save.type = "submit";
  const feedback = text(
    "small",
    rating.callerWithdrawn ? "Your prior rating is withdrawn." : "",
    "project-resource-rating-feedback"
  );
  feedback.ariaLive = "polite";
  form.append(score, save);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    score.disabled = true;
    save.disabled = true;
    feedback.textContent = "Saving your private rating…";
    try {
      const receipt = await state.adapter.setResourceRating(
        state.project.id,
        resource.id,
        {
          score: score.value === "" ? null : Number(score.value),
          expectedVersion: rating.callerVersion
        }
      );
      related.rating = receipt.summary;
      renderResourceDetail(state, resource, related, detail);
    } catch (error) {
      feedback.textContent = `Rating was not changed (${error?.code ?? "unexpected_error"}).`;
      score.disabled = false;
      save.disabled = false;
    }
  });
  panel.append(aggregate, privacy, form, feedback);
  return panel;
}

function pageSourceHistory(state, resource, versions = []) {
  if (!PAGE_KINDS.has(resource.kind)) return document.createDocumentFragment();
  const panel = editorPanel(
    "Page source history",
    "Exact UTF-8 .md · immutable S3 version · pinned compiler"
  );
  const feedback = text(
    "p",
    versions.length
      ? `${versions.length} exact source version${versions.length === 1 ? "" : "s"} available.`
      : "No exact source object exists yet. The next Page Studio save creates the first one.",
    "project-resource-feedback"
  );
  feedback.ariaLive = "polite";
  const output = document.createElement("pre");
  output.className = "page-source-history-output";
  output.hidden = true;
  const list = document.createElement("ol");
  list.className = "page-source-history-list";
  for (const version of versions) {
    const item = document.createElement("li");
    const inspect = text("button", `Inspect exact source v${version.resourceVersionNumber}`, "platform-button secondary");
    inspect.type = "button";
    inspect.addEventListener("click", async () => {
      inspect.disabled = true;
      feedback.textContent = `Verifying exact source v${version.resourceVersionNumber}…`;
      try {
        const source = await state.adapter.getPageSource(
          state.project.id,
          resource.id,
          version.resourceVersionNumber
        );
        output.textContent = source.sourceMarkdown;
        output.hidden = false;
        feedback.textContent = `Verified v${source.resourceVersionNumber} · SHA-256 ${source.checksumSha256} · ${source.compilerVersion}`;
      } catch (error) {
        feedback.textContent = `Exact source could not be read safely (${error?.code ?? "unexpected_error"}).`;
      } finally {
        inspect.disabled = false;
      }
    });
    const compare = text("button", "Compare with parent", "platform-button secondary");
    compare.type = "button";
    const parentAvailable = versions.some(
      (candidate) => candidate.resourceVersionNumber === version.parentVersionNumber
    );
    compare.disabled = !parentAvailable;
    compare.addEventListener("click", async () => {
      compare.disabled = true;
      feedback.textContent = `Loading exact v${version.resourceVersionNumber} and parent source…`;
      try {
        const [current, parent] = await Promise.all([
          state.adapter.getPageSource(
            state.project.id,
            resource.id,
            version.resourceVersionNumber
          ),
          state.adapter.getPageSource(
            state.project.id,
            resource.id,
            version.parentVersionNumber
          )
        ]);
        output.textContent = boundedLineDiff(parent.sourceMarkdown, current.sourceMarkdown);
        output.hidden = false;
        feedback.textContent = `Exact source diff · v${parent.resourceVersionNumber} → v${current.resourceVersionNumber}`;
      } catch (error) {
        feedback.textContent = `Exact source diff could not be produced (${error?.code ?? "unexpected_error"}).`;
      } finally {
        compare.disabled = !parentAvailable;
      }
    });
    item.append(
      text(
        "p",
        `v${version.resourceVersionNumber} · ${version.changeSummary} · ${version.sizeBytes} bytes · ${version.checksumSha256.slice(0, 12)}…`,
        "project-resource-feedback"
      ),
      inspect,
      compare
    );
    list.append(item);
  }
  panel.append(feedback, list, output);
  return panel;
}

export function boundedLineDiff(parent, current) {
  const before = String(parent ?? "").split("\n").slice(0, 2_000);
  const after = String(current ?? "").split("\n").slice(0, 2_000);
  const lines = [];
  const maximum = Math.max(before.length, after.length);
  for (let index = 0; index < maximum; index += 1) {
    if (before[index] === after[index]) {
      if (before[index] !== undefined) lines.push(`  ${before[index]}`);
      continue;
    }
    if (before[index] !== undefined) lines.push(`- ${before[index]}`);
    if (after[index] !== undefined) lines.push(`+ ${after[index]}`);
  }
  return lines.join("\n") || "  No line changes";
}

function resourceMetadataEditor(state, resource, detail, workingDraft = null, capabilities = null) {
  const panel = editorPanel("Metadata and rights", "Versioned and extensible");
  panel.classList.add("project-resource-metadata-editor");
  const form = document.createElement("form");
  form.className = "project-resource-editor-grid";
  const canEdit = capabilities?.canUpdate === true && ["draft", "review"].includes(resource.state);
  const recovered = workingDraft?.baseResourceVersion === resource.versionNumber
    ? workingDraft
    : null;
  const draftConflict = workingDraft && recovered === null ? workingDraft : null;
  let recoveryDraft = workingDraft;
  const initialMetadata = recovered?.metadata ?? {
    title: resource.title,
    abstract: resource.abstract,
    language: resource.language,
    license: resource.license,
    attribution: resource.attribution,
    keywords: resource.keywords,
    spatialExtent: resource.spatialExtent,
    temporalStart: resource.temporalStart,
    temporalEnd: resource.temporalEnd,
    profile: resource.metadataProfile,
    extensions: resource.metadataExtensions,
    translations: resource.translations,
    managedProfileId: resource.managedMetadataProfileId,
    managedProfileVersion: resource.managedMetadataProfileVersion
  };
  const initialContent = recovered?.content ?? resource.content ?? {blocks: []};
  const initialProvenance = recovered?.provenance ?? resource.provenance;
  const title = labeledInput("Title", initialMetadata.title, 300);
  const abstract = labeledTextarea("Abstract", initialMetadata.abstract ?? "", 8_000);
  const keywords = labeledInput(
    "Keywords (comma separated)",
    initialMetadata.keywords.join(", "),
    2_000
  );
  const license = labeledInput("License", initialMetadata.license ?? "", 1_000);
  const attribution = labeledInput("Attribution", initialMetadata.attribution ?? "", 2_000);
  const language = labeledInput("Primary language (BCP 47)", initialMetadata.language, 40);
  const coverage = ResourceCoverageEditor(initialMetadata);
  const translations = labeledTextarea(
    "Alternate-language metadata (JSON by BCP 47 tag)",
    JSON.stringify(initialMetadata.translations ?? {}, null, 2),
    16_384
  );
  const extensions = labeledTextarea(
    "Extended catalog metadata (JSON; use the reserved opengeo schema for interoperable fields)",
    JSON.stringify(initialMetadata.extensions ?? {}, null, 2),
    8_192
  );
  const content = labeledTextarea(
    "Mixed content (JSON; Markdown, map, dataset, link, citation, table, chart, image, file, preserved)",
    JSON.stringify(
      pinCurrentResourceReferences(initialContent, state.resources ?? []),
      null,
      2
    ),
    24_576
  );
  const markdownStudio = MarkdownSourceEditor({
    contentControl: content.control,
    resourceSlug: resource.slug,
    validateContent: parseContentDraft,
    initialSourceArtifact: recovered
      ? {sourceBlockId: recovered.sourceBlockId, sourceMarkdown: recovered.sourceMarkdown}
      : null
  });
  const assetPicker = governedAssetPicker(state, content.control);
  const referencePicker = governedResourceReferencePicker(
    state,
    resource,
    content.control
  );
  const structurePicker = governedPageStructurePicker(resource, content.control);
  const structuredPicker = governedStructuredContentPicker(resource, content.control);
  const pinnedPreview = pinnedPagePreview(
    state,
    resource,
    title.control,
    abstract.control,
    content.control
  );
  const advancedContent = document.createElement("details");
  advancedContent.className = "project-resource-advanced-content";
  advancedContent.append(text("summary", "Advanced mixed-content JSON"), content.label);
  const visibility = labeledSelect(
    "Working visibility",
    ["restricted", "organization"],
    (recovered?.visibility ?? resource.visibility) === "public"
      ? "organization"
      : recovered?.visibility ?? resource.visibility
  );
  const changeSummary = labeledInput(
    "Change summary",
    recovered?.changeSummary
      ?? (PAGE_KINDS.has(resource.kind) ? "Update page source" : "Browser metadata edit"),
    500
  );
  changeSummary.control.required = true;
  const managedProfile = document.createElement("select");
  managedProfile.ariaLabel = "Managed metadata profile";
  const unmanaged = document.createElement("option");
  unmanaged.value = "";
  unmanaged.textContent = "Free-form metadata (no managed profile)";
  managedProfile.append(unmanaged);
  for (const profile of state.metadataProfiles ?? []) {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = `${profile.title} · v${profile.versionNumber}`;
    option.selected = profile.id === initialMetadata.managedProfileId;
    managedProfile.append(option);
  }
  if (
    initialMetadata.managedProfileId
    && !(state.metadataProfiles ?? []).some(
      (profile) => profile.id === initialMetadata.managedProfileId
    )
  ) {
    const pinnedProfile = document.createElement("option");
    pinnedProfile.value = initialMetadata.managedProfileId;
    pinnedProfile.textContent = `${initialMetadata.profile ?? "Pinned managed profile"} · v${initialMetadata.managedProfileVersion ?? "?"} (unavailable)`;
    pinnedProfile.selected = true;
    managedProfile.append(pinnedProfile);
  }
  const recovery = document.createElement("section");
  recovery.className = "page-draft-recovery";
  const recoveryStatus = text("p", "", "project-resource-feedback");
  recoveryStatus.ariaLive = "polite";
  const discardRecovery = text("button", "Discard private recovery draft", "platform-button secondary");
  discardRecovery.type = "button";
  discardRecovery.disabled = !workingDraft
    || typeof state.adapter.discardPageWorkingDraft !== "function";
  recovery.append(text("h5", "Private recovery draft"), recoveryStatus, discardRecovery);
  const autosaveAvailable = canEdit && PAGE_KINDS.has(resource.kind)
    && ["draft", "review"].includes(resource.state)
    && typeof state.adapter.savePageWorkingDraft === "function";
  let draftRevision = workingDraft?.revisionNumber ?? 0;
  let draftBaseVersion = workingDraft?.baseResourceVersion ?? resource.versionNumber;
  let autosaveTimer = null;
  let autosaveInFlight = null;
  let autosaveQueued = false;
  let autosaveSuspended = Boolean(draftConflict) || !autosaveAvailable;
  if (draftConflict) {
    recovery.dataset.state = "conflict";
    recoveryStatus.textContent = `Conflict: private revision ${draftConflict.revisionNumber} is based on v${draftConflict.baseResourceVersion}; the governed resource is v${resource.versionNumber}. Discard it or preserve it outside Studio before editing.`;
  } else if (recovered) {
    recovery.dataset.state = "recovered";
    recoveryStatus.textContent = `Recovered private revision ${recovered.revisionNumber} from ${new Date(recovered.updatedAt).toLocaleString()}. Autosave continues against governed v${recovered.baseResourceVersion}.`;
  } else if (autosaveAvailable) {
    recovery.dataset.state = "ready";
    recoveryStatus.textContent = "Recovery autosave is ready. Valid edits are saved privately after a short pause; only Save new version creates governed history.";
  } else {
    recovery.dataset.state = "unavailable";
    recoveryStatus.textContent = "Private recovery autosave is unavailable in this adapter or resource state.";
  }
  const feedback = text("p", canEdit
    ? "Changes append an immutable metadata/content version."
    : "This metadata is read-only for your current access or the resource's publication state.", "project-resource-feedback");
  const save = text("button", "Save new version", "platform-button");
  save.type = "submit";
  save.disabled = !canEdit;
  form.append(
    ...(PAGE_KINDS.has(resource.kind) ? [recovery] : []),
    title.label,
    abstract.label,
    keywords.label,
    license.label,
    attribution.label,
    language.label,
    coverage.element,
    translations.label,
    extensions.label,
    markdownStudio,
    structurePicker,
    referencePicker,
    assetPicker,
    structuredPicker,
    pinnedPreview,
    advancedContent,
    visibility.label,
    changeSummary.label,
    labeled("Managed profile", managedProfile),
    save,
    feedback
  );
  if (!canEdit) {
    for (const control of form.querySelectorAll("input, textarea")) control.readOnly = true;
    for (const control of form.querySelectorAll("select")) control.disabled = true;
    discardRecovery.disabled = true;
  }

  function currentUpdate({focusError = false} = {}) {
    const coverageDraft = coverage.read({focusError});
    const selectedProfile = (state.metadataProfiles ?? []).find(
      (profile) => profile.id === managedProfile.value
    ) ?? (
      managedProfile.value === initialMetadata.managedProfileId
        ? {
          id: initialMetadata.managedProfileId,
          versionNumber: initialMetadata.managedProfileVersion,
          slug: initialMetadata.profile
        }
        : null
    );
    return {
      expectedVersion: resource.versionNumber,
      visibility: visibility.control.value,
      metadata: {
        title: title.control.value.trim(),
        abstract: abstract.control.value.trim() || null,
        language: language.control.value.trim().toLowerCase(),
        license: license.control.value.trim() || null,
        attribution: attribution.control.value.trim() || null,
        keywords: keywords.control.value.split(",").map((item) => item.trim()).filter(Boolean),
        ...coverageDraft,
        profile: selectedProfile?.slug ?? initialMetadata.profile,
        extensions: parseMetadataExtensionsDraft(extensions.control.value),
        translations: parseTranslationDraft(
          translations.control.value,
          language.control.value
        ),
        managedProfileId: selectedProfile?.id ?? null,
        managedProfileVersion: selectedProfile?.versionNumber ?? null
      },
      content: parseContentDraft(content.control.value),
      provenance: initialProvenance,
      changeMessage: changeSummary.control.value.trim() || null
    };
  }

  async function persistRecoveryDraft() {
    autosaveTimer = null;
    if (autosaveSuspended) return;
    if (autosaveInFlight) {
      autosaveQueued = true;
      return;
    }
    let update;
    try {
      update = currentUpdate();
    } catch (error) {
      recovery.dataset.state = "invalid";
      recoveryStatus.textContent = `Recovery is waiting for valid structured fields (${error?.message ?? "invalid draft"}).`;
      return;
    }
    recovery.dataset.state = "saving";
    recoveryStatus.textContent = "Saving a private recovery revision…";
    const request = state.adapter.savePageWorkingDraft(
      state.project.id,
      resource.id,
      {...update, expectedDraftRevision: draftRevision},
      markdownStudio.getRecoveryArtifact()
    );
    autosaveInFlight = request;
    try {
      const saved = await request;
      recoveryDraft = saved;
      draftRevision = saved.revisionNumber;
      draftBaseVersion = saved.baseResourceVersion;
      discardRecovery.disabled = typeof state.adapter.discardPageWorkingDraft !== "function";
      recovery.dataset.state = "saved";
      recoveryStatus.textContent = `Private recovery revision ${saved.revisionNumber} saved at ${new Date(saved.updatedAt).toLocaleTimeString()}. Governed v${resource.versionNumber} is unchanged.`;
    } catch (error) {
      if ([
        "page_draft_revision_conflict",
        "page_draft_base_conflict",
        "resource_version_conflict",
        "page_draft_revision_limit"
      ].includes(error?.code)) {
        autosaveSuspended = true;
        recovery.dataset.state = "conflict";
        recoveryStatus.textContent = `Recovery autosave stopped safely (${error.code}). Reopen the resource to reconcile the latest revision.`;
      } else {
        recovery.dataset.state = "error";
        recoveryStatus.textContent = `Private recovery save failed (${error?.code ?? "unexpected_error"}); the next valid edit will retry.`;
      }
    } finally {
      autosaveInFlight = null;
      if (autosaveQueued && !autosaveSuspended) {
        autosaveQueued = false;
        scheduleRecoverySave();
      }
    }
  }

  function scheduleRecoverySave() {
    if (autosaveSuspended) return;
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => void persistRecoveryDraft(), 1_500);
    recovery.dataset.state = "pending";
    recoveryStatus.textContent = "Valid changes pending private recovery autosave…";
  }

  if (PAGE_KINDS.has(resource.kind)) {
    form.addEventListener("input", scheduleRecoverySave);
    form.addEventListener("change", scheduleRecoverySave);
    form.addEventListener("draftchange", scheduleRecoverySave);
    state.pageDraftCleanup = () => {
      autosaveSuspended = true;
      autosaveQueued = false;
      clearTimeout(autosaveTimer);
    };
  }

  discardRecovery.addEventListener("click", async () => {
    if (!canEdit || !recoveryDraft || typeof state.adapter.discardPageWorkingDraft !== "function") return;
    discardRecovery.disabled = true;
    autosaveSuspended = true;
    clearTimeout(autosaveTimer);
    if (autosaveInFlight) await autosaveInFlight.catch(() => null);
    recovery.dataset.state = "discarding";
    recoveryStatus.textContent = "Discarding the private recovery history…";
    try {
      await state.adapter.discardPageWorkingDraft(state.project.id, resource.id, {
        expectedVersion: draftBaseVersion,
        expectedDraftRevision: draftRevision
      });
      state.pageDraftCleanup?.();
      state.pageDraftCleanup = null;
      await openResourceDetail(state, resource.id, detail);
    } catch (error) {
      autosaveSuspended = Boolean(draftConflict);
      recovery.dataset.state = "error";
      recoveryStatus.textContent = `Private recovery discard failed safely (${error?.code ?? "unexpected_error"}).`;
      discardRecovery.disabled = false;
    }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!canEdit) return;
    if (markdownStudio.dataset.unapplied === "true") {
      feedback.textContent = "Apply the Markdown editor changes to the draft before saving a new version.";
      markdownStudio.scrollIntoView?.({behavior: "smooth", block: "nearest"});
      markdownStudio.querySelector("textarea")?.focus();
      return;
    }
    autosaveSuspended = true;
    autosaveQueued = false;
    clearTimeout(autosaveTimer);
    if (autosaveInFlight) await autosaveInFlight.catch(() => null);
    save.disabled = true;
    feedback.textContent = "Saving governed resource version…";
    try {
      const update = currentUpdate({focusError: true});
      if (!update.changeMessage) throw new TypeError("change summary is required");
      let updated;
      if (PAGE_KINDS.has(resource.kind)) {
        if (typeof state.adapter.savePageVersion !== "function") {
          throw Object.assign(new Error("page source persistence unavailable"), {
            code: "page_source_storage_unavailable"
          });
        }
        feedback.textContent = "Hashing and storing exact UTF-8 Markdown source…";
        const artifact = markdownStudio.getSourceArtifact();
        const committed = await state.adapter.savePageVersion(
          state.project.id,
          resource.id,
          update,
          artifact
        );
        updated = committed.resource;
      } else {
        updated = await state.adapter.updateResource(state.project.id, resource.id, update);
      }
      await openResourceDetail(state, updated.id, detail);
    } catch (error) {
      feedback.textContent = error?.code === "metadata_coverage_invalid"
        ? error.message
        : `Save failed safely (${error?.code ?? "unexpected_error"}).`;
      save.disabled = false;
      autosaveSuspended = Boolean(draftConflict) || !autosaveAvailable;
    }
  });
  panel.append(form);
  return panel;
}

function resourceMetadataInteroperability(state, resource) {
  const panel = editorPanel(
    "Validate and exchange metadata",
    "DCAT · STAC · OGC Records · ISO 19115-3 · schema.org · DataCite · GeoDCAT-AP"
  );
  const profiles = state.metadataProfiles ?? [];
  const profile = document.createElement("select");
  profile.ariaLabel = "Metadata validation profile";
  for (const record of profiles) {
    const option = document.createElement("option");
    option.value = record.id;
    option.textContent = `${record.title} · v${record.versionNumber}`;
    option.selected = record.id === resource.managedMetadataProfileId;
    profile.append(option);
  }
  const result = document.createElement("div");
  result.className = "project-render-result";
  result.append(text(
    "p",
    resource.metadataValidation
      ? `Stored revision validation: ${resource.metadataValidation.status} · ${resource.metadataValidation.errors} errors · ${resource.metadataValidation.warnings} warnings.`
      : "This revision has no managed validation snapshot.",
    "project-resource-feedback"
  ));
  const validate = text("button", "Validate current revision", "platform-button");
  validate.type = "button";
  validate.disabled = !profiles.length || typeof state.adapter.validateResourceMetadata !== "function";
  validate.addEventListener("click", async () => {
    const selected = profiles.find((record) => record.id === profile.value);
    if (!selected) return;
    validate.disabled = true;
    try {
      const validation = await state.adapter.validateResourceMetadata(
        state.project.id,
        resource.id,
        selected.id,
        selected.versionNumber
      );
      result.replaceChildren(text(
        "p",
        `${validation.report.status} · ${validation.report.errors} errors · ${validation.report.warnings} warnings · profile SHA-256 ${validation.profileChecksumSha256}`,
        "project-resource-feedback"
      ));
    } catch (error) {
      result.replaceChildren(text(
        "p",
        `Validation failed safely (${error?.code ?? "unexpected_error"}).`,
        "project-resource-feedback"
      ));
    } finally {
      validate.disabled = false;
    }
  });
  panel.append(labeled("Validation profile", profile), validate,
    ResourceMetadataExchange({adapter: state.adapter, projectId: state.project.id, resource}));
  const inspectSource = text("button", "Show immutable import source", "platform-button secondary");
  inspectSource.type = "button";
  inspectSource.disabled = typeof state.adapter.getResourceMetadataSource !== "function";
  inspectSource.addEventListener("click", async () => {
    inspectSource.disabled = true;
    try {
      const source = await state.adapter.getResourceMetadataSource(state.project.id, resource.id);
      result.replaceChildren(
        text(
          "p",
          `${source.sourceFormat} · ${source.sourceVersion} · ${source.sourceNamespace}/${source.sourceIdentifier} · ${source.checksumBasis} SHA-256 ${source.sourceSha256}`,
          "project-resource-feedback"
        ),
        text(
          "pre",
          typeof source.document === "string"
            ? `${source.document}\n\nConversion report\n${JSON.stringify(
              source.conversionReport,
              null,
              2
            )}`
            : JSON.stringify(
              {document: source.document, conversionReport: source.conversionReport},
              null,
              2
            ),
          "project-resource-metadata-export"
        )
      );
    } catch (error) {
      result.replaceChildren(text(
        "p",
        `No readable import source for this exact revision (${error?.code ?? "unexpected_error"}).`,
        "project-resource-feedback"
      ));
    } finally {
      inspectSource.disabled = false;
    }
  });
  panel.append(inspectSource);
  panel.append(result);
  return panel;
}

export function parseTranslationDraft(source, primaryLanguage) {
  const translations = JSON.parse(source);
  if (!translations || typeof translations !== "object" || Array.isArray(translations)) {
    throw new TypeError("translated metadata must be an object");
  }
  const entries = Object.entries(translations);
  if (entries.length > 8) throw new TypeError("translated metadata has too many languages");
  const primary = normalizeLanguage(primaryLanguage);
  const normalized = {};
  for (const [language, value] of entries) {
    const tag = normalizeLanguage(language);
    if (tag === primary) throw new TypeError("primary language must not be duplicated");
    if (Object.hasOwn(normalized, tag)) throw new TypeError("translation languages must be unique");
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("translated metadata value must be an object");
    }
    if (typeof value.title !== "string" || !value.title.trim() || value.title.length > 300) {
      throw new TypeError("translated metadata title is invalid");
    }
    const keywords = value.keywords ?? [];
    if (!Array.isArray(keywords) || keywords.length > 64 || keywords.some(
      (keyword) => typeof keyword !== "string" || !keyword.trim() || keyword.length > 200
    )) {
      throw new TypeError("translated metadata keywords are invalid");
    }
    normalized[tag] = {
      title: value.title.trim(),
      abstract: optionalTranslatedText(value.abstract, 8_000),
      attribution: optionalTranslatedText(value.attribution, 2_000),
      keywords: keywords.map((keyword) => keyword.trim())
    };
  }
  if (new TextEncoder().encode(JSON.stringify(normalized)).byteLength > 16_384) {
    throw new TypeError("translated metadata is too large");
  }
  return normalized;
}

export function parseMetadataExtensionsDraft(source) {
  const extensions = JSON.parse(source);
  if (!extensions || typeof extensions !== "object" || Array.isArray(extensions)) {
    throw new TypeError("metadata extensions must be an object");
  }
  const namespace = /^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/;
  for (const key of Object.keys(extensions)) {
    if (!namespace.test(key)) throw new TypeError("metadata extension namespace is invalid");
  }
  let nodes = 0;
  const stack = [[extensions, 0]];
  while (stack.length) {
    const [value, depth] = stack.pop();
    nodes += 1;
    if (nodes > 5_000 || depth > 32) {
      throw new TypeError("metadata extensions are too complex");
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError("metadata extension numbers must be finite");
    }
    if (value && typeof value === "object") {
      for (const child of Object.values(value)) stack.push([child, depth + 1]);
    }
  }
  if (Object.hasOwn(extensions, "opengeo")) {
    const catalog = extensions.opengeo;
    if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
      throw new TypeError("metadata extensions.opengeo must be an object");
    }
    if (!["1.0.0", "1.1.0", "1.2.0", "1.3.0"].includes(catalog.schemaVersion)) {
      throw new TypeError(
        "metadata extensions.opengeo.schemaVersion must be 1.0.0, 1.1.0, 1.2.0, or 1.3.0"
      );
    }
    const allowed = new Set([
      "schemaVersion",
      "contacts",
      "distributions",
      "referenceSystems",
      "lineage",
      "quality",
      "updateFrequency",
      "sensitivity"
    ]);
    if (catalog.schemaVersion !== "1.0.0") {
      allowed.add("funding");
      allowed.add("acquisition");
    }
    if (Object.keys(catalog).some((key) => !allowed.has(key))) {
      throw new TypeError("metadata extensions.opengeo contains an unknown field");
    }
  }
  if (new TextEncoder().encode(JSON.stringify(extensions)).byteLength > 8_192) {
    throw new TypeError("metadata extensions exceed 8192 bytes");
  }
  return extensions;
}

export function parseContentDraft(source) {
  let content;
  try {
    content = JSON.parse(source);
  } catch {
    throw new TypeError("mixed content must be valid JSON");
  }
  if (!content || typeof content !== "object" || Array.isArray(content)
    || !Array.isArray(content.blocks) || content.blocks.length > 24) {
    throw new TypeError("mixed content must contain at most 24 blocks");
  }
  if (new TextEncoder().encode(JSON.stringify(content)).byteLength > 16_384) {
    throw new TypeError("mixed content exceeds 16384 bytes");
  }
  return content;
}

export function pinCurrentResourceReferences(content, resources = []) {
  if (!content || typeof content !== "object" || Array.isArray(content)
    || !Array.isArray(content.blocks)) {
    throw new TypeError("mixed content must contain blocks");
  }
  const byId = new Map(resources.map((resource) => [resource.id, resource]));
  return {
    ...content,
    blocks: content.blocks.map((block) => {
      if (!block || !["map", "dataset"].includes(block.type)
        || (block.resourceVersionNumber !== null
          && block.resourceVersionNumber !== undefined)) {
        return block;
      }
      const target = byId.get(block.resourceId);
      if (!target || target.kind !== block.type || !Number.isSafeInteger(target.versionNumber)
        || target.versionNumber < 1) {
        return block;
      }
      return {...block, resourceVersionNumber: target.versionNumber};
    })
  };
}

export function appendResourceReferenceBlockDraft(source, candidate, caption = null) {
  const content = parseContentDraft(source);
  if (content.blocks.length >= 24) throw new TypeError("mixed content already has 24 blocks");
  if (!candidate || !["map", "dataset"].includes(candidate.kind)) {
    throw new TypeError("governed resource candidate is invalid");
  }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (typeof candidate.id !== "string" || !uuid.test(candidate.id)
    || !Number.isSafeInteger(candidate.versionNumber) || candidate.versionNumber < 1) {
    throw new TypeError("governed resource candidate identity is invalid");
  }
  const normalizedCaption = caption === null || caption === undefined || !String(caption).trim()
    ? null
    : String(caption).trim();
  if (normalizedCaption !== null && normalizedCaption.length > 300) {
    throw new TypeError("governed resource caption is invalid");
  }
  const ids = new Set(content.blocks.map((block) => block.id));
  const stem = `${candidate.kind}-${candidate.id.slice(0, 8)}`;
  let id = stem;
  let suffix = 2;
  while (ids.has(id)) {
    id = `${stem}-${suffix}`;
    suffix += 1;
  }
  const block = {
    id,
    type: candidate.kind,
    resourceId: candidate.id,
    resourceVersionNumber: candidate.versionNumber,
    caption: normalizedCaption
  };
  const updated = {blocks: [...content.blocks, block]};
  parseContentDraft(JSON.stringify(updated));
  return updated;
}

function nextContentBlockId(content, prefix) {
  const ids = new Set(content.blocks.map((block) => block.id));
  let sequence = 1;
  let candidate = `${prefix}-${sequence}`;
  while (ids.has(candidate)) {
    sequence += 1;
    candidate = `${prefix}-${sequence}`;
  }
  return candidate;
}

function boundedDraftText(value, maximum, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized.length || normalized.length > maximum) {
    throw new TypeError(`${label} is invalid`);
  }
  return normalized;
}

function structuralHeadingsDraft(content) {
  const headings = [];
  let previousLevel = null;
  for (const [position, block] of content.blocks.entries()) {
    if (block?.type !== "heading") continue;
    if (!Number.isSafeInteger(block.level) || ![2, 3, 4].includes(block.level)
      || typeof block.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(block.id)
      || typeof block.text !== "string" || !block.text.trim() || block.text.trim().length > 300) {
      throw new TypeError("existing structural heading is invalid");
    }
    if (previousLevel === null && block.level !== 2) {
      throw new TypeError("the first structural heading must be level 2");
    }
    if (previousLevel !== null && block.level > previousLevel + 1) {
      throw new TypeError("structural heading levels cannot be skipped");
    }
    headings.push({id: block.id, level: block.level, text: block.text.trim(), position});
    previousLevel = block.level;
  }
  return headings;
}

export function appendHeadingBlockDraft(source, {level, text: headingText}) {
  const content = parseContentDraft(source);
  if (content.blocks.length >= 24) throw new TypeError("mixed content already has 24 blocks");
  const parsedLevel = Number(level);
  if (!Number.isSafeInteger(parsedLevel) || ![2, 3, 4].includes(parsedLevel)) {
    throw new TypeError("heading level is invalid");
  }
  const headings = structuralHeadingsDraft(content);
  if (!headings.length && parsedLevel !== 2) {
    throw new TypeError("the first structural heading must be level 2");
  }
  if (headings.length && parsedLevel > headings.at(-1).level + 1) {
    throw new TypeError("structural heading levels cannot be skipped");
  }
  const updated = {
    blocks: [...content.blocks, {
      id: nextContentBlockId(content, "heading"),
      type: "heading",
      level: parsedLevel,
      text: boundedDraftText(headingText, 300, "heading text")
    }]
  };
  parseContentDraft(JSON.stringify(updated));
  return updated;
}

export function appendCalloutBlockDraft(source, {tone, title, markdown}) {
  const content = parseContentDraft(source);
  if (content.blocks.length >= 24) throw new TypeError("mixed content already has 24 blocks");
  if (!["note", "tip", "warning", "important"].includes(tone)) {
    throw new TypeError("callout tone is invalid");
  }
  const updated = {
    blocks: [...content.blocks, {
      id: nextContentBlockId(content, "callout"),
      type: "callout",
      tone,
      title: boundedDraftText(title, 300, "callout title"),
      markdown: boundedDraftText(markdown, 2_000, "callout Markdown")
    }]
  };
  parseContentDraft(JSON.stringify(updated));
  return updated;
}

export function appendNavigationBlockDraft(source, {label, headingBlockIds}) {
  const content = parseContentDraft(source);
  if (content.blocks.length >= 24) throw new TypeError("mixed content already has 24 blocks");
  const headings = structuralHeadingsDraft(content);
  const positions = new Map(headings.map((heading) => [heading.id, heading.position]));
  const targets = Array.from(headingBlockIds ?? [], (target) => String(target));
  if (!targets.length || targets.length > 12 || new Set(targets).size !== targets.length
    || targets.some((target) => !positions.has(target))) {
    throw new TypeError("navigation must target one to twelve structural headings");
  }
  const targetPositions = targets.map((target) => positions.get(target));
  if (targetPositions.some(
    (position, index) => index > 0 && position < targetPositions[index - 1]
  )) {
    throw new TypeError("navigation headings must preserve document order");
  }
  const updated = {
    blocks: [...content.blocks, {
      id: nextContentBlockId(content, "navigation"),
      type: "navigation",
      label: boundedDraftText(label, 300, "navigation label"),
      headingBlockIds: targets
    }]
  };
  parseContentDraft(JSON.stringify(updated));
  return updated;
}

function tableCellDraft(value) {
  const normalized = value.trim();
  if (!normalized.length) return null;
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  if (/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(normalized)) {
    const number = Number(normalized);
    if (Number.isFinite(number) && Math.abs(number) <= 1e15) return number;
  }
  if (normalized.length > 300) throw new TypeError("table cell is invalid");
  return normalized;
}

export function appendTableBlockDraft(source, {caption, columns, rows}) {
  const content = parseContentDraft(source);
  if (content.blocks.length >= 24) throw new TypeError("mixed content already has 24 blocks");
  const parsedColumns = String(columns ?? "").split(",").map((value) => value.trim());
  if (!parsedColumns.length || parsedColumns.length > 12
    || parsedColumns.some((value) => !value.length || value.length > 300)
    || new Set(parsedColumns.map((value) => value.toLowerCase())).size !== parsedColumns.length) {
    throw new TypeError("table columns are invalid");
  }
  const lines = String(rows ?? "").split(/\r?\n/).filter((line) => line.trim().length);
  if (lines.length > 50) throw new TypeError("table has more than 50 rows");
  const parsedRows = lines.map((line) => {
    const cells = line.split(",");
    if (cells.length !== parsedColumns.length) {
      throw new TypeError("every table row must match the column count");
    }
    return cells.map(tableCellDraft);
  });
  const updated = {
    blocks: [...content.blocks, {
      id: nextContentBlockId(content, "table"),
      type: "table",
      caption: boundedDraftText(caption, 300, "table caption"),
      columns: parsedColumns,
      rows: parsedRows
    }]
  };
  parseContentDraft(JSON.stringify(updated));
  return updated;
}

export function appendChartBlockDraft(
  source,
  {tableBlockId, chartType, title, altText, xColumn, yColumns}
) {
  const content = parseContentDraft(source);
  if (content.blocks.length >= 24) throw new TypeError("mixed content already has 24 blocks");
  const table = content.blocks.find(
    (block) => block?.type === "table" && block.id === tableBlockId
  );
  if (!table || !Array.isArray(table.columns) || !Array.isArray(table.rows)) {
    throw new TypeError("chart must reference a table block");
  }
  if (!["bar", "line"].includes(chartType)) throw new TypeError("chart type is invalid");
  const byName = new Map(table.columns.map((column) => [String(column).toLowerCase(), column]));
  const parsedX = byName.get(String(xColumn ?? "").trim().toLowerCase());
  const requestedY = String(yColumns ?? "").split(",").map((value) => value.trim())
    .filter(Boolean);
  const parsedY = requestedY.map((column) => byName.get(column.toLowerCase()));
  if (!parsedX || !parsedY.length || parsedY.length > 4 || parsedY.some((column) => !column)
    || new Set(parsedY.map((column) => column.toLowerCase())).size !== parsedY.length
    || parsedY.some((column) => column.toLowerCase() === parsedX.toLowerCase())) {
    throw new TypeError("chart columns are invalid");
  }
  for (const column of parsedY) {
    const index = table.columns.indexOf(column);
    const values = table.rows.map((row) => row[index]).filter((value) => value !== null);
    if (!values.length || values.some(
      (value) => typeof value !== "number" || !Number.isFinite(value)
    )) {
      throw new TypeError("chart value columns must contain only numbers");
    }
  }
  const updated = {
    blocks: [...content.blocks, {
      id: nextContentBlockId(content, "chart"),
      type: "chart",
      chartType,
      title: boundedDraftText(title, 300, "chart title"),
      altText: boundedDraftText(altText, 1_000, "chart text alternative"),
      tableBlockId: table.id,
      xColumn: parsedX,
      yColumns: parsedY
    }]
  };
  parseContentDraft(JSON.stringify(updated));
  return updated;
}

export function appendCitationBlockDraft(source, {title, doi = null, url = null}) {
  const content = parseContentDraft(source);
  if (content.blocks.length >= 24) throw new TypeError("mixed content already has 24 blocks");
  const normalizedDoi = String(doi ?? "").trim() || null;
  const normalizedUrl = String(url ?? "").trim() || null;
  if (normalizedDoi !== null && !/^10\.[0-9]{4,9}\/\S+$/.test(normalizedDoi)) {
    throw new TypeError("citation DOI is invalid");
  }
  if (normalizedUrl !== null) {
    let parsed;
    try {
      parsed = new URL(normalizedUrl);
    } catch {
      throw new TypeError("citation URL is invalid");
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password
      || normalizedUrl.length > 2_048) {
      throw new TypeError("citation URL is invalid");
    }
  }
  if (normalizedDoi === null && normalizedUrl === null) {
    throw new TypeError("citation requires a DOI or URL");
  }
  const updated = {
    blocks: [...content.blocks, {
      id: nextContentBlockId(content, "citation"),
      type: "citation",
      title: boundedDraftText(title, 300, "citation title"),
      doi: normalizedDoi,
      url: normalizedUrl
    }]
  };
  parseContentDraft(JSON.stringify(updated));
  return updated;
}

function governedResourceReferencePicker(state, resource, contentControl) {
  if (!PAGE_KINDS.has(resource.kind)) return document.createDocumentFragment();
  const picker = document.createElement("section");
  picker.className = "project-resource-reference-picker";
  picker.append(
    text("h5", "Add a governed map or dataset"),
    text(
      "p",
      "The block records the authorized resource and its current immutable version. Publication fails closed if that pin drifts.",
      "project-resource-feedback"
    )
  );
  const candidates = (state.resources ?? []).filter(
    (candidate) => candidate.id !== resource.id && ["map", "dataset"].includes(candidate.kind)
  );
  const choices = document.createElement("select");
  choices.ariaLabel = "Governed map or dataset";
  for (const [index, candidate] of candidates.entries()) {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = `${candidate.kind} · ${candidate.title} · v${candidate.versionNumber}`;
    choices.append(option);
  }
  const caption = labeledInput("Map or dataset caption", "", 300);
  const add = text("button", "Add governed reference", "platform-button");
  add.type = "button";
  add.disabled = !candidates.length;
  const feedback = text(
    "p",
    candidates.length
      ? `${candidates.length} authorized map/data resource${candidates.length === 1 ? "" : "s"} available.`
      : "No authorized governed map or dataset is available in this project.",
    "project-resource-feedback"
  );
  add.addEventListener("click", () => {
    try {
      const candidate = candidates[Number(choices.value)];
      const updated = appendResourceReferenceBlockDraft(
        contentControl.value,
        candidate,
        caption.control.value
      );
      contentControl.value = JSON.stringify(updated, null, 2);
      contentControl.dispatchEvent(new Event("input", {bubbles: true}));
      feedback.textContent = `Added ${candidate.kind} ${candidate.title} pinned at v${candidate.versionNumber}. Render the pinned preview, then save a new page version.`;
    } catch (error) {
      feedback.textContent = error?.message ?? "The governed reference could not be added.";
    }
  });
  picker.append(labeled("Governed map or dataset", choices), caption.label, add, feedback);
  return picker;
}

function governedPageStructurePicker(resource, contentControl) {
  if (!PAGE_KINDS.has(resource.kind)) return document.createDocumentFragment();
  const picker = document.createElement("section");
  picker.className = "project-page-structure-picker";
  picker.append(
    text("h5", "Add page structure and navigation"),
    text(
      "p",
      "Typed headings create stable in-page anchors. Navigation can target only headings in this exact draft; callouts use the same inert Markdown dialect.",
      "project-resource-feedback"
    )
  );
  const replaceDraft = (updated) => {
    contentControl.value = JSON.stringify(updated, null, 2);
    contentControl.dispatchEvent(new Event("input", {bubbles: true}));
  };

  const heading = document.createElement("section");
  heading.className = "project-resource-structured-group";
  const headingLevel = labeledSelect("Heading level", ["2", "3", "4"], "2");
  const headingText = labeledInput("Heading text", "", 300);
  const addHeading = text("button", "Add structural heading", "platform-button");
  addHeading.type = "button";
  const headingFeedback = text(
    "p",
    "Begin at level 2; later headings may stay level or move one level deeper.",
    "project-resource-feedback"
  );
  addHeading.addEventListener("click", () => {
    try {
      const updated = appendHeadingBlockDraft(contentControl.value, {
        level: headingLevel.control.value,
        text: headingText.control.value
      });
      replaceDraft(updated);
      headingFeedback.textContent = "Added a stable structural heading to the draft.";
    } catch (error) {
      headingFeedback.textContent = error?.message ?? "The heading could not be added.";
    }
  });
  heading.append(
    text("h6", "Structural heading"),
    headingLevel.label,
    headingText.label,
    addHeading,
    headingFeedback
  );

  const callout = document.createElement("section");
  callout.className = "project-resource-structured-group";
  const calloutTone = labeledSelect(
    "Callout tone", ["note", "tip", "warning", "important"], "note"
  );
  const calloutTitle = labeledInput("Callout title", "", 300);
  const calloutMarkdown = labeledTextarea("Callout Markdown", "", 2_000);
  const addCallout = text("button", "Add safe callout", "platform-button");
  addCallout.type = "button";
  const calloutFeedback = text(
    "p",
    "The body supports only the bounded script-free Markdown renderer.",
    "project-resource-feedback"
  );
  addCallout.addEventListener("click", () => {
    try {
      const updated = appendCalloutBlockDraft(contentControl.value, {
        tone: calloutTone.control.value,
        title: calloutTitle.control.value,
        markdown: calloutMarkdown.control.value
      });
      replaceDraft(updated);
      calloutFeedback.textContent = "Added a bounded portable callout to the draft.";
    } catch (error) {
      calloutFeedback.textContent = error?.message ?? "The callout could not be added.";
    }
  });
  callout.append(
    text("h6", "Callout"),
    calloutTone.label,
    calloutTitle.label,
    calloutMarkdown.label,
    addCallout,
    calloutFeedback
  );

  const navigation = document.createElement("section");
  navigation.className = "project-resource-structured-group";
  const navigationLabel = labeledInput("Navigation label", "On this page", 300);
  const headingTargets = document.createElement("select");
  headingTargets.ariaLabel = "Navigation heading targets";
  headingTargets.multiple = true;
  headingTargets.size = 5;
  const addNavigation = text("button", "Add in-page navigation", "platform-button");
  addNavigation.type = "button";
  const navigationFeedback = text(
    "p",
    "Add headings first, then select up to 12 in document order.",
    "project-resource-feedback"
  );
  const refreshHeadings = () => {
    const selected = new Set([...headingTargets.selectedOptions].map((option) => option.value));
    let headings = [];
    try {
      headings = structuralHeadingsDraft(parseContentDraft(contentControl.value));
    } catch {
      headings = [];
    }
    headingTargets.replaceChildren();
    for (const candidate of headings) {
      const option = document.createElement("option");
      option.value = candidate.id;
      option.textContent = `H${candidate.level} · ${candidate.text}`;
      option.selected = selected.has(candidate.id);
      headingTargets.append(option);
    }
    headingTargets.disabled = !headings.length;
    addNavigation.disabled = !headings.length;
  };
  addNavigation.addEventListener("click", () => {
    try {
      const updated = appendNavigationBlockDraft(contentControl.value, {
        label: navigationLabel.control.value,
        headingBlockIds: [...headingTargets.selectedOptions].map((option) => option.value)
      });
      replaceDraft(updated);
      navigationFeedback.textContent = "Added exact same-page navigation to the draft.";
    } catch (error) {
      navigationFeedback.textContent = error?.message ?? "Navigation could not be added.";
    }
  });
  contentControl.addEventListener("input", refreshHeadings);
  navigation.append(
    text("h6", "In-page navigation"),
    navigationLabel.label,
    labeled("Structural headings", headingTargets),
    addNavigation,
    navigationFeedback
  );
  picker.append(heading, callout, navigation);
  refreshHeadings();
  return picker;
}

function governedStructuredContentPicker(resource, contentControl) {
  if (!PAGE_KINDS.has(resource.kind)) return document.createDocumentFragment();
  const picker = document.createElement("section");
  picker.className = "project-resource-structured-picker";
  picker.append(
    text("h5", "Add a citation, data table, or chart"),
    text(
      "p",
      "These controls append bounded typed blocks. Tables are the inspectable data source for accessible bar and line charts.",
      "project-resource-feedback"
    )
  );
  const replaceDraft = (updated) => {
    contentControl.value = JSON.stringify(updated, null, 2);
    contentControl.dispatchEvent(new Event("input", {bubbles: true}));
  };

  const citation = document.createElement("section");
  citation.className = "project-resource-structured-group";
  const citationTitle = labeledInput("Citation title", "", 300);
  const citationDoi = labeledInput("Citation DOI", "", 200);
  const citationUrl = labeledInput("Citation HTTPS URL", "", 2_048);
  const addCitation = text("button", "Add citation", "platform-button");
  addCitation.type = "button";
  const citationFeedback = text(
    "p", "Provide a DOI, an HTTPS source URL, or both.", "project-resource-feedback"
  );
  addCitation.addEventListener("click", () => {
    try {
      const updated = appendCitationBlockDraft(contentControl.value, {
        title: citationTitle.control.value,
        doi: citationDoi.control.value,
        url: citationUrl.control.value
      });
      replaceDraft(updated);
      citationFeedback.textContent = "Added a portable citation block to the draft.";
    } catch (error) {
      citationFeedback.textContent = error?.message ?? "The citation could not be added.";
    }
  });
  citation.append(
    text("h6", "Citation"),
    citationTitle.label,
    citationDoi.label,
    citationUrl.label,
    addCitation,
    citationFeedback
  );

  const table = document.createElement("section");
  table.className = "project-resource-structured-group";
  const tableCaption = labeledInput("Table caption", "", 300);
  const tableColumns = labeledInput("Table columns (comma separated)", "", 3_600);
  const tableRows = labeledTextarea(
    "Table rows (one comma-separated row per line)", "", 15_000
  );
  const addTable = text("button", "Add data table", "platform-button");
  addTable.type = "button";
  const tableFeedback = text(
    "p",
    "Up to 12 unique columns and 50 rows; empty cells become null and bounded numbers remain numeric.",
    "project-resource-feedback"
  );
  addTable.addEventListener("click", () => {
    try {
      const updated = appendTableBlockDraft(contentControl.value, {
        caption: tableCaption.control.value,
        columns: tableColumns.control.value,
        rows: tableRows.control.value
      });
      replaceDraft(updated);
      tableFeedback.textContent = "Added a bounded portable data table to the draft.";
    } catch (error) {
      tableFeedback.textContent = error?.message ?? "The table could not be added.";
    }
  });
  table.append(
    text("h6", "Data table"),
    tableCaption.label,
    tableColumns.label,
    tableRows.label,
    addTable,
    tableFeedback
  );

  const chart = document.createElement("section");
  chart.className = "project-resource-structured-group";
  const chartTable = document.createElement("select");
  chartTable.ariaLabel = "Chart source table";
  const chartType = labeledSelect("Chart type", ["bar", "line"], "bar");
  const chartTitle = labeledInput("Chart title", "", 300);
  const chartAlt = labeledTextarea("Chart text alternative", "", 1_000);
  const chartX = labeledInput("Chart category column", "", 300);
  const chartY = labeledInput("Chart numeric columns (comma separated)", "", 1_200);
  const addChart = text("button", "Add accessible chart", "platform-button");
  addChart.type = "button";
  const chartFeedback = text(
    "p",
    "Add a table first; chart values must refer to one to four numeric columns.",
    "project-resource-feedback"
  );
  let tables = [];
  const prefillChartColumns = () => {
    const selected = tables.find((candidate) => candidate.id === chartTable.value);
    if (!selected) return;
    if (!chartX.control.value.trim()) chartX.control.value = selected.columns[0] ?? "";
    if (!chartY.control.value.trim()) {
      const numeric = selected.columns.filter((column, index) => {
        const values = selected.rows.map((row) => row[index]).filter((value) => value !== null);
        return values.length && values.every((value) => typeof value === "number");
      });
      chartY.control.value = numeric.find(
        (column) => column.toLowerCase() !== chartX.control.value.toLowerCase()
      ) ?? "";
    }
  };
  const refreshTables = () => {
    try {
      tables = parseContentDraft(contentControl.value).blocks.filter(
        (block) => block?.type === "table"
          && Array.isArray(block.columns) && Array.isArray(block.rows)
      );
    } catch {
      tables = [];
    }
    const selected = chartTable.value;
    chartTable.replaceChildren();
    for (const candidate of tables) {
      const option = document.createElement("option");
      option.value = candidate.id;
      option.textContent = `${candidate.caption} · ${candidate.columns.length} columns`;
      chartTable.append(option);
    }
    if (tables.some((candidate) => candidate.id === selected)) chartTable.value = selected;
    chartTable.disabled = !tables.length;
    addChart.disabled = !tables.length;
    prefillChartColumns();
  };
  chartTable.addEventListener("change", () => {
    chartX.control.value = "";
    chartY.control.value = "";
    prefillChartColumns();
  });
  contentControl.addEventListener("input", refreshTables);
  addChart.addEventListener("click", () => {
    try {
      const updated = appendChartBlockDraft(contentControl.value, {
        tableBlockId: chartTable.value,
        chartType: chartType.control.value,
        title: chartTitle.control.value,
        altText: chartAlt.control.value,
        xColumn: chartX.control.value,
        yColumns: chartY.control.value
      });
      replaceDraft(updated);
      chartFeedback.textContent = "Added an accessible chart linked to its exact table block.";
    } catch (error) {
      chartFeedback.textContent = error?.message ?? "The chart could not be added.";
    }
  });
  chart.append(
    text("h6", "Accessible chart"),
    labeled("Chart source table", chartTable),
    chartType.label,
    chartTitle.label,
    chartAlt.label,
    chartX.label,
    chartY.label,
    addChart,
    chartFeedback
  );
  picker.append(citation, table, chart);
  refreshTables();
  return picker;
}

function pinnedPagePreview(state, resource, titleControl, abstractControl, contentControl) {
  if (!PAGE_KINDS.has(resource.kind)) return document.createDocumentFragment();
  const panel = document.createElement("section");
  panel.className = "project-page-pinned-preview";
  const heading = document.createElement("header");
  heading.append(
    text("h5", "Pinned page preview"),
    text("span", "opengeo-page-renderer-1.1.0 · sandboxed", "project-resources-boundary")
  );
  const render = text("button", "Render pinned page preview", "platform-button secondary");
  render.type = "button";
  render.disabled = typeof state.adapter.previewPageVersion !== "function";
  const feedback = text(
    "p",
    render.disabled
      ? "The pinned server renderer is unavailable in this adapter. Local syntax outlines are not publication evidence."
      : "Preview validates every governed dependency and uses the same pinned renderer as publication.",
    "project-resource-feedback"
  );
  feedback.ariaLive = "polite";
  const frame = document.createElement("iframe");
  frame.title = "Pinned safe page preview";
  frame.className = "project-page-preview-frame";
  frame.setAttribute("sandbox", "");
  frame.referrerPolicy = "no-referrer";
  frame.hidden = true;
  const markStale = () => {
    if (frame.hidden) return;
    feedback.textContent = "The draft changed. Render again before relying on this preview.";
    frame.dataset.state = "stale";
  };
  contentControl.addEventListener("input", markStale);
  titleControl.addEventListener("input", markStale);
  abstractControl.addEventListener("input", markStale);
  render.addEventListener("click", async () => {
    render.disabled = true;
    feedback.textContent = "Authorizing dependencies and rendering the pinned inert document…";
    try {
      const preview = await state.adapter.previewPageVersion(
        state.project.id,
        resource.id,
        resource.versionNumber,
        {
          title: titleControl.value.trim(),
          abstract: abstractControl.value.trim() || null,
          content: parseContentDraft(contentControl.value)
        }
      );
      frame.srcdoc = preview.html;
      frame.hidden = false;
      frame.dataset.state = "current";
      feedback.textContent = `${preview.rendererVersion} · ${preview.dependencies.length} governed dependencies · SHA-256 ${preview.contentChecksumSha256}`;
    } catch (error) {
      frame.hidden = true;
      frame.removeAttribute("srcdoc");
      feedback.textContent = `Pinned preview failed safely (${error?.code ?? "page_preview_invalid"}).`;
    } finally {
      render.disabled = false;
    }
  });
  panel.append(heading, render, feedback, frame);
  return panel;
}

export function appendSiteAssetBlockDraft(source, candidate, accessibleLabel) {
  const content = parseContentDraft(source);
  if (content.blocks.length >= 24) throw new TypeError("mixed content already has 24 blocks");
  if (!candidate || !["image", "file", "document"].includes(candidate.kind)) {
    throw new TypeError("site asset candidate is invalid");
  }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  for (const value of [candidate.datasetId, candidate.datasetVersionId, candidate.objectId]) {
    if (typeof value !== "string" || !uuid.test(value)) {
      throw new TypeError("site asset candidate identity is invalid");
    }
  }
  const label = String(accessibleLabel ?? "").trim();
  if (!label || label.length > (candidate.kind === "image" ? 1_000 : 300)) {
    throw new TypeError("site asset accessible label is invalid");
  }
  const prefix = candidate.kind;
  const stem = `${prefix}-${candidate.objectId.slice(0, 8)}`;
  const ids = new Set(content.blocks.map((block) => block.id));
  let id = stem;
  let suffix = 2;
  while (ids.has(id)) {
    id = `${stem}-${suffix}`;
    suffix += 1;
  }
  const shared = {
    id,
    type: candidate.kind,
    datasetId: candidate.datasetId,
    datasetVersionId: candidate.datasetVersionId,
    objectId: candidate.objectId
  };
  const block = candidate.kind === "image"
    ? {...shared, altText: label, caption: null}
    : candidate.kind === "file"
      ? {...shared, label, description: null}
      : {...shared, label};
  const updated = {blocks: [...content.blocks, block]};
  parseContentDraft(JSON.stringify(updated));
  return updated;
}

function governedAssetPicker(state, contentControl) {
  const picker = document.createElement("section");
  picker.className = "project-resource-asset-picker";
  picker.append(
    text("h5", "Add a governed project asset"),
    text(
      "p",
      "Only active public current-version objects accepted by the publication gate are listed. Storage locations and remote URLs are never exposed.",
      "project-resource-feedback"
    )
  );
  if (typeof state.adapter.listSiteAssetCandidates !== "function") {
    picker.append(text("p", "Asset discovery is unavailable in this adapter.", "project-resource-feedback"));
    return picker;
  }
  const load = text("button", "Load publishable assets", "platform-button secondary");
  load.type = "button";
  const choices = document.createElement("select");
  choices.ariaLabel = "Publishable project asset";
  choices.disabled = true;
  const accessible = labeledInput("Image alternative text, file label, or document heading", "", 1_000);
  const add = text("button", "Add asset block", "platform-button");
  add.type = "button";
  add.disabled = true;
  const feedback = text(
    "p",
    "Load the current governed inventory, choose an object, and add its immutable identifiers to this draft.",
    "project-resource-feedback"
  );
  let candidates = [];
  const selectCandidate = () => {
    const candidate = candidates[Number(choices.value)];
    add.disabled = !candidate;
    if (candidate && !accessible.control.value.trim()) {
      accessible.control.value = candidate.filename;
    }
  };
  choices.addEventListener("change", selectCandidate);
  load.addEventListener("click", async () => {
    load.disabled = true;
    feedback.textContent = "Loading prevalidated project assets…";
    try {
      candidates = await state.adapter.listSiteAssetCandidates(state.project.id);
      choices.replaceChildren();
      for (const [index, candidate] of candidates.entries()) {
        const option = document.createElement("option");
        option.value = String(index);
        option.textContent = `${candidate.datasetName} v${candidate.datasetVersionNumber} · ${candidate.kind} · ${candidate.filename} · ${formatBytes(candidate.sizeBytes)}`;
        choices.append(option);
      }
      choices.disabled = !candidates.length;
      feedback.textContent = candidates.length
        ? `${candidates.length} publishable governed asset${candidates.length === 1 ? "" : "s"} available.`
        : "No current public project object satisfies the bounded publication policy.";
      selectCandidate();
    } catch (error) {
      feedback.textContent = `Asset discovery failed safely (${error?.code ?? "unexpected_error"}).`;
    } finally {
      load.disabled = false;
    }
  });
  add.addEventListener("click", () => {
    try {
      const candidate = candidates[Number(choices.value)];
      const updated = appendSiteAssetBlockDraft(
        contentControl.value,
        candidate,
        accessible.control.value
      );
      contentControl.value = JSON.stringify(updated, null, 2);
      contentControl.dispatchEvent(new Event("input", {bubbles: true}));
      feedback.textContent = `Added exact ${candidate.kind} block ${candidate.objectId}; save a new governed resource version to persist it.`;
    } catch (error) {
      feedback.textContent = error?.message ?? "The asset block could not be added.";
    }
  });
  picker.append(
    load,
    labeled("Publishable project asset", choices),
    accessible.label,
    add,
    feedback
  );
  return picker;
}

function normalizeLanguage(value) {
  const language = String(value ?? "").trim().toLowerCase();
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(language) || language.length > 40) {
    throw new TypeError("metadata language is invalid");
  }
  return language;
}

function optionalTranslatedText(value, maximum) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new TypeError("translated metadata text is invalid");
  }
  return value.trim();
}

function resourceBindingEditor(state, resource, detail, capabilities, metadataPanel) {
  const panel = editorPanel("Data or map binding", "Same project · one-time");
  if (resource.datasetId || resource.mapId) {
    panel.append(text("p", resource.datasetId ? `Dataset ${resource.datasetId}` : `Map ${resource.mapId}`, "project-resource-feedback"));
    if (resource.kind === "map" && resource.mapId) {
      panel.append(resourceMapVersionEditor(state, resource, detail, capabilities, metadataPanel));
    }
    return panel;
  }
  if (!["dataset", "service", "map"].includes(resource.kind)) {
    panel.append(text("p", "This content resource does not require a data/map binding.", "project-resource-feedback"));
    return panel;
  }
  const choices = resource.kind === "map" ? state.maps ?? [] : state.datasets ?? [];
  const selectControl = document.createElement("select");
  selectControl.ariaLabel = resource.kind === "map" ? "Map binding" : "Dataset binding";
  for (const item of choices) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.name;
    selectControl.append(option);
  }
  const bind = text("button", "Bind governed asset", "platform-button");
  bind.type = "button";
  bind.disabled = !choices.length;
  const feedback = text("p", "Imported records remain staged until explicitly bound.", "project-resource-feedback");
  bind.addEventListener("click", async () => {
    bind.disabled = true;
    try {
      await state.adapter.bindResource(state.project.id, resource.id, {
        expectedVersion: resource.versionNumber,
        datasetId: resource.kind === "map" ? null : selectControl.value,
        mapId: resource.kind === "map" ? selectControl.value : null
      });
      await openResourceDetail(state, resource.id, detail);
    } catch (error) {
      feedback.textContent = `Binding failed safely (${error?.code ?? "unexpected_error"}).`;
      bind.disabled = false;
    }
  });
  panel.append(selectControl, bind, feedback);
  return panel;
}

function resourceMapVersionEditor(state, resource, detail, capabilities, metadataPanel) {
  const panel = document.createElement("section");
  panel.className = "project-resource-map-version";
  const summary = text("p", "", "project-resource-feedback");
  const feedback = text("p", "", "project-resource-feedback");
  feedback.ariaLive = "polite";
  const refresh = text("button", "Refresh saved map version", "platform-button secondary");
  refresh.type = "button";
  const use = text("button", "Use saved map in a new resource version", "platform-button");
  use.type = "button";
  const canRefresh = typeof state.adapter.getMap === "function";
  const editable = ["draft", "review"].includes(resource.state);
  let canUpdate = capabilities?.canUpdate === true;
  let savedMap = (state.maps ?? []).find(({id}) => id === resource.mapId) ?? null;
  let dirty = false;
  let busy = false;
  let accessDenied = false;
  let resourceChanged = false;
  const savedVersion = () => savedMap?.id === resource.mapId
    && savedMap.status === "active" && Number.isSafeInteger(savedMap.version) && savedMap.version > 0
    ? savedMap.version : null;

  function render() {
    const pinned = resource.mapSnapshot?.mapVersion ?? null;
    const current = savedVersion();
    panel.dataset.state = pinned === null ? "missing" : current === null ? "unknown" : current === pinned ? "current" : "stale";
    summary.textContent = pinned === null
      ? `Resource v${resource.versionNumber} has no recorded exact map revision.`
      : `Resource v${resource.versionNumber} uses map v${pinned}.`;
    summary.textContent += current === null
      ? " The saved map revision is unavailable."
      : ` Saved map: v${current}.`;
    use.textContent = current === null ? "Use saved map in a new resource version"
      : `Use saved map v${current} in a new resource version`;
    use.disabled = busy || dirty || accessDenied || resourceChanged || !editable || !canUpdate
      || typeof state.adapter.updateResource !== "function" || current === null || current === pinned;
    refresh.disabled = busy || !canRefresh;
    if (dirty) feedback.textContent = "Save your metadata edits before choosing a map revision.";
    else if (resourceChanged) feedback.textContent = "The resource changed. Reopen it to compare the current version before choosing a map revision.";
    else if (!editable) feedback.textContent = "This published or archived resource version cannot change its map revision here.";
    else if (!canUpdate && !accessDenied) feedback.textContent = "Resource edit permission is required to select a map revision.";
  }

  for (const event of ["input", "change", "draftchange"]) {
    metadataPanel.addEventListener(event, () => { dirty = true; render(); });
  }
  refresh.addEventListener("click", async () => {
    if (busy || !canRefresh) return;
    busy = true;
    feedback.textContent = "Reading the saved map revision…";
    render();
    try {
      const [map, permissions] = await Promise.all([
        state.adapter.getMap(state.project.id, resource.mapId),
        typeof state.adapter.getResourceCapabilities === "function"
          ? state.adapter.getResourceCapabilities(state.project.id, resource.id) : null
      ]);
      savedMap = map;
      if (permissions) canUpdate = permissions.canUpdate === true;
      accessDenied = false;
      feedback.textContent = "Saved map checked. Selecting it creates a new resource version; rendering and publication are separate actions.";
    } catch (error) {
      savedMap = null;
      accessDenied = ["action_forbidden", "http_403"].includes(error?.code);
      feedback.textContent = `Saved map could not be checked (${error?.code ?? "unexpected_error"}). Retry when access is available.`;
    } finally {
      busy = false;
      render();
    }
  });
  use.addEventListener("click", async () => {
    if (use.disabled) return;
    const expectedMapVersion = savedVersion();
    busy = true;
    feedback.textContent = `Creating a resource version for saved map v${expectedMapVersion}…`;
    render();
    // Keep the metadata form stable during the write and subsequent reload.
    const controls = [...metadataPanel.querySelectorAll("input, textarea, select, button")]
      .map((control) => ({control, disabled: control.disabled}));
    for (const {control} of controls) control.disabled = true;
    try {
      const updated = await state.adapter.updateResource(state.project.id, resource.id, {
        expectedVersion: resource.versionNumber,
        expectedMapVersion,
        visibility: resource.visibility,
        metadata: structuredClone({
          title: resource.title, abstract: resource.abstract, language: resource.language,
          license: resource.license, attribution: resource.attribution, keywords: resource.keywords,
          spatialExtent: resource.spatialExtent, temporalStart: resource.temporalStart,
          temporalEnd: resource.temporalEnd, profile: resource.metadataProfile,
          extensions: resource.metadataExtensions, translations: resource.translations,
          managedProfileId: resource.managedMetadataProfileId,
          managedProfileVersion: resource.managedMetadataProfileVersion
        }),
        content: structuredClone(resource.content),
        provenance: structuredClone(resource.provenance),
        changeMessage: `Use saved map v${expectedMapVersion}`
      });
      if (savedMap) {
        state.maps = (state.maps ?? []).some(({id}) => id === resource.mapId)
          ? state.maps.map((map) => map.id === resource.mapId ? savedMap : map)
          : [...(state.maps ?? []), savedMap];
      }
      await openResourceDetail(state, updated.id, detail);
    } catch (error) {
      if (error?.code === "map_version_conflict") {
        savedMap = null;
        feedback.textContent = "The saved map changed. Refresh its version and choose again.";
      } else if (["resource_version_conflict", "http_409"].includes(error?.code)) {
        resourceChanged = true;
        feedback.textContent = "The resource changed. Reopen it to compare the current version before choosing a map revision.";
      } else {
        accessDenied = ["action_forbidden", "http_403"].includes(error?.code);
        feedback.textContent = `Map revision was not changed (${error?.code ?? "unexpected_error"}). Refresh the saved map to check access and try again.`;
      }
    } finally {
      for (const {control, disabled} of controls) control.disabled = disabled;
      busy = false;
      render();
    }
  });
  panel.append(summary, refresh, use, feedback);
  render();
  return panel;
}

function resourceWorkflowEditor(state, resource, workflow, capabilities, detail) {
  const panel = editorPanel("Editorial workflow", "Explicit and audited");
  const next = {draft: "review", review: "published", published: "archived"}[resource.state];
  const history = document.createElement("ol");
  history.className = "project-resource-history";
  for (const event of workflow) {
    history.append(text("li", `${event.sourceState} → ${event.targetState}${event.reason ? ` · ${event.reason}` : ""}`));
  }
  if (!workflow.length) history.append(text("li", "No editorial decision recorded yet."));
  panel.append(history);
  if (resource.state === "published") {
    const publishing = document.createElement("a");
    publishing.className = "platform-button secondary";
    publishing.href = projectHref(state.project.id, {
      adapterKind: state.adapter?.kind,
      management: "publishing",
      siteResourceTarget: {
        resourceId: resource.id,
        resourceVersion: resource.versionNumber
      },
      fragment: "project-sites"
    });
    publishing.textContent = "Add to a site";
    panel.append(
      text(
        "p",
        "This resource is ready to be pinned into a reviewed site edition.",
        "project-resource-feedback"
      ),
      publishing
    );
  }
  if (!next) {
    panel.append(text(
      "p",
      "This resource is archived; its immutable history remains available.",
      "project-resource-feedback"
    ));
    return panel;
  }
  const canTransition = next === "review" ? capabilities.canUpdate : capabilities.canPublish;
  const canArchiveDraft = ["draft", "review"].includes(resource.state) && capabilities.canPublish;
  if (!canTransition && !canArchiveDraft) {
    const message = resource.state === "review"
      ? "Review is pending. A project owner or member with resource publish access must approve this version."
      : resource.state === "draft"
        ? "A project owner, editor, or member with resource edit access must submit this draft for review."
        : "A project owner or member with resource publish access is required to archive this publication.";
    panel.append(text("p", message, "project-resource-workflow-handoff"));
    return panel;
  }
  const reason = labeledInput("Decision note", "", 1_000);
  const scope = labeledSelect("Publication visibility", ["organization", "public"], "organization");
  if (next !== "published") scope.label.hidden = true;
  const transition = canTransition
    ? text("button", next === "review" ? "Submit for review" : next === "published" ? "Publish" : "Archive", "platform-button")
    : null;
  const archive = canArchiveDraft
    ? text("button", resource.state === "draft" ? "Archive draft" : "Archive", "platform-button secondary")
    : null;
  const decisions = [transition, archive].filter(Boolean);
  for (const button of decisions) button.type = "button";
  const feedback = text("p", "Publication authority is separate from edit authority.", "project-resource-feedback");
  let busy = false;
  const decide = async targetState => {
    if (busy) return;
    busy = true;
    for (const button of decisions) button.disabled = true;
    try {
      await state.adapter.transitionResource(state.project.id, resource.id, {
        expectedVersion: resource.versionNumber,
        targetState,
        visibility: targetState === "published" ? scope.control.value : null,
        reason: reason.control.value.trim() || null
      });
      await openResourceDetail(state, resource.id, detail);
    } catch (error) {
      if (["resource_version_conflict", "http_409"].includes(error?.code)) {
        await openResourceDetail(state, resource.id, detail);
        detail.prepend(text(
          "p",
          "The resource changed in another session. Studio reloaded the current version before any decision was applied.",
          "project-resource-workflow-handoff"
        ));
        return;
      }
      feedback.textContent = `Transition failed safely (${error?.code ?? "unexpected_error"}).`;
      for (const button of decisions) button.disabled = false;
      busy = false;
    }
  };
  transition?.addEventListener("click", () => void decide(next));
  archive?.addEventListener("click", () => void decide("archived"));
  panel.append(reason.label, scope.label, ...decisions, feedback);
  if (resource.state === "published" && typeof state.adapter.setResourcePublicationVisibility === "function") {
    const audience = labeledSelect("Current publication audience", ["organization", "public"], resource.visibility === "public" ? "public" : "organization");
    audience.control.options[0].textContent = "Account members";
    audience.control.options[1].textContent = "Public";
    const apply = text("button", "Change publication audience", "platform-button secondary");
    apply.type = "button";
    const audienceFeedback = text("p", "Current audience governs Catalog and derived-output access. Content, editions and history are retained.", "project-resource-feedback");
    const adapter = state.adapter, projectId = state.project.id, accountId = state.organization.id;
    const current = () => detail.contains(panel) && state.adapter === adapter
      && state.project.id === projectId && state.organization.id === accountId;
    const update = () => {apply.disabled = audience.control.value === resource.visibility;};
    audience.control.addEventListener("change", update);
    apply.addEventListener("click", async () => {
      const controls = [...panel.querySelectorAll("button, input, select")].map(control => ({control, disabled: control.disabled}));
      for (const {control} of controls) control.disabled = true;
      try {
        await adapter.setResourcePublicationVisibility(projectId, resource.id, {
          expectedVersion: resource.versionNumber, expectedVisibility: resource.visibility,
          visibility: audience.control.value
        });
        if (current()) await openResourceDetail(state, resource.id, detail);
      } catch (error) {
        if (!current()) return;
        if (error?.code === "resource_context_changed") {
          detail.replaceChildren(text("p", "Your sign-in or selected account changed. Reopen the resource to check its current audience.", "project-resource-workflow-handoff"));
          return;
        }
        if (["resource_version_conflict", "resource_visibility_conflict", "http_409"].includes(error?.code)) {
          await openResourceDetail(state, resource.id, detail);
          detail.prepend(text("p", "The resource or its audience changed in another session. Review the current audience before applying another change.", "project-resource-workflow-handoff"));
        } else {
          audienceFeedback.textContent = `Audience change could not finish (${error?.code ?? "unexpected_error"}). Refresh the resource before trying again.`;
          for (const {control, disabled} of controls) control.disabled = disabled;
        }
      }
    });
    update(); panel.append(audience.label, apply, audienceFeedback);
  }
  return panel;
}

function resourceStyleEditor(state, resource, styles, detail, capabilities) {
  const panel = editorPanel("Portable styles", "MapLibre · GeoStyler · SLD · MapServer");
  const list = document.createElement("ul");
  for (const style of styles) {
    const item = document.createElement("li");
    const mapServer = mapServerAdapterMetadata(style);
    const savedIdentity = text(
      "span",
      `${style.title} · ${mapServer ? `MapServer ${mapServer.source_version ?? "import"} → MapLibre` : style.format} · v${style.versionNumber}`
    );
    item.append(savedIdentity);
    if (mapServer && typeof state.adapter.exportMapServerStyle === "function") {
      const exportButton = text("button", "Export detached Mapfile", "platform-button secondary");
      exportButton.type = "button";
      exportButton.addEventListener("click", async () => {
        exportButton.disabled = true;
        try {
          const exported = await state.adapter.exportMapServerStyle(
            state.project.id, resource.id, style.id
          );
          downloadTextArtifact(exported.filename, exported.mapfile, exported.mediaType);
        } finally {
          exportButton.disabled = false;
        }
      });
      item.append(exportButton);
    }
    item.append(ResourceStyleVersionEditor({
      adapter: state.adapter,
      projectId: state.project.id,
      resourceId: resource.id,
      style,
      canUpdate: capabilities.canUpdate && resource.state !== "archived",
      onStyleChange: (updated) => {
        savedIdentity.textContent = `${updated.title} · ${updated.format} · v${updated.versionNumber}`;
      }
    }));
    list.append(item);
  }
  if (!styles.length) list.append(text("li", "No portable style attached."));
  panel.append(list);
  const lastImport = state.lastMapServerStyleImport;
  if (lastImport?.resourceId === resource.id) {
    const losses = lastImport.result.report?.losses?.length ?? 0;
    const removed = lastImport.result.report?.removed_data_bindings?.length ?? 0;
    panel.append(text(
      "p",
      `MapServer import completed with ${losses} declared conversion loss${losses === 1 ? "" : "es"} and ${removed} source binding${removed === 1 ? "" : "s"} removed. MapScript was not executed. Runtime limits: ${lastImport.result.requestLimits.requestsPerMinute} requests/minute, ${lastImport.result.requestLimits.concurrentRequestsPerProject} concurrent requests per project.`,
      "project-resource-feedback"
    ));
  }
  if (!["dataset", "map", "service"].includes(resource.kind)) return panel;
  const slug = labeledInput("Style slug", "default-style", 100);
  const title = labeledInput("Style title", "Default style", 300);
  const format = labeledSelect("Style format", ["maplibre", "geostyler", "sld_1_0", "sld_1_1", "mapserver_mapfile"], "maplibre");
  const definition = labeledTextarea(
    "Detached style definition",
    '{"version":8,"sources":{},"layers":[{"id":"features","type":"line","paint":{"line-color":"#275d52","line-width":2}},{"id":"labels","type":"symbol","layout":{"text-field":["get","name"]},"paint":{"text-color":"#172824","text-halo-color":"#ffffff","text-halo-width":1}}]}',
    49_152
  );
  const attach = text("button", "Attach style", "platform-button");
  attach.type = "button";
  const feedback = text("p", "Definitions are bounded, checksummed, and cannot carry credentials.", "project-resource-feedback");
  const mapfileSample = `MAP
  NAME "imported-layer"
  LAYER
    NAME "imported-layer"
    TYPE LINE
    CLASS
      NAME "Default"
      STYLE
        COLOR 39 93 82
        WIDTH 2
      END
    END
  END
END
`;
  const mapLibreSample = definition.control.value;
  const updateFormat = () => {
    const mapServer = format.control.value === "mapserver_mapfile";
    attach.textContent = mapServer ? "Import Mapfile" : "Attach style";
    feedback.textContent = mapServer
      ? "Source paths and connections are removed; unsupported directives are reported; MapScript is never executed."
      : "Definitions are bounded, checksummed, and cannot carry credentials.";
    if (mapServer && definition.control.value === mapLibreSample) {
      definition.control.value = mapfileSample;
    } else if (!mapServer && definition.control.value === mapfileSample) {
      definition.control.value = mapLibreSample;
    }
  };
  format.control.addEventListener("change", updateFormat);
  attach.addEventListener("click", async () => {
    attach.disabled = true;
    try {
      if (format.control.value === "mapserver_mapfile") {
        if (typeof state.adapter.importMapServerStyle !== "function") {
          throw new Error("mapserver_import_unavailable");
        }
        const result = await state.adapter.importMapServerStyle(state.project.id, resource.id, {
          slug: slug.control.value,
          title: title.control.value,
          mapfile: definition.control.value
        });
        state.lastMapServerStyleImport = {resourceId: resource.id, result};
      } else {
        await state.adapter.createResourceStyle(state.project.id, resource.id, {
          slug: slug.control.value,
          format: format.control.value,
          title: title.control.value,
          definition: definition.control.value
        });
      }
      await openResourceDetail(state, resource.id, detail);
    } catch (error) {
      feedback.textContent = `Style attachment failed safely (${error?.code ?? "unexpected_error"}).`;
      attach.disabled = false;
    }
  });
  panel.append(slug.label, title.label, format.label, definition.label, attach, feedback);
  return panel;
}

function mapServerAdapterMetadata(style) {
  if (style.format !== "maplibre") return null;
  try {
    const document = JSON.parse(style.definition);
    const adapter = document?.metadata?.opengeo?.mapserver_adapter;
    return adapter && typeof adapter === "object" && !Array.isArray(adapter) ? adapter : null;
  } catch {
    return null;
  }
}

function downloadTextArtifact(filename, contents, mediaType) {
  const url = URL.createObjectURL(new Blob([contents], {type: mediaType}));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function resourceRenderEditor(state, resource, styles, profiles, detail) {
  if (resource.kind === "map") return savedMapRenderEditor(state, resource);
  const panel = editorPanel(
    "Deterministic map renders",
    "Exact-version SVG or PNG · on-demand processing"
  );
  panel.append(text(
    "p",
    "Each request snapshots exact resource, dataset, and MapLibre style versions. Queued work activates the existing isolated worker; inactivity keeps compute at zero.",
    "project-resource-feedback"
  ));
  if (!["dataset", "service"].includes(resource.kind) || !resource.datasetId) {
    panel.append(text(
      "p",
      "Available for dataset-bound dataset and service resources; stories and documents may embed the resulting static map without becoming map-only publications.",
      "project-resource-feedback"
    ));
    return panel;
  }
  const list = document.createElement("ul");
  for (const profile of profiles) {
    list.append(text(
      "li",
      `${profile.title} · SVG / PNG · v${profile.versionNumber} · dataset ${shortId(profile.datasetVersionId)} · style ${shortId(profile.styleVersionId)}`
    ));
  }
  if (!profiles.length) list.append(text("li", "No deterministic render profile configured."));
  panel.append(list);

  const mapLibreStyles = styles.filter((style) => style.format === "maplibre");
  if (!profiles.length) {
    if (!mapLibreStyles.length) {
      panel.append(text(
        "p",
        "Attach a MapLibre style above before compiling a bounded server-side render profile.",
        "project-resource-feedback"
      ));
      return panel;
    }
    const slug = labeledInput("Render profile slug", "default-svg", 100);
    const title = labeledInput("Render profile title", "Default SVG map", 300);
    const style = document.createElement("select");
    style.ariaLabel = "Render source style";
    for (const record of mapLibreStyles) {
      const option = document.createElement("option");
      option.value = record.id;
      option.textContent = `${record.title} · v${record.versionNumber}`;
      style.append(option);
    }
    const imported = state.lastMapServerStyleImport?.resourceId === resource.id
      ? state.lastMapServerStyleImport.result
      : null;
    if (imported && mapLibreStyles.some(({id}) => id === imported.activation.styleId)) {
      style.value = imported.activation.styleId;
    }
    const selectedStyle = mapLibreStyles.find(({id}) => id === style.value) ?? mapLibreStyles[0];
    const geometryLayer = labeledInput(
      "Geometry layer id",
      imported?.activation.styleId === selectedStyle.id
        ? imported.activation.geometryLayerId
        : mapLibreLayerIds(selectedStyle).geometry ?? "features",
      100
    );
    const labelLayer = labeledInput(
      "Label layer id (optional)",
      imported?.activation.styleId === selectedStyle.id
        ? imported.activation.labelLayerId ?? ""
        : mapLibreLayerIds(selectedStyle).label ?? "",
      100
    );
    const create = text("button", "Compile render profile", "platform-button");
    create.type = "button";
    const feedback = text(
      "p",
      imported
        ? "The converted MapServer style is validated but inactive. Compile this exact governed profile to activate it; unsupported source semantics remain in its conversion report."
        : "Unsupported MapLibre expressions are rejected explicitly instead of being rendered approximately.",
      "project-resource-feedback"
    );
    style.addEventListener("change", () => {
      const selected = mapLibreStyles.find(({id}) => id === style.value);
      if (!selected) return;
      const ids = mapLibreLayerIds(selected);
      geometryLayer.control.value = imported?.activation.styleId === selected.id
        ? imported.activation.geometryLayerId
        : ids.geometry ?? "features";
      labelLayer.control.value = imported?.activation.styleId === selected.id
        ? imported.activation.labelLayerId ?? ""
        : ids.label ?? "";
    });
    create.addEventListener("click", async () => {
      create.disabled = true;
      feedback.textContent = "Compiling and snapshotting the render profile…";
      try {
        await state.adapter.createRenderProfile(state.project.id, resource.id, {
          slug: slug.control.value.trim(),
          title: title.control.value.trim(),
          styleId: style.value,
          geometryLayerId: geometryLayer.control.value.trim(),
          labelLayerId: labelLayer.control.value.trim() || null,
          minimumScaleDenominator: imported?.activation.styleId === style.value
            ? imported.activation.minimumScaleDenominator
            : null,
          maximumScaleDenominator: imported?.activation.styleId === style.value
            ? imported.activation.maximumScaleDenominator
            : null,
          includeLegend: imported?.activation.styleId === style.value
            ? imported.activation.includeLegend
            : true,
          changeMessage: null
        });
        await openResourceDetail(state, resource.id, detail);
      } catch (error) {
        feedback.textContent = `Render profile failed safely (${error?.code ?? "unexpected_error"}).`;
        create.disabled = false;
      }
    });
    panel.append(
      slug.label,
      title.label,
      labeled("Render source style", style),
      geometryLayer.label,
      labelLayer.label,
      create,
      feedback
    );
    return panel;
  }

  const profile = document.createElement("select");
  profile.ariaLabel = "Render profile";
  for (const record of profiles) {
    const option = document.createElement("option");
    option.value = record.id;
    option.textContent = `${record.title} · v${record.versionNumber}`;
    profile.append(option);
  }
  const extent = resource.spatialExtent ?? [-180, -90, 180, 90];
  const bbox = labeledInput("Render extent (west, south, east, north)", extent.join(", "), 120);
  const format = labeledSelect("Render format", ["svg", "png"], "svg");
  for (const option of format.control.options) option.textContent = option.value.toUpperCase();
  const width = labeledInput("Render width", "1200", 4);
  const height = labeledInput("Render height", "800", 4);
  const request = text("button", "Request SVG render", "platform-button");
  request.type = "button";
  format.control.addEventListener("change", () => {
    request.textContent = `Request ${format.control.value.toUpperCase()} render`;
  });
  const result = document.createElement("div");
  result.className = "project-render-result";
  result.append(text(
    "p",
    "Render requests are idempotent, bounded to 4.2 million pixels, and charged only while work runs.",
    "project-resource-feedback"
  ));
  request.addEventListener("click", async () => {
    request.disabled = true;
    const selectedFormat = format.control.value;
    result.replaceChildren(text("p", `Queueing exact-version ${selectedFormat.toUpperCase()} render…`, "project-resource-feedback"));
    try {
      const job = await state.adapter.requestResourceRender(
        state.project.id,
        resource.id,
        profile.value,
        {
          idempotencyKey: crypto.randomUUID(),
          bbox: bbox.control.value.split(",").map((value) => Number(value.trim())),
          width: Number(width.control.value),
          height: Number(height.control.value),
          format: selectedFormat
        }
      );
      renderJobResult(state, resource, job, result);
    } catch (error) {
      result.replaceChildren(text(
        "p",
        `Render request failed safely (${error?.code ?? "unexpected_error"}).`,
        "project-resource-feedback"
      ));
    } finally {
      request.disabled = false;
    }
  });
  panel.append(
    labeled("Render profile", profile),
    format.label,
    bbox.label,
    width.label,
    height.label,
    request,
    result
  );
  return panel;
}

function savedMapRenderEditor(state, resource) {
  const panel = editorPanel("Deterministic map renders", "Saved composition · exact-version PNG");
  const snapshot = resource.mapSnapshot;
  if (!snapshot) {
    panel.append(text("p",
      "This resource has no recorded map revision. Select a saved revision under Data or map binding before creating a map image.",
      "project-resource-feedback"));
    return panel;
  }
  panel.append(text("p",
    `Create an image of resource v${resource.versionNumber}, bound map v${snapshot.mapVersion}. The saved layer order, styles, extent and background come from that revision, not the latest map. Unsaved metadata edits are not included.`,
    "project-resource-feedback"));
  const history = savedMapRenderHistory(state, resource);
  if (typeof state.adapter.requestSavedMapRender !== "function") {
    panel.append(text("p", "Saved-map image creation is unavailable in this adapter.", "project-resource-feedback"));
    panel.append(history);
    return panel;
  }
  // Keep ambiguous attempts across detail reopening in this workspace. No key,
  // job, or request is created merely by reading the form or job history.
  const attempts = state.savedMapRenderAttempts ??= new Map();
  const width = labeledInput("Render width", "1200", 4);
  const height = labeledInput("Render height", "800", 4);
  for (const {control} of [width, height]) {
    control.type = "number";
    control.min = "64";
    control.max = "2048";
    control.step = "1";
  }
  const request = text("button", "Create map image", "platform-button");
  request.type = "button";
  const result = document.createElement("div");
  result.className = "project-render-result";
  result.ariaLive = "polite";
  result.append(text("p",
    "PNG only · 64–2048 pixels per side, at most 4,194,304 pixels. A matching completed image is reused when its inputs remain unchanged and accessible; otherwise this action starts processing. Inspecting this form does not start work.",
    "project-resource-feedback"));
  request.addEventListener("click", async () => {
    request.disabled = true;
    let submitted = false;
    try {
      const dimensions = [Number(width.control.value), Number(height.control.value)];
      if (dimensions.some((value) => !Number.isSafeInteger(value) || value < 64 || value > 2048)
        || dimensions[0] * dimensions[1] > 4_194_304) {
        throw new TypeError("Choose whole-number dimensions from 64 to 2048 pixels per side.");
      }
      const signature = JSON.stringify([state.organization.id, state.session?.userId, state.project.id,
        resource.id, resource.versionNumber, snapshot.mapVersion, ...dimensions, "png"]);
      const idempotencyKey = attempts.get(signature) ?? crypto.randomUUID();
      attempts.set(signature, idempotencyKey);
      result.replaceChildren(text("p", `Creating PNG for resource v${resource.versionNumber}, map v${snapshot.mapVersion}…`, "project-resource-feedback"));
      submitted = true;
      const job = await state.adapter.requestSavedMapRender(state.project.id, resource.id, {
        idempotencyKey,
        expectedResourceVersion: resource.versionNumber,
        expectedMapVersion: snapshot.mapVersion,
        width: dimensions[0],
        height: dimensions[1],
        format: "png"
      });
      attempts.delete(signature);
      renderJobResult(state, resource, job, result);
    } catch (error) {
      const rejected = Number.isInteger(error?.status) && error.status >= 400 && error.status < 500
        && ![408, 429].includes(error.status);
      const message = !submitted ? "Map image request was not sent."
        : rejected ? "Map image request was rejected."
          : "Image creation could not be confirmed. An image may already be queued. Refresh map images to check, or retry these dimensions with the same request key.";
      result.replaceChildren(text("p",
        `${message} (${error?.code ?? (submitted ? "unconfirmed_request" : "invalid_request")}) ${error?.message ?? "Review the saved map and try again."}`,
        "project-resource-feedback"));
    } finally {
      request.disabled = false;
    }
  });
  panel.append(width.label, height.label, request, result, history);
  return panel;
}

function savedMapRenderHistory(state, resource) {
  const history = document.createElement("div");
  history.className = "project-map-render-history";
  history.append(text("h4", "Existing map images"));
  const feedback = text("p",
    "Refresh to reopen up to 100 recent jobs, including queued work and older revisions. Reading or selecting an image does not create another job.",
    "project-resource-feedback");
  feedback.ariaLive = "polite";
  if (typeof state.adapter.listResourceRenders !== "function") {
    feedback.textContent = "Existing map image history is unavailable in this adapter.";
    history.append(feedback);
    return history;
  }
  const refresh = text("button", "Refresh map images", "platform-button secondary");
  refresh.type = "button";
  const select = document.createElement("select");
  select.ariaLabel = "Existing map image";
  select.disabled = true;
  const placeholder = () => {
    const option = text("option", "Choose an existing map image");
    option.value = "";
    return option;
  };
  select.append(placeholder());
  const result = document.createElement("div");
  result.className = "project-render-history-result";
  result.ariaLive = "polite";
  let jobs = [];
  refresh.addEventListener("click", async () => {
    refresh.disabled = true;
    select.disabled = true;
    feedback.textContent = "Reading existing map images…";
    try {
      const received = await state.adapter.listResourceRenders(state.project.id, resource.id);
      jobs = received.filter(job => job.resourceId === resource.id && job.projectId === state.project.id
        && job.savedMapSnapshot?.mapId === resource.mapId);
      const previous = select.value;
      select.replaceChildren(placeholder());
      for (const job of jobs) {
        const saved = job.savedMapSnapshot;
        const current = saved.resourceVersionNumber === resource.versionNumber
          && saved.mapVersion === resource.mapSnapshot?.mapVersion
          && saved.definitionChecksumSha256 === resource.mapSnapshot?.definitionChecksumSha256;
        const option = text("option",
          `${job.state} · resource v${saved.resourceVersionNumber} / map v${saved.mapVersion} · ${job.width} × ${job.height} ${job.format.toUpperCase()} · ${current ? "current revision" : "different revision"} · ${job.id}`);
        option.value = job.id;
        select.append(option);
      }
      const selected = jobs.find(job => job.id === previous);
      if (selected) {
        select.value = previous;
        renderJobResult(state, resource, selected, result);
      } else result.replaceChildren();
      select.disabled = jobs.length === 0;
      feedback.textContent = jobs.length
        ? `${jobs.length} existing map image jobs. Select one to check its status or authorize its exact download; the new-image form and metadata edits are unchanged.`
        : "No existing map image jobs were found. Creating a new image remains a separate action.";
    } catch (error) {
      result.replaceChildren();
      feedback.textContent = `Existing images could not be refreshed (${error?.code ?? "unexpected_error"}). Retry this read before choosing a prior job.`;
    } finally {
      refresh.disabled = false;
    }
  });
  select.addEventListener("change", () => {
    const job = jobs.find(job => job.id === select.value);
    if (job) renderJobResult(state, resource, job, result);
    else result.replaceChildren();
  });
  history.append(refresh, labeled("Existing map image", select), feedback, result);
  return history;
}

function renderJobResult(state, resource, job, result) {
  const saved = job.savedMapSnapshot;
  const lineage = text(
    "p",
    saved
      ? `State ${job.state} · resource v${saved.resourceVersionNumber} · map v${saved.mapVersion} · ${job.width} × ${job.height} ${job.format.toUpperCase()}`
      : `State ${job.state} · profile v${job.profileVersionNumber} · dataset ${shortId(job.datasetVersionId)} · style ${shortId(job.styleVersionId)}`,
    "project-resource-feedback"
  );
  const checksum = text(
    "p",
    job.outputChecksumSha256
      ? `Output SHA-256 ${job.outputChecksumSha256}`
      : `Request SHA-256 ${job.requestChecksumSha256}`,
    "project-resource-feedback"
  );
  result.replaceChildren(lineage, checksum);
  if (["queued", "running"].includes(job.state)) {
    const refresh = text("button", "Refresh render status", "platform-button secondary");
    refresh.type = "button";
    refresh.addEventListener("click", async () => {
      refresh.disabled = true;
      try {
        renderJobResult(
          state,
          resource,
          await state.adapter.getResourceRender(state.project.id, resource.id, job.id),
          result
        );
      } catch (error) {
        result.append(text(
          "p",
          `Status refresh failed safely (${error?.code ?? "unexpected_error"}).`,
          "project-resource-feedback"
        ));
        refresh.disabled = false;
      }
    });
    result.append(refresh);
  }
  if (job.state === "completed") {
    if (saved) result.append(text("p",
      `Map image ready: ${job.id}. Choose this resource v${saved.resourceVersionNumber} / map v${saved.mapVersion} image when publishing the reviewed site. Creating or downloading it does not publish it.`,
      "project-resource-feedback"));
    if (saved && typeof state.adapter.getProjectArtifactManifest === "function") {
      const manifest = text("button", "Download Artifact manifest", "platform-button secondary");
      manifest.type = "button";
      manifest.addEventListener("click", async () => {
        manifest.disabled = true;
        try {
          const record = await state.adapter.getProjectArtifactManifest(state.project.id, resource.id, job.id);
          downloadTextArtifact(`project-artifact-${job.id}.json`, JSON.stringify(record, null, 2), "application/json");
        } catch (error) {
          result.append(text("p", `Artifact manifest unavailable (${error?.code ?? "unexpected_error"}). No build was started.`, "project-resource-feedback"));
        } finally {
          manifest.disabled = false;
        }
      });
      result.append(manifest);
    }
    const formatLabel = job.format.toUpperCase();
    const authorize = text("button", `Authorize exact ${formatLabel} download`, "platform-button secondary");
    authorize.type = "button";
    authorize.addEventListener("click", async () => {
      authorize.disabled = true;
      try {
        const ticket = await state.adapter.downloadResourceRender(
          state.project.id,
          resource.id,
          job.id
        );
        const link = text("a", `Download exact ${formatLabel}`, "platform-button secondary");
        link.href = ticket.url;
        link.rel = "noopener noreferrer";
        result.append(link);
        authorize.remove();
      } catch (error) {
        result.append(text(
          "p",
          `Download authorization failed safely (${error?.code ?? "unexpected_error"}).`,
          "project-resource-feedback"
        ));
        authorize.disabled = false;
      }
    });
    result.append(authorize);
  }
  if (["failed", "cancelled"].includes(job.state)) {
    result.append(text("p", `No completed image is available (${job.errorCode ?? job.state}). Review the saved map before creating another image.`, "project-resource-feedback"));
  }
}

function mapLibreLayerIds(style) {
  try {
    const definition = JSON.parse(style.definition);
    const layers = Array.isArray(definition.layers) ? definition.layers : [];
    return {
      geometry: layers.find((layer) => ["fill", "line", "circle"].includes(layer?.type))?.id,
      label: layers.find((layer) => layer?.type === "symbol")?.id
    };
  } catch {
    return {};
  }
}

function shortId(value) {
  return String(value).slice(0, 8);
}

function resourcePermissionEditor(state, resource, permissions, capabilities, detail) {
  const panel = editorPanel("Resource access", "View · edit · publish · manage");
  const list = document.createElement("ul");
  for (const permission of permissions) {
    list.append(text("li", `${permission.displayName} · ${permission.role}`));
  }
  if (!permissions.length) list.append(text("li", "No explicit resource grants visible."));
  panel.append(list);
  if (!capabilities.canManagePermissions) {
    panel.append(text(
      "p",
      "Only the resource owner, a project owner, an organization administrator, or a member with resource manage access can change grants.",
      "project-resource-feedback"
    ));
    return panel;
  }
  const userId = labeledInput("Organization member UUID", "", 36);
  const role = labeledSelect("Resource role", ["view", "edit", "publish", "manage"], "view");
  const grant = text("button", "Grant access", "platform-button");
  grant.type = "button";
  const feedback = text("p", "Project roles and resource grants are evaluated independently.", "project-resource-feedback");
  grant.addEventListener("click", async () => {
    grant.disabled = true;
    try {
      await state.adapter.putResourcePermission(
        state.project.id,
        resource.id,
        userId.control.value.trim(),
        role.control.value
      );
      await openResourceDetail(state, resource.id, detail);
    } catch (error) {
      feedback.textContent = `Grant failed safely (${error?.code ?? "unexpected_error"}).`;
      grant.disabled = false;
    }
  });
  panel.append(userId.label, role.label, grant, feedback);
  return panel;
}

function inferredResourceCapabilities(state, resource, permissions) {
  const userId = state.session?.userId;
  const explicitRole = permissions.find((permission) => permission.userId === userId)?.role ?? null;
  const admin = state.organization?.callerRole === "admin";
  const projectRole = state.project?.callerRole;
  const owner = resource.ownerUserId === userId;
  return {
    canRead: true,
    canUpdate: admin
      || owner
      || ["owner", "editor"].includes(projectRole)
      || ["manage", "edit"].includes(explicitRole),
    canPublish: admin
      || projectRole === "owner"
      || ["manage", "publish"].includes(explicitRole),
    canManagePermissions: admin
      || owner
      || projectRole === "owner"
      || explicitRole === "manage"
  };
}

function resourceContentSummary(resource) {
  const panel = editorPanel("Mixed content", `${resource.content?.blocks?.length ?? 0} blocks`);
  const list = document.createElement("ul");
  for (const block of resource.content?.blocks ?? []) list.append(text("li", `${block.type} · ${block.id}`));
  if (!resource.content?.blocks?.length) list.append(text("li", "No content blocks."));
  panel.append(list);
  return panel;
}

function editorPanel(titleValue, boundary) {
  const panel = document.createElement("section");
  panel.className = "project-resource-editor-panel";
  const heading = document.createElement("header");
  heading.append(text("h4", titleValue), text("span", boundary, "project-resources-boundary"));
  panel.append(heading);
  return panel;
}

function labeledInput(labelValue, value, maxLength) {
  const control = input("text", labelValue, "");
  control.value = value;
  control.maxLength = maxLength;
  return {label: labeled(labelValue, control), control};
}

function labeledTextarea(labelValue, value, maxLength) {
  const control = document.createElement("textarea");
  control.ariaLabel = labelValue;
  control.value = value;
  control.maxLength = maxLength;
  return {label: labeled(labelValue, control), control};
}

function labeledSelect(labelValue, values, selected) {
  const control = document.createElement("select");
  control.ariaLabel = labelValue;
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    control.append(option);
  }
  control.value = selected;
  return {label: labeled(labelValue, control), control};
}

function labeled(labelValue, control) {
  const label = document.createElement("label");
  label.append(text("span", labelValue), control);
  return label;
}

function resourceCount(resources = [], qualifier = "governed") {
  return `${resources.length} ${qualifier} resource${resources.length === 1 ? "" : "s"} · datasets, maps, documents, stories, dashboards, and services`;
}

function temporalLabel(resource) {
  if (!resource.temporalStart && !resource.temporalEnd) return "Not declared";
  return `${resource.temporalStart ?? "open"} → ${resource.temporalEnd ?? "open"}`;
}

function select(label, emptyLabel, values) {
  const control = document.createElement("select");
  control.ariaLabel = label;
  for (const [value, textValue] of [["", emptyLabel], ...values.map((value) => [value, value])]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = textValue;
    control.append(option);
  }
  return control;
}

function input(type, label, placeholder) {
  const control = document.createElement("input");
  control.type = type;
  control.ariaLabel = label;
  control.placeholder = placeholder;
  return control;
}

function badge(value) {
  return text("span", value.replaceAll("_", " "), "platform-badge");
}

function fact(label, value) {
  const fragment = document.createDocumentFragment();
  fragment.append(text("dt", label), text("dd", value));
  return fragment;
}

function text(tag, content, className = null) {
  const element = document.createElement(tag);
  element.textContent = content;
  if (className) element.className = className;
  return element;
}

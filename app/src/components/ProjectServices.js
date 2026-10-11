import {TileSeedExtentPicker} from "./TileSeedExtentPicker.js";
import {ServiceConnection} from "./ServiceConnection.js";
import {TileCacheSettings} from "./TileCacheSettings.js";
import {ProjectWmsPublications} from "./ProjectWmsPublications.js";
import {WcsSubsetPreparation} from "./WcsSubsetPreparation.js";

const VECTOR_FORMATS = new Set(["geojson", "shapefile", "geopackage", "geoparquet"]);
const COG_CONTENT_TYPES = new Set(["image/tiff", "image/geotiff"]);

export function ProjectServices({state, refresh}) {
  const section = document.createElement("section");
  section.className = "project-services";
  section.dataset.state = "ready";

  const heading = document.createElement("header");
  heading.className = "project-resources-heading";
  const identity = document.createElement("div");
  identity.append(
    text("p", "Open service publishing", "platform-eyebrow"),
    text("h2", "Administered spatial services"),
    text(
      "p",
      "Immutable feature, render-profile, and exact-COG seals · shared auth.categori.se",
      "platform-subtitle"
    )
  );
  heading.append(
    identity,
    text(
      "p",
      "Feature · map · WebMercatorQuad tile · WCS 2.0.1 exact coverage · candidate OGC API coverage discovery · no coverage conformance claim",
      "project-resources-boundary"
    )
  );
  section.append(heading);
  if (typeof state.adapter.listWmsPublications === "function") {
    section.append(ProjectWmsPublications({state}));
  }

  if (canManage(state)) section.append(serviceCreator(state, refresh));
  const catalog = document.createElement("div");
  catalog.className = "project-service-catalog";
  catalog.append(text("p", "Loading service bindings…", "project-resource-feedback"));
  section.append(catalog);
  let catalogRevision = 0;
  const refreshCatalog = async () => {
    const openDisclosures = new Set(
      [...catalog.querySelectorAll("details[open] > summary")]
        .map((summary) => summary.textContent.trim())
    );
    const revision = ++catalogRevision;
    catalog.dataset.state = "loading";
    await renderCatalog(state, refreshCatalog, catalog, revision, () => catalogRevision);
    if (revision === catalogRevision) {
      for (const summary of catalog.querySelectorAll("details > summary")) {
        if (openDisclosures.has(summary.textContent.trim())) summary.parentElement.open = true;
      }
      catalog.dataset.state = "ready";
    }
  };
  void refreshCatalog();
  return section;
}

function serviceCreator(state, refresh) {
  const panel = document.createElement("section");
  panel.className = "project-resource-editor-panel";
  panel.append(text("h3", "Create project service"));
  const slug = labeledInput("Service identifier", "research-atlas", 100);
  const title = labeledInput("Service title", `${state.project.name} spatial service`, 200);
  const description = labeledInput(
    "Service description",
    "Authenticated feature, map, and tile access for this project.",
    2000
  );
  const submit = button("Create immutable service identifier");
  const feedback = text(
    "p",
    "Identifiers are reserved forever; disabling a service cannot redirect old bookmarks.",
    "project-resource-feedback"
  );
  submit.addEventListener("click", async () => {
    submit.disabled = true;
    feedback.textContent = "Creating governed service…";
    try {
      await state.adapter.createSpatialService(state.project.id, {
        slug: slug.control.value.trim().toLowerCase(),
        title: title.control.value.trim(),
        description: description.control.value.trim() || null
      });
      feedback.textContent = "Service created. Loading its empty collection catalog…";
      await refresh();
    } catch (error) {
      feedback.textContent = `Service creation failed safely (${error?.code ?? "invalid_service"}).`;
      submit.disabled = false;
    }
  });
  panel.append(slug.label, title.label, description.label, submit, feedback);
  return panel;
}

async function renderCatalog(state, refresh, catalog, revision = 0, currentRevision = () => revision) {
  const services = state.spatialServices ?? [];
  if (!services.length) {
    catalog.replaceChildren(text(
      "p",
      "No administered service exists yet. Project owners and editors can create one without adding always-on infrastructure.",
      "project-resource-feedback"
    ));
    return;
  }
  const cards = await Promise.all(services.map(async (service) => {
    try {
      const [bindings, coverages, policy, administration] = await Promise.all([
        state.adapter.listSpatialServiceCollections(
          state.project.id,
          service.id,
          {includeWithdrawn: true}
        ),
        typeof state.adapter.listSpatialServiceCoverages === "function"
          ? state.adapter.listSpatialServiceCoverages(
              state.project.id,
              service.id,
              {includeWithdrawn: true}
            )
          : [],
        typeof state.adapter.getCoverageProcessingPolicy === "function"
          ? state.adapter.getCoverageProcessingPolicy(state.project.id, service.id)
          : null,
        state.adapter.getSpatialServiceCatalog(state.project.id, service.id)
      ]);
      const derivatives = new Map(await Promise.all(coverages.map(async (coverage) => [
        coverage.id,
        typeof state.adapter.listCoverageDerivatives === "function"
          ? await state.adapter.listCoverageDerivatives(
              state.project.id, service.id, coverage.id
            )
          : []
      ])));
      const retiredCaches = new Map(await Promise.all(bindings.map(async (binding) => [
        binding.id,
        typeof state.adapter.listRetiredTileCacheVersions === "function"
          ? await state.adapter.listRetiredTileCacheVersions(
              state.project.id, service.id, binding.id
            )
          : []
      ])));
      const tileCaches = new Map(await Promise.all(bindings.map(async (binding) => [
        binding.id,
        typeof state.adapter.getTileCachePolicy === "function"
          ? await state.adapter.getTileCachePolicy(
              state.project.id, service.id, binding.id
            ).catch((error) => { if (error?.status === 404) return null; throw error; })
          : null
      ])));
      const tileSeedPlans = new Map(await Promise.all(bindings.map(async (binding) => [
        binding.id,
        typeof state.adapter.listTileSeedPlans === "function"
          ? await state.adapter.listTileSeedPlans(
              state.project.id, service.id, binding.id
            ).catch(() => [])
          : []
      ])));
      return serviceCard(
        state, refresh, service, bindings, coverages, derivatives, policy, retiredCaches,
        tileCaches, tileSeedPlans, administration
      );
    } catch (error) {
      const failed = document.createElement("article");
      failed.className = "project-service-card";
      failed.append(
        text("h3", service.title),
        text(
          "p",
          `Collection catalog failed safely (${error?.code ?? "service_catalog_unavailable"}).`,
          "project-resource-feedback"
        )
      );
      return failed;
    }
  }));
  if (revision === currentRevision()) catalog.replaceChildren(...cards);
}

function serviceCard(
  state, refresh, service, bindings, coverages, derivatives, policy, retiredCaches,
  tileCaches, tileSeedPlans, administration
) {
  const card = document.createElement("article");
  card.className = "project-service-card";
  const status = service.disabledAt === null ? "active" : "disabled";
  const header = document.createElement("header");
  header.className = "project-service-card-heading";
  const identity = document.createElement("div");
  identity.append(
    text("p", `${status} · ${service.slug}`, `badge ${status}`),
    text("h3", administration.metadata.title),
    text("p", administration.metadata.abstract ?? "No service abstract", "project-resource-abstract")
  );
  header.append(identity);
  card.append(
    header,
    ServiceConnection({state, service, enabledProtocols: administration.metadata.enabledProtocols}),
    catalogFacts(administration, bindings, coverages),
    disclosure(
      "Catalog configuration",
      catalogAdministration(state, refresh, service, administration, bindings),
      true
    )
  );

  const published = document.createElement("div");
  published.className = "project-service-published";
  published.append(text("h4", "Feature, map, and tile collections"));
  const list = document.createElement("div");
  list.className = "project-service-bindings";
  for (const binding of bindings) {
    const stateLabel = binding.withdrawnAt !== null
      ? "withdrawn"
      : binding.stale
        ? "stale — republish required"
        : "sealed and current";
    const item = document.createElement("details");
    item.className = "project-service-binding";
    item.append(text(
      "summary",
      `${binding.collectionName} · ${stateLabel} · g${binding.sealedFeatureGeneration} / profile v${binding.sealedProfileVersionNumber}`
    ));
    const operations = document.createElement("div");
    operations.className = "project-service-binding-operations";
    operations.append(tileSeedPlanCatalog(
      state,
      refresh,
      service,
      binding,
      tileCaches.get(binding.id) ?? null,
      tileSeedPlans.get(binding.id) ?? []
    ));
    operations.append(tileCacheReclamationCatalog(
      state,
      refresh,
      service,
      binding,
      retiredCaches.get(binding.id) ?? []
    ));
    if (canManage(state) && binding.withdrawnAt === null) {
      const withdraw = button("Withdraw binding", "platform-button secondary");
      withdraw.addEventListener("click", async () => {
        withdraw.disabled = true;
        try {
          await state.adapter.withdrawSpatialServiceCollection(
            state.project.id,
            service.id,
            binding.id
          );
          await refresh();
        } catch (error) {
          operations.append(text(
            "p",
            `Withdrawal failed safely (${error?.code ?? "withdraw_failed"}).`,
            "project-resource-feedback"
          ));
          withdraw.disabled = false;
        }
      });
      operations.append(withdraw);
    }
    item.append(operations);
    list.append(item);
  }
  if (!bindings.length) list.append(text("p", "No collection bindings.", "project-resource-feedback"));
  published.append(list);

  published.append(text("h4", "Exact raster coverages"));
  const coverageList = document.createElement("div");
  coverageList.className = "project-service-bindings";
  for (const coverage of coverages) {
    const stateLabel = coverage.withdrawnAt !== null
      ? "withdrawn"
      : coverage.stale
        ? "stale — republish required"
        : "sealed and current";
    const item = document.createElement("details");
    item.className = "project-service-binding";
    item.append(text(
      "summary",
      `${coverage.coverageName} · ${stateLabel} · dataset v${coverage.sealedDatasetVersionNumber} · ${coverage.width}×${coverage.height}`
    ));
    const operations = document.createElement("div");
    operations.className = "project-service-binding-operations";
    operations.append(text(
      "code",
      `${coverage.bandCount} band${coverage.bandCount === 1 ? "" : "s"} · sha256:${coverage.checksumSha256.slice(0, 16)}…`,
      "project-resource-feedback"
    ));
    operations.append(coverageDerivativeCatalog(
      state,
      refresh,
      service,
      coverage,
      derivatives.get(coverage.id) ?? []
    ));
    if (canManage(state) && coverage.withdrawnAt === null) {
      const withdraw = button("Withdraw coverage", "platform-button secondary");
      withdraw.addEventListener("click", async () => {
        withdraw.disabled = true;
        try {
          await state.adapter.withdrawSpatialServiceCoverage(
            state.project.id,
            service.id,
            coverage.id
          );
          await refresh();
        } catch (error) {
          operations.append(text(
            "p",
            `Coverage withdrawal failed safely (${error?.code ?? "withdraw_failed"}).`,
            "project-resource-feedback"
          ));
          withdraw.disabled = false;
        }
      });
      operations.append(withdraw);
    }
    item.append(operations);
    coverageList.append(item);
  }
  if (!coverages.length) coverageList.append(text("p", "No exact raster coverages.", "project-resource-feedback"));
  published.append(coverageList);
  card.append(disclosure(
    `Published objects · ${bindings.length + coverages.length}`,
    published,
    false
  ));

  if (canManage(state) && service.disabledAt === null) {
    const operations = document.createElement("div");
    operations.className = "project-service-advanced";
    if (policy) {
      operations.append(text(
        "p",
        `Coverage jobs: ${policy.maximumActiveJobsPerCoverage} active / ${policy.maximumRetainedJobsPerCoverage} retained per coverage · ${policy.minimumReclamationAgeHours}-hour minimum reclamation age · read-only requests create no work · idle compute $0.`,
        "project-resource-feedback"
      ));
    }
    operations.append(
      collectionCreator(state, refresh, service),
      coverageCreator(state, refresh, service)
    );
    const disable = button("Disable service", "platform-button secondary");
    disable.addEventListener("click", async () => {
      disable.disabled = true;
      try {
        await state.adapter.disableSpatialService(state.project.id, service.id);
        await refresh();
      } catch (error) {
        operations.append(text(
          "p",
          `Disable failed safely (${error?.code ?? "disable_failed"}).`,
          "project-resource-feedback"
        ));
        disable.disabled = false;
      }
    });
    operations.append(disable);
    card.append(disclosure("Add or retire published objects", operations, false));
  }
  return card;
}

function catalogFacts(catalog, bindings, coverages) {
  const facts = document.createElement("dl");
  facts.className = "project-service-facts";
  for (const [label, value] of [
    ["Stores", catalog.stores.filter((item) => item.disabledAt === null).length],
    ["Collections", bindings.filter((item) => item.withdrawnAt === null).length],
    ["Groups", catalog.layerGroups.filter((item) => item.disabledAt === null).length],
    ["Styles", catalog.styles.filter((item) => item.withdrawnAt === null).length],
    ["Coverages", coverages.filter((item) => item.withdrawnAt === null).length]
  ]) {
    facts.append(text("dt", label), text("dd", String(value)));
  }
  return facts;
}

function disclosure(label, content, open = false) {
  const details = document.createElement("details");
  details.className = "project-service-disclosure";
  details.open = open;
  details.append(text("summary", label), content);
  return details;
}

function catalogAdministration(state, refresh, service, catalog, bindings) {
  const panel = document.createElement("div");
  panel.className = "spatial-catalog-admin";
  panel.append(text(
    "p",
    "Project service = namespace · group order is top-to-bottom · style bindings seal exact governed revisions · bulk API updates are all-or-none.",
    "project-resource-feedback"
  ));
  const sections = document.createElement("div");
  sections.className = "spatial-catalog-sections";
  sections.append(
    disclosure(
      `Metadata · v${catalog.metadata.versionNumber}`,
      catalogMetadataEditor(state, refresh, service, catalog.metadata),
      false
    ),
    disclosure(
      `Stores · ${catalog.stores.filter((item) => item.disabledAt === null).length}`,
      catalogStoreEditor(state, refresh, service, catalog),
      false
    ),
    disclosure(
      `Layer groups · ${catalog.layerGroups.filter((item) => item.disabledAt === null).length}`,
      catalogGroupEditor(state, refresh, service, catalog, bindings),
      false
    ),
    disclosure(
      `Styles · ${catalog.styles.filter((item) => item.withdrawnAt === null).length}`,
      catalogStyleEditor(state, refresh, service, catalog, bindings),
      false
    )
  );
  panel.append(sections);
  return panel;
}

function catalogMetadataEditor(state, refresh, service, metadata) {
  const form = document.createElement("div");
  form.className = "spatial-catalog-form";
  const title = labeledInput("Service title", metadata.title, 200);
  const abstract = labeledTextarea("Abstract", metadata.abstract ?? "", 8000);
  abstract.control.rows = 3;
  const namespace = labeledInput("Namespace URI", metadata.namespaceUri ?? "", 2048);
  const keywords = labeledInput("Keywords (comma separated)", metadata.keywords.join(", "), 1200);
  const constraints = labeledInput(
    "Access constraints (comma separated)", metadata.accessConstraints.join(", "), 1200
  );
  const contactName = labeledInput("Contact name", metadata.contact.name ?? "", 200);
  const contactEmail = labeledInput("Contact email", metadata.contact.email ?? "", 254);
  const protocol = labeledSelect("Published protocols", [
    "ogc_api_features", "wfs_2_0", "wms_1_1", "wms_1_3", "wmts_1_0", "wcs_2_0",
    "arcgis_features"
  ]);
  protocol.control.multiple = true;
  protocol.control.size = 4;
  for (const option of protocol.control.options) {
    option.selected = metadata.enabledProtocols.includes(option.value);
  }
  const submit = button("Save metadata revision");
  const feedback = text(
    "p",
    "Saving creates an immutable revision and updates discovery documents without changing the service URL.",
    "project-resource-feedback"
  );
  submit.disabled = !canManage(state) || service.disabledAt !== null;
  submit.addEventListener("click", async () => {
    submit.disabled = true;
    try {
      await state.adapter.updateSpatialServiceMetadata(state.project.id, service.id, {
        expectedVersion: metadata.versionNumber,
        title: title.control.value.trim(),
        abstract: abstract.control.value.trim() || null,
        namespaceUri: namespace.control.value.trim() || null,
        keywords: commaValues(keywords.control.value),
        fees: metadata.fees,
        accessConstraints: commaValues(constraints.control.value),
        contact: {
          ...(contactName.control.value.trim() ? {name: contactName.control.value.trim()} : {}),
          ...(contactEmail.control.value.trim()
            ? {email: contactEmail.control.value.trim().toLowerCase()}
            : {})
        },
        enabledProtocols: [...protocol.control.selectedOptions].map((option) => option.value),
        changeMessage: "Updated in Studio catalog administration"
      });
      await refresh();
    } catch (error) {
      feedback.textContent = `Metadata update failed safely (${error?.code ?? error?.message ?? "metadata_update_failed"}).`;
      submit.disabled = false;
    }
  });
  form.append(
    title.label, abstract.label, namespace.label, keywords.label, constraints.label,
    contactName.label, contactEmail.label, protocol.label, submit, feedback
  );
  return form;
}

function catalogStoreEditor(state, refresh, service, catalog) {
  const panel = document.createElement("div");
  panel.className = "spatial-catalog-editor";
  const list = document.createElement("div");
  list.className = "spatial-catalog-list";
  for (const store of catalog.stores) {
    const row = document.createElement("div");
    row.className = "spatial-catalog-row";
    row.append(
      text("strong", store.title),
      text(
        "span",
        `${store.slug} · ${store.kind.replaceAll("_", " ")} · ${store.disabledAt ? "disabled" : "active"}`,
        "project-resource-feedback"
      )
    );
    if (canManage(state) && store.disabledAt === null) {
      const disable = button("Disable", "platform-button secondary compact");
      disable.addEventListener("click", async () => {
        disable.disabled = true;
        try {
          await state.adapter.disableSpatialServiceStore(
            state.project.id, service.id, store.id
          );
          await refresh();
        } catch (error) {
          row.append(text(
            "p",
            `Store remains active (${error?.code ?? "store_in_use_or_invalid"}).`,
            "project-resource-feedback"
          ));
          disable.disabled = false;
        }
      });
      row.append(disable);
    }
    list.append(row);
  }
  panel.append(list);
  if (!canManage(state) || service.disabledAt !== null) return panel;

  const creator = document.createElement("div");
  creator.className = "spatial-catalog-form";
  const kind = labeledSelect("Store kind", [
    {value: "managed_project", label: "Managed project"},
    {value: "external_source", label: "Verified external source"},
    {value: "postgresql_connection", label: "Verified PostgreSQL connection"}
  ]);
  const slug = labeledInput("Store identifier", "source-store", 100);
  const title = labeledInput("Store title", "Source store", 200);
  const targetId = labeledInput("Dataset or connection UUID", "", 36);
  const revision = labeledInput("Verified revision", "", 12);
  const configuration = labeledTextarea("Configuration JSON", "{}", 8192);
  configuration.control.rows = 2;
  const submit = button("Create store");
  const feedback = text(
    "p",
    "External stores accept only an exact verified source or read-only PostgreSQL connection revision.",
    "project-resource-feedback"
  );
  submit.addEventListener("click", async () => {
    submit.disabled = true;
    try {
      const selectedKind = kind.control.value;
      const selectedRevision = revision.control.value.trim()
        ? Number(revision.control.value)
        : null;
      await state.adapter.createSpatialServiceStore(state.project.id, service.id, {
        slug: slug.control.value.trim().toLowerCase(),
        title: title.control.value.trim(),
        description: null,
        kind: selectedKind,
        datasetId: selectedKind === "external_source" ? targetId.control.value.trim() : null,
        externalConnectionId: selectedKind === "postgresql_connection"
          ? targetId.control.value.trim()
          : null,
        sealedSourceRevisionNumber: selectedKind === "external_source"
          ? selectedRevision
          : null,
        sealedConnectionRevisionNumber: selectedKind === "postgresql_connection"
          ? selectedRevision
          : null,
        configuration: JSON.parse(configuration.control.value)
      });
      await refresh();
    } catch (error) {
      feedback.textContent = `Store creation failed safely (${error?.code ?? error?.message ?? "store_invalid"}).`;
      submit.disabled = false;
    }
  });
  creator.append(
    kind.label, slug.label, title.label, targetId.label, revision.label,
    configuration.label, submit, feedback
  );
  panel.append(disclosure("Add verified store", creator, false));
  return panel;
}

function catalogGroupEditor(state, refresh, service, catalog, bindings) {
  const panel = document.createElement("div");
  panel.className = "spatial-catalog-editor";
  const active = bindings.filter((binding) => binding.withdrawnAt === null);
  for (const group of catalog.layerGroups) {
    panel.append(disclosure(
      `${group.title} · v${group.versionNumber}${group.disabledAt ? " · disabled" : ""}`,
      layerGroupForm(state, refresh, service, active, group),
      false
    ));
  }
  if (canManage(state) && service.disabledAt === null && active.length) {
    panel.append(disclosure(
      "Create layer group",
      layerGroupForm(state, refresh, service, active, null),
      false
    ));
  }
  if (!active.length) panel.append(text(
    "p", "Publish a feature collection before creating a group.", "project-resource-feedback"
  ));
  return panel;
}

function layerGroupForm(state, refresh, service, bindings, group) {
  const form = document.createElement("div");
  form.className = "spatial-catalog-form";
  const slug = labeledInput("Group identifier", group?.slug ?? "map-layers", 100);
  slug.control.disabled = Boolean(group);
  const title = labeledInput("Group title", group?.title ?? "Map layers", 300);
  const mode = labeledSelect("Mode", [
    "named", "single", "opaque_container", "container", "earth_observation"
  ]);
  mode.control.value = group?.mode ?? "named";
  const ordered = [...(group?.memberCollectionIds ?? [])];
  const memberList = document.createElement("div");
  memberList.className = "spatial-catalog-member-order";
  const drawMembers = () => {
    const remaining = bindings.filter((binding) => !ordered.includes(binding.id));
    memberList.replaceChildren();
    for (const binding of [
      ...ordered.map((id) => bindings.find((candidate) => candidate.id === id)).filter(Boolean),
      ...remaining
    ]) {
      const selected = ordered.includes(binding.id);
      const row = document.createElement("div");
      row.className = "spatial-catalog-member";
      row.dataset.selected = String(selected);
      row.append(text("span", binding.collectionName));
      const toggle = button(selected ? "Remove" : "Add", "platform-button secondary compact");
      toggle.addEventListener("click", () => {
        if (selected) ordered.splice(ordered.indexOf(binding.id), 1);
        else ordered.push(binding.id);
        drawMembers();
      });
      row.append(toggle);
      if (selected) {
        const index = ordered.indexOf(binding.id);
        const up = button("↑", "platform-button secondary compact");
        up.title = "Draw one position higher";
        up.disabled = index === 0;
        up.addEventListener("click", () => {
          [ordered[index - 1], ordered[index]] = [ordered[index], ordered[index - 1]];
          drawMembers();
        });
        const down = button("↓", "platform-button secondary compact");
        down.title = "Draw one position lower";
        down.disabled = index === ordered.length - 1;
        down.addEventListener("click", () => {
          [ordered[index], ordered[index + 1]] = [ordered[index + 1], ordered[index]];
          drawMembers();
        });
        row.append(up, down);
      }
      memberList.append(row);
    }
  };
  drawMembers();
  const submit = button(group ? "Save group revision" : "Create group");
  const feedback = text(
    "p", "The first selected collection draws on top.", "project-resource-feedback"
  );
  submit.disabled = !canManage(state) || service.disabledAt !== null || Boolean(group?.disabledAt);
  submit.addEventListener("click", async () => {
    submit.disabled = true;
    try {
      await state.adapter.putSpatialServiceLayerGroup(
        state.project.id,
        service.id,
        slug.control.value.trim().toLowerCase(),
        {
          expectedVersion: group?.versionNumber ?? 0,
          title: title.control.value.trim(),
          description: group?.description ?? null,
          mode: mode.control.value,
          memberCollectionIds: ordered,
          changeMessage: "Updated ordered group in Studio"
        }
      );
      await refresh();
    } catch (error) {
      feedback.textContent = `Layer group failed safely (${error?.code ?? error?.message ?? "group_invalid"}).`;
      submit.disabled = false;
    }
  });
  form.append(slug.label, title.label, mode.label, text("p", "Top → bottom", "platform-eyebrow"), memberList, submit, feedback);
  if (group && group.disabledAt === null && canManage(state)) {
    const disable = button("Disable group", "platform-button secondary");
    disable.addEventListener("click", async () => {
      disable.disabled = true;
      try {
        await state.adapter.disableSpatialServiceLayerGroup(
          state.project.id, service.id, group.id
        );
        await refresh();
      } catch (error) {
        feedback.textContent = `Group disable failed safely (${error?.code ?? "group_disable_failed"}).`;
        disable.disabled = false;
      }
    });
    form.append(disable);
  }
  return form;
}

function catalogStyleEditor(state, refresh, service, catalog, bindings) {
  const panel = document.createElement("div");
  panel.className = "spatial-catalog-editor";
  const names = new Map(bindings.map((binding) => [binding.id, binding.collectionName]));
  const list = document.createElement("div");
  list.className = "spatial-catalog-list";
  for (const style of catalog.styles) {
    const row = document.createElement("div");
    row.className = "spatial-catalog-row";
    row.append(
      text("strong", `${names.get(style.collectionId) ?? "Collection"} · ${style.styleName}`),
      text(
        "span",
        `${style.isDefault ? "default" : "alternate"} · style v${style.sealedStyleVersionNumber} · profile ${style.sealedProfileVersionNumber == null ? "not bound" : `v${style.sealedProfileVersionNumber}`} · ${style.withdrawnAt ? "withdrawn" : style.stale ? "stale" : style.consumable ? "renderable" : "metadata only"}`,
        "project-resource-feedback"
      )
    );
    if (canManage(state) && !style.isDefault && style.withdrawnAt === null) {
      const withdraw = button("Withdraw", "platform-button secondary compact");
      withdraw.addEventListener("click", async () => {
        withdraw.disabled = true;
        try {
          await state.adapter.withdrawSpatialServiceCollectionStyle(
            state.project.id, service.id, style.id
          );
          await refresh();
        } catch (error) {
          row.append(text(
            "p", `Style withdrawal failed safely (${error?.code ?? "style_withdraw_failed"}).`,
            "project-resource-feedback"
          ));
          withdraw.disabled = false;
        }
      });
      row.append(withdraw);
    }
    list.append(row);
  }
  panel.append(list);
  if (canManage(state) && service.disabledAt === null && bindings.length) {
    panel.append(disclosure(
      "Assign governed style revision",
      styleAssignmentForm(state, refresh, service, bindings),
      false
    ));
  }
  return panel;
}

function styleAssignmentForm(state, refresh, service, bindings) {
  const form = document.createElement("div");
  form.className = "spatial-catalog-form";
  const active = bindings.filter((binding) => binding.withdrawnAt === null);
  const collection = labeledSelect(
    "Collection",
    active.map((binding) => ({value: binding.id, label: binding.collectionName}))
  );
  const style = labeledSelect("Governed style", []);
  const profile = labeledSelect("Exact render profile", []);
  const styleName = labeledInput("Published style name", "alternate", 100);
  const defaultLabel = document.createElement("label");
  defaultLabel.className = "spatial-catalog-check";
  const makeDefault = document.createElement("input");
  makeDefault.type = "checkbox";
  defaultLabel.append(makeDefault, document.createTextNode(" Replace the default style"));
  const feedback = text(
    "p", "Only styles owned by the collection’s governed resource are eligible.",
    "project-resource-feedback"
  );
  let availableStyles = [];
  let availableProfiles = [];
  const drawProfiles = () => {
    replaceOptions(profile.control, availableProfiles
      .filter((record) => record.styleId === style.control.value)
      .map((record) => ({
        value: record.id,
        label: `${record.title} · v${record.versionNumber}`
      })));
    for (const option of profile.control.options) {
      option.dataset.version = String(
        availableProfiles.find((record) => record.id === option.value)?.versionNumber ?? ""
      );
    }
  };
  const loadStyles = async () => {
    replaceOptions(style.control, []);
    replaceOptions(profile.control, []);
    const binding = active.find((candidate) => candidate.id === collection.control.value);
    if (!binding) return;
    try {
      [availableStyles, availableProfiles] = await Promise.all([
        state.adapter.listResourceStyles(state.project.id, binding.resourceId),
        state.adapter.listRenderProfiles(state.project.id, binding.resourceId)
      ]);
      replaceOptions(style.control, availableStyles.map((record) => ({
        value: record.id,
        label: `${record.title} · ${record.format} v${record.versionNumber}`
      })));
      for (const option of style.control.options) {
        option.dataset.version = String(
          availableStyles.find((record) => record.id === option.value)?.versionNumber ?? ""
        );
      }
      drawProfiles();
    } catch (error) {
      feedback.textContent = `Styles and profiles failed safely (${error?.code ?? "style_profile_list_failed"}).`;
    }
  };
  collection.control.addEventListener("change", () => void loadStyles());
  style.control.addEventListener("change", drawProfiles);
  void loadStyles();
  const submit = button("Seal style revision");
  submit.addEventListener("click", async () => {
    submit.disabled = true;
    try {
      await state.adapter.assignSpatialServiceCollectionStyle(
        state.project.id,
        service.id,
        collection.control.value,
        {
          styleName: styleName.control.value.trim().toLowerCase(),
          styleId: style.control.value,
          expectedStyleVersion: Number(style.control.selectedOptions[0]?.dataset.version),
          renderProfileId: profile.control.value,
          expectedProfileVersion: Number(
            profile.control.selectedOptions[0]?.dataset.version
          ),
          isDefault: makeDefault.checked
        }
      );
      await refresh();
    } catch (error) {
      feedback.textContent = `Style assignment failed safely (${error?.code ?? error?.message ?? "style_invalid"}).`;
      submit.disabled = false;
    }
  });
  form.append(
    collection.label, style.label, profile.label, styleName.label, defaultLabel, submit, feedback
  );
  return form;
}

function commaValues(value) {
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

function tileSeedPlanCatalog(state, refresh, service, binding, policy, plans) {
  const section = document.createElement("section");
  section.className = "project-resource-editor-panel tile-seed-plan-catalog";
  section.append(
    TileCacheSettings({state, service, binding, policy, refresh}),
    text("h5", "Bounded WMTS seed plans"),
    text(
      "p",
      "Preview is read-only. Activation is explicit confirmation only: it reserves quota, publishes exact cache coordinates, and wakes the existing render workers. GetTile, cache misses, page views, and timers create no work; inactive compute cost is $0.",
      "project-resource-feedback"
    )
  );
  if (!policy) {
    section.append(text(
      "p",
      "Save tile cache settings above before preparing tiles.",
      "project-resource-feedback"
    ));
    return section;
  }
  section.append(text(
    "p",
    `Current generation ${policy.versionNumber} · zoom ${policy.minimumTileMatrix}–${policy.maximumTileMatrix} · ${policy.currentEntries}/${policy.maximumEntries} exact coordinates.`,
    "project-resource-feedback"
  ));
  const list = document.createElement("ul");
  list.className = "project-service-bindings tile-seed-plan-list";
  for (const plan of plans) {
    const item = document.createElement("li");
    item.append(text(
      "span",
      `${plan.state} · ${plan.targetCount} target${plan.targetCount === 1 ? "" : "s"} · ${plan.existingCount} already cached · generation ${plan.cacheVersionNumber}`
    ));
    if (plan.errorCode) {
      item.append(text("p", `Plan result: ${plan.errorCode}`, "project-resource-feedback"));
    }
    if (canManage(state) && plan.cancelAvailable) {
      const cancel = button("Cancel before dispatch", "platform-button secondary");
      cancel.addEventListener("click", async () => {
        cancel.disabled = true;
        try {
          await state.adapter.cancelTileSeedPlan(
            state.project.id, service.id, binding.id, plan.id
          );
          await refresh();
        } catch (error) {
          item.append(text(
            "p",
            `Cancellation failed safely (${error?.code ?? "tile_seed_cancel_failed"}). Once exact cache entries are published, cancellation is closed.`,
            "project-resource-feedback"
          ));
        }
      });
      item.append(cancel);
    }
    list.append(item);
  }
  if (!plans.length) list.append(text("li", "No seed plan has been confirmed."));
  section.append(list);

  if (canManage(state) && binding.withdrawnAt === null && !binding.stale) {
    let pendingConfirmation = null;
    const coordinates = labeledTextarea(
      "Exact tiles (one z,row,col coordinate per line; at most 64)",
      "0,0,0\n1,0,0",
      1200
    );
    const previewButton = button("Preview exact tile seed plan");
    const feedback = text(
      "p",
      "Nothing is queued until the checksum-bound preview is explicitly confirmed.",
      "project-resource-feedback"
    );
    previewButton.addEventListener("click", async () => {
      try {
        const tiles = coordinates.control.value.split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => {
            const values = line.split(",").map((value) => Number(value.trim()));
            if (values.length !== 3 || values.some((value) => !Number.isSafeInteger(value))) {
              throw new TypeError("Each line must contain three integers: z,row,col.");
            }
            return {tileMatrix: values[0], tileRow: values[1], tileCol: values[2]};
          });
        const selector = {
          expectedCacheVersion: policy.versionNumber,
          mode: "tiles",
          tiles
        };
        await previewSelector(selector, previewButton);
      } catch (error) {
        feedback.textContent = `Preview failed safely (${error?.code ?? error?.message ?? "tile_seed_preview_failed"}). No render work was created.`;
        previewButton.disabled = false;
      }
    });
    const extentPicker = TileSeedExtentPicker({policy});
    const extentPreviewButton = button("Preview drawn extent seed plan");
    extentPreviewButton.addEventListener("click", async () => {
      try {
        await previewSelector(extentPicker.getSelector(), extentPreviewButton);
      } catch (error) {
        feedback.textContent = `Extent preview failed safely (${error?.code ?? error?.message ?? "tile_seed_extent_preview_failed"}). No render work was created.`;
        extentPreviewButton.disabled = false;
      }
    });
    section.append(
      coordinates.label,
      previewButton,
      extentPicker,
      extentPreviewButton,
      feedback
    );

    async function previewSelector(selector, sourceButton) {
      sourceButton.disabled = true;
      pendingConfirmation?.remove();
      pendingConfirmation = null;
      const preview = await state.adapter.previewTileSeedPlan(
        state.project.id, service.id, binding.id, selector
      );
      feedback.textContent = preview.targetCount
        ? `${preview.targetCount} exact tile${preview.targetCount === 1 ? "" : "s"} will be queued; ${preview.existingCount} already exist. Preview expires ${new Date(preview.expiresAt).toLocaleString()}.`
        : "Every requested coordinate already exists; there is no work to confirm.";
      if (!preview.targetCount) {
        sourceButton.disabled = false;
        return;
      }
      const confirm = button(
        "Confirm and activate render workers",
        "platform-button secondary"
      );
      pendingConfirmation = confirm;
      confirm.addEventListener("click", async () => {
        confirm.disabled = true;
        try {
          await state.adapter.confirmTileSeedPlan(
            state.project.id, service.id, binding.id, selector, preview
          );
          await refresh();
        } catch (error) {
          feedback.textContent = `Confirmation failed safely (${error?.code ?? "tile_seed_confirmation_failed"}). Request a fresh preview before retrying.`;
          confirm.disabled = false;
        }
      });
      section.append(confirm);
    }
  }
  return section;
}

function tileCacheReclamationCatalog(state, refresh, service, binding, versions) {
  const section = document.createElement("section");
  section.className = "project-resource-editor-panel";
  section.append(
    text("h5", "Retired WMTS render outputs"),
    text(
      "p",
      "Only outputs from retired cache generations that are at least 24 hours old, absent from current profiles/caches, and absent from every resource or site seal can be reclaimed. Reads and timers never queue deletion; inactive fixed-cost change is $0.",
      "project-resource-feedback"
    )
  );
  const list = document.createElement("ul");
  list.className = "project-service-bindings";
  for (const version of versions) {
    const item = document.createElement("li");
    const status = version.reclamationState
      ? ` · reclamation ${version.reclamationState} (${version.reclamationCompletedCount} completed / ${version.reclamationFailedCount} failed)`
      : "";
    item.append(text(
      "span",
      `cache generation ${version.cacheVersionNumber} · retired ${new Date(version.retiredAt).toLocaleString()} · ${version.entryCount} entries / ${version.renderOutputCount} render outputs${status}`
    ));
    if (
      canManage(state)
      && version.renderOutputCount > 0
      && !["queued", "running"].includes(version.reclamationState)
    ) {
      const previewButton = button(
        "Preview retired-cache reclamation",
        "platform-button secondary"
      );
      previewButton.addEventListener("click", async () => {
        previewButton.disabled = true;
        try {
          const preview = await state.adapter.previewTileCacheReclamation(
            state.project.id,
            service.id,
            binding.id,
            version.cacheVersionId
          );
          const details = text(
            "p",
            `Will delete ${preview.targetCount} exact storage version${preview.targetCount === 1 ? "" : "s"} totaling ${preview.targetSizeBytes.toLocaleString()} bytes. Render jobs, cache generations, coordinates, and audit history remain. ${preview.remainingEligibleTargetCount} additional eligible output${preview.remainingEligibleTargetCount === 1 ? "" : "s"} will require another bounded batch. Preview expires ${new Date(preview.expiresAt).toLocaleString()}.`,
            "project-resource-feedback"
          );
          const confirmButton = button(
            "Confirm exact render-version deletion",
            "platform-button secondary"
          );
          confirmButton.addEventListener("click", async () => {
            confirmButton.disabled = true;
            try {
              const reclamation = await state.adapter.reclaimTileCacheOutputs(
                state.project.id,
                service.id,
                binding.id,
                version.cacheVersionId,
                preview
              );
              item.firstElementChild.textContent = `cache generation ${version.cacheVersionNumber} · retired ${new Date(version.retiredAt).toLocaleString()} · ${version.entryCount} entries / ${version.renderOutputCount} render outputs · reclamation ${reclamation.state} (${reclamation.completedTargetCount} completed / ${reclamation.failedTargetCount} failed)`;
              item.dataset.reclamationState = reclamation.state;
              details.remove();
              confirmButton.remove();
            } catch (error) {
              item.append(text(
                "p",
                `Cache reclamation confirmation failed safely (${error?.code ?? "cache_reclamation_failed"}). Request a fresh preview before retrying.`,
                "project-resource-feedback"
              ));
              confirmButton.disabled = false;
            }
          });
          item.append(details, confirmButton);
          previewButton.remove();
        } catch (error) {
          item.append(text(
            "p",
            `Cache reclamation preview failed safely (${error?.code ?? "cache_reclamation_preview_failed"}). Current profile generations, live cache entries, and any resource/site seals remain protected.`,
            "project-resource-feedback"
          ));
          previewButton.disabled = false;
        }
      });
      item.append(previewButton);
    }
    list.append(item);
  }
  if (!versions.length) list.append(text("li", "No retired tile-cache generation."));
  section.append(list);
  return section;
}

function coverageDerivativeCatalog(state, refresh, service, coverage, derivatives) {
  const section = document.createElement("section");
  section.className = "project-resource-editor-panel";
  section.append(text("h5", "Explicit COG derivatives"));
  const list = document.createElement("ul");
  list.className = "project-service-bindings";
  for (const job of derivatives) {
    const item = document.createElement("li");
    item.append(text(
      "span",
      `${job.state} · ${job.targetCrs} · ${job.targetWidth}×${job.targetHeight} · bands ${job.bandIndexes.join(",")} · ${job.scaleMode} · ${job.resampling}`
    ));
    item.append(text(
      "code",
      `request sha256:${job.requestChecksumSha256.slice(0, 16)}…`,
      "project-resource-feedback"
    ));
    if (job.errorCode) {
      item.append(text("p", `Worker result: ${job.errorCode}`, "project-resource-feedback"));
    }
    if (job.reclamationState) {
      item.append(text(
        "p",
        `Physical reclamation: ${job.reclamationState}. Derivative history remains retained.`,
        "project-resource-feedback"
      ));
    }
    if (job.state === "completed" && job.sourceAvailable && job.outputAvailable) {
      const authorize = button("Authorize exact derivative download", "platform-button secondary");
      authorize.addEventListener("click", async () => {
        authorize.disabled = true;
        try {
          const ticket = await state.adapter.downloadCoverageDerivative(
            state.project.id, service.id, coverage.id, job.id
          );
          const link = text("a", "Download derivative COG", "platform-button secondary");
          link.href = ticket.url;
          link.rel = "noopener noreferrer";
          link.referrerPolicy = "no-referrer";
          item.append(link);
          authorize.remove();
        } catch (error) {
          item.append(text(
            "p",
            `Download authorization failed safely (${error?.code ?? "download_failed"}).`,
            "project-resource-feedback"
          ));
          authorize.disabled = false;
        }
      });
      item.append(authorize);
    }
    if (
      job.state === "completed" && job.outputAvailable && canManage(state)
      && !["queued", "running", "completed"].includes(job.reclamationState)
    ) {
      const previewButton = button(
        "Preview physical reclamation",
        "platform-button secondary"
      );
      previewButton.addEventListener("click", async () => {
        previewButton.disabled = true;
        try {
          const preview = await state.adapter.previewCoverageDerivativeReclamation(
            state.project.id, service.id, coverage.id, job.id
          );
          const details = text(
            "p",
            `Will delete the exact ${preview.sizeBytes.toLocaleString()}-byte COG whose checksum begins ${preview.checksumSha256.slice(0, 16)}…. The derivative request and result metadata remain. Preview expires ${new Date(preview.expiresAt).toLocaleString()}.`,
            "project-resource-feedback"
          );
          const confirmButton = button(
            "Confirm exact-version deletion",
            "platform-button secondary"
          );
          confirmButton.addEventListener("click", async () => {
            confirmButton.disabled = true;
            try {
              const reclamation = await state.adapter.reclaimCoverageDerivative(
                state.project.id, service.id, coverage.id, job.id, preview
              );
              item.append(text(
                "p",
                `Physical reclamation: ${reclamation.state}. Derivative history remains retained.`,
                "project-resource-feedback"
              ));
              item.dataset.reclamationState = reclamation.state;
              details.remove();
              confirmButton.remove();
            } catch (error) {
              item.append(text(
                "p",
                `Reclamation confirmation failed safely (${error?.code ?? "reclamation_failed"}). Request a fresh preview before retrying.`,
                "project-resource-feedback"
              ));
              confirmButton.disabled = false;
            }
          });
          item.append(details, confirmButton);
          previewButton.remove();
        } catch (error) {
          item.append(text(
            "p",
            `Reclamation preview failed safely (${error?.code ?? "reclamation_preview_failed"}). Outputs must be complete, unreferenced, and old enough.`,
            "project-resource-feedback"
          ));
          previewButton.disabled = false;
        }
      });
      item.append(previewButton);
    }
    if (job.state === "queued" && canManage(state)) {
      const cancel = button("Cancel queued derivative", "platform-button secondary");
      cancel.addEventListener("click", async () => {
        cancel.disabled = true;
        try {
          await state.adapter.cancelCoverageDerivative(
            state.project.id, service.id, coverage.id, job.id
          );
          await refresh();
        } catch (error) {
          item.append(text(
            "p",
            `Cancellation failed safely (${error?.code ?? "cancel_failed"}). Running work cannot be cancelled by this bounded operation.`,
            "project-resource-feedback"
          ));
          cancel.disabled = false;
        }
      });
      item.append(cancel);
    }
    list.append(item);
  }
  if (!derivatives.length) list.append(text("li", "No derivative has been requested."));
  section.append(list);
  section.append(WcsSubsetPreparation({state, service, coverage, refresh}));
  if (
    canManage(state) && service.disabledAt === null
    && coverage.withdrawnAt === null && !coverage.stale
  ) {
    section.append(coverageDerivativeCreator(state, refresh, service, coverage));
  }
  return section;
}

function coverageDerivativeCreator(state, refresh, service, coverage) {
  const fieldset = document.createElement("fieldset");
  fieldset.append(text("legend", "Subset, scale, or reproject to a new COG"));
  const west = labeledInput("West", String(coverage.extent[0]), 32);
  const south = labeledInput("South", String(coverage.extent[1]), 32);
  const east = labeledInput("East", String(coverage.extent[2]), 32);
  const north = labeledInput("North", String(coverage.extent[3]), 32);
  const targetCrs = labeledInput(
    "Target CRS",
    coverage.crs === "EPSG:4326"
      ? "EPSG:3857"
      : /^EPSG:[1-9][0-9]{2,7}$/.test(coverage.crs)
        ? coverage.crs
        : "EPSG:4326",
    100
  );
  const scaleMode = labeledSelect("Scale input", [
    {value: "size", label: "Output width and height"},
    {value: "resolution", label: "Maximum source-CRS units per pixel"}
  ]);
  const width = labeledInput("Width", String(Math.max(1, Math.ceil(coverage.width / 2))), 4);
  const height = labeledInput(
    "Height", String(Math.max(1, Math.ceil(coverage.height / 2))), 4
  );
  const resolutionX = labeledInput(
    "Resolution X",
    String((coverage.extent[2] - coverage.extent[0]) / Math.max(1, Math.ceil(coverage.width / 2))),
    32
  );
  const resolutionY = labeledInput(
    "Resolution Y",
    String((coverage.extent[3] - coverage.extent[1]) / Math.max(1, Math.ceil(coverage.height / 2))),
    32
  );
  const bandIndexes = labeledInput(
    "Source bands",
    Array.from({length: coverage.bandCount}, (_, index) => index + 1).join(","),
    191
  );
  const resampling = labeledSelect("Resampling", ["nearest", "bilinear", "cubic"]);
  const submit = button("Queue bounded derivative");
  const feedback = text(
    "p",
    "Only this button queues activation-only GDAL work. Catalog and coverage GET requests never create processing; inactive fixed-cost delta is $0.",
    "project-resource-feedback"
  );
  submit.addEventListener("click", async () => {
    submit.disabled = true;
    feedback.textContent = "Sealing the request and dispatching the existing activation-only worker…";
    try {
      const useResolution = scaleMode.control.value === "resolution";
      const bands = bandIndexes.control.value.split(",").map((value) => Number(value.trim()));
      await state.adapter.createCoverageDerivative(
        state.project.id,
        service.id,
        coverage.id,
        {
          subsetExtent: [west, south, east, north].map((field) => Number(field.control.value)),
          targetCrs: useResolution ? coverage.crs : targetCrs.control.value.trim(),
          ...(useResolution
            ? {resolution: [Number(resolutionX.control.value), Number(resolutionY.control.value)]}
            : {width: Number(width.control.value), height: Number(height.control.value)}),
          bandIndexes: bands,
          resampling: resampling.control.value
        }
      );
      feedback.textContent = "Derivative request accepted. Repeated identical requests reuse it.";
      await refresh();
    } catch (error) {
      feedback.textContent = `Derivative request failed safely (${error?.code ?? error?.message ?? "invalid_request"}).`;
      submit.disabled = false;
    }
  });
  fieldset.append(
    west.label,
    south.label,
    east.label,
    north.label,
    targetCrs.label,
    scaleMode.label,
    width.label,
    height.label,
    resolutionX.label,
    resolutionY.label,
    bandIndexes.label,
    resampling.label,
    submit,
    feedback
  );
  return fieldset;
}

function coverageCreator(state, refresh, service) {
  const fieldset = document.createElement("fieldset");
  fieldset.className = "project-resource-editor-panel";
  fieldset.append(text("legend", "Seal a WCS whole-coverage COG"));
  const datasets = (state.datasets ?? []).filter(
    (dataset) => dataset.status === "active"
      && dataset.currentVersionState === "active"
      && dataset.format === "cog"
      && dataset.currentVersionId
      && dataset.currentVersionNumber
  );
  const dataset = labeledSelect(
    "Validated current COG dataset",
    datasets.map((record) => ({value: record.id, label: record.name}))
  );
  const name = labeledInput("Coverage identifier", "published-raster", 100);
  const title = labeledInput("Coverage title", "Published raster", 300);
  const submit = button("Seal exact current COG");
  submit.disabled = datasets.length === 0;
  const feedback = text(
    "p",
    datasets.length
      ? "WCS whole-coverage retrieval remains exact and read-only. Subset, range, scale, and reprojection require a separate explicit derivative request."
      : "No active validated COG is available. Upload and finish COG ingestion first.",
    "project-resource-feedback"
  );
  submit.addEventListener("click", async () => {
    submit.disabled = true;
    feedback.textContent = "Resolving the current version and exact original object…";
    try {
      const selected = datasets.find((record) => record.id === dataset.control.value);
      if (!selected?.currentVersionId || !selected.currentVersionNumber) {
        throw new Error("coverage_target_required");
      }
      const versions = await state.adapter.listDatasetVersions(
        state.project.id,
        selected.id,
        {limit: 50}
      );
      const version = versions.find(
        (record) => record.current
          && record.state === "active"
          && record.id === selected.currentVersionId
          && record.versionNumber === selected.currentVersionNumber
      );
      const source = version?.objects.find(
        (object) => object.role === "original" && COG_CONTENT_TYPES.has(object.contentType)
      );
      if (!version || !source) throw new Error("coverage_original_unavailable");
      await state.adapter.createSpatialServiceCoverage(
        state.project.id,
        service.id,
        {
          coverageName: name.control.value.trim().toLowerCase(),
          datasetId: selected.id,
          datasetVersionId: version.id,
          dataObjectId: source.id,
          expectedDatasetVersion: version.versionNumber,
          title: title.control.value.trim(),
          description: null
        }
      );
      feedback.textContent = "Exact COG coverage seal created.";
      await refresh();
    } catch (error) {
      feedback.textContent = `Coverage seal failed safely (${error?.code ?? error?.message ?? "invalid_target"}).`;
      submit.disabled = false;
    }
  });
  fieldset.append(dataset.label, name.label, title.label, submit, feedback);
  return fieldset;
}

function collectionCreator(state, refresh, service) {
  const fieldset = document.createElement("fieldset");
  fieldset.className = "project-resource-editor-panel";
  fieldset.append(text("legend", "Seal a feature, map, and tile collection"));
  const datasets = (state.datasets ?? []).filter(
    (dataset) => dataset.status === "active" && VECTOR_FORMATS.has(dataset.format)
  );
  const dataset = labeledSelect(
    "Authoritative feature dataset",
    datasets.map((record) => ({value: record.id, label: record.name}))
  );
  const resource = labeledSelect("Published map resource", []);
  const profile = labeledSelect("Current render profile", []);
  const name = labeledInput("Collection identifier", "published-features", 100);
  const title = labeledInput("Collection title", "Published features", 300);
  const submit = button("Seal current generations");
  const feedback = text(
    "p",
    "The API rechecks both heads atomically. Later edits make this binding stale instead of silently changing it.",
    "project-resource-feedback"
  );

  const updateResources = async () => {
    const candidates = (state.resources ?? []).filter(
      (record) => record.datasetId === dataset.control.value
        && ["dataset", "service"].includes(record.kind)
        && record.state === "published"
    );
    replaceOptions(resource.control, candidates.map(
      (record) => ({value: record.id, label: record.title})
    ));
    await updateProfiles();
  };
  const updateProfiles = async () => {
    replaceOptions(profile.control, []);
    if (!resource.control.value) return;
    try {
      const profiles = await state.adapter.listRenderProfiles(
        state.project.id,
        resource.control.value
      );
      replaceOptions(profile.control, profiles.map(
        (record) => ({
          value: record.id,
          label: `${record.title} · v${record.versionNumber}`,
          versionNumber: record.versionNumber
        })
      ));
      for (const option of profile.control.options) {
        const match = profiles.find((record) => record.id === option.value);
        option.dataset.version = String(match?.versionNumber ?? "");
      }
    } catch (error) {
      feedback.textContent = `Profiles failed safely (${error?.code ?? "profile_list_failed"}).`;
    }
  };
  dataset.control.addEventListener("change", () => void updateResources());
  resource.control.addEventListener("change", () => void updateProfiles());
  void updateResources();

  submit.disabled = datasets.length === 0;
  submit.addEventListener("click", async () => {
    submit.disabled = true;
    feedback.textContent = "Reading feature generation and sealing current targets…";
    try {
      if (!dataset.control.value || !resource.control.value || !profile.control.value) {
        throw new Error("service_target_required");
      }
      const page = await state.adapter.listFeatures(
        state.project.id,
        dataset.control.value,
        {limit: 1, offset: 0}
      );
      const selectedProfile = profile.control.selectedOptions[0];
      await state.adapter.createSpatialServiceCollection(
        state.project.id,
        service.id,
        {
          collectionName: name.control.value.trim().toLowerCase(),
          datasetId: dataset.control.value,
          resourceId: resource.control.value,
          defaultProfileId: profile.control.value,
          expectedFeatureGeneration: page.collection.generation,
          expectedProfileVersion: Number(selectedProfile.dataset.version),
          title: title.control.value.trim(),
          description: null
        }
      );
      feedback.textContent = "Collection seal created.";
      await refresh();
    } catch (error) {
      feedback.textContent = `Collection seal failed safely (${error?.code ?? error?.message ?? "invalid_target"}).`;
      submit.disabled = false;
    }
  });
  fieldset.append(
    dataset.label,
    resource.label,
    profile.label,
    name.label,
    title.label,
    submit,
    feedback
  );
  return fieldset;
}

function canManage(state) {
  return state.organization.callerRole === "admin"
    || ["owner", "editor"].includes(state.project.callerRole);
}

function labeledInput(labelText, value, maxLength) {
  const label = document.createElement("label");
  label.textContent = labelText;
  const control = document.createElement("input");
  control.value = value;
  control.maxLength = maxLength;
  label.append(control);
  return {label, control};
}

function labeledTextarea(labelText, value, maxLength) {
  const label = document.createElement("label");
  label.textContent = labelText;
  const control = document.createElement("textarea");
  control.value = value;
  control.maxLength = maxLength;
  control.rows = 4;
  control.ariaLabel = labelText;
  label.append(control);
  return {label, control};
}

function labeledSelect(labelText, values) {
  const label = document.createElement("label");
  label.textContent = labelText;
  const control = document.createElement("select");
  control.ariaLabel = labelText;
  replaceOptions(control, values);
  label.append(control);
  return {label, control};
}

function replaceOptions(select, values) {
  const options = values.map((value) => {
    const normalized = typeof value === "string" ? {value, label: value} : value;
    const option = document.createElement("option");
    option.value = normalized.value;
    option.textContent = normalized.label;
    return option;
  });
  if (!options.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No eligible target";
    options.push(option);
  }
  select.replaceChildren(...options);
}

function button(value, className = "platform-button") {
  const control = text("button", value, className);
  control.type = "button";
  return control;
}

function text(tag, value, className = "") {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  return element;
}

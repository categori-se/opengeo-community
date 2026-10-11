const CONFIGURATION_SCHEMA = "opengeo.geonode-federation-configuration.1.0.0";
const GEONODE_VERSION = "5.1.0";
const GEONODE_COMMIT = "a1db97e81dfc26c16bb4ee1a5d2b408877af66c9";

export function ProjectFederations({state}) {
  const panel = document.createElement("details");
  panel.className = "project-federations";
  panel.id = "federated-catalogs";
  panel.open = globalThis.location?.hash === "#federated-catalogs";
  const summary = document.createElement("summary");
  const title = text("strong", "Federated catalogs");
  const status = text("span", "GeoNode catalogs · load on demand", "platform-subtitle");
  summary.append(title, status);
  const body = document.createElement("section");
  body.className = "project-federations-body";
  body.append(text(
    "p",
    "Connect an anonymous GeoNode 5.1 catalog to this project. Remote identities, provenance, freshness, harvest history, and withdrawals remain governed records; remote content is not silently copied.",
    "platform-subtitle"
  ));
  panel.append(summary, body);

  if (typeof state.adapter.listGeoNodeFederations !== "function") {
    body.append(text(
      "p",
      "Federated catalog administration is not available in this local fixture.",
      "project-resource-feedback"
    ));
    status.textContent = "GeoNode catalogs · unavailable in this adapter";
    return panel;
  }

  let loaded = false;
  let revision = 0;
  panel.addEventListener("toggle", () => {
    if (panel.open && !loaded) void loadSources();
  });
  if (panel.open) void loadSources();
  return panel;

  async function loadSources() {
    loaded = true;
    const requestedRevision = ++revision;
    status.textContent = "Loading authorized GeoNode catalogs…";
    const loading = text("p", "Loading catalog registrations…", "project-resource-feedback");
    body.replaceChildren(
      federationIntroduction(),
      loading
    );
    try {
      const sources = await state.adapter.listGeoNodeFederations(
        state.project.id,
        {limit: 100}
      );
      if (requestedRevision !== revision) return;
      renderSources(sources);
    } catch (error) {
      if (requestedRevision !== revision) return;
      status.textContent = "GeoNode catalogs · temporarily unavailable";
      loading.textContent = `Catalog registrations could not be loaded (${errorCode(error)}).`;
      const retry = button("Retry", "platform-button secondary");
      retry.addEventListener("click", () => void loadSources());
      body.append(retry);
    }
  }

  function renderSources(sources) {
    const activeCount = sources.filter(({status}) => status === "active").length;
    status.textContent = `${sources.length} catalog${sources.length === 1 ? "" : "s"} · ${activeCount} active`;
    const list = document.createElement("div");
    list.className = "project-federation-list";
    for (const source of sources) list.append(sourceCard(source));
    if (!sources.length) {
      list.append(text(
        "p",
        "No GeoNode catalog is connected to this project.",
        "project-datasets-empty"
      ));
    }
    body.replaceChildren(federationIntroduction());
    if (canManage(state)) body.append(connectionForms());
    body.append(list);
  }

  function sourceCard(source) {
    const card = document.createElement("article");
    card.className = "project-federation-card";
    card.dataset.sourceId = source.sourceId;
    const harvester = source.configuration.harvester;
    const heading = document.createElement("header");
    const identity = document.createElement("div");
    identity.append(
      text("h4", harvester.name),
      externalLink(harvester.remote_url)
    );
    heading.append(identity, badge(source.status));

    const facts = document.createElement("dl");
    facts.className = "project-federation-facts";
    facts.append(
      fact("Contract", `GeoNode ${GEONODE_VERSION} · anonymous`),
      fact("Bound", `${harvester.maximum_resources} resources · one page`),
      fact(
        "Refresh preference",
        harvester.scheduling_enabled
          ? `Every ${formatInterval(harvester.refresh_interval_minutes)} · manual trigger required`
          : "Manual only"
      ),
      fact("Config seal", `sha256:${source.configurationChecksumSha256.slice(0, 16)}…`)
    );

    const actions = document.createElement("div");
    actions.className = "project-federation-actions";
    const inspect = button("Inspect catalog", "platform-button secondary");
    const details = document.createElement("section");
    details.className = "project-federation-inspection";
    details.hidden = true;
    inspect.addEventListener("click", async () => {
      details.hidden = !details.hidden;
      inspect.textContent = details.hidden ? "Inspect catalog" : "Hide catalog";
      if (!details.hidden && !details.dataset.loaded) {
        await loadSourceDetails(source, details);
      }
    });
    actions.append(inspect, exactConfiguration(source.configuration));

    if (canManage(state) && source.status === "active") {
      const refresh = button("Refresh now", "platform-button");
      refresh.addEventListener("click", async () => {
        refresh.disabled = true;
        refresh.textContent = "Queueing…";
        try {
          await state.adapter.createGeoNodeHarvest(state.project.id, source.sourceId, {
            idempotencyKey: randomUuid()
          });
          details.hidden = false;
          inspect.textContent = "Hide catalog";
          delete details.dataset.loaded;
          await loadSourceDetails(source, details);
        } catch (error) {
          details.replaceChildren(text(
            "p",
            `Refresh was not queued (${errorCode(error)}).`,
            "project-resource-feedback"
          ));
          details.hidden = false;
        } finally {
          refresh.disabled = false;
          refresh.textContent = "Refresh now";
        }
      });
      const disable = button("Disable", "platform-button secondary");
      disable.addEventListener("click", async () => {
        disable.disabled = true;
        try {
          await state.adapter.disableGeoNodeFederation(state.project.id, source.sourceId);
          await loadSources();
        } catch (error) {
          details.replaceChildren(text(
            "p",
            `Catalog was not disabled (${errorCode(error)}).`,
            "project-resource-feedback"
          ));
          details.hidden = false;
          disable.disabled = false;
        }
      });
      actions.append(refresh, disable);
    }
    card.append(heading, facts, actions, details);
    return card;
  }

  async function loadSourceDetails(source, container) {
    container.hidden = false;
    container.dataset.state = "loading";
    container.replaceChildren(text(
      "p", "Loading resources and harvest history…", "project-resource-feedback"
    ));
    try {
      const [resources, jobs] = await Promise.all([
        state.adapter.listGeoNodeFederatedResources(
          state.project.id, source.sourceId, {limit: 100}
        ),
        state.adapter.listGeoNodeHarvests(
          state.project.id, source.sourceId, {limit: 20}
        )
      ]);
      container.replaceChildren(
        resourceCatalog(source, resources),
        harvestCatalog(source, jobs)
      );
      container.dataset.loaded = "true";
      container.dataset.state = "ready";
    } catch (error) {
      container.dataset.state = "error";
      container.replaceChildren(text(
        "p",
        `Catalog details could not be loaded (${errorCode(error)}).`,
        "project-resource-feedback"
      ));
      const retry = button("Retry details", "platform-button secondary");
      retry.addEventListener("click", () => void loadSourceDetails(source, container));
      container.append(retry);
    }
  }

  function resourceCatalog(source, resources) {
    const section = document.createElement("section");
    const current = resources.filter(({status}) => status === "current").length;
    section.append(
      text("h5", `Remote resources · ${current} current · ${resources.length - current} withdrawn`),
      text(
        "p",
        "Freshness is evaluated per identity. Version history is append-only and loaded only when requested.",
        "project-resource-feedback"
      )
    );
    const list = document.createElement("div");
    list.className = "project-federated-resource-list";
    for (const resource of resources) {
      const record = document.createElement("article");
      record.className = "project-federated-resource";
      const freshness = resource.status === "withdrawn"
        ? "withdrawn"
        : Date.parse(resource.freshUntil) >= Date.now()
          ? "fresh"
          : "stale";
      const identity = document.createElement("div");
      identity.append(
        text("strong", resource.title),
        text(
          "span",
          `${resource.resourceType} · v${resource.currentVersionNumber} · ${freshness} until ${formatTimestamp(resource.freshUntil)}`
        )
      );
      const history = button("History", "platform-button secondary");
      const versions = document.createElement("div");
      versions.className = "project-federated-resource-history";
      versions.hidden = true;
      history.addEventListener("click", async () => {
        versions.hidden = !versions.hidden;
        if (versions.hidden || versions.dataset.loaded) return;
        history.disabled = true;
        versions.replaceChildren(text("p", "Loading immutable versions…"));
        try {
          const rows = await state.adapter.listGeoNodeFederatedResourceVersions(
            state.project.id,
            source.sourceId,
            resource.remoteIdentifier,
            {limit: 100}
          );
          const list = document.createElement("ol");
          for (const version of rows) {
            list.append(text(
              "li",
              `v${version.versionNumber} · ${version.action} · ${formatTimestamp(version.observedAt)} · sha256:${version.payloadSha256.slice(0, 12)}…`
            ));
          }
          if (!rows.length) list.append(text("li", "No version records."));
          versions.replaceChildren(list);
          versions.dataset.loaded = "true";
        } catch (error) {
          versions.replaceChildren(text(
            "p", `History could not be loaded (${errorCode(error)}).`
          ));
        } finally {
          history.disabled = false;
        }
      });
      record.append(identity, badge(freshness), history, versions);
      list.append(record);
    }
    if (!resources.length) list.append(text("p", "No remote identities have been harvested."));
    section.append(list);
    return section;
  }

  function harvestCatalog(source, jobs) {
    const section = document.createElement("section");
    section.append(text("h5", `Harvest history · ${jobs.length}`));
    const list = document.createElement("ol");
    list.className = "project-federation-harvests";
    for (const job of jobs) {
      const item = document.createElement("li");
      const counts = job.result?.reconciliation ?? job.result?.counts ?? null;
      const result = counts
        ? ` · +${counts.added ?? 0} ~${counts.updated ?? 0} =${counts.unchanged ?? 0} −${counts.withdrawn ?? 0}`
        : "";
      item.append(text(
        "span",
        `${job.state} · ${formatTimestamp(job.createdAt)} · attempt ${job.attemptCount}${result}`
      ));
      if (canManage(state) && job.cancellable) {
        const cancel = button("Cancel", "platform-button secondary");
        cancel.addEventListener("click", async () => {
          cancel.disabled = true;
          try {
            await state.adapter.cancelGeoNodeHarvest(
              state.project.id, source.sourceId, job.jobId
            );
            await loadSources();
          } catch (error) {
            item.append(text("span", `Cancellation failed (${errorCode(error)}).`));
            cancel.disabled = false;
          }
        });
        item.append(cancel);
      }
      list.append(item);
    }
    if (!jobs.length) list.append(text("li", "No harvest has been requested."));
    section.append(list);
    return section;
  }

  function connectionForms() {
    const forms = document.createElement("details");
    forms.className = "project-federation-connect";
    const summary = document.createElement("summary");
    summary.textContent = "Connect a GeoNode catalog";
    const guided = guidedConnectionForm();
    const exact = exactImportForm();
    forms.append(summary, guided, exact);
    return forms;
  }

  function guidedConnectionForm() {
    const form = document.createElement("form");
    form.className = "project-federation-form";
    const name = input("text", "Catalog name", "Regional GeoNode");
    name.required = true;
    name.maxLength = 100;
    const url = input("url", "GeoNode HTTPS URL", "https://geonode.example.org");
    url.required = true;
    url.maxLength = 2_048;
    const interval = input("number", "Refresh interval in minutes", "1440");
    interval.min = "60";
    interval.max = "10080";
    interval.required = true;
    const maximum = input("number", "Maximum resources", "100");
    maximum.min = "1";
    maximum.max = "100";
    maximum.required = true;
    const scheduling = input("checkbox", "Record scheduled refresh preference");
    const scheduleField = document.createElement("label");
    scheduleField.className = "project-federation-checkbox";
    scheduleField.append(scheduling, text("span", "Record a scheduled-refresh preference"));
    const submit = button("Connect catalog", "platform-button");
    submit.type = "submit";
    const feedback = text(
      "p",
      "Anonymous HTTPS only. A scheduling preference does not create a timer or always-on compute; use Refresh now.",
      "project-resource-feedback platform-field-wide"
    );
    form.append(
      field("Name", name),
      field("GeoNode URL", url),
      field("Refresh preference (minutes)", interval),
      field("Resource limit", maximum),
      scheduleField,
      submit,
      feedback
    );
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      submit.disabled = true;
      feedback.textContent = "Registering exact GeoNode 5.1 configuration…";
      try {
        await state.adapter.createGeoNodeFederation(
          state.project.id,
          configuration({
            name: name.value,
            remoteUrl: url.value,
            schedulingEnabled: scheduling.checked,
            refreshIntervalMinutes: Number(interval.value),
            maximumResources: Number(maximum.value)
          })
        );
        await loadSources();
      } catch (error) {
        feedback.textContent = `Catalog was not connected (${errorCode(error)}). No credential was stored.`;
        submit.disabled = false;
      }
    });
    return form;
  }

  function exactImportForm() {
    const details = document.createElement("details");
    details.className = "project-federation-import";
    const summary = document.createElement("summary");
    summary.textContent = "Import exact configuration JSON";
    const form = document.createElement("form");
    const source = document.createElement("textarea");
    source.ariaLabel = "Exact GeoNode federation configuration JSON";
    source.placeholder = JSON.stringify(configuration({
      name: "Regional GeoNode",
      remoteUrl: "https://geonode.example.org",
      schedulingEnabled: false,
      refreshIntervalMinutes: 1440,
      maximumResources: 100
    }), null, 2);
    const submit = button("Import exact configuration", "platform-button secondary");
    submit.type = "submit";
    const feedback = text(
      "p",
      "Only the sealed OpenGeo Studio GeoNode 5.1 configuration schema is accepted. Secret-bearing fields are rejected.",
      "project-resource-feedback"
    );
    form.append(field("Configuration JSON", source), submit, feedback);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      submit.disabled = true;
      try {
        const value = JSON.parse(source.value);
        await state.adapter.createGeoNodeFederation(state.project.id, value);
        await loadSources();
      } catch (error) {
        feedback.textContent = `Configuration was not imported (${errorCode(error)}).`;
        submit.disabled = false;
      }
    });
    details.append(summary, form);
    return details;
  }
}

function federationIntroduction() {
  return text(
    "p",
    "Project data · external catalog identity · bounded manual refresh",
    "project-federation-boundary"
  );
}

function exactConfiguration(configuration) {
  const details = document.createElement("details");
  details.className = "project-federation-export";
  const summary = document.createElement("summary");
  summary.textContent = "Exact config";
  const code = document.createElement("pre");
  const serialized = JSON.stringify(configuration, null, 2);
  code.textContent = serialized;
  const download = document.createElement("a");
  download.className = "platform-button secondary";
  download.href = `data:application/json;charset=utf-8,${encodeURIComponent(serialized)}`;
  download.download = "opengeo-geonode-federation.json";
  download.textContent = "Download JSON";
  details.append(summary, code, download);
  return details;
}

function configuration({
  name,
  remoteUrl,
  schedulingEnabled,
  refreshIntervalMinutes,
  maximumResources
}) {
  return {
    schema_version: CONFIGURATION_SCHEMA,
    source: {
      product: "geonode",
      version: GEONODE_VERSION,
      commit: GEONODE_COMMIT
    },
    harvester: {
      name: String(name).trim(),
      remote_url: canonicalUrl(remoteUrl),
      scheduling_enabled: Boolean(schedulingEnabled),
      refresh_interval_minutes: refreshIntervalMinutes,
      maximum_resources: maximumResources,
      credential_mode: "anonymous"
    }
  };
}

function canonicalUrl(value) {
  const url = new URL(String(value).trim());
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw Object.assign(new TypeError("GeoNode URL must be anonymous HTTPS"), {
      code: "geonode_federation_url_invalid"
    });
  }
  return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
}

function externalLink(url) {
  const link = document.createElement("a");
  link.href = url;
  link.textContent = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

function canManage(state) {
  return state.organization.callerRole === "admin"
    || ["owner", "editor"].includes(state.project.callerRole);
}

function randomUuid() {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw Object.assign(new Error("secure_uuid_unavailable"), {code: "secure_uuid_unavailable"});
  }
  return globalThis.crypto.randomUUID();
}

function formatInterval(minutes) {
  if (minutes % 1_440 === 0) {
    const days = minutes / 1_440;
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${minutes} minutes`;
}

function formatTimestamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "unknown time" : date.toLocaleString();
}

function errorCode(error) {
  return error?.code ?? (error instanceof SyntaxError ? "invalid_json" : "unexpected_error");
}

function fact(label, value) {
  const fragment = document.createDocumentFragment();
  fragment.append(text("dt", label), text("dd", value));
  return fragment;
}

function field(label, control) {
  const wrapper = document.createElement("label");
  wrapper.append(text("span", label), control);
  return wrapper;
}

function input(type, ariaLabel, value = "") {
  const control = document.createElement("input");
  control.type = type;
  control.ariaLabel = ariaLabel;
  control.value = value;
  return control;
}

function badge(value) {
  return text("span", value, `badge ${String(value).toLowerCase().replaceAll(" ", "-")}`);
}

function button(label, className) {
  const control = text("button", label, className);
  control.type = "button";
  return control;
}

function text(tag, value, className = "") {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  return element;
}

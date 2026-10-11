import {SERVICE_CONNECTION_PROTOCOLS, serviceConnectionTarget, serviceConnectionUrl, readServiceConnection} from "../lib/serviceConnection.js";

export function ServiceConnection({state, service, enabledProtocols = [], projectWms = false}) {
  const panel = document.createElement("details");
  panel.className = "service-connection";
  const summary = document.createElement("summary");
  summary.textContent = "Connect & preview";
  const label = document.createElement("label");
  label.textContent = "Service protocol";
  const protocol = document.createElement("select");
  protocol.setAttribute("aria-label", "Service protocol");
  for (const {value, label} of SERVICE_CONNECTION_PROTOCOLS) {
    if ((value === "wms") !== projectWms) continue;
    const option = document.createElement("option");
    option.value = value;
    const enabled = value === "wms" || value === "ogc" || enabledProtocols.includes(value === "wcs" ? "wcs_2_0" : "wmts_1_0");
    option.disabled = !enabled;
    option.textContent = enabled ? label : `${label} (not enabled)`;
    protocol.append(option);
  }
  label.append(protocol);
  const addressLabel = document.createElement("label");
  addressLabel.textContent = "Connection URL";
  const address = document.createElement("input");
  address.readOnly = true;
  addressLabel.append(address);
  const guidance = document.createElement("p");
  guidance.textContent = "This service requires your account and project access. In a GIS client, configure authentication separately and send the X-OpenGeo-Organization header with your organization ID. The URL contains no credentials; opening it in an ordinary browser tab does not sign you in.";
  const organization = document.createElement("p");
  organization.textContent = `Organization ID: ${state.organization.id ?? "Select an organization"}`;
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "platform-button secondary";
  copy.textContent = "Copy connection URL";
  const preview = document.createElement("button");
  preview.type = "button";
  preview.className = "platform-button secondary";
  preview.textContent = "Preview service document";
  const feedback = document.createElement("p");
  feedback.setAttribute("role", "status");
  const documentView = document.createElement("pre");
  documentView.tabIndex = 0;
  documentView.setAttribute("aria-label", "Service document");
  documentView.hidden = true;
  let revision = 0;
  let controller = null;
  const available = state.adapter.kind === "api" && typeof state.adapter.requestResponse === "function" && !service.disabledAt;
  function reset() {
    revision++;
    controller?.abort();
    documentView.textContent = "";
    documentView.hidden = true;
    feedback.textContent = available ? "Preview reads metadata only; it does not publish data or start processing." : "A preview requires an active service and a connected API session.";
    preview.disabled = !available;
    copy.disabled = !available;
    address.value = available ? serviceConnectionUrl(state.adapter.baseUrl, serviceConnectionTarget(state.project.id, service.slug, protocol.value), window.location.href) : "";
  }
  protocol.addEventListener("change", reset);
  panel.addEventListener("toggle", () => {if (!panel.open) reset();});
  copy.addEventListener("click", async () => {
    const current = revision;
    try {
      await window.navigator.clipboard.writeText(address.value);
      if (current === revision) feedback.textContent = "Connection URL copied. Credentials were not copied.";
    } catch {
      if (current !== revision) return;
      address.focus();
      address.select();
      feedback.textContent = "Copy is unavailable here. The connection URL is selected for manual copying.";
    }
  });
  preview.addEventListener("click", async () => {
    const current = ++revision;
    controller?.abort();
    controller = new AbortController();
    const activeController = controller;
    const timeout = setTimeout(() => activeController.abort(), 30_000);
    preview.disabled = true;
    documentView.hidden = true;
    documentView.textContent = "";
    feedback.textContent = "Loading service metadata…";
    try {
      const result = await readServiceConnection(state.adapter, state.project.id, service.slug, protocol.value, {signal: activeController.signal});
      if (current !== revision || !panel.isConnected || !panel.open) return;
      documentView.textContent = result.content;
      documentView.hidden = false;
      feedback.textContent = `${result.mediaType} · ${result.bytes.toLocaleString()} bytes. This preview uses your current access.`;
    } catch (error) {
      if (current !== revision || !panel.isConnected || !panel.open) return;
      feedback.textContent = error.status === 401 ? "Sign in again to preview this service."
        : [403, 404].includes(error.status) ? "This service is unavailable or your account no longer has access."
        : activeController.signal.aborted ? "The preview timed out. Try again when the service is ready."
        : "The service document could not be previewed. Try again.";
    } finally {
      clearTimeout(timeout);
      if (current === revision) preview.disabled = !available;
    }
  });
  reset();
  panel.append(summary, label, addressLabel, copy, guidance, organization, preview, feedback, documentView);
  return panel;
}

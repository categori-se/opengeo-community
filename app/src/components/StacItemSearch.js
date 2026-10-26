import {createStacItemClient} from "../lib/stacItemSearch.js";
import {cogReferenceDefaultBands} from "../lib/cogReference.js";
import {StacSourceComparison} from "./StacSourceComparison.js";

export function StacItemSearch({client = createStacItemClient(), onReference = null, adapter = null} = {}) {
  const root = element("details"); root.className = "platform-stac-item-search platform-static-item-search";
  root.append(element("summary", "Search external STAC Items"),
    element("p", "Search an external STAC endpoint using Collection IDs, bounds and UTC dates. Bounding extents identify candidates; they do not prove coverage of your area."),
    element("p", "Search reads metadata only. It does not establish imagery access or permission to analyse an asset."));
  const form = element("form"); form.className = "platform-controls";
  const endpoint = input("url", "STAC search endpoint", "https://earth-search.aws.element84.com/v1/search"); endpoint.maxLength = 2048;
  const collections = input("text", "Collection IDs (comma separated)", "sentinel-2-l2a"); collections.maxLength = 1000;
  const bbox = input("text", "STAC bounds west, south, east, north", "85.533, 27.6119167, 85.5340833, 27.613");
  const start = input("datetime-local", "STAC start (UTC)", "2021-10-01T00:00");
  const end = input("datetime-local", "STAC end (UTC)", "2021-10-31T23:59");
  start.step = end.step = "any";
  const limit = input("number", "Items per page", "1"); limit.min = "1"; limit.max = "20"; limit.step = "1";
  const controls = [endpoint, collections, bbox, start, end, limit];
  for (const control of controls) {const label = element("label", control.ariaLabel); label.append(control); form.append(label);}
  const search = element("button", "Search Items"); search.type = "submit";
  const cancel = element("button", "Cancel"); cancel.type = "button"; cancel.disabled = true;
  form.append(search, cancel);
  const status = element("p", "Search reads metadata only. It does not establish imagery access or permission to analyse an asset.");
  status.setAttribute("role", "status"); status.ariaLive = "polite";
  const results = element("div"), next = element("button", "Next page"); next.type = "button"; next.hidden = true;
  root.append(form, element("p", "Search and deliberate pages share a limit of 3 metadata requests, 3 MiB and 30 seconds, with at most 60 Items."), status, results, next);
  let controller = null, generation = 0, disposed = false, page = null, scope = null;
  const comparison = StacSourceComparison({onReference, guardCurrent: async () => {
    const ticket = generation;
    try {return Boolean(page) && await guard(scope, ticket);}
    catch (error) {failure(error, ticket); return false;}
  }});
  root.append(comparison);
  const live = ticket => !disposed && generation === ticket && !controller?.signal.aborted && root.isConnected;
  function clearResults() {
    for (const panel of results.querySelectorAll(".static-item-registration")) panel.dispose?.();
    results.replaceChildren(); next.hidden = true;
    comparison.reset();
  }
  function invalidate(message) {
    controller?.abort(); generation++; page = scope = null; clearResults();
    search.disabled = disposed; cancel.disabled = true; next.disabled = false; form.removeAttribute("aria-busy");
    if (message) status.textContent = message;
  }
  async function captureContext() {
    if (!adapter?.tokenProvider && !adapter?.organizationProvider) return null;
    if (typeof adapter.tokenProvider !== "function" || typeof adapter.organizationProvider !== "function"
      || typeof adapter.assertCollectionContext !== "function") throw Error("Sign-in scope is unavailable. Reopen Catalog before continuing.");
    const context = {tokenProvider: adapter.tokenProvider, organizationProvider: adapter.organizationProvider, baseUrl: adapter.baseUrl,
      token: await adapter.tokenProvider(), organization: String(await adapter.organizationProvider()).toLowerCase()};
    await adapter.assertCollectionContext(context); return context;
  }
  async function guard(context, ticket) {
    if (!live(ticket)) return false;
    if (context) await adapter.assertCollectionContext(context);
    return live(ticket);
  }
  function failure(error, ticket) {
    if (!live(ticket)) return;
    invalidate(/context_changed|scope_changed/.test(error?.code ?? "")
      ? "Your sign-in or selected account changed. Search again in the current account."
      : error?.message || "The external STAC endpoint could not be searched.");
  }
  for (const control of controls) for (const event of ["input", "change"]) control.addEventListener(event, () => {
    if (!disposed) invalidate("Search to apply these filters.");
  });
  cancel.addEventListener("click", () => {if (!disposed) invalidate("Search cancelled. Your Catalog and Projects are unchanged.");});
  async function run(append = false) {
    if (disposed || !root.isConnected || !form.reportValidity() || (append && !page?.next)) return;
    const previous = page, previousScope = scope;
    controller?.abort(); controller = new AbortController(); const ticket = ++generation, signal = controller.signal;
    page = null; clearResults(); search.disabled = next.disabled = true; cancel.disabled = false; form.setAttribute("aria-busy", "true");
    status.textContent = append ? "Reading the next page of Item metadata…" : "Searching Item metadata…";
    try {
      const context = append ? previousScope : await captureContext();
      if (!await guard(context, ticket)) return;
      const options = {signal, onStatus: message => {if (live(ticket)) status.textContent = message;}};
      const result = append ? await client.next(previous, options) : await client.search({endpoint: endpoint.value.trim(),
        collections: collections.value.split(",").map(value => value.trim()).filter(Boolean),
        bbox: bbox.value.split(",").map(value => value.trim() ? Number(value) : NaN), start: utc(start.value), end: utc(end.value), limit: Number(limit.value)}, options);
      if (!await guard(context, ticket)) return;
      page = result; scope = context; render(result, ticket, context);
    } catch (error) {failure(error, ticket);}
    finally {if (live(ticket)) {search.disabled = next.disabled = false; cancel.disabled = true; form.removeAttribute("aria-busy");}}
  }
  function render(result, ticket, context) {
    const items = result.items ?? [], usage = result.usage ?? {}, snapshot = result.snapshot ?? {};
    comparison.reset(result.query ?? items[0]?.query);
    status.textContent = `${items.length} Item${items.length === 1 ? "" : "s"} shown. ${result.complete ? "The provider returned no further page." : "Results are incomplete."} ${(result.issues ?? []).join(" ")}`;
    results.append(element("p", `Metadata usage: ${usage.requests ?? "unknown"} requests; ${usage.bytes ?? "unknown"} bytes; ${Number.isFinite(usage.milliseconds) ? (usage.milliseconds / 1000).toFixed(1) : "unknown"} seconds; ${usage.pages ?? "unknown"} pages; ${usage.items ?? items.length} returned Items.`),
      element("p", `Metadata read: ${snapshot.readAt ?? "unknown"}. Provider snapshot: ${snapshot.etag ?? "not supplied"}.`));
    for (const reference of items) {
      const row = element("article"); row.className = "platform-static-item-result platform-stac-item-result";
      row.append(element("strong", reference.id ?? "Item identity unknown"),
        element("p", `Collection: ${reference.collectionId ?? "unknown"}. Date: ${reference.datetime ?? (reference.start && reference.end ? `${reference.start} to ${reference.end}` : "unknown")}. Cloud cover: ${Number.isFinite(reference.cloudCover) ? `${reference.cloudCover}%` : "unknown"}.`),
        element("p", `Bounding extent: ${Array.isArray(reference.bbox) ? reference.bbox.join(", ") : "unknown"}. Candidate coverage only; area coverage has not been verified.`));
      const inspect = element("button", "View asset references"); inspect.type = "button";
      const detail = element("div");
      inspect.addEventListener("click", async () => {
        try {
          if (!await guard(context, ticket)) return;
          for (const panel of detail.querySelectorAll(".static-item-registration")) panel.dispose?.();
          const assets = reference.assets ?? [];
          detail.replaceChildren(element("p", `${assets.length} asset references from the returned Item. Item terms: ${reference.license ?? "unknown"}. Asset terms remain separate. No imagery has been fetched.`));
          for (const asset of assets) {
            const line = element("div"); line.append(element("p", `${asset.key} · ${asset.type ?? "type unknown"} · asset terms: ${asset.license ?? "unknown"}`),
              element("code", asset.href ?? "Asset address unknown"),
              element("p", asset.cogCompatible === true ? "Candidate for bounded COG review; access and rendering remain unverified."
                : `Reference only: ${(asset.unsupportedReasons?.length ? asset.unsupportedReasons : ["unsupported by the current COG reader"]).join(" ")}`));
            if (asset.roles?.length) line.append(element("p", `Roles: ${asset.roles.join(", ")}`));
            if (asset.cogCompatible === true) {
              const selectedBands = input("text", `Comparison bands for ${reference.id} / ${asset.key}`,
                cogReferenceDefaultBands(reference, asset.key).join(","));
              selectedBands.required = false; selectedBands.maxLength = 12;
              const bandLabel = element("label", selectedBands.ariaLabel); bandLabel.append(selectedBands);
              const add = element("button", `Add ${reference.id} / ${asset.key} to comparison`); add.type = "button";
              add.addEventListener("click", async () => {
                try {
                  if (!await guard(context, ticket)) return;
                  comparison.addSelection({reference, assetKey: asset.key,
                    bands: selectedBands.value.split(",").map(value => /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN)});
                } catch (error) {if (live(ticket)) status.textContent = error.message;}
              });
              line.append(bandLabel, add);
            }
            detail.append(line);
          }
          const original = element("details"); original.append(element("summary", "Returned Item JSON"), element("pre", json(reference.original ?? reference)));
          const download = element("button", "Download Item references"); download.type = "button";
          download.addEventListener("click", async () => {
            try {
              if (!await guard(context, ticket)) return;
              const url = URL.createObjectURL(new Blob([json(reference) + "\n"], {type: "application/json"}));
              const link = element("a"); link.href = url; link.download = `stac-item-${String(reference.id ?? "unknown").replace(/[^A-Za-z0-9_-]/g, "_")}.json`;
              link.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
            } catch (error) {failure(error, ticket);}
          });
          detail.append(original, download);
          if (onReference && assets.some(asset => asset.cogCompatible === true)) {
            const register = element("button", "Review Catalog registration"); register.type = "button";
            register.addEventListener("click", async () => {
              try {
                if (!await guard(context, ticket)) return;
                const review = onReference(reference);
                if (review) {const old = detail.querySelector(".static-item-registration"); old?.dispose?.(); old?.remove(); detail.append(review);}
              } catch (error) {failure(error, ticket);}
            }); detail.append(register);
          } else if (!assets.some(asset => asset.cogCompatible === true)) detail.append(element("p", "These references have no asset supported by the current COG reader."));
          else detail.append(element("p", "Catalog registration is unavailable in this workspace."));
        } catch (error) {failure(error, ticket);}
      });
      row.append(inspect, detail); results.append(row);
    }
    next.hidden = !result.next;
    results.append(element("p", result.next ? "More Items may be available. Next page makes a separate metadata request for the same query within the remaining search limits."
      : result.complete ? "No further page was returned." : "No further page is available within this search’s supported paging and limits."));
  }
  form.addEventListener("submit", event => {event.preventDefault(); void run();});
  next.addEventListener("click", () => {void run(true);});
  root.dispose = () => {disposed = true; invalidate(); comparison.dispose();};
  return root;
}
function element(tag, value) {const node = document.createElement(tag); if (value !== undefined) node.textContent = value; return node;}
function input(type, label, value) {const node = element("input"); node.type = type; node.ariaLabel = label; node.value = value; node.required = true; return node;}
function utc(value) {return value ? `${value.length === 16 ? `${value}:00` : value}Z` : "";}
function json(value) {return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2);}

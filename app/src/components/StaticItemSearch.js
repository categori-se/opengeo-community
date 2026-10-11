import {createStaticItemClient, publicItemUrl} from "../lib/staticItemSearch.js";

// A deliberate external search inside Catalog. Opening Catalog performs no provider read.
export function StaticItemSearch({client = createStaticItemClient(), onReference = null} = {}) {
  const root = document.createElement("details"); root.className = "platform-static-item-search";
  root.append(element("summary", "Search public satellite scenes"));
  root.append(element("p", "Search one year of the published Sentinel-2 Collection 1 index. Results match scene bounding extents; the measured footprint may cover less."));
  const form = document.createElement("form"); form.className = "platform-controls";
  const year = input("number", "Year", "2015"); year.min = "2015"; year.max = "2100";
  const start = input("date", "Start date (UTC)", "2015-10-22"), end = input("date", "End date (UTC)", "2015-10-22");
  const bbox = input("text", "West, south, east, north", "1, 40, 16, 51");
  const tile = input("text", "MGRS tile (optional)", ""); tile.required = false; tile.maxLength = 5;
  const cloud = input("number", "Maximum cloud cover (%)", "30"); cloud.min = "0"; cloud.max = "100";
  const search = element("button", "Search scenes"); search.type = "submit";
  const cancel = element("button", "Cancel"); cancel.type = "button"; cancel.disabled = true;
  for (const control of [year, start, end, bbox, tile, cloud]) {const label = element("label", control.ariaLabel); label.append(control); form.append(label);}
  form.append(search, cancel);
  const status = element("p", "Search reads public metadata only. Selecting a result loads asset references; imagery stays with its provider.");
  status.setAttribute("role", "status"); status.ariaLive = "polite";
  const results = document.createElement("div");
  root.append(form, status, results);
  let controller = null, generation = 0;
  year.addEventListener("change", () => {start.value = `${year.value}-01-01`; end.value = `${year.value}-12-31`;});
  const current = number => generation === number && !controller?.signal.aborted;
  function begin() {
    controller?.abort(); controller = new AbortController(); generation++;
    search.disabled = true; cancel.disabled = false; form.setAttribute("aria-busy", "true");
    return {number: generation, signal: controller.signal};
  }
  function finish(number) {if (number !== generation) return; search.disabled = false; cancel.disabled = true; form.removeAttribute("aria-busy");}
  cancel.addEventListener("click", () => {controller?.abort(); generation++; search.disabled = false; cancel.disabled = true; form.removeAttribute("aria-busy"); status.textContent = "Search cancelled. Your Catalog and Projects are unchanged.";});
  for (const control of [year, start, end, bbox, tile, cloud]) control.addEventListener("input", () => {
    controller?.abort(); generation++; results.replaceChildren(); search.disabled = false; cancel.disabled = true;
    form.removeAttribute("aria-busy"); status.textContent = "Search to apply these filters.";
  });
  form.addEventListener("submit", async event => {
    event.preventDefault(); const request = begin(); results.replaceChildren();
    try {
      const result = await client.search({year: year.value, start: `${start.value}T00:00:00Z`, end: `${end.value}T23:59:59.999Z`,
        bbox: bbox.value.split(",").map(value => value.trim() ? Number(value) : NaN), tile: tile.value, maxCloud: cloud.value},
      {signal: request.signal, onStatus: message => {if (current(request.number)) status.textContent = message;}});
      if (!current(request.number)) return;
      status.textContent = `${result.items.length} scene${result.items.length === 1 ? "" : "s"} shown. ${result.complete ? "All matching published partitions in this year were searched." : "Results are incomplete."} ${result.issues.join(" ")}`;
      const freshness = element("p", `Metadata read ${new Date(result.inventory.readAt).toLocaleString()}. Upstream update: ${result.inventory.upstreamUpdatedAt ?? "not supplied"}. Terms: ${result.inventory.license ?? "not supplied"}.`);
      results.append(freshness);
      for (const item of result.items) {
        const article = document.createElement("article"); article.className = "platform-static-item-result";
        article.append(element("strong", item.id), element("p", `${item.datetime} · cloud cover ${item.cloudCover ?? "unknown"}${item.cloudCover === null ? "" : "%"}`));
        const inspect = element("button", "View asset references"); inspect.type = "button";
        const detail = document.createElement("div");
        inspect.addEventListener("click", async () => {
          if (search.disabled) return; const selection = begin(); inspect.disabled = true;
          try {
            const reference = await client.select(item, {signal: selection.signal,
              onStatus: message => {if (current(selection.number)) status.textContent = message;}});
            if (!current(selection.number)) return;
            detail.replaceChildren(element("p", `Referenced scene · ${reference.assets.length} assets · terms ${reference.license ?? "not supplied"}.`));
            for (const asset of reference.assets) {
              const link = element("a", `${asset.key} · ${asset.type ?? "type not supplied"}`);
              link.href = publicItemUrl(asset.href); link.target = "_blank"; link.rel = "noopener noreferrer";
              const line = element("p", ""); line.append(link, document.createTextNode(` · terms ${asset.license ?? "not supplied"}`)); detail.append(line);
            }
            const download = element("button", "Download scene references"); download.type = "button";
            download.addEventListener("click", () => {
              const url = URL.createObjectURL(new Blob([JSON.stringify(reference, (_key, value) => typeof value === "bigint" ? value.toString() : value, 2) + "\n"], {type: "application/json"}));
              const link = element("a", ""); link.href = url; link.download = `scene-${item.id.replace(/[^A-Za-z0-9_-]/g, "_")}.json`;
              link.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
            });
            detail.append(download);
            if (onReference) {
              const register = element("button", "Review Catalog registration"); register.type = "button";
              register.addEventListener("click", () => {
                const review = onReference(reference);
                if (review) {detail.querySelector(".static-item-registration")?.dispose?.(); detail.querySelector(".static-item-registration")?.remove(); detail.append(review);}
              }); detail.append(register);
            }
            status.textContent = "Scene references are ready. The provider’s imagery has not been copied.";
          } catch (error) {if (current(selection.number)) status.textContent = error.message || "Scene references could not be read. Search again.";}
          finally {finish(selection.number); inspect.disabled = false;}
        });
        article.append(inspect, detail); results.append(article);
      }
    } catch (error) {if (current(request.number)) status.textContent = error.message || "The public index could not be searched.";}
    finally {finish(request.number);}
  });
  root.dispose = () => {controller?.abort(); generation++; for (const panel of root.querySelectorAll(".static-item-registration")) panel.dispose?.();};
  return root;
}
function element(tag, value) {const node = document.createElement(tag); node.textContent = value; return node;}
function input(type, label, value) {const node = document.createElement("input"); node.type = type; node.ariaLabel = label; node.value = value; node.required = true; return node;}

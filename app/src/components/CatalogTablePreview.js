import {csvParseRows} from "d3";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 50;
const MAX_COLUMNS = 64;

// Original strings remain strings: a blank cell is not silently changed to zero.
export function CatalogTablePreview({adapter, dataset, version, object, fetchImplementation = fetch}) {
  const root = el("section");
  root.style.minWidth = "0";
  const button = el("button", "Preview table");
  button.type = "button";
  button.setAttribute("aria-expanded", "false");
  const content = el("div");
  content.hidden = true;
  content.id = `table-preview-${version.id}-${object.id}`;
  button.setAttribute("aria-controls", content.id);
  button.setAttribute("aria-label", `Preview table: ${object.filename}`);
  const status = el("p");
  status.setAttribute("role", "status");
  content.append(status);
  root.append(button, content);
  let disposed = false, loaded = false, controller;
  root.dispose = () => {disposed = true; controller?.abort(); content.replaceChildren();};
  button.onclick = async () => {
    content.hidden = !content.hidden;
    button.setAttribute("aria-expanded", String(!content.hidden));
    button.textContent = content.hidden ? "Preview table" : "Hide table";
    if (content.hidden || loaded || disposed) return;
    button.disabled = true;
    status.textContent = "Checking access and loading this exact CSV…";
    controller = new AbortController();
    try {
      if (!dataset.capabilities?.download || object.sizeBytes > MAX_BYTES || !/^[a-f0-9]{64}$/.test(object.checksumSha256)) throw Error("unavailable");
      const ticket = await adapter.requestDatasetDownload(dataset.projectId, dataset.id, version.id, object.id);
      if (disposed) return;
      const url = new URL(ticket.url);
      if (url.protocol !== "https:" || url.username || url.password || !Number.isFinite(Date.parse(ticket.expiresAt)) || Date.parse(ticket.expiresAt) <= Date.now()) throw Error("unavailable");
      const response = await fetchImplementation(url.href, {signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]), credentials: "omit", redirect: "error"});
      if (!response.ok || !response.body) throw Error("unavailable");
      const reader = response.body.getReader(), chunks = [];
      let size = 0;
      try {
        for (;;) {
          const {done, value} = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BYTES || size > object.sizeBytes) {await reader.cancel(); throw Error("size");}
          chunks.push(value);
        }
      } finally {reader.releaseLock();}
      if (disposed) return;
      if (size !== object.sizeBytes) throw Error("size");
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.byteLength;}
      const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(n => n.toString(16).padStart(2, "0")).join("");
      if (digest !== object.checksumSha256) throw Error("identity");
      const rows = csvParseRows(new TextDecoder("utf-8", {fatal: true}).decode(bytes).replace(/^\uFEFF/, ""));
      if (!rows.length) throw Error("empty");
      const columns = rows.reduce((max, row) => Math.max(max, row.length), 0);
      if (columns > MAX_COLUMNS) throw Error("columns");
      const table = el("table");
      table.append(el("caption", `${object.filename} · first row shown as column headings`));
      const head = el("thead"), header = el("tr");
      for (let i = 0; i < columns; i++) {const th = el("th", rows[0][i] || `Column ${i + 1}`); th.scope = "col"; header.append(th);}
      head.append(header);
      const body = el("tbody");
      for (const values of rows.slice(1, MAX_ROWS + 1)) {
        const row = el("tr");
        for (let i = 0; i < columns; i++) row.append(el("td", values[i] ?? ""));
        body.append(row);
      }
      table.append(head, body);
      const scroll = el("div");
      scroll.style.overflowX = "auto";
      scroll.style.maxWidth = "100%";
      scroll.append(table);
      if (disposed) return;
      status.textContent = `${Math.min(rows.length - 1, MAX_ROWS)} of ${rows.length - 1} data rows · ${columns} columns · exact source checksum verified. Values are displayed as text; empty cells remain empty. No geometry inferred.`;
      content.replaceChildren(status, scroll);
      loaded = true;
    } catch {
      if (!disposed) status.textContent = "Table preview unavailable. Close and reopen to check access and retry. Use the original download for files over 2 MiB, more than 64 columns, or other encodings.";
    } finally {if (!disposed) button.disabled = false;}
  };
  return root;
}

export function canPreviewCatalogTable(dataset, object, adapter) {
  return dataset.capabilities?.download === true && typeof adapter.requestDatasetDownload === "function"
    && /\.csv$/i.test(object.filename) && object.sizeBytes > 0 && object.sizeBytes <= MAX_BYTES
    && /^[a-f0-9]{64}$/.test(object.checksumSha256);
}

function el(tag, text = "") {const node = document.createElement(tag); node.textContent = text; return node;}

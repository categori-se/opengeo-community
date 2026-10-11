/** Preview pinned page content on demand without building or publishing a site. */
export function SitePagePreview({state, site}) {
  const root = document.createElement("section");
  const heading = document.createElement("h4"); heading.textContent = "Saved page preview";
  const select = document.createElement("select"); select.ariaLabel = "Page to preview";
  const pages = site.pages.filter(page => ["document", "story", "dashboard"].includes(page.resourceKind));
  for (const page of pages) {
    const option = document.createElement("option"); option.value = page.slug;
    option.textContent = `${page.navigationLabel} · revision ${page.resourceVersionNumber}`;
    select.append(option);
  }
  const render = document.createElement("button"); render.type = "button";
  render.className = "platform-button secondary"; render.textContent = "Preview saved page";
  render.disabled = !pages.length || typeof state.adapter.previewPageVersion !== "function";
  const status = document.createElement("p"); status.setAttribute("role", "status");
  status.textContent = pages.length
    ? "Preview the saved page revision. Unsaved edits and site navigation are not included."
    : "This publication contains maps only. Review its saved maps under Resources before publishing.";
  if (pages.length && render.disabled) status.textContent = "The saved-page renderer is unavailable for this connection.";
  const frame = document.createElement("iframe"); frame.title = "Saved publication page preview";
  frame.className = "project-page-preview-frame"; frame.setAttribute("sandbox", "");
  frame.referrerPolicy = "no-referrer"; frame.hidden = true;
  let generation = 0;
  const clear = () => { frame.hidden = true; frame.removeAttribute("srcdoc"); };
  select.addEventListener("change", () => {
    ++generation; clear(); render.disabled = typeof state.adapter.previewPageVersion !== "function";
    status.textContent = "Preview the selected saved page.";
  });
  render.addEventListener("click", async () => {
    const page = pages.find(item => item.slug === select.value);
    if (!page || render.disabled) return;
    const current = ++generation; render.disabled = true; clear();
    status.textContent = `Rendering ${page.navigationLabel}…`;
    try {
      const preview = await state.adapter.previewPageVersion(state.project.id, page.resourceId,
        page.resourceVersionNumber, {title: page.resourceTitle, abstract: null, content: page.content});
      if (current !== generation) return;
      frame.srcdoc = preview.html; frame.hidden = false;
      status.textContent = `${page.navigationLabel} · saved revision ${page.resourceVersionNumber}. Nothing published.`;
    } catch (error) {
      if (current !== generation) return;
      clear(); status.textContent = `Preview unavailable (${error?.code ?? "page_preview_failed"}).`;
    } finally { if (current === generation) render.disabled = false; }
  });
  root.append(heading, select, render, status, frame);
  return root;
}

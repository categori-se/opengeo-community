/** Renders the validated semantic preview without interpreting source HTML. */
export function documentPreview(preview) {
  const article = document.createElement("article");
  article.className = "project-document-preview-content";
  article.lang = preview.language ?? "";
  const pdfOcrDescription = preview.sourceFormat === "pdf" && preview.extraction.ocrPerformed
    ? ` Declared-language Tesseract OCR was attempted on ${preview.extraction.ocrPages.length} page${preview.extraction.ocrPages.length === 1 ? "" : "s"} using ${preview.extraction.ocrModel}; OCR text may contain errors.${preview.extraction.ocrTruncated ? " The bounded 32-page OCR limit was reached." : ""}`
    : " OCR is not performed.";
  const description = preview.sourceFormat === "pdf"
    ? `All-page semantic PDF ${preview.pdfVersion} text · ${preview.pages.length} page${preview.pages.length === 1 ? "" : "s"}. Reading order is heuristic.${pdfOcrDescription}`
    : `Semantic ODF ${preview.odfVersion} preview · ${preview.pages.length} page${preview.pages.length === 1 ? "" : "s"}. Page layout and embedded media are not reproduced.`;
  article.append(
    text("h5", preview.title ?? (preview.sourceFormat === "pdf" ? "PDF text presentation" : "OpenDocument text preview")),
    text("p", description, "project-catalog-feedback")
  );
  for (const page of preview.pages) {
    const section = document.createElement("section");
    section.className = "project-document-preview-page";
    section.setAttribute("aria-label", `Document page ${page.number}`);
    const sourceLabel = page.textSource === "ocr"
      ? " · OCR text"
      : (page.textSource === "none" ? " · OCR limit reached" : "");
    section.append(text("p", `Page ${page.number}${sourceLabel}`, "project-document-preview-page-number"));
    for (const block of page.blocks) section.append(documentPreviewBlock(block, page.number));
    if (preview.sourceFormat === "pdf" && !page.blocks.length) {
      const emptyMessage = page.textSource === "ocr"
        ? "OCR was attempted on this page but found no text."
        : (
            page.textSource === "none"
              ? "No text was extracted because the bounded OCR page limit was reached."
              : "No extractable text was found on this page; OCR was not performed."
          );
      section.append(text(
        "p",
        emptyMessage,
        "project-catalog-feedback"
      ));
    }
    article.append(section);
  }
  return article;
}

function documentPreviewBlock(block, pageNumber) {
  if (block.type === "heading") {
    const heading = text("div", block.text, "project-document-preview-heading");
    heading.setAttribute("role", "heading");
    heading.setAttribute("aria-level", String(block.level));
    return heading;
  }
  if (block.type === "paragraph") return text("p", block.text);
  if (block.type === "list") {
    const list = document.createElement(block.ordered ? "ol" : "ul");
    for (const value of block.items) list.append(text("li", value));
    return list;
  }
  const table = document.createElement("table");
  table.className = "project-document-preview-table";
  const caption = document.createElement("caption");
  caption.textContent = block.label ?? `Table on document page ${pageNumber}`;
  table.append(caption);
  for (const [rowIndex, values] of block.rows.entries()) {
    const row = document.createElement("tr");
    for (const value of values) {
      const cell = document.createElement(rowIndex < block.headerRows ? "th" : "td");
      if (cell.tagName === "TH") cell.scope = "col";
      cell.textContent = value;
      row.append(cell);
    }
    table.append(row);
  }
  return table;
}

function text(tag, value, className) {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
}

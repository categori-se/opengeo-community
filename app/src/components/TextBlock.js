export function TextBlock(element) {
  const block = document.createElement(element.style === "title" ? "h2" : "div");
  block.className = `layout-text ${element.style ?? "body"}`;
  block.contentEditable = "true";
  block.spellcheck = true;
  block.textContent = element.text ?? "";
  return block;
}

const NS = "http://www.w3.org/2000/svg";
let engine, legal, loading;
const cache = new Map();let cacheBytes = 0;
export const hasPrintMath = layout => (layout.textFrames ?? []).some(frame => frame.type === "math");
export const printMathReady = () => Boolean(engine && legal);
export function preparePrintMath() {
  const runtime = globalThis.process?.versions?.node
    ? () => import(new URL("./printMathRuntime.js", import.meta.url).href)
    : () => import("./printMathAttachment.js").then(module => module.loadPrintMathRuntime());
  return loading ??= Promise.all([runtime(), import("./printMathNotices.js")]).then(([runtime, notices]) => {
    engine = runtime.typesetPrintMath;legal = notices.PRINT_MATH_LEGAL;
  });
}
export function printMathLegalFiles(layout) {
  if (!hasPrintMath(layout)) return [];
  if (!printMathReady()) throw Error("Prepare equations before exporting this layout.");
  return legal.map(file => ({name: file.name, body: file.body, sha256: file.sha256}));
}
export function appendPrintMathMetadata(svg, layout, {preview = false} = {}) {
  if (!hasPrintMath(layout) || preview && !printMathReady()) return;
  const metadata = [...svg.children].find(node => node.localName === "metadata");
  if (!metadata) return;
  const record = JSON.parse(metadata.textContent);
  record.math = {typesetter: "MathJax", version: "4.1.3", font: "mathjax-tex@4.1.0", representation: "outlined-glyphs", licenses: printMathLegalFiles(layout)};
  metadata.textContent = JSON.stringify(record);
}
function typeset(source) {
  if (!printMathReady()) throw Error("Preparing equations…");
  if (cache.has(source)) {const value=cache.get(source);cache.delete(source);cache.set(source,value);return value;}
  const result = engine(source);
  while (cache.size && (cache.size >= 16 || cacheBytes + result.svg.length * 2 > 2 * 1024 * 1024)) {
    const key=cache.keys().next().value;cacheBytes-=cache.get(key).svg.length*2;cache.delete(key);
  }
  if (result.svg.length * 2 <= 2 * 1024 * 1024) {cache.set(source,result);cacheBytes+=result.svg.length*2;}
  return result;
}
function numeric(value) {
  if (!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i.test(value) || !Number.isFinite(Number(value)) || Math.abs(Number(value)) > 1e7) throw Error("Unsupported equation geometry.");
}
// Rebuild the typesetter's output using only closed owned vector commands.
// Never import its root HTML, CSS, links, text fallback, font requests or scripts.
export function sanitizedPrintMath(document, source) {
  if (typeof source !== "string" || source.length > 1000000 || /<!DOCTYPE|<!ENTITY/i.test(source)) throw Error("Unsupported equation SVG.");
  const parsed = new document.defaultView.DOMParser().parseFromString(source,"image/svg+xml");
  if (parsed.querySelector("parsererror") || parsed.documentElement.namespaceURI !== NS || parsed.documentElement.localName !== "svg") throw Error("Invalid equation SVG.");
  let count=0;
  const copy = node => {
    if (++count>6000 || node.namespaceURI!==NS || !["g","path","rect"].includes(node.localName)) throw Error("Unsupported equation vector content.");
    const result=document.createElementNS(NS,node.localName);
    for(const {name,value} of [...node.attributes]) {
      if (/^data-[a-z0-9-]+$/.test(name)) continue;
      if (name==="transform" && node.localName==="g") {
        if (!/^(?:(?:translate|scale|matrix|rotate)\(\s*[-+\deE.,\s]+\)\s*)+$/.test(value) || value.length>4000) throw Error("Unsupported equation transform.");
        for(const number of value.match(/[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?/gi)??[])numeric(number);
      } else if (name==="d" && node.localName==="path") {
        if (!value || value.length>200000 || !/^[MLHVCSQTAZmlhvcsqtaz\d.eE,+\s-]+$/.test(value)) throw Error("Unsupported equation path.");
        for(const number of value.match(/[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?/gi)??[])numeric(number);
      } else if (["x","y","width","height","rx","ry"].includes(name) && node.localName==="rect") numeric(value);
      else if (["fill","stroke"].includes(name) && ["currentColor","none"].includes(value)) {if(value==="none")result.setAttribute(name,value);continue;}
      else if(name==="stroke-width" && value==="0")continue;
      else throw Error(`Unsupported equation ${name} attribute.`);
      result.setAttribute(name,value);
    }
    if(node.localName==="path"&&!result.hasAttribute("d"))throw Error("An equation path is missing.");
    for(const child of node.childNodes) {
      if(child.nodeType===3&&!child.textContent.trim())continue;
      if(child.nodeType!==1)throw Error("Unsupported equation text.");
      result.append(copy(child));
    }
    return result;
  };
  const group=document.createElementNS(NS,"g");
  for(const child of parsed.documentElement.childNodes) {
    if(child.nodeType===3&&!child.textContent.trim())continue;
    if(child.nodeType!==1)throw Error("Unsupported equation content.");
    group.append(copy(child));
  }
  return group;
}
export function appendPrintMathFrame(group, frame) {
  const result=typeset(frame.text), scale=frame.fontSizePt*25.4/72/1000, width=result.viewBox[2]*scale, height=result.viewBox[3]*scale;
  if(width>frame.widthMm-2+1e-9||height>frame.heightMm-2+1e-9)throw Error("Equation exceeds its frame. Enlarge the frame or reduce the text size.");
  const remaining=frame.widthMm-2-width, x=frame.xMm+1+(frame.alignment==="right"?remaining:frame.alignment==="center"?remaining/2:0), y=frame.yMm+1;
  const outlines=sanitizedPrintMath(group.ownerDocument,result.svg);
  outlines.setAttribute("transform",`translate(${x} ${y}) scale(${scale} ${scale}) translate(${-result.viewBox[0]} ${-result.viewBox[1]})`);
  outlines.setAttribute("fill",frame.color);outlines.setAttribute("stroke",frame.color);outlines.setAttribute("stroke-width","0");
  outlines.setAttribute("data-print-math",frame.id);outlines.setAttribute("role","img");outlines.setAttribute("aria-label",frame.text);
  const title=group.ownerDocument.createElementNS(NS,"title");title.textContent=frame.text;outlines.prepend(title);group.append(outlines);
}

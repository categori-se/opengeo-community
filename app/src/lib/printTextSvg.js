import {appendPrintMathFrame, appendPrintMathMetadata} from "./printMathSvg.js";
import {layoutPrintTextFrame, validatePrintTextFrames} from "./printTextFrames.js";
const NS = "http://www.w3.org/2000/svg";

// Only owned literal text and geometry enter this renderer. Logical newlines stay
// in the layout; each painted line is a flat text node for SVG and direct PDF.
export function appendPrintTextFrames(svg, layout, {fontFamily = "system-ui,sans-serif", preview = false} = {}) {
  const document = svg.ownerDocument, frames = validatePrintTextFrames(layout.textFrames ?? [], layout.page,
    [...layout.frames, ...(layout.dataFrames ?? [])].map(frame => frame.id));
  const node = (name, attrs, text) => {const value=document.createElementNS(NS,name);for(const [key,entry]of Object.entries(attrs))value.setAttribute(key,entry);if(text!==undefined)value.textContent=text;return value;};
  let context;
  if (typeof document.defaultView?.CanvasRenderingContext2D === "function") context = document.createElement("canvas").getContext("2d");
  const measure = context ? (text,size) => {context.font = `${size * 96 / 25.4}px ${fontFamily}`;return context.measureText(text).width * 25.4 / 96;} : undefined;
  appendPrintMathMetadata(svg, layout, {preview});
  for (const [index,frame] of frames.entries()) {
    const id=`print-text-${index}`,defs=node("defs",{}),clip=node("clipPath",{id});clip.append(node("rect",{x:frame.xMm,y:frame.yMm,width:frame.widthMm,height:frame.heightMm}));defs.append(clip);svg.append(defs);
    const group=node("g",{"data-print-text-frame":frame.id,"clip-path":`url(#${id})`,role:"group","aria-label":frame.title});svg.append(group);
    if(frame.background!=="none")group.append(node("rect",{x:frame.xMm,y:frame.yMm,width:frame.widthMm,height:frame.heightMm,fill:frame.background}));
    try {
      if(frame.type === "math") {appendPrintMathFrame(group,frame);continue;}
      const result=layoutPrintTextFrame(frame,measure);
      for(const [lineIndex,line]of result.lines.entries())group.append(node("text",{x:line.x,y:line.y,"font-size":result.fontSizeMm,"font-family":fontFamily,
        fill:frame.color,"text-anchor":"start","xml:space":"preserve","data-print-text-line":lineIndex},line.text));
    } catch(error) {
      if(!preview)throw error;
      group.append(node("rect",{x:frame.xMm,y:frame.yMm,width:frame.widthMm,height:frame.heightMm,fill:"#fff7ed",stroke:"#c2410c","stroke-width":0.2}),
        node("text",{x:frame.xMm+1,y:frame.yMm+4,"font-size":2.3,fill:"#9a3412"},frame.type === "math" ? error.message.slice(0,100) : "Increase text frame size or reduce text size."));
    }
  }
}

// Direct PDF loads its exact embedded font first. Rewrap owned text from the
// unchanged logical layout in that font instead of inheriting browser metrics.
export function reflowPrintPdfTextFrames(svg, layout, fontFamily) {
  for (const group of [...svg.querySelectorAll("[data-print-text-frame]")]) group.remove();
  for (const clip of [...svg.querySelectorAll('[id^="print-text-"]')].filter(node => node.localName === "clipPath")) {const defs=clip.parentElement;clip.remove();if(!defs.children.length)defs.remove();}
  appendPrintTextFrames(svg, layout, {fontFamily});
}

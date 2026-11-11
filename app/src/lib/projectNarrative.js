import {compilePortableMapArtifact} from "./portableMapArtifact.js";
import {publicTileOrigin} from "./staticMapExport.js";

export const PROJECT_WIDGET_TYPES = ["histogram", "scatter", "bar", "line", "box", "pie"];

export function projectNarrativeState(definition = {}) {
  definition ??= {};
  definition ??= {};
  return {
    storymap: definition.storymap === undefined ? undefined : structuredClone(definition.storymap),
    widgets: definition.widgets === undefined ? undefined : structuredClone(definition.widgets),
    dashboardColumns: definition.dashboardColumns
  };
}

export function moveNarrativeItem(items, index, offset) {
  const next = [...items], target = index + offset;
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(target)
    || index < 0 || target < 0 || index >= next.length || target >= next.length) return next;
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function storyLocation(value) {
  const center = value?.center;
  if (!Array.isArray(center) || center.length !== 2
    || ![...center, value.zoom, value.pitch, value.bearing].every(Number.isFinite)
    || Math.abs(center[0]) > 180 || Math.abs(center[1]) > 90
    || value.zoom < 0 || value.zoom > 24 || value.pitch < 0 || value.pitch > 85) {
    throw Error("Choose a valid map view before capturing this chapter.");
  }
  return {center: [...center], zoom: value.zoom, pitch: value.pitch, bearing: value.bearing};
}

export function newStoryChapter(location, id = crypto.randomUUID()) {
  return {
    id, title: "Untitled chapter", description: "", alignment: "left", hidden: false,
    location: storyLocation(location), mapAnimation: "flyTo", rotateAnimation: false,
    onChapterEnter: [], onChapterExit: []
  };
}

export function newDashboardWidget(type, layerId, fields = [], id = crypto.randomUUID()) {
  if (!PROJECT_WIDGET_TYPES.includes(type)) throw Error("Choose a supported widget type.");
  return {
    id, layerId, type, title: "", field: fields[0] ?? "", xField: fields[0] ?? "",
    yField: fields[1] ?? fields[0] ?? "", category: fields[0] ?? "",
    valueField: fields[1] ?? fields[0] ?? "", aggregation: "count", bins: 12
  };
}

const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g,
  character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[character]);
const scriptJson = value => JSON.stringify(value).replaceAll("<", "\\u003c");

function storyImage(value, mode) {
  if (typeof value !== "string" || !value) return null;
  if (/^data:image\/(?:png|jpeg|webp|gif);base64,[a-zA-Z0-9+/=]+$/.test(value)) return value;
  if (mode !== "live") return null;
  try {
    publicTileOrigin(value);
    const url = new URL(value);
    if ([...url.searchParams.keys()].some(key => /^(?:code|auth|cookie|password)$/i.test(key))) return null;
    return url.href;
  } catch { /* Preserve the imported value in the Project, without requesting it. */ }
  return null;
}

export function storyImageReview(storymap, mode = "offline") {
  return (Array.isArray(storymap?.chapters) ? storymap.chapters : []).filter(chapter => chapter.image).map(chapter => {
    const url = storyImage(chapter.image, mode);
    return {chapterId: chapter.id, title: chapter.title || "Untitled chapter", url,
      mode: url?.startsWith("https:") ? "live" : url ? "embedded" : "excluded",
      reason: !url ? (mode === "offline" ? "Remote or unsupported image omitted from offline output" : "Unsupported or credential-bearing image URL omitted") : null};
  });
}

/** Compile the existing reviewed map once and use its declared chapter cameras. */
export async function compileProjectStoryHtml(storymap, mapOptions) {
  const chapters = storymap?.chapters;
  if (!Array.isArray(chapters) || !chapters.length) throw Error("Add a chapter before exporting the story.");
  const ids = new Set();
  const storyChapters = chapters.map(chapter => {
    if (typeof chapter.id !== "string" || !chapter.id || ids.has(chapter.id)) {
      throw Error("Story chapters need distinct identities before export.");
    }
    ids.add(chapter.id);
    return {
      id: chapter.id, location: storyLocation(chapter.location),
      mapAnimation: ["flyTo", "easeTo", "jumpTo"].includes(chapter.mapAnimation) ? chapter.mapAnimation : "flyTo"
    };
  });
  const map = await compilePortableMapArtifact({
    ...mapOptions, title: storymap.title || mapOptions.title || "Story",
    view: storyChapters[0].location, storyChapters
  });
  return buildProjectStoryHtml(storymap, map.html, map.manifest.networkDependencies, {mode: mapOptions.mode ?? "offline", mapManifest: map.manifest});
}

export function buildProjectStoryHtml(storymap, mapHtml, networkDependencies = [], {mode = "offline", mapManifest = null} = {}) {
  if (typeof mapHtml !== "string" || !mapHtml.startsWith("<!doctype html>")) throw Error("A compiled portable map is required.");
  const chapters = storymap?.chapters;
  if (!Array.isArray(chapters) || !chapters.length) throw Error("Add a chapter before exporting the story.");
  const imageReview = storyImageReview(storymap, mode);
  const imageByChapter = new Map(imageReview.map(image => [image.chapterId, image]));
  const imageDependencies = imageReview.filter(image => image.mode === "live").map(image =>
    ({chapterId: image.chapterId, mode: "live", accessUrls: [image.url], coverage: "external-chapter-image", credentials: "omit"}));
  const dependencies = [...networkDependencies, ...imageDependencies];
  const origins = [...new Set(dependencies.flatMap(item => item.accessUrls ?? []).map(value => new URL(value).origin))];
  const display = {
    title: String(storymap.title || "Story"), subtitle: String(storymap.subtitle ?? ""), byline: String(storymap.byline ?? ""),
    footer: String(storymap.footer ?? ""), theme: storymap.theme === "dark" ? "dark" : "light",
    chapters: chapters.map(chapter => ({id: String(chapter.id), title: String(chapter.title ?? ""),
      description: String(chapter.description ?? ""), hidden: chapter.hidden === true,
      image: imageByChapter.get(chapter.id)?.url ?? null}))
  };
  const manifest = {schemaVersion: "opengeo.project-story.1.0.0", mode, mapArtifact: mapManifest,
    networkDependencies: dependencies, chapterImages: imageReview,
    limitations: ["Map uses reviewed loaded features", "Imported chapter layer actions and rotation are preserved in the Project and are not executed by this viewer"]};
  const title = storymap.title || "Story";
  const policy = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self' blob:; worker-src blob:; child-src blob:; img-src data: blob: ${origins.join(" ")}; connect-src blob: ${origins.join(" ")}; base-uri 'none'; form-action 'none'`;
  const navigation = chapters.map((chapter, index) =>
    `<button type="button" data-chapter="${index}" aria-pressed="${index === 0}">${escapeHtml(chapter.title || "Untitled chapter")}</button>`).join("");
  const sections = chapters.map((chapter, index) => {
    const image = imageByChapter.get(chapter.id)?.url;
    return `<article id="chapter-${index}" data-section="${index}"${chapter.hidden ? ' class="chapter-hidden"' : ""}><h2>${escapeHtml(chapter.title)}</h2><p>${escapeHtml(chapter.description)}</p>${image ? `<img src="${escapeHtml(image)}" alt="" crossorigin="anonymous" referrerpolicy="no-referrer">` : ""}</article>`;
  }).join("");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${escapeHtml(policy)}"><title>${escapeHtml(title)}</title>
<style>html{color-scheme:${storymap.theme === "dark" ? "dark" : "light"}}body{margin:0;font:16px system-ui,sans-serif;background:${storymap.theme === "dark" ? "#171c23" : "#fff"};color:${storymap.theme === "dark" ? "#f2f4f7" : "#1b2430"}}header,nav,main,footer{padding:1rem;max-width:72rem;margin:auto}h1{margin:.3rem 0}nav{display:flex;gap:.5rem;flex-wrap:wrap}button{font:inherit;padding:.55rem .8rem;cursor:pointer}button[aria-pressed=true]{font-weight:700}iframe{display:block;border:0;width:100%;height:58vh;min-height:260px;position:sticky;top:0;z-index:1;background:#e7ecef}article{padding:2rem 0;min-height:25vh;scroll-margin-top:60vh}article p{white-space:pre-wrap;line-height:1.6}article img{max-width:100%;height:auto}.chapter-hidden{min-height:1px;padding:0}.chapter-hidden>*{display:none}footer{white-space:pre-wrap}</style></head>
<body><header><h1>${escapeHtml(title)}</h1><p>${escapeHtml(storymap.subtitle)}</p><p>${escapeHtml(storymap.byline)}</p></header><nav aria-label="Story chapters">${navigation}</nav>
<iframe id="story-map" title="${escapeHtml(title)}" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe><main>${sections}</main><footer>${escapeHtml(storymap.footer)}<p>Map shows reviewed loaded features. Chapter layer actions and rotation remain in the Project and are not executed here.${imageReview.some(image => image.reason) ? " Some chapter images were omitted; see the embedded story manifest." : ""}</p></footer>
<script type="application/json" id="story-manifest">${scriptJson(manifest)}</script>
<script>const story=${scriptJson(display)},mapHtml=${scriptJson(mapHtml)};
const frame=document.getElementById('story-map'),buttons=[...document.querySelectorAll('[data-chapter]')];let active=0;
function activate(index,scroll){if(!story.chapters[index])return;active=index;buttons.forEach((button,i)=>button.setAttribute('aria-pressed',String(i===index)));frame.contentWindow?.postMessage({schema:'opengeo.story-chapter.1',id:story.chapters[index].id},'*');if(scroll)document.getElementById('chapter-'+index).scrollIntoView({behavior:'smooth',block:'start'});}
frame.addEventListener('load',()=>activate(active,false));frame.srcdoc=mapHtml;
buttons.forEach(button=>button.addEventListener('click',()=>activate(Number(button.dataset.chapter),true)));
if('IntersectionObserver'in window){const observer=new IntersectionObserver(entries=>{const entry=entries.filter(item=>item.isIntersecting).sort((a,b)=>b.intersectionRatio-a.intersectionRatio)[0];if(entry)activate(Number(entry.target.dataset.section),false);},{threshold:[.25,.5,.75]});document.querySelectorAll('[data-section]').forEach(section=>observer.observe(section));}
</script></body></html>`;
  if (new TextEncoder().encode(html).byteLength > 20 * 1024 * 1024) throw Error("The story exceeds the existing 20 MiB portable export limit.");
  return html;
}

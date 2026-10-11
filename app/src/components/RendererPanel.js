import {rendererTitle} from "../lib/cesiumWorkbench.js";
export function RendererPanel({session, current, preferred = current, report, status, onSwitch, onCancel}) {
  const root = document.createElement("section");
  root.className = "gis-renderer-panel";
  const heading = document.createElement("h3"); heading.textContent = "Rendering engine";
  const active = document.createElement("p"), feedback = document.createElement("p");
  feedback.setAttribute("role", "status");
  const explanation = document.createElement("p");
  explanation.textContent = "MapLibre is the default. Mapbox uses your Mapbox account and may incur usage charges. Cesium offers a token-free globe for compatible vector Layers. Switching keeps your Project and Layers.";
  const terms = document.createElement("a");
  terms.href = "https://www.mapbox.com/legal/tos/"; terms.target = "_blank"; terms.rel = "noopener noreferrer";
  terms.textContent = "Mapbox terms and account requirements";
  const label = document.createElement("label"); label.textContent = "Mapbox public token";
  const input = document.createElement("input"); input.type = "password"; input.autocomplete = "off";
  input.placeholder = "pk.…"; label.append(input);
  const note = document.createElement("p");
  note.textContent = "Token stays in this workspace session. It is not saved in Projects or browser storage. MapLibre sky appearance may differ in Mapbox and is restored when switching back.";
  const issues = document.createElement("ul");
  let inputError = "";
  const button = (text, action) => { const b=document.createElement("button"); b.type="button"; b.textContent=text; b.onclick=action; return b; };
  const run = async id => {
    inputError = "";
    try {
      if (id === "mapbox" && input.value) { session.configure(input.value); input.value=""; }
      await onSwitch(id);
    } catch { inputError = "Enter a valid public Mapbox token starting with pk. Secret tokens are not accepted."; }
    update();
  };
  const libre = button("Use MapLibre", () => run("maplibre"));
  const box = button("Use Mapbox", () => run("mapbox"));
  const globe = button("Use Cesium", () => run("cesium"));
  const globeLabel=document.createElement("label"),globeConsent=document.createElement("input");
  globeConsent.type="checkbox";globeConsent.onchange=()=>update();
  globeLabel.append(globeConsent,document.createTextNode("Use a plain globe in Cesium. My current basemap is retained for MapLibre/Mapbox."));
  const globeNote=document.createElement("p");
  globeNote.textContent="Cesium supports camera navigation, feature inspection, Layer visibility, folder ordering and compatible public raster backgrounds. Switch back for styling, editing, other imagery and unmapped tools. Pinned labels support wrapping and overlap control. Native area anchors and placement can differ; curved or repeated line labels remain in MapLibre.";
  const backgroundNote=document.createElement('p');
  const globeIssues=document.createElement("ul");
  const cancel = button("Cancel switch", onCancel);
  const forget = button("Forget Mapbox token", () => {session.clear(); input.value=""; update();});
  function update() {
    const value = status(), compatibility = report("mapbox"), cesium = report("cesium");
    active.textContent = `Current: ${rendererTitle(current())}`;
    feedback.textContent = inputError || value.message || "";
    issues.replaceChildren(...compatibility.issues.map(issue => {
      const item=document.createElement("li"); item.textContent=`${issue.title ? `${issue.title}: ` : ""}${issue.message}`; return item;
    }));
    const pending = value.pending === true || value.paused === true;
    libre.disabled = pending || (current() === "maplibre" && preferred() === "maplibre");
    box.disabled = pending || (current() === "mapbox" && preferred() === "mapbox") || !compatibility.ready;
    globeIssues.replaceChildren(...cesium.issues.map(issue=>{
      const item=document.createElement("li");item.textContent=`Cesium · ${issue.title?issue.title+": ":""}${issue.message}`;return item;
    }));
    backgroundNote.textContent=cesium.message??'';
    globeLabel.hidden=Boolean(cesium.basemap);
    globe.disabled=pending || !cesium.ready || (!cesium.basemap && !globeConsent.checked) || (current()==="cesium" && preferred()==="cesium");
    globeConsent.disabled=pending;
    input.disabled = pending;
    // An active SDK still holds its per-map token until disposal.
    forget.disabled = pending || current() === "mapbox" || !session.configured;
    cancel.hidden = !pending;
  }
  root.append(heading, active, explanation, terms, label, note, issues, libre, box, forget, globeNote, backgroundNote, globeLabel, globeIssues, globe, cancel, feedback);
  root.clearCredentialInput = () => {input.value = ""; inputError = "";};
  root.update = update; update(); return root;
}

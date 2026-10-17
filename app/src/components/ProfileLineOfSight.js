import {analyzeProfileLineOfSight, profileLineOfSightJSON} from "../lib/pathMeasurement.js";

export function ProfileLineOfSight(measurement, {onDownload} = {}) {
  const root = document.createElement("details");
  root.className = "gis-profile-line-of-sight";
  const summary = element("summary", "Line of sight");
  const form = document.createElement("form");
  const fields = [
    field("Observer height above ground (m)", "1.75", false),
    field("Target height above ground (m)", "0", false),
    field("Elevation uncertainty ± (m, optional)", "", true)
  ];
  const curveLabel = document.createElement("label"), curve = document.createElement("input");
  curveLabel.className = "gis-line-of-sight-curvature";
  curve.type = "checkbox";curve.checked = true;
  curveLabel.append(curve, document.createTextNode(" Include world curvature"));
  const calculate = element("button", "Calculate line of sight");calculate.type = "submit";
  calculate.className = "gis-button";
  const output = document.createElement("section");output.setAttribute("aria-live", "polite");
  const download = element("button", "Download analysis JSON");download.type = "button";download.disabled = true;
  download.className = "gis-button";
  let result = null;
  form.append(...fields.map(f => f.label), curveLabel, calculate);
  const invalidate = () => {result = null;download.disabled = true;output.replaceChildren();};
  form.addEventListener("input", invalidate);form.addEventListener("change", invalidate);
  form.addEventListener("submit", event => {
    event.preventDefault();if (!form.reportValidity()) return;
    try {
      result = analyzeProfileLineOfSight(measurement, {observerHeightMeters: fields[0].input.valueAsNumber,
        targetHeightMeters: fields[1].input.valueAsNumber,
        uncertaintyMeters: fields[2].input.value === "" ? null : fields[2].input.valueAsNumber, curvature: curve.checked});
      const labels = {"sampled-clear": "Clear at sampled terrain", "sampled-obstruction": "Obstruction at sampled terrain",
        grazing: "Sight line touches sampled terrain", incomplete: "Profile needs more suitable samples"};
      const facts = {
        "Result": labels[result.status],
        "Profile length": meters(result.input.horizontalDistanceMeters),
        "Largest sample gap": meters(result.maximumSampleSpacingMeters),
        "Lowest sampled clearance": result.minimumClearanceMeters === null ? "Not calculated" : meters(result.minimumClearanceMeters),
        "Uncertainty": {"not-evaluated": "Not evaluated", "clear-within-bound": "Clear within supplied bound",
          "obstructed-within-bound": "Obstructed within supplied bound", uncertain: "Result changes within supplied bound"}[result.uncertaintyResult],
        "Terrain source": result.input.terrainProfile.source?.provider ?? "No source samples",
        "Source observation": result.input.terrainProfile.source?.observedAt ?? "Not recorded",
        "Curvature": result.options.curvature ? `${result.input.spatialBodyId} mean sphere` : "Planar profile"
      };
      const dl = document.createElement("dl");dl.className = "gis-key-values";
      for (const [name,value] of Object.entries(facts)) dl.append(element("dt",name),element("dd",value));
      output.replaceChildren(dl);
      if (result.reason) output.append(element("p", {
        "missing-elevation-samples": "Some saved elevations are missing. Load terrain and measure this line again to obtain a complete profile.",
        "no-interior-samples": "This profile contains only its endpoints. Measure a longer line to include terrain between them.",
        "samples-outside-sight-axis": "These saved samples depart from the direct sight axis by more than one metre. A direct-axis elevation profile is required."
      }[result.reason]));
      download.disabled = typeof onDownload !== "function";
    } catch (error) {
      result = null;download.disabled = true;
      const message = error.code === "line_of_sight_distance_limit" ? "Use a line between 1 metre and 100 kilometres."
        : error.code === "line_of_sight_straight_profile_required" ? "Use a saved two-point line with a valid terrain profile."
        : "Choose finite heights and uncertainty from 0 to 1,000 metres.";
      output.replaceChildren(element("p",message));
    }
  });
  download.addEventListener("click", () => {
    if (!result || !onDownload) return;
    try {onDownload(profileLineOfSightJSON(result));}
    catch (error) {
      download.disabled = true;
      output.append(element("p",error.code === "line_of_sight_private_source_url"
        ? "The source terms link contains private access parameters. Use a public terms link before exporting."
        : "The analysis could not be exported within the supported limits."));
    }
  });
  root.append(summary, element("p", "Compare the saved terrain profile with a sight line from its first point to its last. Heights use the profile’s metres and elevation datum."),
    form, output, download, element("p", "The result covers sampled terrain. Ground between samples, buildings, vegetation and atmospheric refraction are not evaluated. Provider elevation accuracy remains undeclared; any uncertainty entered here is your assumption."));
  return root;
}

function field(name,value,optional) {
  const label=element("label",name), input=document.createElement("input");
  input.type="number";input.min="0";input.max="1000";input.step="any";input.required=!optional;input.value=value;
  input.setAttribute("aria-label",name);label.append(input);return {label,input};
}
function element(tag,text) {const node=document.createElement(tag);node.textContent=text;return node;}
function meters(value) {return `${value.toFixed(2)} m`;}

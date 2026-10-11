// Coverage describes a catalog resource; it never transforms its data.
export function ResourceCoverageEditor(metadata) {
  const element = document.createElement("details");
  element.className = "resource-coverage-editor";
  const summary = document.createElement("summary");
  summary.textContent = "Coverage · location and dates";
  const spatial = document.createElement("fieldset");
  const legend = document.createElement("legend");
  legend.textContent = "Geographic coverage";
  const hint = document.createElement("p");
  hint.textContent = "Longitude and latitude in degrees (EPSG:4326). These describe coverage; they do not clip or reproject the data. Leave all four blank for unknown coverage.";
  const grid = document.createElement("div");
  grid.className = "resource-coverage-coordinates";
  const coordinates = ["West", "South", "East", "North"].map((name, index) => {
    const field = input(`${name} boundary`, "number", metadata.spatialExtent?.[index] ?? "");
    field.control.step = "any";
    field.control.min = index % 2 ? "-90" : "-180";
    field.control.max = index % 2 ? "90" : "180";
    grid.append(field.label);
    return field.control;
  });
  spatial.append(legend, hint, grid);
  const temporal = document.createElement("fieldset");
  const temporalLegend = document.createElement("legend");
  temporalLegend.textContent = "Time coverage";
  const timeHint = document.createElement("p");
  timeHint.textContent = "Use a date and time with its time zone, for example 2026-09-08T14:30:00Z or 2026-09-08T10:30:00-04:00. Z means UTC. A blank start or end leaves that side open; both blank means unknown.";
  const start = input("Coverage start", "text", metadata.temporalStart ?? "");
  const end = input("Coverage end", "text", metadata.temporalEnd ?? "");
  for (const {control} of [start, end]) {
    control.maxLength = 40;
    control.placeholder = "YYYY-MM-DDThh:mm:ssZ";
    control.spellcheck = false;
  }
  temporal.append(temporalLegend, timeHint, start.label, end.label);
  const status = document.createElement("p");
  status.className = "project-resource-feedback";
  status.setAttribute("role", "status");
  const controls = [...coordinates, start.control, end.control];
  function read({focusError = false} = {}) {
    for (const control of controls) control.setCustomValidity("");
    status.textContent = "";
    try {
      return parseResourceCoverage({
        coordinates: coordinates.map((control) => control.validity.badInput ? "invalid" : control.value),
        temporalStart: start.control.value,
        temporalEnd: end.control.value
      });
    } catch (error) {
      const control = controls[error.controlIndex ?? 0];
      control.setCustomValidity(error.message);
      status.textContent = error.message;
      if (focusError) {
        element.open = true;
        control.focus();
      }
      throw error;
    }
  }
  // Clear custom validity as soon as the user corrects a field. Validation also
  // runs on submission and private recovery, including programmatic drafts.
  element.addEventListener("input", () => { try { read(); } catch {} });
  element.addEventListener("invalid", () => { element.open = true; }, true);
  element.append(summary, spatial, temporal, status);
  return {element, read};
}

function input(name, type, value) {
  const label = document.createElement("label");
  const caption = document.createElement("span");
  caption.textContent = name;
  const control = document.createElement("input");
  control.type = type;
  control.value = String(value);
  control.setAttribute("aria-label", name);
  label.append(caption, control);
  return {label, control};
}

export function parseResourceCoverage({coordinates, temporalStart, temporalEnd}) {
  if (!Array.isArray(coordinates) || coordinates.length !== 4) fail("Enter exactly four geographic boundaries.", 0);
  const values = coordinates.map((value) => String(value).trim());
  let spatialExtent = null;
  if (values.some(Boolean)) {
    if (values.some((value) => !value)) fail("Enter all four boundaries, or clear all four for unknown coverage.", values.findIndex((value) => !value));
    spatialExtent = values.map(Number);
    for (let index = 0; index < 4; index++) {
      const limit = index % 2 ? 90 : 180;
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(values[index]) || !Number.isFinite(spatialExtent[index]) || Math.abs(spatialExtent[index]) > limit) {
        fail(`Use a finite ${index % 2 ? "latitude from -90 to 90" : "longitude from -180 to 180"} in degrees.`, index);
      }
    }
    if (spatialExtent[0] > spatialExtent[2]) fail("West must not exceed east. A single crossing-antimeridian box is not supported by this metadata profile.", 2);
    if (spatialExtent[1] > spatialExtent[3]) fail("South must not exceed north.", 3);
  }
  const start = parseTimestamp(temporalStart, 4);
  const end = parseTimestamp(temporalEnd, 5);
  if (start && end && start.microseconds > end.microseconds) fail("Coverage end must not be earlier than coverage start, accounting for their time zones.", 5);
  return {spatialExtent, temporalStart: start?.value ?? null, temporalEnd: end?.value ?? null};
}

function parseTimestamp(source, index) {
  const value = String(source ?? "").trim();
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) fail("Use a full date and time with Z or a ±hh:mm time zone; up to six fractional-second digits are supported.", index);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = "", zone, sign, zoneHour, zoneMinute] = match;
  const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const instant = new Date(0);
  instant.setUTCFullYear(year, month - 1, day);
  instant.setUTCHours(hour, minute, second, 0);
  if (year < 1 || instant.getUTCFullYear() !== year || instant.getUTCMonth() !== month - 1 || instant.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59 || (zone !== "Z" && (Number(zoneHour) > 23 || Number(zoneMinute) > 59))) {
    fail("Enter a real calendar date, time and time-zone offset.", index);
  }
  const offsetMinutes = zone === "Z" ? 0 : (Number(zoneHour) * 60 + Number(zoneMinute)) * (sign === "-" ? -1 : 1);
  const microseconds = BigInt(instant.getTime()) * 1000n + BigInt(fraction.padEnd(6, "0")) - BigInt(offsetMinutes) * 60_000_000n;
  return {value, microseconds};
}

function fail(message, controlIndex) {
  throw Object.assign(new Error(message), {code: "metadata_coverage_invalid", controlIndex});
}

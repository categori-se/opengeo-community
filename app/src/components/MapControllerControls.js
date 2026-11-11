import {createMapController} from "../lib/mapController.js";

export function MapControllerControls(getMap, {available = () => true, document: doc = document} = {}) {
  const element = doc.createElement("details");
  element.className = "gis-map-view-help";
  element.dataset.mapController = "true";
  const summary = doc.createElement("summary");
  summary.textContent = "Controller navigation";
  const label = doc.createElement("label");
  label.textContent = "Controller layout";
  const select = doc.createElement("select");
  select.setAttribute("aria-label", "Controller layout");
  for (const [value, title] of [["standard", "Standard gamepad"], ["six-axis", "Six-axis XYZ controller"]]) {
    const option = doc.createElement("option");
    option.value = value;
    option.textContent = title;
    select.append(option);
  }
  label.append(select);
  const help = doc.createElement("p");
  const instructions = () => {
    help.textContent = select.value === "standard"
      ? "Left stick pans; right stick turns and tilts; triggers zoom. Press a controller button and release the controls before enabling."
      : "Requires a browser driver exposing translation X/Y/Z and rotation X/Y/Z axes. X/Y pan, Z zooms, rotation X tilts, rotation Y rolls and rotation Z turns. Release the axes before enabling.";
  };
  const privacy = doc.createElement("p");
  privacy.textContent = "Enable for this map session. Moving focus, hiding the page or changing the device stops control. Device details are not saved or sent.";
  const message = doc.createElement("p");
  message.setAttribute("role", "status");
  message.textContent = "Controller off. Keyboard, pointer and touch remain available.";
  const toggle = doc.createElement("button");
  toggle.type = "button";
  toggle.className = "gis-button";
  toggle.textContent = "Enable map controller";
  toggle.setAttribute("aria-pressed", "false");
  const controller = createMapController({getMap, available, document: doc, onStatus: ({active, message: text}) => {
    toggle.textContent = active ? "Stop controller" : "Enable map controller";
    toggle.setAttribute("aria-pressed", String(active));
    select.disabled = active;
    message.textContent = text;
  }});
  // Focus can leave the canvas between pointerdown and click. Preserve the
  // intended Stop action even if the animation loop has already stopped.
  let stopOnClick = false;
  toggle.addEventListener("pointerdown", () => { stopOnClick = controller.active; });
  toggle.addEventListener("pointercancel", () => { stopOnClick = false; });
  toggle.addEventListener("click", () => {
    if (stopOnClick || controller.active) controller.stop();
    else controller.start(select.value);
    stopOnClick = false;
  });
  select.addEventListener("change", instructions);
  instructions();
  element.append(summary, label, help, privacy, toggle, message);
  return {element, dispose: () => controller.dispose(), stop: () => controller.stop()};
}

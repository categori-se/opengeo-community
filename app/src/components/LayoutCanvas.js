import {elementStyle} from "../lib/printLayouts.js";
import {LegendBox} from "./LegendBox.js";
import {MapFrame} from "./MapFrame.js";
import {MeasurementAnnotation} from "./MeasurementAnnotation.js";
import {NorthArrow} from "./NorthArrow.js";
import {ScaleBar} from "./ScaleBar.js";
import {TextBlock} from "./TextBlock.js";

export function LayoutCanvas(layout, context) {
  const canvas = document.createElement("section");
  canvas.className = "layout-canvas";
  canvas.style.width = `${layout.page.widthMm}mm`;
  canvas.style.height = `${layout.page.heightMm}mm`;
  canvas.style.setProperty("--page-width-mm", layout.page.widthMm);
  canvas.style.setProperty("--page-height-mm", layout.page.heightMm);

  for (const element of layout.elements) {
    const wrapper = document.createElement("div");
    wrapper.className = `layout-element ${element.type}`;
    wrapper.style.cssText = elementStyle(element);
    wrapper.dataset.elementId = element.id;
    wrapper.append(renderElement(element, context));
    canvas.append(wrapper);
  }

  return canvas;
}

function renderElement(element, context) {
  if (element.type === "map_frame") return MapFrame(element, context);
  if (element.type === "legend") return LegendBox(element, context);
  if (element.type === "scale_bar") return ScaleBar(element);
  if (element.type === "north_arrow") return NorthArrow(element);
  if (element.type === "measurement_annotation") return MeasurementAnnotation(element);
  return TextBlock(element);
}

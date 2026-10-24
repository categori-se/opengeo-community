import {FileAttachment} from "observablehq:stdlib";
// Packaged local code only; expressions never supply a runtime URL.
export async function loadPrintMathRuntime() {
  return import(await FileAttachment("../assets/print-math-runtime.js").url());
}

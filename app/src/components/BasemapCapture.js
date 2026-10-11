export function BasemapCapture({mapFrame, basemap}) {
  const wrapper = document.createElement("div");
  wrapper.className = "basemap-capture";

  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 820;
  canvas.className = "basemap-canvas";
  wrapper.append(canvas);

  drawBasemap(canvas, mapFrame, basemap);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "print-button secondary";
  button.textContent = "Capture basemap PNG";
  button.addEventListener("click", () => {
    const link = document.createElement("a");
    link.download = `${mapFrame.id}-basemap.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  });
  wrapper.append(button);

  return wrapper;
}

function drawBasemap(canvas, mapFrame, basemap) {
  const context = canvas.getContext("2d");
  const {width, height} = canvas;

  const water = context.createLinearGradient(0, 0, width, height);
  water.addColorStop(0, "#dceef6");
  water.addColorStop(1, "#edf5f1");
  context.fillStyle = water;
  context.fillRect(0, 0, width, height);

  context.strokeStyle = "rgba(65, 83, 98, 0.18)";
  context.lineWidth = 1;
  for (let x = 0; x < width; x += 80) line(context, x, 0, x - 60, height);
  for (let y = 0; y < height; y += 70) line(context, 0, y, width, y + 30);

  context.strokeStyle = "rgba(120, 130, 70, 0.35)";
  context.lineWidth = 8;
  line(context, 80, height * 0.76, width * 0.42, height * 0.48);
  line(context, width * 0.42, height * 0.48, width * 0.82, height * 0.28);

  context.fillStyle = "rgba(0, 0, 0, 0.62)";
  context.font = "28px system-ui, sans-serif";
  context.fillText(basemap?.title ?? mapFrame.basemapId ?? "Selected basemap", 28, 46);
  context.font = "18px system-ui, sans-serif";
  context.fillText(`Extent: ${(mapFrame.extent ?? []).join(", ")}`, 28, 76);
  context.fillText("Basemap capture prototype. Final high-resolution exports can use serverless rendering.", 28, height - 32);
}

function line(context, x1, y1, x2, y2) {
  context.beginPath();
  context.moveTo(x1, y1);
  context.lineTo(x2, y2);
  context.stroke();
}

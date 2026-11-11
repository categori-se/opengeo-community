import {normalizePanoramaPose, verifyPanoramaScene} from "../lib/panorama.js";

/** Offline equirectangular viewer. It never resolves a remote URL or enables tracking. */
export function PanoramaViewer({scene, pose, onChange = () => {}, onMove = () => {}, onExit = () => {}, available = () => true, document: doc = document} = {}) {
  const element = doc.createElement("section");
  element.className = "gis-panorama-viewer";
  element.setAttribute("aria-label", "Panoramic imagery");
  Object.assign(element.style, {position: "absolute", inset: "0", zIndex: "8", background: "#111827", color: "#f9fafb", display: "flex", flexDirection: "column"});
  const toolbar = doc.createElement("div");
  Object.assign(toolbar.style, {display: "flex", gap: "0.5rem", flexWrap: "wrap", padding: "0.5rem", alignItems: "center"});
  const title = doc.createElement("strong"); title.textContent = scene.title;
  const exit = doc.createElement("button"); exit.type = "button"; exit.className = "gis-button"; exit.textContent = "Exit panorama";
  const status = doc.createElement("p"); status.setAttribute("role", "status"); status.textContent = "Verifying and opening private panorama…";
  const canvas = doc.createElement("canvas"); canvas.tabIndex = 0; canvas.setAttribute("aria-label", "Panorama: drag or use arrow keys to look; plus or minus zoom; Escape exits");
  Object.assign(canvas.style, {width: "100%", minHeight: "160px", flex: "1", touchAction: "none"});
  const credit = doc.createElement("p"); credit.textContent = `${scene.rights.attribution} · ${scene.rights.license} · privacy reviewed · ${scene.rights.exportAllowed ? "export permitted" : "export not permitted"}`;
  credit.style.padding = "0.5rem";
  toolbar.append(title, exit); element.append(toolbar, canvas, status, credit);
  let camera = normalizePanoramaPose(pose ?? scene.initialPose), disposed = false, gl, program, texture, buffer, image, resize, cancelImage;
  let drag = null, ready = false;
  const controls = new Map();
  const tell = () => {status.textContent = `${scene.title}: heading ${camera.heading.toFixed(1)}°, pitch ${camera.pitch.toFixed(1)}°, field of view ${camera.fov.toFixed(1)}°.`;};
  const draw = () => {
    if (!ready || disposed || !available()) return;
    const width = Math.max(1, Math.round(canvas.clientWidth || 640)), height = Math.max(1, Math.round(canvas.clientHeight || 320));
    canvas.width = width;canvas.height = height;gl.viewport(0, 0, width, height);
    gl.useProgram(program);
    gl.uniform2f(gl.getUniformLocation(program, "angles"), camera.heading * Math.PI / 180, camera.pitch * Math.PI / 180);
    gl.uniform2f(gl.getUniformLocation(program, "view"), width / height, Math.tan(camera.fov * Math.PI / 360));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };
  const update = next => {
    if (disposed || !available()) return;
    camera = normalizePanoramaPose({...camera, ...next});
    for (const [key, input] of controls) input.value = String(camera[key]);
    draw();tell();onChange({...camera});
  };
  for (const [key, label, min, max] of [["heading", "Panorama heading", 0, 359.9], ["pitch", "Panorama pitch", -85, 85], ["fov", "Panorama field of view", 30, 110]]) {
    const wrap = doc.createElement("label"); wrap.textContent = label;
    const input = doc.createElement("input"); input.type = "range"; input.min = min; input.max = max; input.step = "0.1"; input.value = camera[key]; input.setAttribute("aria-label", label);
    input.addEventListener("input", () => update({[key]: Number(input.value)})); controls.set(key, input); wrap.append(input);toolbar.append(wrap);
  }
  for (const link of scene.links) {
    const button = doc.createElement("button");button.className = "gis-button";button.type = "button";button.textContent = `Move to ${link.sceneId}`;
    button.addEventListener("click", () => {if (!disposed && available()) onMove(link.sceneId, link.heading);});toolbar.append(button);
  }
  exit.addEventListener("click", onExit);
  canvas.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "=", "-", "Escape"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Escape") onExit();
    else if (event.key === "ArrowLeft" || event.key === "ArrowRight") update({heading: camera.heading + (event.key === "ArrowLeft" ? -5 : 5)});
    else if (event.key === "ArrowUp" || event.key === "ArrowDown") update({pitch: Math.max(-85, Math.min(85, camera.pitch + (event.key === "ArrowUp" ? 5 : -5)))});
    else update({fov: Math.max(30, Math.min(110, camera.fov + (event.key === "-" ? 5 : -5)))});
  });
  canvas.addEventListener("pointerdown", event => {if (!available()) return;drag = {x: event.clientX, y: event.clientY, camera: {...camera}, id: event.pointerId};canvas.setPointerCapture?.(event.pointerId);canvas.focus();});
  canvas.addEventListener("pointermove", event => {if (drag?.id === event.pointerId) update({heading: drag.camera.heading - (event.clientX - drag.x) * 0.2, pitch: Math.max(-85, Math.min(85, drag.camera.pitch + (event.clientY - drag.y) * 0.2))});});
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) canvas.addEventListener(type, () => {drag = null;});
  canvas.addEventListener("wheel", event => {event.preventDefault();update({fov: Math.max(30, Math.min(110, camera.fov + Math.sign(event.deltaY) * 5))});}, {passive: false});
  const shader = (type, source) => {
    const value = gl.createShader(type);gl.shaderSource(value, source);gl.compileShader(value);
    if (!gl.getShaderParameter(value, gl.COMPILE_STATUS)) {gl.deleteShader(value);throw Error("panorama_shader_unavailable");}return value;
  };
  const opened = (async () => {
    try {
      const verified = await verifyPanoramaScene(scene);
      if (disposed || !available()) return false;
      gl = canvas.getContext("webgl", {alpha: false, preserveDrawingBuffer: true});
      if (!gl) throw Error("panorama_graphics_unavailable");
      const vertex = shader(gl.VERTEX_SHADER, "attribute vec2 p; varying vec2 uv; void main(){uv=p;gl_Position=vec4(p,0.,1.);}");
      const fragment = shader(gl.FRAGMENT_SHADER, "precision highp float; varying vec2 uv; uniform sampler2D image; uniform vec2 angles; uniform vec2 view; void main(){vec3 d=normalize(vec3(uv.x*view.x*view.y,uv.y*view.y,-1.));float c=cos(angles.y),s=sin(angles.y);vec3 r=vec3(d.x,c*d.y-s*d.z,s*d.y+c*d.z);c=cos(angles.x);s=sin(angles.x);r=vec3(c*r.x-s*r.z,r.y,s*r.x+c*r.z);vec2 t=vec2(fract(atan(r.x,-r.z)/6.28318530718+0.5),0.5-asin(clamp(r.y,-1.,1.))/3.14159265359);gl_FragColor=texture2D(image,t);}");
      program = gl.createProgram();gl.attachShader(program, vertex);gl.attachShader(program, fragment);gl.linkProgram(program);gl.deleteShader(vertex);gl.deleteShader(fragment);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error("panorama_shader_unavailable");
      gl.useProgram(program);buffer = gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER, buffer);gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW);
      const attribute = gl.getAttribLocation(program, "p");gl.enableVertexAttribArray(attribute);gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0);
      image = new doc.defaultView.Image();
      await new Promise((resolve, reject) => {cancelImage = () => reject(Error("panorama_closed"));image.onload = resolve;image.onerror = () => reject(Error("panorama_image_invalid"));image.src = verified.asset.dataUrl;});
      cancelImage = null;
      if (disposed || !available()) return false;
      if (image.naturalWidth !== verified.asset.width || image.naturalHeight !== verified.asset.height) throw Error("panorama_dimensions_mismatch");
      texture = gl.createTexture();gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      ready = true;element.dataset.ready = "true";draw();tell();canvas.focus();
      if (globalThis.ResizeObserver) {resize = new ResizeObserver(draw);resize.observe(canvas);}return true;
    } catch (error) {if (!disposed) {element.dataset.ready = "false";status.textContent = `Panorama could not open (${error.code ?? error.message}). Exit to keep using the map.`;}return false;}
  })();
  return {element, opened, getPose: () => ({...camera}), setPose: update,
    capture: () => {if (!ready || !scene.rights.exportAllowed) throw Error("panorama_export_review_required");return canvas;},
    dispose() {if (disposed) return;disposed = true;cancelImage?.();resize?.disconnect();if (image) {image.onload = image.onerror = null;image.src = "";}if (gl) {if (texture) gl.deleteTexture(texture);if (buffer) gl.deleteBuffer(buffer);if (program) gl.deleteProgram(program);}element.remove();}};
}

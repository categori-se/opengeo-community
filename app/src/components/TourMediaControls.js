import {captureCameraTourScene, updateCameraTourKeyframe} from "../lib/cameraTour.js";
import {captureMapView} from "../lib/globeView.js";
import {tourAudioFromBlob, recordTourNarration, TOUR_MEDIA_LIMITS} from "../lib/tourMedia.js";
import {encodeTourMovie, TOUR_MOVIE_LIMITS} from "../lib/tourMovie.js";

/** Cached by its Workbench context; callbacks read current scope and state.
 * assertScope is a local current-authority check, never a per-frame provider read.
 * renderFrame/restoreAfterMovie own the temporary scene and native renderer.
 */
export function TourMediaControls({getTour, getKeyframeId, getMap, captureScene, validateScene = () => {}, replaceTour,
  canEdit = () => false, assertScope = () => {}, renderFrame, restoreAfterMovie = () => {}, stopPlayback = () => {},
  disposePlayer = () => {}, download, getAttribution = () => "", document: doc = globalThis.document,
  encodeMovie = encodeTourMovie, recordNarration = recordTourNarration, audioDuration = localAudioDuration} = {}) {
  const element = doc.createElement("section");element.className = "gis-camera-tour-media";
  const heading = doc.createElement("h3");heading.textContent = "Scenes, narration and movie";
  const explanation = doc.createElement("p");explanation.textContent = "Record the current Place, imagery, sunlight and reviewed panorama at the selected view. Audio is embedded in the tour and saved with the Project when you choose Save.";
  const status = doc.createElement("p");status.setAttribute("role", "status");status.setAttribute("aria-live", "polite");
  let disposed = false, operation = null, generation = 0, microphone = null;
  const report = message => {if (!disposed) status.textContent = message;};
  const button = (label, action) => {
    const node = doc.createElement("button");node.type = "button";node.className = "gis-button";node.textContent = label;
    node.addEventListener("click", () => {void Promise.resolve().then(action).catch(error => report(error.message || "The operation could not finish."));});return node;
  };
  const field = (label, input) => {const wrapper = doc.createElement("label");wrapper.className = "gis-field";wrapper.append(doc.createTextNode(label), input);input.setAttribute("aria-label", label);return wrapper;};
  const input = (maximum, placeholder) => {const node = doc.createElement("input");node.type = "text";node.maxLength = maximum;node.placeholder = placeholder;return node;};
  const text = value => typeof value === "string" ? value.trim() : "";
  const current = op => !disposed && operation === op && generation === op.generation && canEdit()
    && getTour?.() === op.tour && (op.kind === "movie" || getKeyframeId?.() === op.keyframeId);
  const check = async op => {
    op.controller.signal.throwIfAborted();await assertScope();
    if (!current(op)) throw Error("The selected Project, view or edit authority changed. Start this action again in the current Project.");
  };
  const begin = async kind => {
    if (disposed || operation || !canEdit()) throw Error("Editing this Project is required to record media or export its movie.");
    await assertScope();
    if (disposed || operation || !canEdit()) throw Error("The Project edit authority changed.");
    const tour = getTour?.(), keyframeId = getKeyframeId?.();
    if (!tour || !tour.keyframes?.some(frame => frame.id === keyframeId)) throw Error("Start a tour and select a view first.");
    const op = {kind, tour, keyframeId, generation: ++generation, controller: new AbortController()};operation = op;update();return op;
  };
  const finish = op => {if (operation === op) {operation = null;microphone = null;update();}};
  const applyRecorded = async (op, scene, camera = null) => {
    await check(op);
    const previous = op.tour.keyframes.find(frame => frame.id === op.keyframeId)?.scene;
    const combined = {...previous, ...scene};await validateScene(combined);await check(op);
    let next = captureCameraTourScene(op.tour, op.keyframeId, combined);
    if (camera) next = updateCameraTourKeyframe(next, op.keyframeId, {camera});
    await replaceTour(next, op.keyframeId);
  };
  const rights = () => {
    const attribution = text(audioAttribution.value), license = text(audioLicense.value);
    if (!attribution || !license) throw Error("Enter audio attribution and its license or permitted use before adding or recording audio.");
    return {attribution, license};
  };
  const recordScene = button("Record current scene", async () => {
    let op;
    try {
      op = await begin("scene");
      const map = getMap?.();if (!map || !["getCenter", "getZoom", "getPitch", "getBearing"].every(method => typeof map[method] === "function"))
        throw Error("Wait for the supported interactive map before recording a scene.");
      const camera = captureMapView(map), scene = await captureScene(op.controller.signal);
      await applyRecorded(op, scene, camera);report("Scene recorded at this view. Save the Project to retain it.");
    } finally {if (op) finish(op);}
  });

  const audioAttribution = input(2000, "Author or source credit"), audioLicense = input(2000, "License or permitted use");
  const audioFile = doc.createElement("input");audioFile.type = "file";audioFile.accept = ".wav,.mp3,.ogg,.webm,audio/wav,audio/mpeg,audio/ogg,audio/webm";
  audioFile.addEventListener("change", () => {void (async () => {
    const selected = audioFile.files?.[0];if (!selected) return;
    let op;
    try {
      const metadata = rights();op = await begin("audio");
      if (!selected.size || selected.size > TOUR_MEDIA_LIMITS.audioBytes) throw Error("Choose an audio file of at most 8 MiB.");
      const inferred = {wav: "audio/wav", mp3: "audio/mpeg", ogg: "audio/ogg", webm: "audio/webm"}[selected.name?.split(".").at(-1)?.toLowerCase()];
      const mime = {"audio/x-wav": "audio/wav", "audio/wave": "audio/wav", "video/webm": "audio/webm"}[selected.type] ?? (selected.type || inferred);
      const blob = mime === selected.type ? selected : new Blob([selected], {type: mime});
      const durationMilliseconds = await audioDuration(blob, op.controller.signal, doc);await check(op);
      const clip = await tourAudioFromBlob(blob, {id: "local-audio", durationMilliseconds, ...metadata});
      await applyRecorded(op, {audio: {action: "play", clip, offsetMilliseconds: 0, gain: 1}});
      report("Audio attached at this view. Save the Project to retain it.");
    } finally {audioFile.value = "";if (op) finish(op);}
  })().catch(error => report(error.message || "The audio could not be added."));});
  const record = button("Record narration", async () => {
    let op;
    try {
      const metadata = rights();op = await begin("microphone");report("Requesting microphone access…");
      const session = await recordNarration({signal: op.controller.signal, ...metadata});microphone = session;
      // Attach a handler before another awaited scope check can fail.
      const outcome = session.result.then(clip => ({clip}), error => ({error}));
      await check(op);report("Recording narration. Stop when finished, or cancel to discard it.");update();
      const result = await outcome;if (result.error) throw result.error;await check(op);
      await applyRecorded(op, {audio: {action: "play", clip: result.clip, offsetMilliseconds: 0, gain: 1}});
      report("Narration attached at this view. Save the Project to retain it.");
    } finally {if (op) {op.controller.abort(Error("Narration session finished."));finish(op);}}
  });
  const stopRecording = button("Stop narration", () => {if (operation?.kind === "microphone") microphone?.stop();});
  const cancelRecording = button("Cancel narration", () => {
    if (operation?.kind === "microphone") {operation.controller.abort(Error("Narration cancelled; no clip was added."));report("Narration cancelled; no clip was added.");}
  });
  const stopAudio = button("Stop audio at this view", async () => {
    let op;try {op = await begin("audio");await applyRecorded(op, {audio: {action: "stop"}});report("Audio stop recorded. Save the Project to retain it.");}
    finally {if (op) finish(op);}
  });
  const audioHelp = doc.createElement("p");audioHelp.textContent = "WAV, MP3, Ogg or WebM; at most 8 MiB and 120 seconds per clip. Recording starts only when requested. Audio attribution and permitted use travel with the tour.";

  const size = doc.createElement("select");for (const [width, height] of TOUR_MOVIE_LIMITS.sizes) {const option = doc.createElement("option");option.value = `${width}x${height}`;option.textContent = `${width} × ${height}`;size.append(option);}
  const rate = doc.createElement("select");for (const fps of TOUR_MOVIE_LIMITS.frameRates) {const option = doc.createElement("option");option.value = `${fps}`;option.textContent = `${fps} frames per second`;rate.append(option);}
  const additionalCredits = doc.createElement("textarea");additionalCredits.maxLength = 4000;
  const requiredCredits = doc.createElement("p");requiredCredits.className = "gis-help";
  const movieHelp = doc.createElement("p");movieHelp.textContent = "WebM with VP8 video and Opus when audio is present. Up to 30 seconds, 32 MiB, and one final frame holding the exact endpoint. Movie audio inputs total at most 30 seconds and 8 MiB. Browser codec support is checked when export starts.";
  const movie = button("Export tour movie", async () => {
    let op;
    try {
      op = await begin("movie");stopPlayback();
      if (typeof renderFrame !== "function" || typeof download !== "function") throw Error("Movie capture is unavailable in this view.");
      const [width, height] = size.value.split("x").map(Number), credits = text(getAttribution());
      if (!credits) throw Error("Source attribution is required before exporting this movie.");
      const audioCredits = [...new Map(op.tour.keyframes.filter(frame => frame.scene?.audio?.action === "play")
        .map(frame => [frame.scene.audio.clip.sha256, frame.scene.audio.clip])).values()].map(clip => `${clip.attribution} · ${clip.license}`);
      const attribution = [credits, ...audioCredits, text(additionalCredits.value)].filter(Boolean).join(" · ");
      const result = await encodeMovie(op.tour, {canvas: doc.createElement("canvas"), width, height, frameRate: Number(rate.value),
        attribution, signal: op.controller.signal, renderFrame: async (...args) => {await check(op);return renderFrame(...args);},
        onProgress: progress => report(`Captured ${progress.completedFrames} of ${progress.totalFrames} frames.`)});
      await check(op);
      await download("tour.webm", result.blob, "video/webm");await check(op);
      await download("tour-movie-report.json", JSON.stringify(result.report, null, 2), "application/json");
      report("Movie and capture report downloaded.");
    } finally {
      if (op) {try {await restoreAfterMovie();} finally {finish(op);}}
    }
  });
  const cancelMovie = button("Cancel movie export", () => {
    if (operation?.kind === "movie") {operation.controller.abort(Error("Movie export cancelled; no partial movie was downloaded."));report("Movie export cancelled; no partial movie was downloaded.");}
  });
  element.append(heading, explanation, recordScene, field("Audio attribution", audioAttribution), field("Audio license or permitted use", audioLicense),
    field("Attach local tour audio", audioFile), audioHelp, record, stopRecording, cancelRecording, stopAudio,
    field("Movie frame size", size), field("Movie frame rate", rate), requiredCredits, field("Additional movie credits", additionalCredits), movieHelp, movie, cancelMovie, status);
  const mutable = [recordScene, audioAttribution, audioLicense, audioFile, record, stopAudio, size, rate, additionalCredits, movie];
  function update() {
    if (disposed) return;
    if (operation && !current(operation)) operation.controller.abort(Error("The Project or selected view changed; media work stopped."));
    const disabled = !canEdit() || !getTour?.() || Boolean(operation);
    for (const control of mutable) control.disabled = disabled;
    stopRecording.disabled = operation?.kind !== "microphone" || !microphone;
    cancelRecording.disabled = operation?.kind !== "microphone";
    cancelMovie.disabled = operation?.kind !== "movie";
    requiredCredits.textContent = `Required source credits: ${text(getAttribution()) || "No source attribution is available for export."}`;
    if (!canEdit() && !operation) report("Editing this Project is required to record media or export its movie.");
  }
  update();
  return {element, update, dispose() {
    if (disposed) return;disposed = true;generation++;
    operation?.controller.abort(Error("The Project media controls were closed."));microphone?.stop();stopPlayback();disposePlayer();
    operation = null;microphone = null;
  }};
}

async function localAudioDuration(blob, signal, doc) {
  signal.throwIfAborted();const audio = doc.createElement("audio"), url = URL.createObjectURL(blob);
  let timer, abort;
  try {
    return await new Promise((resolve, reject) => {
      const fail = message => reject(Error(message));
      audio.onloadedmetadata = () => {
        if (!Number.isFinite(audio.duration) || audio.duration <= 0 || audio.duration * 1000 > TOUR_MEDIA_LIMITS.audioMilliseconds)
          fail("Use audio of at most 120 seconds with a readable duration.");
        else resolve(Math.max(1, Math.round(audio.duration * 1000)));
      };
      audio.onerror = () => fail("This browser could not decode the selected local audio.");
      abort = () => reject(signal.reason ?? Error("Audio inspection cancelled."));signal.addEventListener("abort", abort, {once: true});
      timer = setTimeout(() => fail("Local audio inspection timed out."), 8000);audio.preload = "metadata";audio.src = url;
    });
  } finally {clearTimeout(timer);signal.removeEventListener("abort", abort);audio.pause();audio.removeAttribute("src");audio.load();URL.revokeObjectURL(url);}
}

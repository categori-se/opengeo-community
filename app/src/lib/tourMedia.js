import {sha256} from "@noble/hashes/sha2.js";

export const TOUR_MEDIA_LIMITS = Object.freeze({audioBytes: 8 * 1024 * 1024, audioMilliseconds: 120000,
  sceneBytes: 64 * 1024, exchangeBytes: 256 * 1024, maximumUpdates: 64});
const fail = code => Object.assign(new Error(code), {code});
const checkedAudio = new Map();
export const tourMediaSha256 = bytes => [...sha256(bytes)].map(value => value.toString(16).padStart(2, "0")).join("");
export function tourMediaBytes(value) {
  if (typeof value !== "string" || value.length % 4 || value.length > Math.ceil(TOUR_MEDIA_LIMITS.audioBytes / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw fail("tour_audio_base64_invalid");
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}
const text = (value, maximum = 2000) => {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw fail("tour_media_text_invalid");
  return value.trim();
};
export function normalizeTourAudio(value) {
  if (!value || !["audio/wav", "audio/mpeg", "audio/ogg", "audio/webm", "audio/webm;codecs=opus"].includes(value.mimeType)) throw fail("tour_audio_type_invalid");
  if (checkedAudio.get(value.sha256) !== value.dataBase64) {
    const bytes = tourMediaBytes(value.dataBase64);
    if (!bytes.length || bytes.length > TOUR_MEDIA_LIMITS.audioBytes || tourMediaSha256(bytes) !== value.sha256) throw fail("tour_audio_checksum_invalid");
    // Avoid decoding/hashing unchanged embedded clips on every playback frame.
    // At most two retained strings; no provider or account results are cached.
    if (checkedAudio.size >= 2) checkedAudio.delete(checkedAudio.keys().next().value);
    checkedAudio.set(value.sha256, value.dataBase64);
  }
  if (!Number.isInteger(value.durationMilliseconds) || value.durationMilliseconds <= 0 || value.durationMilliseconds > TOUR_MEDIA_LIMITS.audioMilliseconds) throw fail("tour_audio_duration_invalid");
  return {id: text(value.id, 160), mimeType: value.mimeType, dataBase64: value.dataBase64, sha256: value.sha256,
    durationMilliseconds: value.durationMilliseconds, attribution: text(value.attribution), license: text(value.license)};
}

function portable(value, depth = 0) {
  if (depth > 16) throw fail("tour_scene_complexity");
  if (value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    if (value.length > 8192 || /^(?:javascript|file|data):/i.test(value)) throw fail("tour_scene_value_invalid");
    if (/^https?:/i.test(value)) {const url = new URL(value);if (url.username || url.password || [...url.searchParams.keys()].some(key => /token|secret|signature|credential|api.?key/i.test(key))) throw fail("tour_scene_credentials_forbidden");}
    return value;
  }
  if (Array.isArray(value) && value.length <= 256) return value.map(item => portable(item, depth + 1));
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length > 128) throw fail("tour_scene_value_invalid");
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (["__proto__", "constructor", "prototype"].includes(key) || /^(?:password|accessToken|refreshToken|authorization|cookie|secret|apiKey)$/i.test(key)) throw fail("tour_scene_credentials_forbidden");
    result[key] = portable(item, depth + 1);
  }
  return result;
}
export function normalizeTourScene(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["place", "historicalImagery", "sunlight", "panorama", "audio", "updates"].includes(key))) throw fail("tour_scene_invalid");
  const scene = {};
  for (const key of ["place", "historicalImagery", "sunlight", "panorama"]) if (Object.hasOwn(value, key)) scene[key] = portable(value[key]);
  if (Object.hasOwn(value, "updates")) {
    if (!Array.isArray(value.updates) || value.updates.length > TOUR_MEDIA_LIMITS.maximumUpdates) throw fail("tour_updates_invalid");
    scene.updates = value.updates.map(update => {
      if (!update || !["visibility", "description", "name"].includes(update.property) || typeof update.targetId !== "string") throw fail("tour_update_unsupported");
      if (update.property === "visibility" ? typeof update.value !== "boolean" : typeof update.value !== "string" || update.value.length > 2000) throw fail("tour_update_invalid");
      if (update.targetType !== undefined && !["Placemark", "Folder", "Document", "GroundOverlay", "ScreenOverlay", "PhotoOverlay", "Model", "NetworkLink"].includes(update.targetType)) throw fail("tour_update_unsupported");
      return {targetId: text(update.targetId, 160), ...(update.targetType ? {targetType: update.targetType} : {}), property: update.property, value: update.value};
    });
  }
  if (new TextEncoder().encode(JSON.stringify(scene)).length > TOUR_MEDIA_LIMITS.sceneBytes) throw fail("tour_scene_size_limit");
  if (Object.hasOwn(value, "audio")) {
    const audio = value.audio;
    if (audio === null || audio?.action === "stop") scene.audio = {action: "stop"};
    else {
      if (!audio || audio.action !== "play" || !Number.isInteger(audio.offsetMilliseconds ?? 0) || (audio.offsetMilliseconds ?? 0) < 0
        || !Number.isFinite(audio.gain ?? 1) || (audio.gain ?? 1) < 0 || (audio.gain ?? 1) > 1) throw fail("tour_audio_event_invalid");
      const clip = normalizeTourAudio(audio.clip);
      if ((audio.offsetMilliseconds ?? 0) >= clip.durationMilliseconds) throw fail("tour_audio_offset_invalid");
      scene.audio = {action: "play", clip, offsetMilliseconds: audio.offsetMilliseconds ?? 0, gain: audio.gain ?? 1};
    }
  }
  return scene;
}
export function normalizeTourExchange(value) {
  if (!value || typeof value.originalKml !== "string" || new TextEncoder().encode(value.originalKml).length > TOUR_MEDIA_LIMITS.exchangeBytes
    || /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(value.originalKml) || !/^[a-f0-9]{64}$/.test(value.sourceSha256)
    || tourMediaSha256(new TextEncoder().encode(value.originalKml)) !== value.sourceSha256) throw fail("tour_exchange_invalid");
  return {originalKml: value.originalKml, sourceSha256: value.sourceSha256,
    modelSha256: text(value.modelSha256, 64), primitives: portable(value.primitives ?? [])};
}

/** Local playback never fetches a SoundCue URL or obtains a microphone implicitly. */
export function createTourScenePlayer({applyPlace, applyHistoricalImagery, applySunlight, applyPanorama, applyUpdate, assertScope = () => {}, validateScene = () => {},
  createAudio = url => new Audio(url), createObjectURL = blob => URL.createObjectURL(blob), revokeObjectURL = url => URL.revokeObjectURL(url)} = {}) {
  let disposed = false, active = null, key = null, generation = 0;
  const stopAudio = () => {
    if (active) {active.audio.pause();active.audio.removeAttribute?.("src");revokeObjectURL(active.url);active = null;}
  };
  return {
    async apply(frame, {playing = false, signal} = {}) {
      const currentGeneration = generation;
      const check = () => {if (disposed) throw fail("tour_scene_disposed");if (generation !== currentGeneration) throw fail("tour_scene_cancelled");signal?.throwIfAborted();assertScope();};
      check();
      const scene = frame.scene ? normalizeTourScene(frame.scene) : null;
      await validateScene(scene);check();
      const identity = scene ? {...scene, ...(scene.audio?.action === "play" ? {audio: {...scene.audio, clip: {...scene.audio.clip, dataBase64: undefined}}} : {})} : null;
      const nextKey = `${frame.sceneKeyframeId ?? ""}:${identity ? tourMediaSha256(new TextEncoder().encode(JSON.stringify(identity))) : ""}`;
      if (nextKey !== key) {
        const audioKey = scene?.audio?.action === "play" ? `${scene.audio.clip.sha256}:${frame.audioStartedMilliseconds ?? frame.sceneStartedMilliseconds ?? 0}:${scene.audio.offsetMilliseconds}` : null;
        if (active?.key !== audioKey) stopAudio();
        for (const [field, apply] of [["place", applyPlace], ["historicalImagery", applyHistoricalImagery], ["sunlight", applySunlight], ["panorama", applyPanorama]]) {
          if (scene && Object.hasOwn(scene, field)) {if (!apply) throw fail(`tour_${field}_unavailable`);await apply(structuredClone(scene[field]), {signal});check();}
        }
        for (const update of scene?.updates ?? []) {if (!applyUpdate) throw fail("tour_updates_unavailable");await applyUpdate(update);check();}
        if (scene?.audio?.action === "play" && !active) {
          const clip = scene.audio.clip, url = createObjectURL(new Blob([tourMediaBytes(clip.dataBase64)], {type: clip.mimeType}));
          active = {url, audio: createAudio(url), event: scene.audio, key: audioKey, needsSeek: true};active.audio.volume = scene.audio.gain;
        }
        key = nextKey;
      }
      if (active) {
        const seconds = Math.max(0, frame.elapsedMilliseconds - (frame.audioStartedMilliseconds ?? frame.sceneStartedMilliseconds ?? 0) + active.event.offsetMilliseconds) / 1000;
        if (seconds * 1000 >= active.event.clip.durationMilliseconds) {active.audio.pause();return;}
        if (active.needsSeek || !playing || Math.abs(active.audio.currentTime - seconds) > 0.15) active.audio.currentTime = seconds;
        active.needsSeek = false;
        if (playing) {
          const audio = active.audio, abort = () => audio.pause();signal?.addEventListener("abort", abort, {once: true});
          try {await audio.play();check();} catch (error) {audio.pause();throw error;} finally {signal?.removeEventListener("abort", abort);}
        } else active.audio.pause();
      }
    },
    pause() {generation++;active?.audio.pause();},
    stop() {generation++;stopAudio();key = null;},
    dispose() {generation++;stopAudio();key = null;disposed = true;}
  };
}

export async function tourAudioFromBlob(blob, {id = "narration", durationMilliseconds, attribution, license} = {}) {
  if (!(blob instanceof Blob) || !blob.size || blob.size > TOUR_MEDIA_LIMITS.audioBytes) throw fail("tour_audio_size_invalid");
  const bytes = new Uint8Array(await blob.arrayBuffer());let binary = "";
  for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return normalizeTourAudio({id, mimeType: blob.type, dataBase64: btoa(binary), sha256: tourMediaSha256(bytes), durationMilliseconds, attribution, license});
}

/** Call only from an explicit Record narration action; every owned track stops. */
export async function recordTourNarration({signal, mediaDevices = globalThis.navigator?.mediaDevices, Recorder = globalThis.MediaRecorder,
  attribution, license, now = () => performance.now()} = {}) {
  if (!mediaDevices?.getUserMedia || !Recorder?.isTypeSupported?.("audio/webm;codecs=opus")) throw fail("tour_narration_recorder_unavailable");
  signal?.throwIfAborted();const stream = await mediaDevices.getUserMedia({audio: true});
  if (signal?.aborted) {stream.getTracks().forEach(track => track.stop());signal.throwIfAborted();}
  const recorder = new Recorder(stream, {mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 64000}), chunks = [], start = now();
  let size = 0, timer, abort, done = false;
  const result = new Promise((resolve, reject) => {
    const cleanup = () => {clearTimeout(timer);signal?.removeEventListener("abort", abort);stream.getTracks().forEach(track => track.stop());};
    recorder.ondataavailable = event => {if (event.data?.size) {size += event.data.size;chunks.push(event.data);if (size > TOUR_MEDIA_LIMITS.audioBytes) {done = true;recorder.stop();cleanup();reject(fail("tour_audio_size_invalid"));}}};
    recorder.onerror = () => {done = true;cleanup();reject(fail("tour_narration_recording_failed"));};
    recorder.onstop = async () => {
      cleanup();if (done) return;done = true;
      try {resolve(await tourAudioFromBlob(new Blob(chunks, {type: recorder.mimeType}), {durationMilliseconds: Math.min(TOUR_MEDIA_LIMITS.audioMilliseconds, Math.max(1, Math.round(now() - start))), attribution, license}));}
      catch (error) {reject(error);}
    };
    abort = () => {done = true;if (recorder.state !== "inactive") recorder.stop();cleanup();reject(signal.reason ?? fail("tour_narration_cancelled"));};
    signal?.addEventListener("abort", abort, {once: true});timer = setTimeout(() => recorder.stop(), TOUR_MEDIA_LIMITS.audioMilliseconds);
    try {recorder.start(250);} catch (error) {done = true;cleanup();reject(error);}
  });
  void result.catch(() => {});
  return {result, stop() {if (!done && recorder.state !== "inactive") recorder.stop();}};
}

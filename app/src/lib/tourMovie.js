import {normalizeCameraTour, cameraTourDurationMilliseconds, cameraTourFrameAt} from "./cameraTour.js";
import {tourMediaBytes, tourMediaSha256} from "./tourMedia.js";

export const TOUR_MOVIE_LIMITS = Object.freeze({sizes: [[640, 360], [1280, 720]], frameRates: [12, 24],
  durationMilliseconds: 30000, frames: 721, encodedBytes: 32 * 1024 * 1024, encoderQueue: 2,
  executionMilliseconds: 90000, audioSampleRate: 48000, audioChannels: 2,
  audioSourceMilliseconds: 30000, audioSourceBytes: 8 * 1024 * 1024,
  codecs: {video: "vp8", audio: "opus", container: "video/webm"}});
const fail = code => Object.assign(new Error(code), {code});

export function tourMoviePlan(value, {width = 640, height = 360, frameRate = 12, attribution} = {}) {
  const tour = normalizeCameraTour(value), duration = cameraTourDurationMilliseconds(tour);
  if (!TOUR_MOVIE_LIMITS.sizes.some(size => size[0] === width && size[1] === height)
    || !TOUR_MOVIE_LIMITS.frameRates.includes(frameRate)) throw fail("tour_movie_profile_unsupported");
  if (!duration || duration > TOUR_MOVIE_LIMITS.durationMilliseconds) throw fail("tour_movie_duration_limit");
  if (typeof attribution !== "string" || !attribution.trim() || attribution.length > 8000) throw fail("tour_movie_attribution_required");
  const count = Math.ceil(duration * frameRate / 1000) + 1;
  if (count > TOUR_MOVIE_LIMITS.frames) throw fail("tour_movie_frame_limit");
  const audioSources = [...new Map(tourAudioEvents(tour).filter(event => event.audio.action === "play")
    .map(event => [event.audio.clip.sha256, event.audio.clip])).values()];
  if (audioSources.reduce((sum, clip) => sum + clip.durationMilliseconds, 0) > TOUR_MOVIE_LIMITS.audioSourceMilliseconds
    || audioSources.reduce((sum, clip) => sum + clip.dataBase64.length * 3 / 4, 0) > TOUR_MOVIE_LIMITS.audioSourceBytes)
    throw fail("tour_movie_audio_source_limit");
  return {width, height, frameRate, durationMilliseconds: duration, encodedDurationMilliseconds: count * 1000 / frameRate,
    attribution, timestamps: Array.from({length: count}, (_, index) => ({timestamp: Math.round(index * 1e6 / frameRate),
      sourceMilliseconds: Math.min(duration, index * 1000 / frameRate)})),
    endpointPolicy: "One final captured frame holds the exact tour endpoint for one frame interval."};
}

/** Deterministic frame timestamps and explicit caller-owned rendering; no fetches. */
export async function encodeTourMovie(value, {canvas, renderFrame, signal, onProgress = () => {},
  Encoder = globalThis.VideoEncoder, Frame = globalThis.VideoFrame,
  AudioEncoder: AudioEncoderType = globalThis.AudioEncoder, AudioData: AudioDataType = globalThis.AudioData,
  OfflineAudioContext: OfflineContext = globalThis.OfflineAudioContext, ...options} = {}) {
  const tour = normalizeCameraTour(value), plan = tourMoviePlan(tour, options);
  if (!canvas || typeof canvas.getContext !== "function" || typeof renderFrame !== "function" || !Encoder || !Frame) throw fail("tour_movie_encoder_unavailable");
  signal?.throwIfAborted();
  const configuration = {codec: "vp8", width: plan.width, height: plan.height, framerate: plan.frameRate, bitrate: 2000000, latencyMode: "quality"};
  if (!(await Encoder.isConfigSupported(configuration)).supported) throw fail("tour_movie_codec_unsupported");
  const controller = new AbortController(), chunks = [], started = performance.now();let bytes = 0, encoder, audioEncoder, rejectAbort, opusHead = null;
  const abort = () => controller.abort(signal.reason ?? fail("tour_movie_cancelled"));
  signal?.addEventListener("abort", abort, {once: true});
  const timeout = setTimeout(() => controller.abort(fail("tour_movie_execution_limit")), TOUR_MOVIE_LIMITS.executionMilliseconds);
  const aborted = new Promise((resolve, reject) => {rejectAbort = () => reject(controller.signal.reason);controller.signal.addEventListener("abort", rejectAbort, {once: true});});
  // A handled abort promise remains safe when codec support/rendering fails first.
  void aborted.catch(() => {});
  const guarded = promise => Promise.race([promise, aborted]);
  const output = track => (chunk, metadata) => {
    if (controller.signal.aborted) return;
    if (track === 2 && metadata?.decoderConfig?.description) {
      const description = metadata.decoderConfig.description;
      opusHead = description instanceof ArrayBuffer ? new Uint8Array(description).slice()
        : new Uint8Array(description.buffer, description.byteOffset, description.byteLength).slice();
    }
    const data = new Uint8Array(chunk.byteLength);chunk.copyTo(data);bytes += data.byteLength;
    if (bytes > TOUR_MOVIE_LIMITS.encodedBytes) {controller.abort(fail("tour_movie_encoded_size_limit"));return;}
    chunks.push({track, timestamp: chunk.timestamp, key: chunk.type === "key" || track === 2, data});
  };
  try {
    canvas.width = plan.width;canvas.height = plan.height;
    const context = canvas.getContext("2d");if (!context) throw fail("tour_movie_canvas_unavailable");
    encoder = new Encoder({output: output(1), error: error => controller.abort(error)});encoder.configure(configuration);
    for (let index = 0; index < plan.timestamps.length; index++) {
      controller.signal.throwIfAborted();const sample = plan.timestamps[index];
      await guarded(Promise.resolve(renderFrame(cameraTourFrameAt(tour, sample.sourceMilliseconds), canvas, controller.signal)));
      controller.signal.throwIfAborted();burnTourAttribution(context, canvas, plan.attribution);
      const frame = new Frame(canvas, {timestamp: sample.timestamp, duration: Math.round(1e6 / plan.frameRate)});
      try {encoder.encode(frame, {keyFrame: index % (plan.frameRate * 2) === 0});} finally {frame.close();}
      if (encoder.encodeQueueSize >= TOUR_MOVIE_LIMITS.encoderQueue) await guarded(encoder.flush());
      onProgress({phase: "frames", completedFrames: index + 1, totalFrames: plan.timestamps.length});
    }
    await guarded(encoder.flush());
    const audio = tourAudioEvents(tour);
    if (audio.some(event => event.audio.action === "play")) {
      if (!AudioEncoderType || !AudioDataType || !OfflineContext) throw fail("tour_movie_audio_encoder_unavailable");
      const config = {codec: "opus", sampleRate: 48000, numberOfChannels: 2, bitrate: 96000};
      if (!(await AudioEncoderType.isConfigSupported(config)).supported) throw fail("tour_movie_audio_codec_unsupported");
      const samples = Math.ceil(plan.encodedDurationMilliseconds * 48), offline = new OfflineContext(2, samples, 48000), decoded = new Map();
      for (let i = 0; i < audio.length; i++) {
        const event = audio[i];if (event.audio.action !== "play" || event.at >= plan.durationMilliseconds) continue;
        const clip = event.audio.clip;
        let buffer = decoded.get(clip.sha256);
        if (!buffer) {const data = tourMediaBytes(clip.dataBase64);buffer = await guarded(offline.decodeAudioData(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)));decoded.set(clip.sha256, buffer);}
        if (buffer.numberOfChannels > 2 || buffer.sampleRate !== 48000 || buffer.duration > 30.25
          || Math.abs(buffer.duration * 1000 - clip.durationMilliseconds) > 250) throw fail("tour_movie_audio_duration_mismatch");
        const source = offline.createBufferSource(), gain = offline.createGain();source.buffer = buffer;gain.gain.value = event.audio.gain;
        source.connect(gain);gain.connect(offline.destination);
        const offset = event.audio.offsetMilliseconds / 1000, end = Math.min(audio[i + 1]?.at ?? plan.durationMilliseconds, plan.durationMilliseconds);
        source.start(event.at / 1000, offset, Math.max(0, Math.min(end - event.at, clip.durationMilliseconds - event.audio.offsetMilliseconds)) / 1000);
      }
      const mixed = await guarded(offline.startRendering());
      audioEncoder = new AudioEncoderType({output: output(2), error: error => controller.abort(error)});audioEncoder.configure(config);
      for (let offset = 0; offset < samples; offset += 960) {
        controller.signal.throwIfAborted();const length = Math.min(960, samples - offset), data = new Float32Array(length * 2);
        for (let channel = 0; channel < 2; channel++) data.set(mixed.getChannelData(channel).subarray(offset, offset + length), channel * length);
        const frame = new AudioDataType({format: "f32-planar", sampleRate: 48000, numberOfFrames: length, numberOfChannels: 2,
          timestamp: Math.round(offset / 48000 * 1e6), data});
        try {audioEncoder.encode(frame);} finally {frame.close();}
        if (audioEncoder.encodeQueueSize >= TOUR_MOVIE_LIMITS.encoderQueue) await guarded(audioEncoder.flush());
      }
      await guarded(audioEncoder.flush());
    }
    controller.signal.throwIfAborted();
    const movie = muxTourWebM(chunks, plan, chunks.some(chunk => chunk.track === 2), opusHead);
    if (movie.byteLength > TOUR_MOVIE_LIMITS.encodedBytes) throw fail("tour_movie_encoded_size_limit");
    return {blob: new Blob([movie], {type: "video/webm"}), report: {schemaVersion: "opengeo.tour-movie.1.0.0",
      profile: {...plan, timestamps: undefined}, codec: "VP8", audioCodec: chunks.some(chunk => chunk.track === 2) ? "Opus" : null,
      capturedFrames: plan.timestamps.length, encodedBytes: movie.byteLength, sha256: tourMediaSha256(movie),
      frameTimestampsMicroseconds: plan.timestamps.map(sample => sample.timestamp), sourceTimesMilliseconds: plan.timestamps.map(sample => sample.sourceMilliseconds),
      attribution: plan.attribution, audioAttributions: audio.filter(event => event.audio.action === "play").map(event => ({sha256: event.audio.clip.sha256,
        attribution: event.audio.clip.attribution, license: event.audio.clip.license})), executionMilliseconds: performance.now() - started,
      limits: TOUR_MOVIE_LIMITS, networkRequests: 0}};
  } finally {
    clearTimeout(timeout);signal?.removeEventListener("abort", abort);controller.signal.removeEventListener("abort", rejectAbort);
    for (const codec of [encoder, audioEncoder]) if (codec && codec.state !== "closed") codec.close();
  }
}

export function tourAudioEvents(tour) {
  const events = [];let cursor = 0;
  for (let index = 0; index < tour.keyframes.length; index++) {
    const frame = tour.keyframes[index];cursor += index ? frame.transitionMilliseconds : 0;
    if (frame.scene?.audio) events.push({at: cursor, audio: frame.scene.audio});cursor += frame.holdMilliseconds;
  }
  return events;
}
export function burnTourAttribution(context, canvas, attribution) {
  context.save();context.font = "12px sans-serif";const words = attribution.replace(/\s+/g, " ").split(" "), lines = [];let line = "";
  for (const word of words) {const next = line ? `${line} ${word}` : word;if (context.measureText(next).width > canvas.width - 16 && line) {lines.push(line);line = word;} else line = next;}
  if (line) lines.push(line);if (lines.length > 8) {context.restore();throw fail("tour_movie_attribution_does_not_fit");}
  const height = lines.length * 15 + 8;context.fillStyle = "rgba(0,0,0,0.85)";context.fillRect(0, canvas.height - height, canvas.width, height);
  context.fillStyle = "#fff";context.textBaseline = "top";lines.forEach((text, index) => context.fillText(text, 8, canvas.height - height + 4 + index * 15));context.restore();
}

const concat = values => {const bytes = new Uint8Array(values.reduce((sum, value) => sum + value.length, 0));let offset = 0;for (const value of values) {bytes.set(value, offset);offset += value.length;}return bytes;};
const hex = value => Uint8Array.from(value.match(/../g).map(byte => parseInt(byte, 16)));
const integer = value => {const bytes = [];do {bytes.unshift(value % 256);value = Math.floor(value / 256);} while (value);return Uint8Array.from(bytes);};
const size = value => {for (let width = 1; width <= 7; width++) if (value < 2 ** (width * 7) - 1) {const bytes = new Uint8Array(width);for (let i = width - 1; i >= 0; i--) {bytes[i] = value % 256;value = Math.floor(value / 256);}bytes[0] |= 1 << (8 - width);return bytes;}throw fail("tour_movie_mux_size_limit");};
const element = (id, bytes) => concat([hex(id), size(bytes.length), bytes]);
const uint = (id, value) => element(id, integer(value));
const string = (id, value) => element(id, new TextEncoder().encode(value));
const master = (id, values) => element(id, concat(values));
const float = (id, value) => {const buffer = new ArrayBuffer(8);new DataView(buffer).setFloat64(0, value);return element(id, new Uint8Array(buffer));};

/** Small deterministic WebM mux: VP8/optional Opus, bounded millisecond clusters. */
export function muxTourWebM(chunks, plan, audio = false, opusHead = null) {
  if (!chunks.length || chunks.some(chunk => ![1, 2].includes(chunk.track) || !Number.isSafeInteger(chunk.timestamp) || chunk.timestamp < 0)) throw fail("tour_movie_chunks_invalid");
  const header = master("1a45dfa3", [uint("4286", 1), uint("42f7", 1), uint("42f2", 4), uint("42f3", 8), string("4282", "webm"), uint("4287", 4), uint("4285", 2)]);
  const info = master("1549a966", [uint("2ad7b1", 1000000), float("4489", plan.encodedDurationMilliseconds), string("4d80", "OpenGeo"), string("5741", "OpenGeo")]);
  const tracks = [master("ae", [uint("d7", 1), uint("73c5", 1), uint("83", 1), string("86", "V_VP8"), uint("23e383", Math.round(1e9 / plan.frameRate)),
    master("e0", [uint("b0", plan.width), uint("ba", plan.height)])])];
  if (audio) {
    if (!(opusHead instanceof Uint8Array) || opusHead.length < 19 || new TextDecoder().decode(opusHead.subarray(0, 8)) !== "OpusHead"
      || opusHead[9] !== 2) throw fail("tour_movie_opus_configuration_missing");
    const delaySamples = new DataView(opusHead.buffer, opusHead.byteOffset, opusHead.byteLength).getUint16(10, true);
    tracks.push(master("ae", [uint("d7", 2), uint("73c5", 2), uint("83", 2), string("86", "A_OPUS"), element("63a2", opusHead),
      uint("56aa", Math.round(delaySamples / 48000 * 1e9)), uint("56bb", 80000000), master("e1", [float("b5", 48000), uint("9f", 2)])]));
  }
  const clusters = [];let blocks = [], clusterTime = -1;
  const flush = () => {if (blocks.length) clusters.push(master("1f43b675", [uint("e7", clusterTime), ...blocks]));blocks = [];};
  for (const chunk of [...chunks].sort((a, b) => a.timestamp - b.timestamp || a.track - b.track)) {
    const at = Math.round(chunk.timestamp / 1000);
    if (clusterTime < 0 || at - clusterTime >= 2000) {flush();clusterTime = at;}
    const prefix = new Uint8Array(4);prefix[0] = 0x80 | chunk.track;new DataView(prefix.buffer).setInt16(1, at - clusterTime);prefix[3] = chunk.key ? 0x80 : 0;
    blocks.push(element("a3", concat([prefix, chunk.data])));
  }
  flush();const tags = master("1254c367", [master("7373", [master("63c0", []), master("67c8", [string("45a3", "COMMENT"), string("4487", plan.attribution)])])]);
  return concat([header, master("18538067", [info, master("1654ae6b", tracks), ...clusters, tags])]);
}

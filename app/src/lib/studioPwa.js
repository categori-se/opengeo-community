export const CAPTURE_SYNC_TAG = "opengeo-field-capture-v1";
export const CAPTURE_SYNC_MESSAGE = Object.freeze({
  type: "opengeo:capture-sync-request",
  version: 1
});

export async function scheduleCaptureSync({
  serviceWorker = globalThis.navigator?.serviceWorker,
  eventTarget = globalThis
} = {}) {
  if (typeof serviceWorker?.getRegistration !== "function") {
    dispatchClientSync(eventTarget, "service-worker-unavailable");
    return {scheduled: false, mode: "client-assisted"};
  }
  let registration;
  try {
    // ready can remain pending forever if installation is blocked or absent.
    // Saving a durable local record must not depend on future worker activation.
    registration = await serviceWorker.getRegistration();
    if (typeof registration?.sync?.register === "function") {
      await registration.sync.register(CAPTURE_SYNC_TAG);
      return {scheduled: true, mode: "background-sync"};
    }
  } catch {
    // The queued record remains authoritative on this device. A current,
    // authenticated client may still replay it without persisting credentials.
  }
  registration?.active?.postMessage?.(CAPTURE_SYNC_MESSAGE);
  dispatchClientSync(eventTarget, "client-assisted");
  return {scheduled: false, mode: "client-assisted"};
}

export function subscribeCaptureSync(handler, {
  serviceWorker = globalThis.navigator?.serviceWorker,
  onlineTarget = globalThis,
  eventTarget = globalThis,
  runOnStart = true,
  onError = () => {}
} = {}) {
  if (typeof handler !== "function") throw new TypeError("capture sync handler is required");
  if (typeof onError !== "function") throw new TypeError("capture sync error handler is invalid");
  let stopped = false;
  let inFlight = null;
  let rerun = false;
  const run = (reason) => {
    if (stopped || globalThis.navigator?.onLine === false) return Promise.resolve(null);
    if (inFlight) {
      rerun = true;
      return inFlight;
    }
    inFlight = Promise.resolve()
      .then(() => handler(reason))
      .catch((error) => onError(error, reason))
      .finally(() => {
        inFlight = null;
        if (rerun && !stopped) {
          rerun = false;
          queueMicrotask(() => run("coalesced"));
        }
      });
    return inFlight;
  };
  const onMessage = (event) => {
    if (captureSyncMessage(event?.data)) run(event.data.reason ?? "service-worker");
  };
  const onOnline = () => run("online");
  const onClientRequest = (event) => run(event?.detail?.reason ?? "client-assisted");
  serviceWorker?.addEventListener?.("message", onMessage);
  onlineTarget?.addEventListener?.("online", onOnline);
  eventTarget?.addEventListener?.("opengeo:capture-sync", onClientRequest);
  if (runOnStart) queueMicrotask(() => run("client-ready"));
  return () => {
    stopped = true;
    serviceWorker?.removeEventListener?.("message", onMessage);
    onlineTarget?.removeEventListener?.("online", onOnline);
    eventTarget?.removeEventListener?.("opengeo:capture-sync", onClientRequest);
  };
}

export function captureSyncMessage(value) {
  return value?.type === CAPTURE_SYNC_MESSAGE.type
    && value?.version === CAPTURE_SYNC_MESSAGE.version;
}

function dispatchClientSync(target, reason) {
  if (typeof target?.dispatchEvent !== "function") return;
  const CustomEventConstructor = globalThis.CustomEvent;
  if (typeof CustomEventConstructor === "function") {
    target.dispatchEvent(new CustomEventConstructor("opengeo:capture-sync", {
      detail: {reason}
    }));
    return;
  }
  const EventConstructor = globalThis.Event;
  if (typeof EventConstructor === "function") target.dispatchEvent(new EventConstructor("opengeo:capture-sync"));
}

const DEFAULT_DELAYS = Object.freeze([750, 2_000, 5_000]);

const STARTUP_MESSAGES = Object.freeze({
  directory: (
    "Loading your account and project index. The service has not finished responding yet."
  ),
  account: (
    "Loading your account tools. The service has not finished responding yet."
  ),
  project: "Waiting for the project's essential records and source connections."
});

export function platformStartupMessage(scope) {
  const message = STARTUP_MESSAGES[scope];
  if (!message) throw new TypeError("platform startup scope must be account, directory, or project");
  return message;
}

export async function loadWithWakeRetry(
  load,
  {
    delays = DEFAULT_DELAYS,
    onRetry = () => {},
    signal,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
  } = {}
) {
  if (typeof load !== "function") throw new TypeError("platform loader is required");
  let state = await load();
  for (const [index, delay] of delays.entries()) {
    if (signal?.aborted) return state;
    if (state?.status !== "error" || state.retryable === false) return state;
    onRetry({attempt: index + 1, delay, state});
    await sleep(delay);
    if (signal?.aborted) return state;
    state = await load();
  }
  return state;
}

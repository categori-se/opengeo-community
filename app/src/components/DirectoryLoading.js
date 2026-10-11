import {loadDirectoryCore, revalidateDirectoryCore} from "../lib/platform.js";
import {loadWithWakeRetry} from "../lib/platformLoadRetry.js";

export function DirectoryLoading({adapter, timeoutMs = 90_000, retryDelays, tickMs = 1_000, includeProjects = true,
  retainedDirectory = null, retainedIdentity = null, navigationLabel = null}) {
  const returning = Boolean(retainedDirectory && retainedIdentity);
  const controller = new AbortController();
  const root = document.createElement("section");
  root.className = "platform-state platform-state-loading platform-directory-loading";
  root.dataset.state = "loading";
  root.setAttribute("aria-busy", "true");
  const title = document.createElement("h2");
  title.textContent = returning ? `Loading ${navigationLabel ?? 'workspace tools'}` : "Opening Studio";
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.textContent = returning ? "Checking current account permissions…" : "Checking account access…";
  const progress = document.createElement("progress");
  progress.setAttribute("aria-label", title.textContent);
  progress.style.width = "100%";
  const steps = document.createElement("ol");
  const labels = {session: "Account access", access: "Account permissions", ...(includeProjects ? {projects: "Data access"} : {})};
  const rows = Object.fromEntries(Object.entries(labels).map(([key, label]) => {
    const row = document.createElement("li");
    row.textContent = `${label} · waiting`;
    row.dataset.state = "waiting";
    steps.append(row);
    return [key, row];
  }));
  const elapsed = document.createElement("p");
  elapsed.className = "platform-note";
  elapsed.setAttribute("aria-live", "off");
  const note = document.createElement("p");
  note.className = "platform-note";
  note.textContent = "Waiting for Studio’s account service.";
  const home = document.createElement("a");
  home.href = "/";
  home.className = "platform-button platform-button-secondary";
  home.textContent = "Back to map";
  root.append(title, progress, status, ...(returning ? [] : [steps]), elapsed, note, home);
  const started = performance.now();
  const tick = () => {
    const seconds = Math.floor((performance.now() - started) / 1000);
    elapsed.textContent = `Elapsed: ${seconds}s`;
    if (seconds >= 15) note.textContent = "Studio’s account service is taking longer to respond. You can return to the map while it loads.";
  };
  tick();
  const interval = setInterval(tick, tickMs);
  let deadline;
  const dispose = () => {clearInterval(interval); clearTimeout(deadline); controller.abort();};
  home.addEventListener("click", dispose);
  const onProgress = ({step, state}) => {
    if (controller.signal.aborted || !rows[step]) return;
    rows[step].dataset.state = state;
    rows[step].textContent = `${labels[step]} · ${state === "complete" ? "ready" : "loading"}`;
    const active = Object.keys(rows).filter((key) => rows[key].dataset.state === "loading");
    status.textContent = active.length ? `Loading ${active.map((key) => labels[key].toLowerCase()).join(" and ")}…` : "Preparing your projects…";
  };
  const timedOut = new Promise((resolve) => {
    deadline = setTimeout(() => {
      controller.abort();
      resolve({status: "error", code: "directory_load_timeout", scope: "directory", retryable: true, adapter});
    }, timeoutMs);
  });
  const result = Promise.race([timedOut, loadWithWakeRetry(
    () => returning
      ? revalidateDirectoryCore(adapter, retainedDirectory, retainedIdentity, {signal: controller.signal})
      : loadDirectoryCore(adapter, {signal: controller.signal, onProgress, includeProjects}),
    {signal: controller.signal, ...(retryDelays ? {delays: retryDelays} : {}),
      onRetry: ({attempt, delay}) => {
        for (const [key, row] of Object.entries(rows)) {row.dataset.state = "waiting"; row.textContent = `${labels[key]} · waiting`;}
        status.textContent = `No response yet. Retrying in ${Math.ceil(delay / 1000)}s (retry ${attempt}).`;
      }}
  )]).finally(dispose);
  return {element: root, result, dispose};
}

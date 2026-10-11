// Recent history is supplementary: never hold the map or navigation behind it.
export function StartRecentProjects({adapter, render, timeoutMs = 20_000}) {
  const root = document.createElement("div");
  root.className = "start-project-list";
  let generation = 0;
  let controller;
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "platform-button platform-button-secondary";
  retry.textContent = "Retry recent projects";
  retry.addEventListener("click", load);
  void load();
  return root;

  async function load() {
    const current = ++generation;
    controller?.abort();
    controller = new AbortController();
    const {signal} = controller;
    const status = document.createElement("p");
    status.className = "start-search-empty";
    status.setAttribute("role", "status");
    status.textContent = "Loading recent projects… You can use the map and navigation now.";
    root.replaceChildren(status);
    root.setAttribute("aria-busy", "true");
    let timer;
    try {
      const projects = await Promise.race([
        history(signal),
        new Promise((_, reject) => { timer = setTimeout(() => {
          controller.abort();
          reject(new Error("history_timeout"));
        }, timeoutMs); })
      ]);
      if (current !== generation) return;
      root.replaceChildren(...projects.map(render));
      if (!projects.length) {
        status.textContent = "No recent project activity. Browse projects or create one to get started.";
        root.append(status);
      }
    } catch (error) {
      if (current !== generation) return;
      status.textContent = error?.status === 401
        ? "Sign in to see your recent projects."
        : "Recent projects are taking longer to load. You can continue working or retry here.";
      root.replaceChildren(status, ...(error?.status === 401 ? [] : [retry]));
    } finally {
      clearTimeout(timer);
      if (current === generation) root.setAttribute("aria-busy", "false");
    }
  }

  async function history(signal) {
    let session;
    try { session = await adapter.getSession({signal}); }
    catch (error) {
      if (error?.status !== 403 || !adapter.clearOrganization) throw error;
      signal.throwIfAborted();
      adapter.clearOrganization();
      session = await adapter.getSession({signal});
    }
    signal.throwIfAborted();
    const org = session.selectedOrganizationId
      ?? (session.memberships.length === 1 ? session.memberships[0].organizationId : null);
    if (!org) return [];
    adapter.selectOrganization(org);
    const records = typeof adapter.listRecentProjects === "function"
      ? await adapter.listRecentProjects({limit: 5, signal})
      : await adapter.listProjects({limit: 5, signal});
    signal.throwIfAborted();
    return records.slice(0, 5);
  }
}

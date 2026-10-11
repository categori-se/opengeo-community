// Keep map DOM, WebGL context and drafts alive during directory visits.
// Saved editors supply fresh access checks; this stores no credentials or account cache.
export function retainStudioAreas({root, mapSurface = null, createMap = null, createHome = null, createDirectory, startAtDirectory = false, mapHref = null, beforeShowMap = null, beforeShowMapLabel = 'Project', resumeRecovery = null}) {
  const browser = root.ownerDocument.defaultView;
  const navigationRoot = root.ownerDocument;
  const initial = new URL(browser.location.href);
  const mapUrl = new URL(mapHref ?? "/", initial);
  if (!mapHref && initial.searchParams.has("adapter")) mapUrl.searchParams.set("adapter", initial.searchParams.get("adapter"));
  const isMap = url => url.pathname === mapUrl.pathname && url.search === mapUrl.search;
  const homeUrl = new URL('/', initial);
  if (initial.searchParams.has('adapter')) homeUrl.searchParams.set('adapter', initial.searchParams.get('adapter'));
  const isHome = url => Boolean(createHome) && url.pathname === homeUrl.pathname && url.search === homeUrl.search;
  let resume = null, generation = 0;
  let directory = null, pending = null, pendingMap = null, disposed = false, lastDirectoryUrl = null;
  let homeSurface = null, pendingHome = null;
  const placeholder = root.ownerDocument.createElement("section");
  placeholder.className = "platform-state";
  const status = root.ownerDocument.createElement("p");
  status.setAttribute("role", "status");
  status.textContent = "Opening workspace tools…";
  const back = root.ownerDocument.createElement("a");
  back.href = mapUrl.href;
  back.textContent = "Back to map";
  placeholder.append(status, back);
  const directoryLink = root.ownerDocument.createElement("a");
  directoryLink.textContent = "Back to workspace tools";
  directoryLink.hidden = true;
  placeholder.append(directoryLink);
  const recovery = root.ownerDocument.createElement("div");
  placeholder.append(recovery);
  placeholder.hidden = true;
  root.append(placeholder);
  const accepts = url => url.origin === initial.origin && !url.hash
    && url.searchParams.get("adapter") === initial.searchParams.get("adapter")
    && (isMap(url) || isHome(url) ? true
      : url.pathname === "/workspaces"
        && [...url.searchParams.keys()].every(k => ["view", "adapter", "collection", "location", "new"].includes(k))
        && (!url.searchParams.has("new") || ["map", "publication"].includes(url.searchParams.get("new"))));
  const show = async target => {
    if (disposed) return;
    const ticket = ++generation;
    resume?.abort();
    resume = null;
    const home = isMap(target);
    const landing = isHome(target);
    directoryLink.hidden = true;
    recovery.replaceChildren();
    const reopening = Boolean(directory?.hidden);
    if (mapSurface) mapSurface.hidden = !home || Boolean(beforeShowMap);
    if (homeSurface) homeSurface.hidden = !landing;
    if (directory) directory.hidden = home || landing;
    if (landing) {
      placeholder.hidden = Boolean(homeSurface);
      if (!homeSurface) {
        status.textContent = 'Opening Home…';
        if (!pendingHome) pendingHome = Promise.resolve().then(createHome).then(view => {
          if (disposed) {view.dispose?.(); return;}
          homeSurface = view; root.append(view);
        }).catch(() => {status.textContent = 'Home could not load. Return to your saved work or try again.';})
          .finally(() => {pendingHome = null;});
        await pendingHome;
        if (disposed || !homeSurface) return;
        return show(new URL(browser.location.href));
      }
      homeSurface.querySelector('.gis-map')?.dispatchEvent(new browser.Event('workbench:resize'));
      return;
    }
    placeholder.hidden = home || Boolean(directory);
    if (home) {
      if (mapSurface && beforeShowMap) {
        const controller = resume = new AbortController();
        placeholder.hidden = false;
        status.textContent = `Checking ${beforeShowMapLabel} access…`;
        back.href = mapUrl.href;
        back.textContent = `Retry returning to ${beforeShowMapLabel}`;
        if (lastDirectoryUrl) {
          directoryLink.href = lastDirectoryUrl;
          directoryLink.hidden = false;
        }
        let allowed = false;
        try { allowed = await beforeShowMap({signal: controller.signal}); } catch { /* Keep the editor hidden. */ }
        if (disposed || ticket !== generation || controller.signal.aborted) return;
        resume = null;
        if (!allowed) {
          status.textContent = `The ${beforeShowMapLabel} could not be reopened safely. Access or source records may have changed. Retry, return to workspace tools, or reload to open the latest ${beforeShowMapLabel}. Reloading may discard unsaved changes.`;
          const content = resumeRecovery?.();
          if (content) recovery.append(content);
          return;
        }
        placeholder.hidden = true;
        mapSurface.hidden = false;
      }
      if (!mapSurface && createMap) {
        placeholder.hidden = false;
        status.textContent = "Opening map…";
        back.href = lastDirectoryUrl ?? initial.href;
        back.textContent = "Back to workspace tools";
        if (!pendingMap) pendingMap = Promise.resolve().then(createMap).then(view => {
          if (disposed) {view.dispose?.(); return;}
          mapSurface = view;
          root.append(view);
        }).catch(() => {
          status.textContent = "The map could not load. Return to workspace tools or try again.";
        }).finally(() => {pendingMap = null;});
        await pendingMap;
        if (disposed || !mapSurface) return;
        return show(new URL(browser.location.href));
      }
      mapSurface.querySelector(".gis-map")?.dispatchEvent(new browser.Event("workbench:resize"));
      return;
    }
    if (!directory) {
      if (!pending) pending = Promise.resolve().then(() => createDirectory(target)).then(view => {
        if (disposed) {view.dispose?.(); return;}
        directory = view;
        lastDirectoryUrl = target.href;
        root.append(view);
      }).catch(() => {
        status.textContent = "Workspace tools could not load. Return to the map or try the area again.";
      }).finally(() => {pending = null;});
      await pending;
      if (disposed || !directory) return;
      // Navigation may have changed while the module loaded.
      return show(new URL(browser.location.href));
    }
    placeholder.hidden = true;
    if (reopening || lastDirectoryUrl !== target.href) {
      lastDirectoryUrl = target.href;
      directory.navigateTo?.(target);
    }
  };
  const click = event => {
    if (disposed || !root.isConnected || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest?.("a");
    if (!link || link.target || link.hasAttribute("download")) return;
    const target = new URL(link.href, browser.location.href);
    if (!accepts(target)) return;
    event.preventDefault();
    if (directory && !directory.hidden && directory.shouldBlockNavigation?.()) return;
    // Remember directory-internal navigation, which its own handler already owns.
    if (directory && !directory.hidden) lastDirectoryUrl = browser.location.href;
    browser.history.pushState(null, "", target);
    void show(target);
  };
  const pop = () => {
    const target = new URL(browser.location.href);
    if (!accepts(target)) return;
    if (directory && !directory.hidden && directory.shouldBlockNavigation?.()) {
      browser.history.pushState(null, "", lastDirectoryUrl);
      return;
    }
    void show(target);
  };
  // Framework's application header is outside this surface. Keep its accepted
  // same-tab area links in the same document, just like the in-surface controls.
  navigationRoot.addEventListener("click", click);
  browser.addEventListener("popstate", pop);
  if (startAtDirectory) void show(initial);
  return () => {
    disposed = true;
    resume?.abort();
    navigationRoot.removeEventListener("click", click);
    browser.removeEventListener("popstate", pop);
    directory?.dispose?.();
    mapSurface?.dispose?.();
    homeSurface?.dispose?.();
  };
}

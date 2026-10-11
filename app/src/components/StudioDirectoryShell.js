import {PlatformDirectory} from "./PlatformDirectory.js";
import {retainStudioAreas} from "../lib/retainedStudioAreas.js";

// Direct account-area entry shares navigation with the landing workbench, but
// does not load a renderer, map data or provider tiles until Home is opened.
export function StudioDirectoryShell({catalog, mapFontAttachments, ...options}) {
  const root = document.createElement("section");
  root.className = "opengeo-start";
  root.dispose = retainStudioAreas({
    root,
    startAtDirectory: true,
    createDirectory: target => PlatformDirectory({...options,
      view: target.searchParams.get("view"), navigationManagedExternally: true}),
    createMap: async () => {
      const {StartPage} = await import("./StartPage.js");
      return StartPage({catalog, mapFontAttachments, adapter: options.adapter,
        auth: options.auth, retainNavigation: false, loadRecentProjects: false});
    }
  });
  return root;
}

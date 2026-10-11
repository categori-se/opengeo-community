import {ProjectWorkspacePage} from "./ProjectWorkspacePage.js";
import {retainStudioAreas} from "../lib/retainedStudioAreas.js";
import {StudioAccountControls} from "./StudioAccountControls.js";

export function SavedProjectShell({directoryOptions, ...options}) {
  const root = document.createElement("section");
  root.className = "opengeo-start";
  const mapHref = window.location.href;
  const editor = ProjectWorkspacePage(options);
  root.append(editor);
  root.dispose = retainStudioAreas({root, mapSurface: editor, mapHref,
    beforeShowMapLabel: options.publicationId ? 'Publication' : 'Project',
    createHome: async () => {
      const {StartPage} = await import('./StartPage.js');
      return StartPage({catalog: options.catalog, mapFontAttachments: options.mapFontAttachments,
        adapter: options.adapter, auth: options.auth, retainNavigation: false, loadRecentProjects: false});
    },
    beforeShowMap: options => editor.canResume(options),
    resumeRecovery: () => editor.resumeStatus === "unauthenticated" && options.auth?.beginSignIn
      ? StudioAccountControls({auth: options.auth, saveDraft: () => editor.saveDraftForSignIn(),
        returnTo: new URL(mapHref).pathname + new URL(mapHref).search})
      : null,
    createDirectory: async target => {
      const {PlatformDirectory} = await import("./PlatformDirectory.js");
      const wrapper = document.createElement("section");
      const back = document.createElement("a");
      back.href = mapHref;
      back.textContent = options.publicationId ? "Back to open Publication" : "Back to open Project";
      back.className = "gis-button";
      const retained = editor.retainedDirectoryContext?.();
      const directory = PlatformDirectory({...directoryOptions, adapter: options.adapter,
        auth: options.auth, view: target.searchParams.get("view"), navigationManagedExternally: true,
        initialDirectory: retained?.directory ?? null, initialIdentity: retained?.identity ?? null});
      wrapper.append(back, directory);
      wrapper.navigateTo = target => directory.navigateTo(target);
      wrapper.shouldBlockNavigation = () => directory.shouldBlockNavigation();
      wrapper.dispose = () => directory.dispose?.();
      return wrapper;
    }
  });
  return root;
}

// Account navigation shares the existing Cognito flow; it never creates a project.
export function StudioAccountControls({session = null, signedIn = false, auth, saveDraft, hasUnsavedChanges = () => true, returnTo = "/"}) {
  const root = document.createElement("div");
  root.className = "gis-account-controls";
  const identity = document.createElement("span");
  identity.className = "gis-account-identity";
  identity.textContent = session?.displayName || session?.email || "";
  identity.title = session?.email || identity.textContent;
  const action = document.createElement("button");
  action.type = "button";
  action.className = "gis-button gis-account-command";
  action.textContent = signedIn ? "Sign out" : "Sign in";
  const dialog = document.createElement("dialog");
  dialog.className = "gis-account-dialog";
  dialog.setAttribute("aria-label", action.textContent);
  const title = document.createElement("h2");
  title.textContent = `${action.textContent} from Studio`;
  const explanation = document.createElement("p");
  explanation.textContent = "Save this map in this browser before leaving. It will not be uploaded or added to a shared project. Finish any open form before continuing.";
  const status = document.createElement("p");
  status.role = "status";
  const navigationError = document.createElement("p");
  navigationError.className = "gis-account-navigation-error";
  navigationError.setAttribute("role", "alert");
  navigationError.hidden = true;
  const actions = document.createElement("div");
  actions.className = "gis-account-dialog-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Stay on map";
  const proceed = document.createElement("button");
  proceed.type = "button";
  proceed.textContent = `Save in browser and ${signedIn ? "sign out" : "sign in"}`;
  actions.append(cancel, proceed);
  dialog.append(title, explanation, status, actions);
  root.append(identity, action, navigationError, dialog);
  action.addEventListener("click", () => {
    status.textContent = "";
    navigationError.hidden = true;
    navigationError.textContent = "";
    if (!hasUnsavedChanges()) {
      void navigate(false);
      return;
    }
    dialog.showModal();
    cancel.focus();
  });
  cancel.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => action.focus());
  dialog.addEventListener("cancel", event => { if (proceed.disabled) event.preventDefault(); });
  proceed.addEventListener("click", () => void navigate(true));
  async function navigate(saveFirst) {
    if (action.disabled) return;
    action.disabled = true;
    proceed.disabled = cancel.disabled = true;
    try {
      if (saveFirst && await saveDraft() !== true) {
        status.textContent = "The map could not be saved here. Stay on the map and export it before signing in or out.";
        return;
      }
      status.textContent = saveFirst ? "Map saved in this browser. Opening your account…" : "Opening your account…";
      if (signedIn) await auth.signOut();
      else await auth.beginSignIn(returnTo);
    } catch {
      if (saveFirst) {
        status.textContent = "Account navigation is unavailable. Your map is still here; please try again.";
      } else {
        // An authentication failure is not evidence of unsaved map changes.
        // Keep the map usable and let the original account button retry.
        navigationError.textContent = `Could not open ${signedIn ? "sign-out" : "sign-in"}. Your map is unchanged. Try ${signedIn ? "Sign out" : "Sign in"} again.`;
        navigationError.hidden = false;
      }
    } finally {
      action.disabled = false;
      proceed.disabled = cancel.disabled = false;
    }
  }
  return root;
}

import {modeBanner, platformStatePanel} from "./PlatformDirectory.js";
import {failureState} from "../lib/platform.js";
import {localFixtureWorkspaceHref} from "../lib/localDevelopment.js";
import {requestedAuthReturnTo} from "../lib/authNavigation.js";

export function SessionPanel({adapter, auth = null}) {
  const root = document.createElement("section");
  root.className = "platform-surface";
  root.ariaLive = "polite";
  const requestedReturnTo = requestedAuthReturnTo();
  renderLoading();
  void load();
  globalThis.addEventListener?.("pageshow", (event) => {
    if (event.persisted && root.isConnected) void load();
  });
  return root;

  async function load() {
    renderLoading();
    if (adapter.kind === "fixture") {
      try {
        const session = await adapter.getSession();
        root.replaceChildren(modeBanner(adapter), sessionDetails(session, adapter, null));
      } catch (error) {
        root.replaceChildren(modeBanner(adapter), platformStatePanel(failureState(error, adapter), load));
      }
      return;
    }

    if (!auth) {
      renderAuthState({status: "configuration_error", code: "browser_auth_unavailable"});
      return;
    }
    const state = await auth.initialize();
    if (!["signed_in", "callback_complete"].includes(state.status)) {
      renderAuthState(state, requestedReturnTo);
      return;
    }
    if (state.status === "callback_complete") adapter.clearOrganization?.();
    location.replace(state.status === "callback_complete" ? state.returnTo : requestedReturnTo);
  }

  function renderAuthState(state, returnTo = requestedReturnTo) {
    root.replaceChildren(modeBanner(adapter), authStatePanel(state, auth, renderAuthState, returnTo));
  }

  function renderLoading() {
    const loading = document.createElement("section");
    loading.className = "platform-state platform-state-loading";
    loading.dataset.state = "loading";
    loading.textContent = "Checking the browser session…";
    root.replaceChildren(loading);
  }
}

function authStatePanel(state, auth, replaceState, returnTo) {
  const panel = document.createElement("section");
  panel.className = `platform-auth platform-auth-${state.status}`;
  panel.dataset.authState = state.status;

  if (state.status === "configuration_error") {
    const fixtureHref = localFixtureWorkspaceHref();
    panel.append(
      text("h2", "Sign-in is not configured"),
      text("p", "This deployment does not have a valid same-origin authentication configuration. No credentials were requested."),
      text(
        "p",
        fixtureHref
          ? "This local preview can use synthetic browser test data, or an operator can provide an exact-origin Cognito configuration."
          : "An operator must publish auth-config.json from the OpenGeo client registered with shared auth.categori.se.",
        "platform-note"
      )
    );
    if (fixtureHref) {
      const actions = document.createElement("div");
      actions.className = "platform-actions";
      const fixture = text("a", "Open local test workspace", "platform-button");
      fixture.href = fixtureHref;
      fixture.dataset.action = "local-fixture";
      actions.append(fixture);
      panel.append(
        actions,
        text(
          "p",
          "Local test mode uses synthetic records, makes memory-only changes, and does not authenticate against Cognito or call the OpenGeo API.",
          "platform-note"
        )
      );
    }
    return panel;
  }

  const expired = state.status === "expired";
  const callbackError = state.status === "callback_error";
  panel.append(
    authStatus(
      expired ? "expired" : "signed_out",
      expired ? "Studio status: Session expired" : "Studio status: Signed out"
    ),
    text("h2", expired ? "Session expired" : callbackError ? "Sign-in did not complete" : "You are signed out"),
    text("p", expired
      ? "Your short-lived access token expired and was removed from this browser session."
      : callbackError
        ? callbackMessage(state.code)
        : "Sign in securely to continue to your projects, files, teams, and account settings."),
    text("p", "Your password and MFA stay with auth.categori.se. OpenGeo keeps the resulting short-lived access token only in this browser tab.", "platform-note")
  );
  const signInLabel = callbackError ? "Try sign-in again" : "Sign in to OpenGeo";
  const signIn = text("button", signInLabel, "platform-button");
  signIn.type = "button";
  signIn.addEventListener("click", async () => {
    signIn.disabled = true;
    signIn.textContent = "Opening secure sign-in…";
    try {
      await auth.beginSignIn(returnTo);
    } catch (error) {
      replaceState({status: "configuration_error", code: error?.code ?? "authentication_unavailable"});
    } finally {
      signIn.disabled = false;
      signIn.textContent = signInLabel;
    }
  });
  const signOut = text("button", "Sign out of auth.categori.se", "platform-button platform-button-secondary");
  signOut.type = "button";
  signOut.addEventListener("click", async () => {
    signOut.disabled = true;
    signOut.textContent = "Signing out…";
    try {
      await auth.signOut();
    } finally {
      signOut.disabled = false;
      signOut.textContent = "Sign out of auth.categori.se";
    }
  });
  const actions = document.createElement("div");
  actions.className = "platform-actions";
  actions.append(signIn);
  const managedAccount = document.createElement("details");
  managedAccount.className = "platform-auth-managed-account";
  managedAccount.append(
    text("summary", "Using a shared or different account?"),
    text(
      "p",
      "Studio is signed out, but auth.categori.se may still remember an account. Clear that managed sign-in session before choosing another account.",
      "platform-note"
    ),
    signOut
  );
  panel.append(actions, managedAccount);
  return panel;
}

function sessionDetails(session, adapter, auth) {
  const panel = document.createElement("section");
  panel.className = "platform-session";
  panel.dataset.authState = "signed_in";
  panel.append(
    authStatus("signed_in", "Studio status: Signed in"),
    text("h2", session.displayName),
    text("p", session.email)
  );

  const memberships = document.createElement("ul");
  memberships.className = "platform-memberships";
  for (const membership of session.memberships) {
    const item = document.createElement("li");
    const choose = text("button", `${membership.organizationId} · ${membership.role}`, "platform-button");
    choose.type = "button";
    choose.disabled = membership.organizationId === session.selectedOrganizationId;
    choose.addEventListener("click", () => {
      adapter.selectOrganization(membership.organizationId);
      location.href = "/workspaces";
    });
    item.append(choose);
    memberships.append(item);
  }
  panel.append(memberships);

  const actions = document.createElement("div");
  actions.className = "platform-actions";
  const projects = text("a", "Open projects", "platform-button");
  projects.href = adapter.kind === "fixture" ? "/workspaces?adapter=fixture" : "/workspaces";
  const clear = text(
    "button",
    adapter.kind === "fixture" ? "Reset fixture session" : "Sign out",
    "platform-button platform-button-secondary"
  );
  clear.type = "button";
  clear.addEventListener("click", async () => {
    clear.disabled = true;
    if (auth) await auth.signOut();
    else {
      adapter.clearSession();
      location.reload();
    }
  });
  actions.append(projects, clear);
  panel.append(actions);
  return panel;
}

function authStatus(kind, label) {
  const status = text("p", label, `platform-auth-status platform-auth-status-${kind}`);
  status.setAttribute("role", "status");
  status.dataset.sessionStatus = kind;
  return status;
}

function callbackMessage(code) {
  const messages = {
    sign_in_cancelled: "The managed sign-in was cancelled. No browser session was created.",
    sign_in_state_mismatch: "The callback did not match the browser that started sign-in. Start again from this page.",
    sign_in_transaction_missing: "The sign-in transaction is missing from this tab. Start again from this page.",
    sign_in_transaction_expired: "The sign-in attempt expired before it completed. Start again from this page.",
    token_endpoint_unavailable: "The identity service is temporarily unavailable. No browser session was created.",
    token_exchange_rejected: "The one-time authorization code was rejected or already used.",
    session_validation_failed: "The API rejected the new browser session. Start again or contact an administrator.",
    identity_provider_rejected: "The identity provider rejected the request. No browser session was created."
  };
  return messages[code] ?? "The identity response was invalid. No browser session was created.";
}

function text(tag, value, className = "") {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  return element;
}

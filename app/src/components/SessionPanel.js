import {modeBanner, platformStatePanel} from "./PlatformDirectory.js";
import {failureState} from "../lib/platform.js";
import {localFixtureWorkspaceHref} from "../lib/localDevelopment.js";
import {loginHrefForReturnTo, requestedAuthReturnTo} from "../lib/authNavigation.js";

export function SessionPanel({adapter, auth = null}) {
  const root = document.createElement("section");
  root.className = "platform-surface platform-signin-shell";
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
    if (new URL(globalThis.location?.href ?? "http://localhost/login").searchParams.get("request") === "account") {
      renderPanel(accountAccessRequestPanel(adapter, requestedReturnTo));
      return;
    }
    if (adapter.kind === "fixture") {
      try {
        const session = await adapter.getSession();
        renderPanel(modeBanner(adapter), sessionDetails(session, adapter, null));
      } catch (error) {
        renderPanel(modeBanner(adapter), platformStatePanel(failureState(error, adapter), load));
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
    renderPanel(authStatePanel(state, auth, renderAuthState, returnTo, adapter));
  }

  function renderPanel(...children) {
    root.ariaBusy = "false";
    root.replaceChildren(signInBrand(), ...children);
  }

  function renderLoading() {
    const loading = document.createElement("section");
    loading.className = "platform-state platform-state-loading";
    loading.dataset.state = "loading";
    loading.textContent = "Checking the browser session…";
    renderPanel(loading);
    root.ariaBusy = "true";
  }
}

function authStatePanel(state, auth, replaceState, returnTo, adapter) {
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
          : "An operator must publish auth-config.json for the registered OpenGeo Studio sign-in client.",
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
          "Local test mode uses synthetic records, makes memory-only changes, and does not authenticate against Cognito or call the OpenGeo Studio API.",
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
    text("p", "Your password stays with the secure sign-in service. OpenGeo Studio keeps the resulting short-lived access token only in this browser tab.", "platform-note")
  );
  const signInLabel = callbackError ? "Try sign-in again" : "Sign in to OpenGeo Studio";
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
  const signOut = text("button", "Clear OpenGeo sign-in session", "platform-button platform-button-secondary");
  signOut.type = "button";
  signOut.addEventListener("click", async () => {
    signOut.disabled = true;
    signOut.textContent = "Signing out…";
    try {
      await auth.signOut();
    } finally {
      signOut.disabled = false;
      signOut.textContent = "Clear OpenGeo sign-in session";
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
      "Studio is signed out, but the secure sign-in service may still remember an account. Clear that sign-in session before choosing another account.",
      "platform-note"
    ),
    signOut
  );
  panel.append(actions, managedAccount);
  if (typeof adapter.requestAccount === "function") panel.append(accountRequestForm(adapter));
  return panel;
}

function signInBrand() {
  const header = document.createElement("header");
  header.className = "platform-signin-brand";
  const home = text("a", "", "platform-signin-home");
  home.href = "/";
  const mark = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  mark.setAttribute("viewBox", "0 0 64 64");
  mark.setAttribute("aria-hidden", "true");
  const diamond = document.createElementNS("http://www.w3.org/2000/svg", "path");
  // The same diamond ring as the existing OpenGeo Studio PWA icon.
  diamond.setAttribute("d", "M32 12 52 32 32 52 12 32Z M32 24 24 32 32 40 40 32Z");
  diamond.setAttribute("fill-rule", "evenodd");
  mark.append(diamond);
  home.append(mark, text("strong", "OpenGeo Studio"));
  header.append(home, text("p", "An open workspace for geospatial analysis and publishing."));
  return header;
}

function accountAccessRequestPanel(adapter, returnTo) {
  const panel = document.createElement("section");
  panel.className = "platform-auth platform-auth-account_request";
  panel.dataset.authState = "account_request";
  panel.append(
    text("h2", "Request OpenGeo access"),
    text("p", "A sign-in account identifies you. Studio access is granted separately after approval.")
  );
  if (typeof adapter.requestAccount === "function") panel.append(accountRequestForm(adapter, {open: true}));
  else panel.append(text("p", "Access requests are unavailable in this preview. Please return to sign in or try again later.", "platform-note"));
  const signIn = text("a", "Back to sign in", "platform-button platform-button-secondary");
  signIn.href = loginHrefForReturnTo(returnTo);
  panel.append(signIn);
  return panel;
}

function accountRequestForm(adapter, {open = false} = {}) {
  const details = document.createElement("details");
  details.className = "platform-auth-request";
  details.open = open;
  details.append(text("summary", "New to OpenGeo Studio? Request access"));
  const description = text("p", "Tell us how you plan to use Studio. Aaron reviews requests before access is granted.", "platform-note");
  const form = document.createElement("form");
  form.className = "platform-auth-request-form";
  const name = requestField("Full name", "displayName", {autocomplete: "name", maxLength: 200});
  const email = requestField("Email address", "email", {type: "email", autocomplete: "email", maxLength: 320});
  const purpose = requestField("What would you like to work on?", "purpose", {multiline: true, minLength: 10, maxLength: 2000});
  const website = requestField("Website", "website", {required: false, autocomplete: "off", tabIndex: -1});
  website.label.hidden = true;
  const submit = text("button", "Request access", "platform-button");
  submit.type = "submit";
  const status = text("p", "", "platform-auth-request-status");
  status.setAttribute("role", "status");
  status.tabIndex = -1;
  form.append(name.label, email.label, purpose.label, website.label, submit, status);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submit.disabled || !form.reportValidity()) return;
    submit.disabled = true;
    form.ariaBusy = "true";
    submit.textContent = "Sending request…";
    status.textContent = "";
    status.removeAttribute("data-state");
    try {
      await adapter.requestAccount({displayName: name.input.value.trim(), email: email.input.value.trim(), purpose: purpose.input.value.trim(), website: website.input.value});
      const success = text("p", "Your request is pending review. Once approved, sign in to accept your invitation. New accounts receive an email to finish setup.", "platform-auth-request-success");
      success.setAttribute("role", "status");
      form.replaceChildren(success);
    } catch (error) {
      status.dataset.state = "error";
      status.textContent = error?.code === "account_request_rate_limited" || error?.status === 429
        ? "Too many requests. Please wait a few minutes before trying again."
        : "Your request could not be sent. Please try again later.";
      status.focus();
      submit.disabled = false;
      submit.textContent = "Request access";
    } finally {
      form.ariaBusy = "false";
    }
  });
  details.append(description, form);
  return details;
}

function requestField(labelText, name, {multiline = false, ...attributes} = {}) {
  const label = text("label", labelText);
  const input = document.createElement(multiline ? "textarea" : "input");
  input.name = name;
  input.required = true;
  if (multiline) input.rows = 4;
  else input.type = "text";
  Object.assign(input, attributes);
  label.append(input);
  return {label, input};
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

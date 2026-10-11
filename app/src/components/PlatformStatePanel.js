import {currentProtectedReturnTo, loginHrefForReturnTo} from "../lib/authNavigation.js";
import {directoryHref as applicationDirectoryHref, projectHref as applicationProjectHref} from "../lib/applicationRoutes.js";

// Shared account-state UI has no dependency on the directory's feature tools.
export function platformStatePanel(
  state,
  retry = () => location.reload(),
  {auth = null, returnTo = currentProtectedReturnTo(), autoSignIn = false, resourceKind = "project"} = {}
) {
  const panel = document.createElement("section");
  panel.className = `platform-state platform-state-${state.status}`;
  panel.dataset.state = state.status;

  if (state.status === "unauthenticated") {
    if (auth?.beginSignIn) {
      const title = text("h2", "Opening secure sign-in…");
      const detail = text(
        "p",
        "After signing in, you will return directly to this OpenGeo Studio screen."
      );
      const signIn = action("Continue to sign in", begin);
      let started = false;
      async function begin() {
        if (started) return;
        started = true;
        signIn.disabled = true;
        try {
          await auth.beginSignIn(returnTo);
        } catch {
          started = false;
          title.textContent = "Sign-in could not open";
          detail.textContent = "The secure sign-in service is unavailable. Retry without leaving this screen.";
          signIn.textContent = "Retry sign-in";
          signIn.disabled = false;
          panel.dataset.authRedirect = "failed";
        }
      }
      panel.dataset.authRedirect = autoSignIn ? "automatic" : "available";
      panel.append(title, detail, signIn);
      if (autoSignIn) queueMicrotask(begin);
      return panel;
    }
    panel.append(
      text("h2", "Sign in required"),
      text("p", "Sign in to continue, then OpenGeo Studio will return to this screen."),
      link("Continue to sign in", loginHrefForReturnTo(returnTo), "platform-button")
    );
    return panel;
  }

  if (state.status === "organization_required") {
    panel.append(
      text("h2", "Choose an organization"),
      text("p", "Your account belongs to more than one organization. The selection is verified by the API.")
    );
    const choices = document.createElement("div");
    choices.className = "platform-actions";
    for (const membership of state.session.memberships) {
      const button = action(`${membership.organizationId} · ${membership.role}`, () => {
        state.adapter.selectOrganization(membership.organizationId);
        location.reload();
      });
      choices.append(button);
    }
    panel.append(choices);
    return panel;
  }

  if (state.status === "forbidden" && state.code === "organization_membership_required") {
    panel.append(
      text("h2", "No workspace access yet"),
      text("p", "You're signed in, but you haven't been given access to a workspace on this site."),
      text("p", "No pending invitations were found. Ask the workspace administrator to invite you using the email you signed in with.")
    );
    appendInvitationRecovery(panel, state, retry, auth);
    return panel;
  }

  if (state.status === "invitation_required") {
    panel.append(
      text("h2", "Accept your invitation"),
      text("p", "Your identity is verified. Accept an invitation before organization data becomes available.")
    );
    const choices = document.createElement("div");
    choices.className = "platform-memberships";
    for (const invitation of state.invitations) {
      const item = document.createElement("section");
      item.className = "platform-state";
      const scope = invitation.projectName
        ? `${invitation.projectName} · ${invitation.projectRole}`
        : "Organization access";
      const feedback = text("p", `Expires ${new Date(invitation.expiresAt).toLocaleDateString()}`, "platform-note");
      const accept = action("Accept invitation", async () => {
        accept.disabled = true;
        feedback.textContent = "Accepting invitation…";
        try {
          const accepted = await state.adapter.acceptInvitation(invitation.invitationId);
          state.adapter.selectOrganization(accepted.organizationId);
          await retry();
        } catch (error) {
          feedback.textContent = `The invitation was not accepted (${error?.code ?? "unexpected_error"}).`;
          accept.disabled = false;
        }
      });
      accept.dataset.action = "accept-invitation";
      item.append(
        text("h3", invitation.organizationName),
        text("p", `${invitation.organizationRole} · ${scope}`),
        feedback,
        accept
      );
      choices.append(item);
    }
    panel.append(choices);
    appendInvitationRecovery(panel, state, retry, auth);
    return panel;
  }

  const notFound = state.scope === "directory"
    ? ["Organization unavailable", "Your saved organization could not be loaded. Return to sign in or retry the project directory."]
    : resourceKind === "publication"
      ? ["Publication not found", "The publication does not exist or is not visible to your role."]
      : ["Project not found", "The project does not exist or is not visible to your role."];
  const messages = {
    forbidden: ["Access unavailable", "Your identity is valid, but it has no permission for this organization or resource."],
    not_found: notFound,
    error: ["OpenGeo Studio is temporarily unavailable", "Studio could not load your account. Try again in a moment. If this continues, share the request ID below so we can investigate."]
  };
  if (state.code === "directory_load_timeout") {
    messages.error = ["Your projects are taking too long to load", "Loading stopped after 90 seconds. Try again, or return to the map. Your saved projects have not changed."];
    panel.append(link("Back to map", "/", "platform-button platform-button-secondary"));
  }
  const [title, detail] = messages[state.status] ?? ["Unable to load", "The platform returned an unknown state."];
  panel.append(text("h2", title), text("p", detail));
  if (state.scope === "project" && resourceKind === "publication") {
    panel.append(link("View all publications", directoryHref("publishing", state.adapter?.kind), "platform-button"));
  }
  if (state.scope === "project" && resourceKind !== "publication") {
    const recovery = document.createElement("div");
    recovery.className = "platform-actions platform-project-recovery";
    recovery.append(link("View all projects", "/workspaces", "platform-button"));
    if (state.organization?.callerRole === "admin") {
      recovery.append(link("Create a project", "/workspaces?new=1", "platform-button secondary"));
    }
    panel.append(recovery);
    const projects = Array.isArray(state.projects) ? state.projects : [];
    if (projects.length) {
      const available = document.createElement("section");
      available.className = "platform-project-recovery-list";
      available.append(
        text("h3", "Projects currently visible to you"),
        text("p", "This URL may refer to an old, development-only, or differently scoped project. These links come from your current authorized project directory.", "platform-note")
      );
      const list = document.createElement("ul");
      for (const project of projects.slice(0, 10)) {
        const item = document.createElement("li");
        item.append(link(project.name, projectHref(project.id, state.adapter?.kind)));
        list.append(item);
      }
      available.append(list);
      panel.append(available);
    }
  }
  if (state.requestId) panel.append(text("p", `Request ID: ${state.requestId}`, "platform-request-id"));
  if (state.status === "error" && state.retryable !== false) panel.append(action("Retry", retry));
  return panel;
}

function appendInvitationRecovery(panel, state, retry, auth) {
  if (state.session?.email) {
    panel.append(text("p", `Signed in as ${state.session.email}`, "platform-note"));
  }
  const controls = document.createElement("div");
  controls.className = "platform-actions";
  const feedback = text("p", "", "platform-note");
  feedback.setAttribute("role", "status");
  const check = action("Check invitations", async () => {
    check.disabled = true;
    feedback.textContent = "Checking invitations…";
    try {
      await retry();
      feedback.textContent = "Invitation check complete.";
    } catch {
      feedback.textContent = "Invitations could not be checked. Try again in a moment.";
    } finally {
      check.disabled = false;
    }
  });
  controls.append(check);
  if (auth?.signOut && state.adapter?.kind !== "fixture") {
    const signOut = action("Sign out", async () => {
      signOut.disabled = true;
      try {
        await auth.signOut();
      } catch {
        feedback.textContent = "Sign-out could not finish. Try again.";
        signOut.disabled = false;
      }
    });
    controls.append(signOut);
  }
  panel.append(controls, feedback);
}

function directoryHref(view, adapterKind = null, publicResourceTarget = null) {
  return applicationDirectoryHref({view, adapterKind, publicResourceTarget});
}


function projectHref(projectId, adapterKind = null) {
  return applicationProjectHref(projectId, {adapterKind});
}


function text(tag, value, className = "") {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  return element;
}


function link(label, href, className = "") {
  const element = text("a", label, className);
  element.href = href;
  return element;
}


function action(label, handler) {
  const button = text("button", label, "platform-button");
  button.type = "button";
  button.addEventListener("click", handler);
  return button;
}

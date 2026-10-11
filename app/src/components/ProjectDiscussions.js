import {projectHref} from "../lib/applicationRoutes.js";

export function ProjectDiscussions({state, featureTarget = null}) {
  const root = document.createElement("section");
  root.className = "project-discussions";
  root.ariaLive = "polite";
  const view = {
    filter: "open",
    discussions: [],
    selectedId: null,
    comments: [],
    subscription: null,
    participants: [],
    notifications: [],
    notificationsOpen: false,
    loading: true,
    error: null,
    submitting: false,
    targetConsumed: false,
    revision: 0
  };
  const requestedTarget = currentFeatureTarget(state, featureTarget);

  if (!supportsDiscussions(state.adapter)) {
    root.append(
      text("h2", "Project discussions"),
      text(
        "p",
        "Durable project discussions are unavailable in this adapter.",
        "project-resource-feedback"
      )
    );
    return root;
  }

  render();
  void loadDiscussions();
  return root;

  async function loadDiscussions({selectId = view.selectedId} = {}) {
    const revision = ++view.revision;
    view.loading = true;
    view.error = null;
    render();
    try {
      const stateFilter = view.filter === "all" ? null : view.filter;
      const [discussions, participants, notifications] = await Promise.all([
        state.adapter.listProjectDiscussions(
          state.project.id,
          {state: stateFilter, limit: 100}
        ),
        optionalAdapterList(
          state.adapter,
          "listProjectDiscussionParticipants",
          [state.project.id]
        ),
        optionalAdapterList(
          state.adapter,
          "listProjectDiscussionNotifications",
          [state.project.id, {limit: 50}]
        )
      ]);
      if (revision !== view.revision) return;
      view.discussions = discussions;
      view.participants = participants;
      view.notifications = notifications;
      view.selectedId = discussions.some(({id}) => id === selectId)
        ? selectId
        : discussions[0]?.id ?? null;
      view.loading = false;
      view.comments = [];
      render();
      if (view.selectedId) await loadComments(view.selectedId, revision);
    } catch (error) {
      if (revision !== view.revision) return;
      view.loading = false;
      view.error = errorCode(error);
      render();
    }
  }

  async function loadComments(discussionId, parentRevision = view.revision) {
    const revision = ++view.revision;
    view.selectedId = discussionId;
    view.comments = [];
    view.loading = true;
    view.error = null;
    render();
    try {
      const [comments, subscription] = await Promise.all([
        state.adapter.listProjectDiscussionComments(
          state.project.id,
          discussionId,
          {limit: 100}
        ),
        optionalAdapterValue(
          state.adapter,
          "getProjectDiscussionSubscription",
          [state.project.id, discussionId]
        )
      ]);
      if (revision !== view.revision || parentRevision > revision) return;
      view.comments = comments;
      view.subscription = subscription;
      view.loading = false;
      render();
    } catch (error) {
      if (revision !== view.revision) return;
      view.loading = false;
      view.error = errorCode(error);
      render();
    }
  }

  function render() {
    const header = document.createElement("header");
    header.className = "project-discussions-heading";
    const identity = document.createElement("div");
    identity.append(
      text("h2", "Project discussions"),
      text(
        "p",
        "Keep review decisions with the project. Comments are attributed and append-only; resolve or reopen a thread without erasing its history.",
        "platform-subtitle"
      )
    );
    header.append(identity, notificationInbox(), newDiscussionForm());

    const controls = document.createElement("div");
    controls.className = "project-discussion-controls";
    const filter = document.createElement("select");
    filter.ariaLabel = "Filter project discussions";
    for (const [value, label] of [["open", "Open"], ["resolved", "Resolved"], ["all", "All"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      option.selected = value === view.filter;
      filter.append(option);
    }
    filter.addEventListener("change", () => {
      view.filter = filter.value;
      void loadDiscussions({selectId: null});
    });
    const refresh = button("Refresh", "platform-button secondary");
    refresh.disabled = view.loading;
    refresh.addEventListener("click", () => void loadDiscussions());
    controls.append(filter, refresh);

    const workspace = document.createElement("div");
    workspace.className = "project-discussion-workspace";
    workspace.append(discussionList(), discussionDetail());
    root.replaceChildren(header, controls, workspace);
  }

  function notificationInbox() {
    const disclosure = document.createElement("details");
    disclosure.className = "project-discussion-notifications";
    disclosure.open = view.notificationsOpen;
    disclosure.addEventListener("toggle", () => {
      view.notificationsOpen = disclosure.open;
    });
    const unread = view.notifications.filter(({readAt}) => readAt === null).length;
    disclosure.append(text(
      "summary",
      unread ? `Notifications (${unread} unread)` : "Notifications"
    ));
    const list = document.createElement("ol");
    list.className = "project-discussion-notification-list";
    if (!view.notifications.length) {
      list.append(text("li", "No discussion notifications."));
    }
    for (const notification of view.notifications) {
      const item = document.createElement("li");
      if (notification.readAt === null) item.classList.add("unread");
      const open = button(
        `${notificationLabel(notification.kind)} · ${notification.discussionTitle}`,
        "project-discussion-notification"
      );
      open.append(text(
        "small",
        `${notification.actorName} · ${formatTime(notification.createdAt)}`
      ));
      open.addEventListener("click", async () => {
        open.disabled = true;
        try {
          if (notification.readAt === null) {
            await state.adapter.markProjectDiscussionNotificationRead(
              state.project.id,
              notification.id,
              {expectedVersion: notification.versionNumber}
            );
          }
          view.notificationsOpen = false;
          view.filter = "all";
          await loadDiscussions({selectId: notification.discussionId});
        } catch (error) {
          view.error = errorCode(error);
          render();
        }
      });
      item.append(open);
      list.append(item);
    }
    disclosure.append(list);
    return disclosure;
  }

  function newDiscussionForm() {
    const disclosure = document.createElement("details");
    disclosure.className = "project-discussion-create";
    const target = view.targetConsumed ? null : requestedTarget;
    const targeted = Boolean(target);
    disclosure.open = targeted;
    disclosure.append(text(
      "summary",
      targeted ? "New feature discussion" : "New discussion"
    ));
    const form = document.createElement("form");
    const title = input("text", "Discussion title", 200);
    const body = document.createElement("textarea");
    body.placeholder = "Describe the decision, question, or review note";
    body.ariaLabel = "Initial discussion comment";
    body.maxLength = 4000;
    body.required = true;
    const objectTarget = targeted ? null : discussionTargetSelect(state);
    const assignment = canModerateDiscussions(state)
      ? participantSelect(
          view.participants,
          "Assign to",
          {includeUnassigned: true}
        )
      : null;
    const mentions = participantSelect(
      view.participants,
      "Notify teammates",
      {multiple: true}
    );
    const submit = button("Create", "platform-button");
    submit.type = "submit";
    submit.disabled = view.submitting;
    if (targeted) {
      title.placeholder = `Review ${target.layerName} feature`;
      form.append(featureTargetSummary(target));
    }
    form.append(
      title,
      body,
      ...[objectTarget, assignment, mentions].filter(Boolean),
      submit
    );
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      view.submitting = true;
      submit.disabled = true;
      try {
        const receipt = await state.adapter.createProjectDiscussion(state.project.id, {
          discussionId: randomUuid(),
          initialCommentId: randomUuid(),
          title: title.value,
          body: body.value,
          target: targeted
            ? featureTargetContract(target)
            : selectedDiscussionTarget(objectTarget),
          assignedTo: assignment?.value || null,
          mentionedUserIds: selectedParticipantIds(mentions)
        });
        view.filter = "open";
        view.targetConsumed = true;
        disclosure.open = false;
        await loadDiscussions({selectId: receipt.discussion.id});
      } catch (error) {
        view.error = errorCode(error);
        render();
      } finally {
        view.submitting = false;
        render();
      }
    });
    disclosure.append(form);
    return disclosure;
  }

  function discussionList() {
    const panel = document.createElement("section");
    panel.className = "project-discussion-list";
    panel.ariaLabel = "Discussion threads";
    if (view.error) {
      panel.append(text(
        "p",
        `Discussions could not be loaded (${view.error}).`,
        "project-resource-feedback"
      ));
      return panel;
    }
    if (view.loading && !view.discussions.length) {
      panel.append(text("p", "Loading discussions…", "project-resource-feedback"));
      return panel;
    }
    if (!view.discussions.length) {
      panel.append(text(
        "p",
        view.filter === "open" ? "No open discussions." : "No discussions match this filter.",
        "project-datasets-empty"
      ));
      return panel;
    }
    for (const discussion of view.discussions) {
      const item = button("", "project-discussion-list-item");
      item.dataset.discussionId = discussion.id;
      item.setAttribute("aria-pressed", String(discussion.id === view.selectedId));
      const badges = document.createElement("span");
      badges.className = "project-discussion-list-badges";
      if (discussion.target) badges.append(badge(discussion.target.kind ?? "feature"));
      if (discussion.assignedToName) {
        badges.append(badge(`assigned · ${discussion.assignedToName}`, "assigned"));
      }
      badges.append(badge(discussion.state));
      item.append(
        text("strong", discussion.title),
        text(
          "span",
          `${discussion.commentCount} ${discussion.commentCount === 1 ? "comment" : "comments"} · ${formatTime(discussion.latestCommentAt)}`
        ),
        badges
      );
      item.addEventListener("click", () => void loadComments(discussion.id));
      panel.append(item);
    }
    return panel;
  }

  function discussionDetail() {
    const panel = document.createElement("section");
    panel.className = "project-discussion-detail";
    const discussion = view.discussions.find(({id}) => id === view.selectedId);
    if (!discussion) {
      panel.append(text("p", "Select a discussion to read its history.", "project-resource-feedback"));
      return panel;
    }
    const heading = document.createElement("header");
    const identity = document.createElement("div");
    identity.append(
      text("h3", discussion.title),
      text("p", `Started by ${discussion.createdByName} · ${formatTime(discussion.createdAt)}`)
    );
    heading.append(identity, discussionActions(discussion));
    panel.append(heading);
    if (discussion.target) {
      panel.append(
        Object.hasOwn(discussion.target, "kind")
          ? objectDiscussionLink(discussion.target)
          : featureDiscussionLink(discussion.target)
      );
    }
    panel.append(assignmentSummary(discussion));
    if (view.loading && !view.comments.length) {
      panel.append(text("p", "Loading comments…", "project-resource-feedback"));
      return panel;
    }
    const comments = document.createElement("ol");
    comments.className = "project-discussion-comments";
    for (const comment of view.comments) {
      const item = document.createElement("li");
      item.append(
        text("p", comment.body),
        text("span", `${comment.createdByName} · ${formatTime(comment.createdAt)}`),
        ...(
          comment.mentions.length
            ? [text(
                "small",
                `Notified ${comment.mentions.map(({displayName}) => displayName).join(", ")}`,
                "project-discussion-mentions"
          )]
            : []
        ),
        ...(comment.moderation ? [moderationSummary(comment.moderation)] : [])
      );
      if (discussion.canModerate
        && !comment.moderation
        && typeof state.adapter.moderateProjectDiscussionComment === "function") {
        item.append(commentModerationForm(discussion, comment));
      }
      comments.append(item);
    }
    panel.append(comments);
    if (discussion.state === "open") panel.append(replyForm(discussion));
    else panel.append(text(
      "p",
      `Resolved by ${discussion.resolvedByName} · ${formatTime(discussion.resolvedAt)}`,
      "project-resource-feedback"
    ));
    return panel;
  }

  function discussionActions(discussion) {
    const actions = document.createElement("div");
    actions.className = "project-discussion-actions";
    actions.append(badge(discussion.state));
    if (typeof state.adapter.getProjectDiscussionSubscription === "function"
      && typeof state.adapter.setProjectDiscussionSubscription === "function") {
      const subscribed = view.subscription?.subscribed === true;
      const follow = button(
        subscribed ? "Following" : "Follow",
        "platform-button secondary project-discussion-subscription"
      );
      follow.setAttribute("aria-pressed", String(subscribed));
      follow.title = subscribed
        ? "Stop receiving new-reply and thread-state notifications"
        : "Receive new-reply and thread-state notifications";
      follow.addEventListener("click", async () => {
        follow.disabled = true;
        try {
          const receipt = await state.adapter.setProjectDiscussionSubscription(
            state.project.id,
            discussion.id,
            {
              subscribed: !subscribed,
              expectedVersion: view.subscription?.versionNumber ?? null
            }
          );
          view.subscription = receipt.subscription;
          render();
        } catch (error) {
          view.error = errorCode(error);
          render();
        }
      });
      actions.append(follow);
    }
    if (!discussion.canModerate) return actions;
    const assignee = participantSelect(
      view.participants,
      "Assignee",
      {includeUnassigned: true, selectedId: discussion.assignedTo}
    );
    if (assignee) {
      assignee.addEventListener("change", async () => {
        assignee.disabled = true;
        try {
          await state.adapter.assignProjectDiscussion(
            state.project.id,
            discussion.id,
            {
              assignedTo: assignee.value || null,
              expectedVersion: discussion.versionNumber
            }
          );
          await loadDiscussions({selectId: discussion.id});
        } catch (error) {
          view.error = errorCode(error);
          render();
        }
      });
      actions.append(assignee);
    }
    const targetState = discussion.state === "open" ? "resolved" : "open";
    const transition = button(
      discussion.state === "open" ? "Resolve" : "Reopen",
      "platform-button secondary"
    );
    transition.addEventListener("click", async () => {
      transition.disabled = true;
      try {
        await state.adapter.transitionProjectDiscussion(
          state.project.id,
          discussion.id,
          {state: targetState, expectedVersion: discussion.versionNumber}
        );
        if (view.filter !== "all") view.filter = targetState;
        await loadDiscussions({selectId: discussion.id});
      } catch (error) {
        view.error = errorCode(error);
        render();
      }
    });
    actions.append(transition);
    return actions;
  }

  function commentModerationForm(discussion, comment) {
    const disclosure = document.createElement("details");
    disclosure.className = "project-discussion-moderation";
    disclosure.append(text("summary", "Redact"));
    const form = document.createElement("form");
    const warning = text(
      "small",
      "Irreversible. Readers will see a redaction marker; the original remains in the append-only audit record."
    );
    const reason = document.createElement("textarea");
    reason.ariaLabel = "Redaction reason";
    reason.placeholder = "Explain why this comment must be hidden";
    reason.maxLength = 500;
    reason.required = true;
    const submit = button("Confirm redaction", "platform-button danger");
    submit.type = "submit";
    form.append(warning, reason, submit);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      submit.disabled = true;
      try {
        const receipt = await state.adapter.moderateProjectDiscussionComment(
          state.project.id,
          discussion.id,
          comment.id,
          {moderationId: randomUuid(), reason: reason.value}
        );
        view.comments = view.comments.map((candidate) => (
          candidate.id === comment.id ? receipt.comment : candidate
        ));
        render();
      } catch (error) {
        view.error = errorCode(error);
        render();
      }
    });
    disclosure.append(form);
    return disclosure;
  }

  function replyForm(discussion) {
    const form = document.createElement("form");
    form.className = "project-discussion-reply";
    const body = document.createElement("textarea");
    body.placeholder = "Add a comment";
    body.ariaLabel = "Discussion reply";
    body.maxLength = 4000;
    body.required = true;
    const mentions = participantSelect(
      view.participants,
      "Notify teammates",
      {multiple: true}
    );
    const submit = button("Reply", "platform-button");
    submit.type = "submit";
    form.append(body, ...[mentions].filter(Boolean), submit);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      submit.disabled = true;
      try {
        await state.adapter.createProjectDiscussionComment(
          state.project.id,
          discussion.id,
          {
            commentId: randomUuid(),
            body: body.value,
            mentionedUserIds: selectedParticipantIds(mentions)
          }
        );
        await loadDiscussions({selectId: discussion.id});
      } catch (error) {
        view.error = errorCode(error);
        render();
      }
    });
    return form;
  }

  function featureDiscussionLink(target) {
    const context = featureTargetContext(state, target);
    const link = text(
      "a",
      context
        ? `Open ${context.layerName} feature in ${context.mapName}`
        : "Open referenced feature",
      "project-discussion-feature-link platform-button secondary"
    );
    link.href = projectHref(state.project.id, {
      adapterKind: state.adapter?.kind,
      management: "data",
      featureTarget: target,
      fragment: `feature-${target.featureId}`
    });
    const wrapper = document.createElement("aside");
    wrapper.className = "project-discussion-feature-target";
    wrapper.append(
      text("strong", "Feature context"),
      text(
        "span",
        `Map v${target.mapVersion} · layer ${target.layerId} · feature ${shortId(target.featureId)}`
      ),
      link
    );
    return wrapper;
  }

  function objectDiscussionLink(target) {
    const context = objectTargetContext(state, target);
    const wrapper = document.createElement("aside");
    wrapper.className = "project-discussion-feature-target object";
    const link = text(
      "a",
      context ? `Open ${context.label}` : `Open referenced ${target.kind}`,
      "project-discussion-feature-link platform-button secondary"
    );
    link.href = objectTargetHref(state, target);
    wrapper.append(
      text("strong", `${capitalize(target.kind)} context`),
      text("span", `${context?.label ?? shortId(target.objectId)} · version ${target.version}`),
      link
    );
    return wrapper;
  }

  function assignmentSummary(discussion) {
    const summary = text(
      "p",
      discussion.assignedToName
        ? `Assigned to ${discussion.assignedToName} by ${discussion.assignedByName} · ${formatTime(discussion.assignedAt)}`
        : "Unassigned",
      "project-discussion-assignment"
    );
    return summary;
  }
}

function currentFeatureTarget(state, target) {
  const context = featureTargetContext(state, target);
  if (!context || context.map.version !== target.mapVersion) return null;
  return {...target, ...context};
}

function featureTargetContext(state, target) {
  if (!target) return null;
  const map = state.maps.find(({id}) => id === target.mapId);
  const dataset = state.datasets.find(({id}) => id === target.datasetId);
  const layer = map?.definition?.layers?.find(
    (candidate) => candidate?.layerId === target.layerId
      && candidate?.datasetId === target.datasetId
  );
  if (!map || !dataset || !layer) return null;
  return {
    map,
    mapName: map.name,
    datasetName: dataset.name,
    layerName: layer.title ?? layer.layerId
  };
}

function featureTargetSummary(target) {
  const summary = document.createElement("aside");
  summary.className = "project-discussion-feature-target pending";
  summary.append(
    text("strong", `${target.mapName} · ${target.layerName}`),
    text("span", `${target.datasetName} · feature ${shortId(target.featureId)}`),
    text("small", `The discussion will retain exact map v${target.mapVersion} context.`)
  );
  return summary;
}

function featureTargetContract(target) {
  return {
    mapId: target.mapId,
    mapVersion: target.mapVersion,
    layerId: target.layerId,
    datasetId: target.datasetId,
    featureId: target.featureId
  };
}

function discussionTargetSelect(state) {
  const select = document.createElement("select");
  select.ariaLabel = "Discussion context";
  select.append(option("Project-wide discussion", ""));
  for (const target of discussionTargetOptions(state)) {
    const choice = option(`${capitalize(target.kind)} · ${target.label}`, target.objectId);
    choice.dataset.kind = target.kind;
    choice.dataset.version = String(target.version);
    select.append(choice);
  }
  return select;
}

function discussionTargetOptions(state) {
  const options = [];
  for (const map of state.maps ?? []) {
    if (map.status === "active" && Number.isSafeInteger(map.version) && map.version > 0) {
      options.push({kind: "map", objectId: map.id, version: map.version, label: map.name});
    }
  }
  for (const dataset of state.datasets ?? []) {
    if (dataset.status !== "archived"
      && Number.isSafeInteger(dataset.currentVersionNumber)
      && dataset.currentVersionNumber > 0) {
      options.push({
        kind: "dataset",
        objectId: dataset.id,
        version: dataset.currentVersionNumber,
        label: dataset.name
      });
    }
  }
  for (const resource of state.resources ?? []) {
    if (resource.state !== "archived"
      && Number.isSafeInteger(resource.versionNumber)
      && resource.versionNumber > 0) {
      options.push({
        kind: "resource",
        objectId: resource.id,
        version: resource.versionNumber,
        label: resource.title
      });
    }
  }
  for (const site of state.sites ?? []) {
    if (Number.isSafeInteger(site.versionNumber) && site.versionNumber > 0) {
      options.push({
        kind: "site",
        objectId: site.id,
        version: site.versionNumber,
        label: site.title
      });
    }
  }
  return options.sort((left, right) => (
    left.kind.localeCompare(right.kind) || left.label.localeCompare(right.label)
  ));
}

function selectedDiscussionTarget(select) {
  const selected = select?.selectedOptions?.[0];
  if (!selected?.value) return null;
  return {
    kind: selected.dataset.kind,
    objectId: selected.value,
    version: Number(selected.dataset.version)
  };
}

function participantSelect(
  participants,
  label,
  {includeUnassigned = false, multiple = false, selectedId = null} = {}
) {
  if (!participants.length) return null;
  const select = document.createElement("select");
  select.ariaLabel = label;
  select.multiple = multiple;
  if (multiple) select.size = Math.min(3, participants.length);
  if (includeUnassigned) select.append(option("Unassigned", ""));
  for (const participant of participants) {
    const choice = option(
      `${participant.displayName} · ${participant.projectRole}`,
      participant.userId
    );
    choice.selected = participant.userId === selectedId;
    select.append(choice);
  }
  return select;
}

function selectedParticipantIds(select) {
  return select ? [...select.selectedOptions].map(({value}) => value).filter(Boolean) : [];
}

function option(label, value) {
  const choice = document.createElement("option");
  choice.textContent = label;
  choice.value = value;
  return choice;
}

function objectTargetContext(state, target) {
  const collections = {
    map: [state.maps ?? [], "name"],
    dataset: [state.datasets ?? [], "name"],
    resource: [state.resources ?? [], "title"],
    site: [state.sites ?? [], "title"]
  };
  const [records, labelKey] = collections[target.kind] ?? [[], "name"];
  const record = records.find(({id}) => id === target.objectId);
  return record ? {record, label: record[labelKey] ?? shortId(target.objectId)} : null;
}

function objectTargetHref(state, target) {
  const common = {adapterKind: state.adapter?.kind};
  if (target.kind === "map") {
    return projectHref(state.project.id, {
      ...common,
      mapId: target.objectId,
      fragment: "map-workspace"
    });
  }
  if (target.kind === "dataset") {
    return projectHref(state.project.id, {
      ...common,
      management: "data",
      datasetId: target.objectId,
      fragment: `dataset-${target.objectId}`
    });
  }
  return projectHref(state.project.id, {
    ...common,
    management: target.kind === "site" ? "publishing" : "resources",
    fragment: `${target.kind}-${target.objectId}`
  });
}

async function optionalAdapterList(adapter, method, parameters) {
  if (typeof adapter?.[method] !== "function") return [];
  try {
    return await adapter[method](...parameters);
  } catch (error) {
    if (["http_404", "action_forbidden"].includes(error?.code)) return [];
    throw error;
  }
}

async function optionalAdapterValue(adapter, method, parameters) {
  if (typeof adapter?.[method] !== "function") return null;
  try {
    return await adapter[method](...parameters);
  } catch (error) {
    if (["http_404", "action_forbidden"].includes(error?.code)) return null;
    throw error;
  }
}

function moderationSummary(moderation) {
  return text(
    "small",
    `Redacted by ${moderation.actorName} · ${formatTime(moderation.createdAt)} · ${moderation.reason}`,
    "project-discussion-moderation-summary"
  );
}

function notificationLabel(kind) {
  return {
    assignment: "Assigned to you",
    mention: "Mentioned you",
    reply: "New reply",
    state: "Thread updated"
  }[kind] ?? "Discussion update";
}

function capitalize(value) {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function shortId(value) {
  return `${String(value).slice(0, 8)}…`;
}

function supportsDiscussions(adapter) {
  return [
    "listProjectDiscussions",
    "createProjectDiscussion",
    "listProjectDiscussionComments",
    "createProjectDiscussionComment",
    "transitionProjectDiscussion"
  ].every((method) => typeof adapter?.[method] === "function");
}

function canModerateDiscussions(state) {
  return state.organization?.callerRole === "admin"
    || ["owner", "editor", "reviewer"].includes(state.project?.callerRole);
}

function text(tag, value, className = "") {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  return element;
}

function button(label, className) {
  const element = text("button", label, className);
  element.type = "button";
  return element;
}

function input(type, placeholder, maxLength) {
  const element = document.createElement("input");
  element.type = type;
  element.placeholder = placeholder;
  element.ariaLabel = placeholder;
  element.maxLength = maxLength;
  element.required = true;
  return element;
}

function badge(value, className = value) {
  return text("span", value, `badge ${className}`);
}

function errorCode(error) {
  return error?.code ?? "unexpected_error";
}

function formatTime(value) {
  if (!value) return "unknown time";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function randomUuid() {
  return globalThis.crypto.randomUUID();
}

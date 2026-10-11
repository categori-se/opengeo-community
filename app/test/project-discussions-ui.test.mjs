import assert from "node:assert/strict";
import {afterEach, beforeEach, describe, it} from "node:test";
import {JSDOM} from "jsdom";

import {ProjectDiscussions} from "../src/components/ProjectDiscussions.js";

const IDS = Object.freeze({
  project: "50000000-0000-4000-8000-000000000075",
  user: "20000000-0000-4000-8000-000000000075",
  teammate: "20000000-0000-4000-8000-000000000076",
  discussion: "94000000-0000-4000-8000-000000000075",
  comment: "95000000-0000-4000-8000-000000000075",
  moderation: "98000000-0000-4000-8000-000000000075",
  notification: "97000000-0000-4000-8000-000000000075",
  map: "60000000-0000-4000-8000-000000000077",
  dataset: "80000000-0000-4000-8000-000000000077",
  feature: "90000000-0000-4000-8000-000000000077"
});

let harness;

beforeEach(() => {
  harness = installDom();
});

afterEach(() => {
  harness.restore();
  harness.dom.window.close();
  harness = null;
});

describe("project discussions UI", () => {
  it("keeps attributed thread history inside one compact project surface", async () => {
    const calls = [];
    const adapter = discussionAdapter(calls);
    const surface = ProjectDiscussions({
      state: {
        adapter,
        project: {id: IDS.project, callerRole: "owner"}
      }
    });
    document.body.append(surface);

    await waitFor(() => surface.querySelector(".project-discussion-comments li"));
    assert.match(surface.textContent, /Review wetlands styling/);
    assert.match(surface.textContent, /Aaron Dennis/);
    assert.equal(surface.querySelectorAll(".project-discussion-list-item").length, 1);

    const reply = surface.querySelector('[aria-label="Discussion reply"]');
    reply.value = "Contrast updated for review.";
    reply.closest("form").dispatchEvent(new harness.dom.window.Event("submit", {
      bubbles: true,
      cancelable: true
    }));
    await waitFor(() => surface.querySelectorAll(".project-discussion-comments li").length === 2);
    assert.match(surface.textContent, /Contrast updated for review/);

    [...surface.querySelectorAll("button")]
      .find(({textContent}) => textContent === "Resolve")
      .click();
    await waitFor(() => surface.textContent.includes("Reopen"));
    assert.match(surface.textContent, /Resolved by Aaron Dennis/);
    assert.deepEqual(calls.filter(({operation}) => operation === "transition")[0], {
      operation: "transition",
      projectId: IDS.project,
      discussionId: IDS.discussion,
      update: {state: "resolved", expectedVersion: 1}
    });
  });

  it("creates a project-scoped discussion with caller-generated idempotency identifiers", async () => {
    const calls = [];
    const adapter = discussionAdapter(calls);
    const surface = ProjectDiscussions({
      state: {adapter, project: {id: IDS.project, callerRole: "editor"}}
    });
    document.body.append(surface);
    await waitFor(() => surface.querySelector(".project-discussion-list-item"));

    const disclosure = surface.querySelector(".project-discussion-create");
    disclosure.open = true;
    disclosure.querySelector("input").value = "Confirm source license";
    disclosure.querySelector("textarea").value = "Record the reviewed rights basis.";
    disclosure.querySelector("form").dispatchEvent(new harness.dom.window.Event("submit", {
      bubbles: true,
      cancelable: true
    }));

    await waitFor(() => surface.textContent.includes("Confirm source license"));
    const creation = calls.find(({operation}) => operation === "create");
    assert.equal(creation.projectId, IDS.project);
    assert.match(creation.input.discussionId, /^[0-9a-f-]{36}$/);
    assert.match(creation.input.initialCommentId, /^[0-9a-f-]{36}$/);
    assert.notEqual(creation.input.discussionId, creation.input.initialCommentId);
    assert.equal(surface.querySelector(".project-discussion-create button").disabled, false);
  });

  it("creates an immutable feature-targeted thread and links back to its exact context", async () => {
    const calls = [];
    const adapter = discussionAdapter(calls);
    const target = {
      mapId: IDS.map,
      mapVersion: 3,
      layerId: "wetlands",
      datasetId: IDS.dataset,
      featureId: IDS.feature
    };
    const surface = ProjectDiscussions({
      state: {
        adapter,
        project: {id: IDS.project, callerRole: "editor"},
        maps: [{
          id: IDS.map,
          name: "Wetlands review",
          version: 3,
          definition: {layers: [{
            layerId: "wetlands",
            datasetId: IDS.dataset,
            title: "Mapped wetlands"
          }]}
        }],
        datasets: [{id: IDS.dataset, name: "Wetland features"}]
      },
      featureTarget: target
    });
    document.body.append(surface);
    await waitFor(() => surface.querySelector(".project-discussion-list-item"));

    const disclosure = surface.querySelector(".project-discussion-create");
    assert.equal(disclosure.open, true);
    assert.match(disclosure.textContent, /Wetlands review · Mapped wetlands/);
    disclosure.querySelector("input").value = "Review mapped feature";
    disclosure.querySelector("textarea").value = "Confirm this exact wetland.";
    disclosure.querySelector("form").dispatchEvent(new harness.dom.window.Event("submit", {
      bubbles: true,
      cancelable: true
    }));

    await waitFor(() => surface.textContent.includes("Review mapped feature"));
    const creation = calls.find(({operation}) => operation === "create");
    assert.deepEqual(creation.input.target, target);
    const link = surface.querySelector(".project-discussion-feature-link");
    assert.match(link.textContent, /Open Mapped wetlands feature in Wetlands review/);
    assert.equal(
      link.getAttribute("href"),
      `/workspaces?project=${IDS.project}&adapter=fixture&map=${IDS.map}&manage=data`
        + `&dataset=${IDS.dataset}&feature=${IDS.feature}`
        + `&layer=wetlands&mapVersion=3#feature-${IDS.feature}`
    );
  });

  it("creates a dataset-targeted, assigned discussion and explicitly notifies teammates", async () => {
    const calls = [];
    const adapter = discussionAdapter(calls);
    const surface = ProjectDiscussions({
      state: {
        adapter,
        project: {id: IDS.project, callerRole: "owner"},
        maps: [],
        datasets: [{
          id: IDS.dataset,
          name: "Wetland features",
          status: "active",
          currentVersionNumber: 4
        }],
        resources: [],
        sites: []
      }
    });
    document.body.append(surface);
    await waitFor(() => surface.querySelector('[aria-label="Assign to"]'));

    const disclosure = surface.querySelector(".project-discussion-create");
    disclosure.open = true;
    disclosure.querySelector("input").value = "Review dataset lineage";
    disclosure.querySelector("textarea").value = "Confirm the governed source.";
    disclosure.querySelector('[aria-label="Discussion context"]').value = IDS.dataset;
    disclosure.querySelector('[aria-label="Assign to"]').value = IDS.teammate;
    const mentions = disclosure.querySelector('[aria-label="Notify teammates"]');
    [...mentions.options].find(({value}) => value === IDS.teammate).selected = true;
    disclosure.querySelector("form").dispatchEvent(new harness.dom.window.Event("submit", {
      bubbles: true,
      cancelable: true
    }));

    await waitFor(() => surface.textContent.includes("Review dataset lineage"));
    const creation = calls.findLast(({operation}) => operation === "create");
    assert.deepEqual(creation.input.target, {
      kind: "dataset",
      objectId: IDS.dataset,
      version: 4
    });
    assert.equal(creation.input.assignedTo, IDS.teammate);
    assert.deepEqual(creation.input.mentionedUserIds, [IDS.teammate]);
    assert.match(surface.textContent, /Assigned to Project Reviewer/);
    assert.match(surface.textContent, /Notified Project Reviewer/);
    assert.equal(
      surface.querySelector(".project-discussion-feature-link").getAttribute("href"),
      `/workspaces?project=${IDS.project}&adapter=fixture&manage=data&dataset=${IDS.dataset}`
        + `#dataset-${IDS.dataset}`
    );
  });

  it("opens a recipient-private notification and acknowledges it once", async () => {
    const calls = [];
    const adapter = discussionAdapter(calls, {withNotification: true});
    const surface = ProjectDiscussions({
      state: {adapter, project: {id: IDS.project, callerRole: "owner"}}
    });
    document.body.append(surface);
    await waitFor(() => surface.textContent.includes("Notifications (1 unread)"));

    const notification = surface.querySelector(".project-discussion-notification");
    notification.click();
    await waitFor(() => calls.some(({operation}) => operation === "notification-read"));
    assert.deepEqual(
      calls.find(({operation}) => operation === "notification-read"),
      {
        operation: "notification-read",
        projectId: IDS.project,
        notificationId: IDS.notification,
        update: {expectedVersion: 1}
      }
    );
  });

  it("follows one exact thread and redacts a comment with an irreversible audit reason", async () => {
    const calls = [];
    const adapter = discussionAdapter(calls);
    const surface = ProjectDiscussions({
      state: {adapter, project: {id: IDS.project, callerRole: "owner"}}
    });
    document.body.append(surface);
    await waitFor(() => surface.querySelector(".project-discussion-comments li"));

    const follow = [...surface.querySelectorAll("button")]
      .find(({textContent}) => textContent === "Follow");
    assert.ok(follow);
    follow.click();
    await waitFor(() => surface.textContent.includes("Following"));
    assert.deepEqual(calls.find(({operation}) => operation === "subscription-set"), {
      operation: "subscription-set",
      projectId: IDS.project,
      discussionId: IDS.discussion,
      update: {subscribed: true, expectedVersion: null}
    });

    const moderation = surface.querySelector(".project-discussion-moderation");
    assert.match(moderation.textContent, /Irreversible/);
    moderation.open = true;
    moderation.querySelector('[aria-label="Redaction reason"]').value = "Contains private contact details";
    moderation.querySelector("form").dispatchEvent(new harness.dom.window.Event("submit", {
      bubbles: true,
      cancelable: true
    }));
    await waitFor(() => surface.textContent.includes("[Comment redacted]"));
    assert.doesNotMatch(surface.textContent, /The outline needs more contrast/);
    assert.match(surface.textContent, /Redacted by Aaron Dennis/);
    assert.match(surface.textContent, /Contains private contact details/);
    const call = calls.find(({operation}) => operation === "moderate");
    assert.match(call.input.moderationId, /^[0-9a-f-]{36}$/);
    assert.equal(call.input.reason, "Contains private contact details");
  });
});

function discussionAdapter(calls, {withNotification = false} = {}) {
  const now = "2026-08-30T12:00:00Z";
  const discussions = [{
    id: IDS.discussion,
    projectId: IDS.project,
    initialCommentId: IDS.comment,
    title: "Review wetlands styling",
    state: "open",
    versionNumber: 1,
    createdBy: IDS.user,
    createdByName: "Aaron Dennis",
    resolvedBy: null,
    resolvedByName: null,
    resolvedAt: null,
    createdAt: now,
    updatedAt: now,
    commentCount: 1,
    latestCommentAt: now,
    canModerate: true,
    target: null,
    assignedTo: null,
    assignedToName: null,
    assignedBy: null,
    assignedByName: null,
    assignedAt: null
  }];
  const comments = new Map([[IDS.discussion, [{
    id: IDS.comment,
    projectId: IDS.project,
    discussionId: IDS.discussion,
    body: "The outline needs more contrast.",
    createdBy: IDS.user,
    createdByName: "Aaron Dennis",
    createdAt: now,
    mentions: [],
    moderation: null
  }]]]);
  let subscription = null;
  const participants = [
    {
      userId: IDS.user,
      displayName: "Aaron Dennis",
      projectRole: "owner"
    },
    {
      userId: IDS.teammate,
      displayName: "Project Reviewer",
      projectRole: "reviewer"
    }
  ];
  const notifications = withNotification ? [{
    id: IDS.notification,
    projectId: IDS.project,
    discussionId: IDS.discussion,
    discussionTitle: discussions[0].title,
    discussionVersion: 1,
    commentId: IDS.comment,
    kind: "mention",
    actorUserId: IDS.teammate,
    actorName: "Project Reviewer",
    versionNumber: 1,
    readAt: null,
    createdAt: now
  }] : [];
  return {
    kind: "fixture",
    async listProjectDiscussions(projectId, options) {
      calls.push({operation: "list", projectId, options});
      return structuredClone(discussions.filter(
        ({state}) => options.state === null || options.state === state
      ));
    },
    async listProjectDiscussionParticipants(projectId) {
      calls.push({operation: "participants", projectId});
      return structuredClone(participants);
    },
    async listProjectDiscussionNotifications(projectId, options) {
      calls.push({operation: "notifications", projectId, options});
      return structuredClone(notifications);
    },
    async listProjectDiscussionComments(projectId, discussionId) {
      calls.push({operation: "comments", projectId, discussionId});
      return structuredClone(comments.get(discussionId) ?? []);
    },
    async getProjectDiscussionSubscription(projectId, discussionId) {
      calls.push({operation: "subscription", projectId, discussionId});
      return structuredClone(subscription);
    },
    async setProjectDiscussionSubscription(projectId, discussionId, update) {
      calls.push({operation: "subscription-set", projectId, discussionId, update});
      const changed = subscription?.subscribed !== update.subscribed;
      const currentVersion = subscription?.versionNumber ?? 0;
      const now = new Date().toISOString();
      subscription = {
        discussionId,
        subscribed: update.subscribed,
        versionNumber: currentVersion + 1,
        subscribedAt: update.subscribed ? now : subscription.subscribedAt,
        unsubscribedAt: update.subscribed ? null : now
      };
      return {changed, subscription: structuredClone(subscription)};
    },
    async createProjectDiscussion(projectId, input) {
      calls.push({operation: "create", projectId, input});
      const createdAt = new Date().toISOString();
      const discussion = {
        ...discussions[0],
        id: input.discussionId,
        initialCommentId: input.initialCommentId,
        title: input.title,
        target: input.target ?? null,
        assignedTo: input.assignedTo ?? null,
        assignedToName: participantName(input.assignedTo),
        assignedBy: input.assignedTo ? IDS.user : null,
        assignedByName: input.assignedTo ? "Aaron Dennis" : null,
        assignedAt: input.assignedTo ? createdAt : null,
        createdAt,
        updatedAt: createdAt,
        latestCommentAt: createdAt
      };
      discussions.unshift(discussion);
      comments.set(discussion.id, [{
        id: input.initialCommentId,
        projectId,
        discussionId: discussion.id,
        body: input.body,
        createdBy: IDS.user,
        createdByName: "Aaron Dennis",
        createdAt,
        mentions: (input.mentionedUserIds ?? []).map((userId) => ({
          userId,
          displayName: userId === IDS.teammate ? "Project Reviewer" : "Aaron Dennis"
        })),
        moderation: null
      }]);
      return {created: true, discussion: structuredClone(discussion)};
    },
    async createProjectDiscussionComment(projectId, discussionId, input) {
      calls.push({operation: "reply", projectId, discussionId, input});
      const comment = {
        id: input.commentId,
        projectId,
        discussionId,
        body: input.body,
        createdBy: IDS.user,
        createdByName: "Aaron Dennis",
        createdAt: new Date().toISOString(),
        mentions: (input.mentionedUserIds ?? []).map((userId) => ({
          userId,
          displayName: userId === IDS.teammate ? "Project Reviewer" : "Aaron Dennis"
        })),
        moderation: null
      };
      comments.get(discussionId).push(comment);
      const discussion = discussions.find(({id}) => id === discussionId);
      discussion.commentCount += 1;
      discussion.latestCommentAt = comment.createdAt;
      return {created: true, comment: structuredClone(comment)};
    },
    async moderateProjectDiscussionComment(projectId, discussionId, commentId, input) {
      calls.push({operation: "moderate", projectId, discussionId, commentId, input});
      const comment = comments.get(discussionId).find(({id}) => id === commentId);
      comment.body = "[Comment redacted]";
      comment.moderation = {
        id: input.moderationId,
        action: "redact",
        reason: input.reason,
        actorUserId: IDS.user,
        actorName: "Aaron Dennis",
        createdAt: new Date().toISOString()
      };
      return {created: true, comment: structuredClone(comment)};
    },
    async transitionProjectDiscussion(projectId, discussionId, update) {
      calls.push({operation: "transition", projectId, discussionId, update});
      const discussion = discussions.find(({id}) => id === discussionId);
      discussion.state = update.state;
      discussion.versionNumber += 1;
      discussion.resolvedBy = update.state === "resolved" ? IDS.user : null;
      discussion.resolvedByName = update.state === "resolved" ? "Aaron Dennis" : null;
      discussion.resolvedAt = update.state === "resolved" ? new Date().toISOString() : null;
      return {changed: true, discussion: structuredClone(discussion)};
    },
    async assignProjectDiscussion(projectId, discussionId, update) {
      calls.push({operation: "assignment", projectId, discussionId, update});
      const discussion = discussions.find(({id}) => id === discussionId);
      discussion.assignedTo = update.assignedTo;
      discussion.assignedToName = participantName(update.assignedTo);
      discussion.assignedBy = update.assignedTo ? IDS.user : null;
      discussion.assignedByName = update.assignedTo ? "Aaron Dennis" : null;
      discussion.assignedAt = update.assignedTo ? new Date().toISOString() : null;
      discussion.versionNumber += 1;
      return {changed: true, discussion: structuredClone(discussion)};
    },
    async markProjectDiscussionNotificationRead(projectId, notificationId, update) {
      calls.push({operation: "notification-read", projectId, notificationId, update});
      const notification = notifications.find(({id}) => id === notificationId);
      notification.readAt = new Date().toISOString();
      notification.versionNumber += 1;
      return {changed: true, notification: structuredClone(notification)};
    }
  };

  function participantName(userId) {
    return participants.find(({userId: candidate}) => candidate === userId)?.displayName ?? null;
  }
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("timed out waiting for project discussions state");
}

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: `https://studio.opengeo.tools/workspaces?project=${IDS.project}&manage=discussions`
  });
  const replacements = {
    document: dom.window.document,
    location: dom.window.location,
    HTMLElement: dom.window.HTMLElement
  };
  const previous = new Map();
  for (const [name, value] of Object.entries(replacements)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
  }
  return {
    dom,
    restore() {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    }
  };
}

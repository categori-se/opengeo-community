import assert from "node:assert/strict";
import {join} from "node:path";

// Uses the built application and real local API/SQL. Only identity verification
// is substituted by the parent runner; no fixture invitation responses.
export async function exerciseStudioAccess({page, context, origin, organization, controlProject,
  initializeSession, readApi, work, errors}) {
  const beforeProjects = await readApi("/projects");
  const beforeMembers = await readApi("/organizations/current/memberships");
  const reviewerId = "20000000-0000-4000-8000-000000000002";
  assert.equal(beforeMembers.some(member => member.user_id === reviewerId), false);
  const reviewer = await context.newPage();
  reviewer.setDefaultTimeout(15_000);
  reviewer.on("pageerror", error => errors.push(error.message));
  await reviewer.addInitScript(initializeSession, {organization, actor: "reviewer"});
  await reviewer.goto(`${origin}/workspaces`);
  await reviewer.getByRole("heading", {name: "No workspace access yet", exact: true}).waitFor();
  assert.match(await reviewer.locator(".platform-state").textContent(), /reviewer@local.invalid/);

  await page.goto(`${origin}/workspaces`);
  await page.getByRole("link", {name: /New Project/}).click();
  await page.getByLabel("New project name", {exact: true}).fill("Disposable viewer access check");
  await page.getByLabel("First map name", {exact: true}).fill("Access check");
  const mapCreated = page.waitForResponse(response => /\/api\/projects\/[^/]+\/maps$/.test(response.url()) && response.request().method() === "POST");
  const created = page.waitForResponse(response => response.url().endsWith("/api/projects") && response.request().method() === "POST");
  await page.getByRole("button", {name: "Create project and map", exact: true}).click();
  const createdResponse = await created;
  assert.equal(createdResponse.status(), 201);
  const project = await createdResponse.json();
  const mapResponse = await mapCreated;
  assert.equal(mapResponse.status(), 201);
  const maps = await readApi(`/projects/${project.id}/maps`);
  assert.equal(maps.length, 1);
  const originalMap = maps[0];
  await page.waitForURL(url => url.searchParams.get("composition") === originalMap.id || url.searchParams.get("project") === project.id);

  await page.goto(`${origin}/workspaces`);
  await page.locator(".platform-account-menu > summary").click();
  await page.locator('.platform-account-navigation a[href="/admin"]').click();
  await page.getByLabel("Email", {exact: true}).fill("reviewer@local.invalid");
  await page.getByLabel("Display name", {exact: true}).fill("Local reviewer");
  await page.getByLabel("Organization role", {exact: true}).selectOption("guest");
  await page.getByLabel("Optional access workspace", {exact: true}).selectOption(project.id);
  await page.getByLabel("Project role", {exact: true}).selectOption("viewer");
  await page.getByLabel("Expires", {exact: true}).selectOption("3");
  const invited = page.waitForResponse(response => response.url().endsWith("/organizations/current/invitations") && response.request().method() === "POST");
  await page.getByRole("button", {name: "Send invitation", exact: true}).click();
  const invitedResponse = await invited;
  assert.equal(invitedResponse.status(), 201);
  const invitation = await invitedResponse.json();
  assert.equal(invitation.project_id, project.id);
  assert.equal(invitation.project_role, "viewer");
  assert.equal(invitation.organization_role, "guest");
  assert.equal(invitation.status, "pending");
  await page.getByLabel("Access workspace membership scope", {exact: true}).waitFor();
  const pendingRecord = (await readApi("/organizations/current/invitations")).find(item => item.id === invitation.id);
  assert.ok(pendingRecord, "Pending invitation must remain visible before the invitee has account membership");
  assert.equal(pendingRecord.display_name, "reviewer@local.invalid");

  const checkRead = reviewer.waitForResponse(response => response.url().includes("/auth/invitations") && response.request().method() === "GET");
  await reviewer.getByRole("button", {name: "Check invitations", exact: true}).click();
  const offered = await (await checkRead).json();
  assert.deepEqual(offered.map(item => item.invitation_id), [invitation.id]);
  await reviewer.getByRole("heading", {name: "Accept your invitation", exact: true}).waitFor();
  await reviewer.screenshot({path: join(work, "persisted-viewer-invitation.png"), fullPage: true});
  assert.equal((await readApi("/organizations/current/memberships")).some(member => member.user_id === reviewerId), false);
  const acceptance = reviewer.waitForResponse(response => response.url().endsWith(`/auth/invitations/${invitation.id}/accept`) && response.request().method() === "POST");
  await reviewer.getByRole("button", {name: "Accept invitation", exact: true}).click();
  assert.equal((await acceptance).status(), 200);
  await reviewer.locator(`a[href="/workspaces?composition=${originalMap.id}"]`).click();
  await reviewer.locator(".opengeo-workbench").waitFor();
  await reviewer.reload();
  await reviewer.locator(".opengeo-workbench").waitFor();
  const save = reviewer.getByRole("button", {name: "Save", exact: true});
  assert.ok(await save.count() === 0 || await save.isDisabled(), "Viewer must not receive an enabled save control");
  const reviewerRequest = async (path, method = "GET", body = null) => reviewer.evaluate(async ({path, method, body}) => {
    const response = await fetch(`/api${path}`, {method, headers: {
      authorization: `Bearer ${sessionStorage.getItem("opengeo.accessToken")}`,
      "x-opengeo-organization": sessionStorage.getItem("opengeo.organizationId"),
      "content-type": "application/json"
    }, ...(body === null ? {} : {body: JSON.stringify(body)})});
    return {status: response.status, body: await response.json()};
  }, {path, method, body});
  const visible = await reviewerRequest("/projects");
  assert.equal(visible.status, 200);
  assert.deepEqual(visible.body.map(item => item.id), [project.id]);
  assert.equal((await reviewerRequest(`/projects/${controlProject.id}`)).status, 404);
  assert.equal((await reviewerRequest(`/projects/${project.id}`, "PATCH", {status: "archived"})).status, 403);
  assert.equal((await readApi(`/projects/${project.id}`)).status, "active");
  assert.equal((await reviewerRequest(`/projects/${project.id}/maps/${originalMap.id}`, "PATCH", {
    name: "Viewer must not save", definition: originalMap.definition, expected_version: originalMap.version
  })).status, 403);
  assert.deepEqual(await readApi(`/projects/${project.id}/maps`), maps);
  assert.equal((await readApi(`/projects/${project.id}/memberships`)).find(member => member.user_id === reviewerId)?.role, "viewer");

  // Exercise legacy project-route denial as well as canonical composition reopening.
  await reviewer.goto(`${origin}/workspaces?project=${project.id}&map=${originalMap.id}`);
  await reviewer.locator(".opengeo-workbench").waitFor();
  await page.reload();
  await page.getByLabel("Access workspace membership scope", {exact: true}).selectOption(project.id);
  const memberRow = page.locator(".platform-admin-panel", {has: page.getByRole("heading", {name: "Access workspace members", exact: true})})
    .locator("tr", {hasText: "reviewer@local.invalid"});
  const removed = page.waitForResponse(response => response.url().endsWith(`/projects/${project.id}/memberships/${reviewerId}`) && response.request().method() === "DELETE");
  await memberRow.getByRole("button", {name: "Revoke", exact: true}).click();
  assert.equal((await removed).status(), 204);
  const denied = reviewer.waitForResponse(response => response.url().endsWith(`/projects/${project.id}`) && response.request().method() === "GET");
  await reviewer.reload();
  assert.equal((await denied).status(), 404);
  await reviewer.getByRole("heading", {name: "Project not found", exact: true}).waitFor();
  const orgRow = page.locator(".platform-admin-panel", {has: page.getByRole("heading", {name: "Organization members", exact: true})})
    .locator("tr", {hasText: "reviewer@local.invalid"});
  const orgRemoved = page.waitForResponse(response => response.url().endsWith(`/organizations/current/memberships/${reviewerId}`) && response.request().method() === "DELETE");
  await orgRow.getByRole("button", {name: "Revoke", exact: true}).click();
  assert.equal((await orgRemoved).status(), 204);
  assert.deepEqual(await readApi("/organizations/current/memberships"), beforeMembers);
  const acceptedRecord = (await readApi("/organizations/current/invitations")).find(item => item.id === invitation.id);
  assert.ok(acceptedRecord, "Removing membership must not hide the accepted invitation audit record");
  assert.equal(acceptedRecord.status, "accepted");
  assert.equal(acceptedRecord.display_name, "reviewer@local.invalid");
  await page.getByLabel("Email", {exact: true}).fill("reviewer@local.invalid");
  await page.getByLabel("Display name", {exact: true}).fill("Local reviewer");
  await page.getByLabel("Organization role", {exact: true}).selectOption("guest");
  await page.getByLabel("Optional access workspace", {exact: true}).selectOption(project.id);
  const pendingCreated = page.waitForResponse(response => response.url().endsWith("/organizations/current/invitations") && response.request().method() === "POST");
  await page.getByRole("button", {name: "Send invitation", exact: true}).click();
  const pendingResponse = await pendingCreated;
  assert.equal(pendingResponse.status(), 201);
  const unaccepted = await pendingResponse.json();
  const invitationsPanel = page.locator(".platform-admin-panel", {has: page.getByRole("heading", {name: "Invitations", exact: true})});
  const pendingRow = invitationsPanel.getByRole("row").filter({has: page.getByRole("cell", {name: "pending", exact: true})});
  const revoked = page.waitForResponse(response => response.url().endsWith(`/invitations/${unaccepted.id}`) && response.request().method() === "DELETE");
  await pendingRow.getByRole("button", {name: "Revoke", exact: true}).click();
  const revokedResponse = await revoked;
  assert.equal(revokedResponse.status(), 200);
  const revokedRecord = await revokedResponse.json();
  assert.equal(revokedRecord.status, "revoked");
  assert.equal(revokedRecord.display_name, "reviewer@local.invalid");
  assert.equal((await readApi("/organizations/current/invitations")).find(item => item.id === unaccepted.id)?.status, "revoked");
  await reviewer.goto(`${origin}/workspaces`);
  await reviewer.getByRole("heading", {name: "No workspace access yet", exact: true}).waitFor();
  await reviewer.close();

  await page.getByRole("link", {name: "Back to projects", exact: true}).click();
  await page.locator(".access-workspace-directory > summary").click();
  await page.getByRole("link", {name: "Open Disposable viewer access check", exact: true}).click();
  const lifecycle = page.locator(".project-lifecycle-settings");
  await lifecycle.getByRole("button", {name: "Archive workspace", exact: true}).click();
  await lifecycle.getByRole("button", {name: "Cancel", exact: true}).click();
  assert.equal((await readApi(`/projects/${project.id}`)).status, "active");
  async function changeStatus(action, target) {
    await lifecycle.getByRole("button", {name: `${action} workspace`, exact: true}).click();
    const changed = page.waitForResponse(response => response.url().endsWith(`/projects/${project.id}`) && response.request().method() === "PATCH");
    await lifecycle.getByRole("button", {name: `Confirm ${action.toLowerCase()}`, exact: true}).click();
    const response = await changed;
    assert.equal(response.status(), 200);
    assert.equal((await response.json()).status, target);
    await page.locator(`.project-lifecycle-settings[data-project-status="${target}"]`).waitFor();
    await page.reload();
    await page.locator(`.project-lifecycle-settings[data-project-status="${target}"]`).waitFor();
  }
  await changeStatus("Archive", "archived");
  await lifecycle.getByRole("link", {name: "View access workspaces", exact: true}).click();
  await page.locator(".access-workspace-directory > summary").click();
  await page.getByLabel("Access workspace status", {exact: true}).waitFor();
  assert.equal(await page.getByRole("link", {name: "Open Disposable viewer access check", exact: true}).count(), 0);
  await page.getByLabel("Access workspace status", {exact: true}).selectOption("archived");
  await page.getByRole("link", {name: "Open Disposable viewer access check", exact: true}).click();
  assert.equal(new URL(page.url()).searchParams.get("manage"), "settings");
  await changeStatus("Restore", "active");
  assert.deepEqual(await readApi(`/projects/${project.id}/maps`), maps);
  await page.setViewportSize({width: 390, height: 844});
  await lifecycle.screenshot({path: join(work, "project-lifecycle-mobile.png")});
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.setViewportSize({width: 1440, height: 1000});
  await changeStatus("Archive", "archived");
  for (const prior of beforeProjects) assert.deepEqual(await readApi(`/projects/${prior.id}`), prior);
  assert.ok((await readApi("/organizations/current/invitations")).some(item => item.id === invitation.id));
  await page.goto(`${origin}/workspaces?project=${controlProject.id}`);
  return {projectId: project.id, mapId: originalMap.id, invitationId: invitation.id,
    guestViewerPersisted: true, invitationReadBeforeExplicitAcceptance: true,
    reopenedViewerMap: true, viewerWriteDenied: true, viewerProjectArchiveDenied: true, otherPrivateProjectDenied: true,
    projectGrantRevokedThroughStudio: true, testOrganizationMembershipRevokedThroughStudio: true,
    originalMembershipsAndProjectsUnchanged: true, pendingAndAcceptedAuditRecordsVisibleWithoutProfile: true,
    unacceptedInvitationId: unaccepted.id, pendingRevocationThroughStudio: true,
    projectArchivedThroughStudio: true, archiveCancelCreatedNoChange: true,
    archivedDirectoryOpensSettings: true, restoredThroughStudioWithMapsUnchanged: true,
    archivedStatusSurvivesReload: true, lifecycleNarrowScreenNoOverflow: true,
    syntheticIdentityOnly: true, realApiAndDatabase: true};
}

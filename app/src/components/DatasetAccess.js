// Dataset grants retain their existing server authority and never change Project roles.
export function DatasetAccess({adapter, dataset, accountId, accountRole}) {
  const root = node("section"); root.className = "dataset-access-editor project-permission-editor";
  const heading = node("h3", "Layer access"), list = node("ul"), feedback = node("p"), memberStatus = node("p");
  feedback.setAttribute("role", "status"); memberStatus.setAttribute("role", "status");
  const inspect = button("Inspect Layer access", () => void reload());
  const members = button("Load account members", () => void loadMembers());
  const people = node("select"); people.setAttribute("aria-label", "Account member");
  people.append(option("", "Choose an account member or existing grantee"));
  const known = node("input"); known.setAttribute("aria-label", "Dataset access user ID");
  known.placeholder = "Known account member UUID"; known.maxLength = 36;
  const manual = node("details"); manual.append(node("summary", "Use a known account member ID"), known);
  const role = node("select"); role.setAttribute("aria-label", "Dataset access role");
  for (const value of ["view", "download", "edit", "manage"]) role.append(option(value, value));
  const save = button("Grant access", () => void change(known.value.trim() || people.value, role.value));
  const canBrowse = Boolean(accountId && ["admin", "member"].includes(accountRole)
    && typeof adapter.listOrganizationMembers === "function");
  members.hidden = !canBrowse;
  if (!canBrowse) memberStatus.textContent = "Account member browsing is unavailable for this role. Choose an existing grantee or enter a known account member ID.";
  people.addEventListener("change", () => {known.value = "";});
  known.addEventListener("input", () => {people.value = "";});
  let disposed = false, busy = false, loaded = false, needsReadback = false, memberOffset = 0;
  const peopleById = new Map();
  root.append(heading, node("p", "Project roles remain the baseline; explicit Layer grants only elevate. Changing Layer access does not change Project membership, publish content or copy data."),
    inspect, list, members, memberStatus, people, manual, role, save, feedback);
  root.dispose = () => {
    disposed = true; list.replaceChildren();
    people.replaceChildren(); known.value = "";
    for (const control of root.querySelectorAll("button,input,select")) control.disabled = true;
  };
  root.load = reload;
  lock();
  return root;

  async function current() {
    if (disposed) return false;
    try {
      const selected = typeof adapter.organizationProvider === "function" ? await adapter.organizationProvider()
        : adapter.selectedOrganizationId;
      if (disposed) return false;
      if (!root.isConnected || !accountId || selected !== accountId) {
        root.dispose(); feedback.textContent = "The selected account changed or this view closed. Reload the Layer before changing access.";
        return false;
      }
      return true;
    } catch {
      root.dispose(); feedback.textContent = "The selected account could not be verified. Reload the Layer before changing access.";
      return false;
    }
  }
  function lock() {
    inspect.disabled = disposed || busy;
    members.disabled = people.disabled = known.disabled = role.disabled = disposed || busy || !loaded || needsReadback;
    save.disabled = disposed || busy || !loaded || needsReadback;
    for (const control of list.querySelectorAll("button")) control.disabled = disposed || busy || needsReadback;
  }
  function person(record) {
    if (!peopleById.has(record.userId)) {
      const entry = option(record.userId, `${record.displayName} · ${record.email}`);
      peopleById.set(record.userId, entry); people.append(entry);
    }
  }
  async function readGrants() {
    const records = await adapter.listDatasetPermissions(dataset.projectId, dataset.id);
    if (!await current()) return false;
    const rows = records.map(record => {
      person(record);
      const item = node("li");
      item.append(node("span", `${record.displayName} · ${record.email} · ${record.role}`),
        button("Change access", () => {people.value = record.userId; known.value = ""; role.value = record.role;}),
        button("Revoke", () => void change(record.userId, null)));
      return item;
    });
    list.replaceChildren(...rows);
    if (!rows.length) list.append(node("li", "No explicit Layer grants."));
    loaded = true; needsReadback = false; inspect.textContent = "Reload access";
    return true;
  }
  async function reload() {
    if (disposed || busy) return;
    busy = true; lock();
    try {
      if (!await current()) return;
      feedback.textContent = "Loading explicit Layer grants…";
      if (await readGrants()) feedback.textContent = "Current grants loaded. The server checks your authority for every change.";
    } catch {
      if (await current()) feedback.textContent = "Layer access could not load. Reload access to check current permissions.";
    } finally {busy = false; if (!disposed) lock();}
  }
  async function loadMembers() {
    if (!canBrowse || disposed || busy || !loaded || needsReadback || memberOffset > 10_000) return;
    busy = true; lock();
    try {
      if (!await current()) return;
      const page = await adapter.listOrganizationMembers({limit: 50, offset: memberOffset});
      if (!await current()) return;
      for (const record of page) person(record);
      memberOffset += page.length;
      members.hidden = page.length < 50 || memberOffset > 10_000;
      members.textContent = "Load more account members";
      memberStatus.textContent = memberOffset > 10_000 ? "The account member list limit has been reached. Use a known account member ID if needed."
        : `${peopleById.size} account members or existing grantees available.`;
    } catch {
      if (await current()) memberStatus.textContent = "Account members could not load. Retry or use a known account member ID; access rules are unchanged.";
    } finally {busy = false; if (!disposed) lock();}
  }
  async function change(userId, nextRole) {
    if (disposed || busy || !loaded || needsReadback) return;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
      feedback.textContent = "Choose an account member or enter their valid account member ID."; return;
    }
    busy = true; lock();
    let submitted = false, saved = false;
    try {
      if (!await current()) return;
      feedback.textContent = "Saving Layer access…";
      submitted = true;
      if (nextRole === null) await adapter.deleteDatasetPermission(dataset.projectId, dataset.id, userId);
      else await adapter.putDatasetPermission(dataset.projectId, dataset.id, userId, nextRole);
      saved = true;
      if (!await current()) return;
      if (await readGrants()) feedback.textContent = "Layer access saved; current grants reloaded.";
    } catch {
      if (!await current()) return;
      needsReadback = submitted;
      feedback.textContent = saved ? "The change was saved, but current grants could not reload. Reload access before making another change."
        : "The change could not be confirmed. Reload access to inspect current grants before making another change.";
    } finally {busy = false; if (!disposed) lock();}
  }
}
function node(tag, text = "") {const element = document.createElement(tag); element.textContent = text; return element;}
function button(text, action) {const control = node("button", text); control.type = "button"; control.className = "platform-button secondary"; control.addEventListener("click", action); return control;}
function option(value, text) {const element = node("option", text); element.value = value; return element;}

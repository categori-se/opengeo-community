// All mutations use the Collection revision; member content keeps independent access.
export function ResourceSharing({listGrants, grant, listMembers, label = "Collection", id, getRevision, setRevision, isDirty, run, feedback}) {
  const root = document.createElement("fieldset");
  const legend = document.createElement("legend"); legend.textContent = `${label} sharing`;
  const note = document.createElement("p");
  note.textContent = `The owner and account administrators retain access. Explicit grants below apply only to this ${label}.`;
  const grants = document.createElement("ul"), people = document.createElement("select");
  people.setAttribute("aria-label", "Account member");
  const placeholder = document.createElement("option"); placeholder.value = ""; placeholder.textContent = "Choose an account member"; people.append(placeholder);
  const role = document.createElement("select"); role.setAttribute("aria-label", `${label} access`);
  for (const value of ["reader", "editor"]) {
    const option = document.createElement("option"); option.value = value; option.textContent = value === "reader" ? `Can view ${label}` : `Can edit ${label}`; role.append(option);
  }
  let grantOffset = 0, memberOffset = 0, grantRevision = null;
  const known = new Set();
  function act(action) {
    if (isDirty()) {feedback(`Save or discard your ${label} draft before changing sharing.`); return;}
    return run(action);
  }
  const loadGrants = button("Inspect sharing", () => act(async () => {
    const page = await listGrants(id, {limit: 50, offset: grantOffset});
    if (page.revision !== getRevision() || (grantRevision !== null && page.revision !== grantRevision)) {
      grantOffset = 0; grantRevision = null; grants.replaceChildren();
      throw Object.assign(Error(`${label} changed`), {status: 409});
    }
    grantRevision = page.revision;
    for (const item of page.grants) {
      const row = document.createElement("li");
      row.append(document.createTextNode(`${item.displayName} (${item.email}) — ${item.role} `), button(`Revoke ${label} access`, () => act(async () => {
        const receipt = await grant(id, item.userId, {revision: getRevision(), role: null});
        setRevision(receipt.revision); resetGrants();
      })));
      grants.append(row);
    }
    grantOffset += page.grants.length; loadGrants.hidden = page.grants.length < 50;
    loadGrants.textContent = "Load more sharing grants";
    if (grantOffset === 0) grants.textContent = "No explicit sharing grants.";
  }));
  function resetGrants() {
    grantOffset = 0; grantRevision = null; grants.replaceChildren(); loadGrants.hidden = false; loadGrants.textContent = "Inspect sharing";
  }
  const loadPeople = button("Load account members", () => act(async () => {
    const page = await listMembers({limit: 50, offset: memberOffset});
    for (const person of page) {
      if (known.has(person.userId)) continue;
      known.add(person.userId);
      const option = document.createElement("option"); option.value = person.userId;
      option.textContent = `${person.displayName} (${person.email})`; people.append(option);
    }
    memberOffset += page.length; loadPeople.hidden = page.length < 50; loadPeople.textContent = "Load more account members";
  }));
  const apply = button(`Apply ${label} access`, () => {
    if (!people.value) {feedback("Choose an account member first."); return;}
    return act(async () => {
      const receipt = await grant(id, people.value, {revision: getRevision(), role: role.value});
      setRevision(receipt.revision); resetGrants();
    });
  });
  root.append(legend, note, loadGrants, grants, loadPeople, people, role, apply);
  return root;
}
function button(label, action) {const element = document.createElement("button"); element.type = "button"; element.textContent = label; element.addEventListener("click", action); return element;}

export function CollectionSharing({adapter, ...options}) {
  return ResourceSharing({...options, listGrants: (id, page) => adapter.listCollectionGrants(id, page),
    grant: (id, userId, body) => adapter.grantCollection(id, userId, body),
    listMembers: page => adapter.listOrganizationMembers(page)});
}

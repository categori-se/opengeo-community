/** Reserve a path on an operator-approved public origin. Never provisions
 * infrastructure, changes an existing address, builds or publishes content. */
export function PublicationDestinationForm({origins, onReserve}) {
  const form = document.createElement('fieldset'); form.className = 'publication-release-form';
  const legend = document.createElement('legend'); legend.textContent = 'Add public address';
  const host = document.createElement('select'); host.ariaLabel = 'Public hosting';
  for (const origin of origins) {
    const option = document.createElement('option'); option.value = origin.id; option.textContent = origin.urlPrefix; host.append(option);
  }
  const name = document.createElement('input'); name.type = 'text'; name.maxLength = 80; name.autocomplete = 'off';
  name.ariaLabel = 'Address name'; name.placeholder = 'my-publication';
  name.pattern = '[a-z0-9][a-z0-9-]{0,79}'; name.title = 'Use lowercase letters, numbers and hyphens.';
  const address = document.createElement('output'); address.ariaLabel = 'Proposed public address';
  const note = document.createElement('p'); note.textContent = 'Use lowercase letters, numbers and hyphens. Reserving an address does not publish it.';
  const reserve = document.createElement('button'); reserve.type = 'button'; reserve.textContent = 'Reserve address'; reserve.className = 'platform-button secondary';
  const feedback = document.createElement('p'); feedback.setAttribute('role', 'status');
  const label = (title, control) => {const element = document.createElement('label'); element.append(title, control); return element;};
  let busy = false;
  function update() {
    const origin = origins.find(origin => origin.id === host.value);
    const valid = Boolean(origin) && /^[a-z0-9][a-z0-9-]{0,79}$/.test(name.value);
    address.textContent = origin ? `${origin.urlPrefix}${valid ? name.value + '/' : '…'}` : '';
    reserve.disabled = busy || !valid;
  }
  host.onchange = name.oninput = update;
  reserve.onclick = async () => {
    if (busy || reserve.disabled) return;
    busy = true; host.disabled = name.disabled = true; update();
    try {await onReserve({originId: host.value, slug: name.value});}
    catch {feedback.textContent = 'Reservation could not be confirmed. Reload addresses before trying again.';}
    finally {busy = false; host.disabled = name.disabled = false; update();}
  };
  form.append(legend, label('Hosting', host), label('Address name', name), address, note, reserve, feedback);
  update(); return form;
}

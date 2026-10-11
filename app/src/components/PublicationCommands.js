/** Native, keyboard-accessible menus; commands act on the selected publication. */
export function PublicationCommands({menus}) {
  const root = document.createElement('nav');
  root.className = 'publication-commands'; root.ariaLabel = 'Publication commands';
  const entries = menus.map(({label, commands}) => {
    const menu = document.createElement('details');
    const title = document.createElement('summary'); title.textContent = label;
    const items = document.createElement('div'); items.className = 'publication-command-items';
    menu.append(title, items);
    for (const command of commands) {
      const control = document.createElement('button'); control.type = 'button'; control.textContent = command.label;
      const update = () => {control.disabled = command.enabled ? !command.enabled() : false;};
      update(); menu.addEventListener('toggle', update);
      control.addEventListener('click', () => {menu.open = false; title.focus(); command.run();});
      items.append(control);
    }
    menu.addEventListener('toggle', () => {
      if (menu.open) for (const sibling of root.children) if (sibling !== menu) sibling.open = false;
    });
    menu.addEventListener('focusout', event => {
      // Do not collapse between pointer-down and click while focus is moving
      // inside the popup. The next focus target determines whether it left.
      if (event.relatedTarget && !menu.contains(event.relatedTarget)) menu.open = false;
    });
    menu.addEventListener('keydown', event => {
      const controls = [...items.querySelectorAll('button:not(:disabled)')];
      if (event.key === 'Escape') {event.preventDefault(); menu.open = false; title.focus();}
      else if (['ArrowDown', 'ArrowUp'].includes(event.key) && controls.length) {
        event.preventDefault(); menu.open = true;
        const index = controls.indexOf(root.ownerDocument.activeElement), direction = event.key === 'ArrowDown' ? 1 : -1;
        controls[index < 0 ? direction > 0 ? 0 : controls.length - 1 : (index + direction + controls.length) % controls.length].focus();
      }
    });
    root.append(menu); return menu;
  });
  root.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const index = entries.findIndex(menu => menu.contains(root.ownerDocument.activeElement));
    if (index < 0) return;
    event.preventDefault(); entries[index].open = false;
    entries[(index + (event.key === 'ArrowRight' ? 1 : -1) + entries.length) % entries.length].querySelector('summary').focus();
  });
  return root;
}

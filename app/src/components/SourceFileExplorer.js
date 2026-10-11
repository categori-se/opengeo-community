/** Source paths, not public routes. Native disclosures retain folder state. */
export function SourceFileExplorer({onSelect, onNewPage}) {
  const root = document.createElement("nav");
  root.className = "source-file-explorer";
  root.setAttribute("aria-label", "Source files");
  let paths = [], active = null, query = "", selectedFolder = null;
  const folders = new Map();
  function render() {
    for (const folder of root.querySelectorAll("details")) folders.set(folder.dataset.path, folder.open);
    const tree = new Map();
    for (const path of paths.filter(path => path.toLowerCase().includes(query))) {
      let branch = tree;
      const parts = path.split("/");
      parts.forEach((part, index) => {
        if (index === parts.length - 1) branch.set(part, path);
        else {
          if (!branch.has(part)) branch.set(part, new Map());
          branch = branch.get(part);
        }
      });
    }
    function renderList(branch, prefix = "") {
      const list = document.createElement("ul");
      const entries = [...branch].sort(([a, av], [b, bv]) =>
        Number(bv instanceof Map) - Number(av instanceof Map) || a.localeCompare(b));
      for (const [name, value] of entries) {
        const item = document.createElement("li");
        if (value instanceof Map) {
          const path = `${prefix}${name}/`, folder = document.createElement("details");
          folder.dataset.path = path; folder.open = query ? true : folders.get(path) ?? true;
          const title = document.createElement("summary"); title.textContent = name;
          title.dataset.sourceFolder = path;
          title.dataset.selected = String(path === selectedFolder);
          title.addEventListener('click', () => {
            selectedFolder = path;
            for (const row of root.querySelectorAll('[data-source-folder]')) {
              row.dataset.selected = String(row === title);
            }
          });
          if (onNewPage) {
            const add = document.createElement('button'); add.type = 'button'; add.textContent = '+';
            add.className = 'source-folder-new-page'; add.ariaLabel = `New page in ${path.slice(0, -1)}`;
            add.addEventListener('click', event => {
              event.preventDefault(); event.stopPropagation(); selectedFolder = path; onNewPage(path);
            });
            title.append(add);
          }
          folder.append(title, renderList(value, path)); item.append(folder);
        } else {
          const button = document.createElement("button");
          button.type = "button"; button.textContent = name; button.title = value;
          button.dataset.sourcePath = value;
          if (value === active) button.setAttribute("aria-current", "true");
          button.addEventListener("click", () => onSelect(value)); item.append(button);
        }
        list.append(item);
      }
      return list;
    }
    root.replaceChildren(renderList(tree));
  }
  return {element: root,
    update(next) {paths = next; render();},
    get folder() {return selectedFolder;},
    select(path) {active = path; selectedFolder = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
      for (const button of root.querySelectorAll("button[data-source-path]")) {
      if (button.dataset.sourcePath === path) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
    }},
    search(value) {query = value.trim().toLowerCase(); render();}
  };
}

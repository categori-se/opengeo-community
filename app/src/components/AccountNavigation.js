import {directoryHref} from "../lib/applicationRoutes.js";

// Account administration is separate from content discovery and item sharing.
export function AccountNavigation({adapterKind = null, active = null, admin = false} = {}) {
  const nav = document.createElement("nav");
  nav.className = "platform-account-navigation";
  nav.setAttribute("aria-label", "Account settings");
  const items = [
    ...(admin ? [["people", "People and access", adapterKind === "fixture" ? "/admin?adapter=fixture" : "/admin"]] : []),
    ["access", "Data access", directoryHref({adapterKind, view: "access"})],
    ["teams", "Teams", directoryHref({adapterKind, view: "teams"})],
    ["sources", "Connections", directoryHref({adapterKind, view: "sources"})]
  ];
  for (const [id, label, href] of items) {
    const link = document.createElement("a");
    link.className = "platform-button platform-button-secondary";
    link.textContent = label;
    link.href = href;
    if (id === active) link.setAttribute("aria-current", "page");
    nav.append(link);
  }
  return nav;
}

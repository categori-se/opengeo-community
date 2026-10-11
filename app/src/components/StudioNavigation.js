import {directoryHref} from "../lib/applicationRoutes.js";

export const MANAGED_STUDIO_URL = "https://studio.opengeo.tools/workspaces";

export function demoNavigationItems() {
  return [
    {id: "home", label: "Demo", href: "/"},
    {id: "samples", label: "Sample datasets", href: "/?view=examples"},
    {id: "studio", label: "Open Studio ↗", href: MANAGED_STUDIO_URL}
  ];
}

export function studioNavigationItems(adapterKind = null) {
  return [
    {id: "home", label: "Home", href: "/"},
    {id: "projects", label: "Projects", href: directoryHref({adapterKind})},
    {id: "data", label: "Catalog", href: directoryHref({adapterKind, view: "data"})},
    {id: "styles", label: "Styles", href: directoryHref({adapterKind, view: "styles"})},
    {id: "locations", label: "Geographic tags", href: directoryHref({adapterKind, view: "locations"})},
    {id: "collections", label: "Collections", href: directoryHref({adapterKind, view: "collections"})},
    {id: "publishing", label: "Publications", href: directoryHref({adapterKind, view: "publishing"})}
  ];
}

export function StudioNavigation({adapterKind = null, active = null} = {}) {
  const nav = document.createElement("nav");
  nav.className = "studio-navigation platform-route-bar";
  nav.setAttribute("aria-label", "Studio navigation");
  const brand = document.createElement("a");
  brand.href = "/";
  brand.className = "studio-navigation-brand";
  brand.textContent = "OpenGeo Studio";
  nav.append(brand);
  for (const item of studioNavigationItems(adapterKind)) {
    const link = document.createElement("a");
    link.href = item.href;
    link.textContent = item.label;
    if (active === item.id) link.setAttribute("aria-current", "page");
    nav.append(link);
  }
  return nav;
}

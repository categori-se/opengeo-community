export const studioPwaHead = [
  '<meta name="referrer" content="no-referrer">',
  '<meta name="theme-color" content="#4f8cff">',
  '<meta name="mobile-web-app-capable" content="yes">',
  '<link rel="stylesheet" href="/style.css">',
  '<script type="module">{const icon=document.createElement("link");icon.rel="icon";icon.type="image/png";icon.href="/icons/opengeo-192.png";document.head.append(icon);const manifest=document.createElement("link");manifest.rel="manifest";manifest.href="/manifest.webmanifest";document.head.append(manifest);if("serviceWorker" in navigator){addEventListener("load",()=>navigator.serviceWorker.register("/service-worker.js",{scope:"/",updateViaCache:"none"}).then(()=>document.documentElement.dataset.pwa="registered").catch(()=>document.documentElement.dataset.pwa="unavailable"),{once:true})}}</script>'
].join("");

export default {
  title: "OpenGeo Studio",
  root: "src",
  theme: ["near-midnight", "wide"],
  head: studioPwaHead,
  // Application components own navigation and authorization context. Records
  // are reached through the account and project directories; fixture record
  // identifiers must never become global pages in the generated shell.
  sidebar: false,
  search: false,
  pager: false,
  toc: false,
  pages: [
    {name: "Overview", path: "/"},
    {name: "Public Demo", path: "/public-demo"},
    {name: "Published Library", path: "/library"},
    {name: "Login", path: "/login"},
    {name: "Projects", path: "/workspaces"},
    {name: "Layer", path: "/layers"},
    {name: "Admin", path: "/admin"},
    {name: "Open Source & Credits", path: "/credits"}
  ]
};

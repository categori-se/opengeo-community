import assert from "node:assert/strict";
import {it} from "node:test";
import {JSDOM} from "jsdom";
import {readFileSync} from "node:fs";
import {StartRecentProjects} from "../src/components/StartRecentProjects.js";

it("renders immediately and fetches history without loading the account-wide directory", async () => {
  const dom = new JSDOM("<!doctype html>"); const old = globalThis.document; globalThis.document = dom.window.document;
  try {
    let resolveSession; const calls=[];
    const root=StartRecentProjects({adapter:{
      getSession:()=>new Promise(resolve=>{resolveSession=resolve;}),
      selectOrganization:id=>calls.push(id),
      listRecentProjects:async ({signal})=>{assert.ok(signal);calls.push("recent");return [{name:"NOAA"}];},
      getCurrentOrganization:()=>assert.fail("Unnecessary organization read"),
      listProjects:()=>assert.fail("Unnecessary full project read")
    }, render:r=>{const p=document.createElement("a");p.textContent=r.name;return p;}});
    assert.match(root.textContent,/You can use the map and navigation now/);
    resolveSession({selectedOrganizationId:"org",memberships:[{organizationId:"org"}]});
    await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(root.textContent,"NOAA"); assert.deepEqual(calls,["org","recent"]);
    assert.equal(root.getAttribute("aria-busy"),"false");
  } finally {globalThis.document=old;dom.window.close();}
});

it("bounds delayed history, aborts it, and allows one explicit retry without replacing the workbench", async () => {
  const dom=new JSDOM("<!doctype html>");const old=globalThis.document;globalThis.document=dom.window.document;
  try {
    let signal, calls=0;
    const root=StartRecentProjects({timeoutMs:5,adapter:{
      getSession:({signal:s})=>{signal=s;calls++;return calls===1 ? new Promise(()=>{}) : Promise.resolve({memberships:[]});},
    }, render:()=>assert.fail()});
    await new Promise(resolve=>setTimeout(resolve,15));
    assert.equal(signal.aborted,true);assert.match(root.textContent,/Retry recent projects/);
    root.querySelector("button").click();
    await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(calls,2);assert.match(root.textContent,/No recent project activity/);
  } finally {globalThis.document=old;dom.window.close();}
});

it("keeps start navigation independent from account history and routes publication management to Publishing", () => {
  const source=readFileSync(new URL("../src/components/StartPage.js",import.meta.url),"utf8");
  assert.doesNotMatch(source,/loadDirectoryCore|Loading your authenticated project history/);
  assert.match(source,/render\(\[\], adapter.kind, \{status: "loading"\}\)/);
  assert.match(source,/directoryHref\(\{view: "publishing", adapterKind\}\)/);
});

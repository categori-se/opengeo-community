import assert from "node:assert/strict";
import {test} from "node:test";
import {JSDOM} from "jsdom";
import {OpenGeoApiClient} from "../src/lib/apiClient.js";
import {ServiceConnection} from "../src/components/ServiceConnection.js";
import {serviceConnectionTarget, serviceConnectionUrl, readServiceConnection} from "../src/lib/serviceConnection.js";

const project = "50000000-0000-4000-8000-000000000168";
const organization = "10000000-0000-4000-8000-000000000168";
const response = (body, status = 200, type = "application/json") => new Response(body, {status, headers:{"content-type":type}});

test("service previews use the current API authority only in headers and never follow document links", async () => {
  const calls = [];
  const client = new OpenGeoApiClient({baseUrl:"https://api.example.test/api", tokenProvider:()=>"secret-sentinel", organizationProvider:()=>organization,
    fetchImplementation:async (url, options) => {calls.push({url,options});return response('{"links":[{"href":"https://untrusted.invalid/"}]}');}});
  const result = await readServiceConnection(client, project, "research", "ogc");
  assert.equal(result.mediaType,"application/json");
  assert.equal(calls.length,1);
  assert.equal(calls[0].options.headers.get("authorization"),"Bearer secret-sentinel");
  assert.equal(calls[0].options.headers.get("X-OpenGeo-Organization"),organization);
  assert.equal(calls[0].options.credentials,"omit");
  assert.equal(calls[0].options.redirect,"error");
  assert.equal(calls[0].options.method,"GET");
  assert.equal(calls[0].options.body,undefined);
  assert.equal(calls[0].url.includes("secret-sentinel"),false);
  assert.equal(serviceConnectionUrl(client.baseUrl,serviceConnectionTarget(project,"research"),"https://studio.example.test"),calls[0].url);
});

test("only fixed project-scoped protocol paths can be requested or copied", () => {
  for (const slug of ["../other", "research?token=x", "https://outside.test", "research/other", "research-"]) assert.throws(()=>serviceConnectionTarget(project,slug));
  assert.match(serviceConnectionTarget(project,"2026-survey").path,/2026-survey\/ogc$/);
  assert.match(serviceConnectionTarget(project,"0").path,/\/0\/ogc$/);
  for (const protocol of ["constructor","__proto__","getmap","https://outside.test"]) assert.throws(()=>serviceConnectionTarget(project,"research",protocol));
  assert.throws(()=>serviceConnectionTarget("../project","research"));
  const target=serviceConnectionTarget(project,"research","wcs");
  assert.match(target.path,/REQUEST=GetCapabilities/);
  for (const url of ["https://user:secret@api.test", "https://api.test?token=secret", "javascript:bad", "https://api.test#secret"]) assert.throws(()=>serviceConnectionUrl(url,target,"https://studio.test"));
});

test("preview rejects denied, HTML, oversized and empty responses", async () => {
  for (const value of [response("denied",401),response("denied",404),response("<script>bad</script>",200,"text/html"),response(""),response("x".repeat(2_097_153))]) {
    await assert.rejects(readServiceConnection({requestResponse:async()=>value},project,"research","ogc"));
  }
  const value=response("small");value.headers.set("content-length","2097153");
  await assert.rejects(readServiceConnection({requestResponse:async()=>value},project,"research","ogc"));
  const xml=await readServiceConnection({requestResponse:async()=>response("<Capabilities/>",200,"application/xml")},project,"research","wcs");
  assert.equal(xml.content,"<Capabilities/>");
});

async function withPanel(run) {
  const old={document:globalThis.document,window:globalThis.window};
  const dom=new JSDOM("<body></body>",{url:"https://studio.example.test"});
  globalThis.document=dom.window.document;globalThis.window=dom.window;
  const calls=[];
  const state={project:{id:project},organization:{id:organization},adapter:{kind:"api",baseUrl:"/api",requestResponse:async(...args)=>{calls.push(args);return response('{"title":"Research"}');}}};
  const panel=ServiceConnection({state,service:{slug:"research",disabledAt:null},enabledProtocols:["wmts_1_0","wcs_2_0"]});
  document.body.append(panel);
  try {await run({panel,state,calls,dom});} finally {dom.window.close();globalThis.document=old.document;globalThis.window=old.window;}
}
const settle=()=>new Promise(resolve=>setTimeout(resolve,0));

test("discovery is explicit, rendered as text, read-only and copyable without credentials", async () => withPanel(async ({panel,state,calls,dom}) => {
  assert.equal(calls.length,0);
  assert.equal(panel.querySelector("select").getAttribute("aria-label"),"Service protocol");
  panel.open=true;await settle();
  state.adapter.requestResponse=async(...args)=>{calls.push(args);return response('<Capabilities><script>bad()</script></Capabilities>',200,"application/xml");};
  const select=panel.querySelector("select");select.value="wcs";select.dispatchEvent(new dom.window.Event("change"));
  panel.querySelectorAll("button")[1].click();await settle();
  assert.equal(calls.length,1);
  assert.equal(panel.querySelector("script"),null);
  assert.match(panel.querySelector("pre").textContent,/<script>/);
  assert.equal(panel.querySelector("pre").hidden,false);
  let copied;
  Object.defineProperty(dom.window.navigator,"clipboard",{value:{writeText:async value=>{copied=value;}}});
  panel.querySelectorAll("button")[0].click();await settle();
  assert.equal(copied,panel.querySelector("input").value);
  assert.equal(panel.querySelectorAll("a").length,0);
}));

test("changing protocol cancels and suppresses stale previews; denied access clears old content", async () => withPanel(async ({panel,state,dom}) => {
  panel.open=true;await settle();
  let finish, signal;
  state.adapter.requestResponse=(_path,options)=>{signal=options.signal;return new Promise(resolve=>{finish=resolve;});};
  panel.querySelectorAll("button")[1].click();
  const select=panel.querySelector("select");select.value="wcs";select.dispatchEvent(new dom.window.Event("change"));
  assert.equal(signal.aborted,true);
  finish(response('{"title":"old"}'));await settle();
  assert.equal(panel.querySelector("pre").textContent,"");
  state.adapter.requestResponse=async()=>response("denied",403);
  panel.querySelectorAll("button")[1].click();await settle();
  assert.match(panel.querySelector('[role="status"]').textContent,/no longer has access/);
  assert.equal(panel.querySelector("pre").hidden,true);
}));

test("closing clears metadata and unsupported clipboard falls back to selecting the URL", async () => withPanel(async ({panel}) => {
  panel.open=true;await settle();
  panel.querySelectorAll("button")[1].click();await settle();
  assert.equal(panel.querySelector("pre").hidden,false);
  panel.querySelectorAll("button")[0].click();await settle();
  const address=panel.querySelector("input");
  assert.equal(document.activeElement,address);
  assert.equal(address.selectionEnd,address.value.length);
  panel.open=false;await settle();
  assert.equal(panel.querySelector("pre").hidden,true);
  assert.equal(panel.querySelector("pre").textContent,"");
}));

test("fixture and disabled services do not offer invented API previews", async () => withPanel(async ({state}) => {
  const restricted=ServiceConnection({state,service:{slug:"research",disabledAt:null},enabledProtocols:["wmts_1_0"]});
  assert.equal(restricted.querySelector('option[value="wcs"]').disabled,true);
  assert.equal(restricted.querySelector('option[value="wmts"]').disabled,false);
  for (const [kind,disabledAt] of [["fixture",null],["api","2026-09-08T00:00:00Z"]]) {
    const panel=ServiceConnection({state:{...state,adapter:{...state.adapter,kind}},service:{slug:"research",disabledAt}});
    assert.ok([...panel.querySelectorAll("button")].every(button=>button.disabled));
    assert.equal(panel.querySelector("input").value,"");
  }
}));

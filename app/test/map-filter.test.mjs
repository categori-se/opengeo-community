import assert from "node:assert/strict";
import {it} from "node:test";
import {validateMapFilter,combineMapFilters} from "../src/lib/mapFilter.js";
import {upgradeMapDefinition,emptyMapDefinition} from "../src/lib/mapDefinition.js";
it("retains bounded native predicate values and rejects unsupported expressions",()=>{
 for(const f of [null,["==",["get","name"],"Park"],["==","name","Park"],["all",["has","name"],["!",["==",["get","value"],null]]]]){
  assert.equal(validateMapFilter(f),f);
 }
 for(const f of [["get","name"],["==",["get",["var","field"]],"x"],["==",["get","x"],{}],["all"],["==",["get","x"],Infinity]]){
  assert.throws(()=>validateMapFilter(f));
 }
 let f=["has","x"];for(let i=0;i<10;i++)f=["!",f];assert.throws(()=>validateMapFilter(f));
 assert.deepEqual(combineMapFilters(["has","a"],["has","b"]),["all",["has","a"],["has","b"]]);
 const filter=["==",["get","name"],"Park"];
 const draft=emptyMapDefinition({layers:[{filter}]});assert.deepEqual(upgradeMapDefinition(draft).layers[0].filter,filter);
});

it("unfiltered layer specifications omit the filter property", async () => {
  const {mapFilterOptions} = await import("../src/lib/mapFilter.js");
  assert.deepEqual(mapFilterOptions(undefined, undefined), {});
  assert.deepEqual(mapFilterOptions(null, null), {});
  const filter = ["==", ["get", "name"], "one"];
  assert.deepEqual(mapFilterOptions(undefined, filter), {filter});
});

it("matches the pinned GeoLens filter helper on the shared subset and rejects unsupported semantics", async () => {
  const {readFile} = await import("node:fs/promises");
  const {createHash} = await import("node:crypto");
  const {stripTypeScriptTypes} = await import("node:module");
  const root = new URL("../../parity/fixtures/geolens-004/", import.meta.url);
  const lock = JSON.parse(await readFile(new URL("source-lock.json", root), "utf8"));
  const body = await readFile(new URL("maplibre-filter-utils.ts", root));
  assert.equal(createHash("sha256").update(body).digest("hex"), lock.files[0].sha256);
  assert.equal(createHash("sha1").update(`blob ${body.length}\0`).update(body).digest("hex"), lock.files[0].gitBlob);
  const peer = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(body.toString())).toString("base64")}`);
  for (const value of [null, ["==", ["get", "name"], "Park"], ["has", "name"],
    ["any", ["!", ["has", "name"]], ["==", ["get", "name"], null]],
    ["all", [">", ["get", "count"], 2], ["!=", ["get", "name"], "Hidden"]]]) {
    const normalized = peer.validateRawFilter(structuredClone(value));
    assert.deepEqual(validateMapFilter(normalized), value);
  }
  assert.deepEqual(peer.validateRawFilter(["==", "name", "Park"]), ["==", ["get", "name"], "Park"]);
  const advanced = ["in", ["get", "name"], ["literal", ["A", "B"]]];
  assert.deepEqual(peer.validateRawFilter(advanced), advanced);
  assert.deepEqual(validateMapFilter(advanced), advanced);
  const numeric = peer.sanitizeNullableNumericFilter([">", ["get", "count"], 2]);
  assert.equal(numeric[1][0], "to-number");
  assert.throws(() => validateMapFilter(numeric), /Unsupported/);
  assert.equal(peer.validateRawFilter([]), null);
  assert.throws(() => validateMapFilter([]), /Unsupported/);
});

it("bounds homogeneous membership lists and preserves negation",()=>{
 for(const values of [["A","B"],[1,2.5]]){const f=["!",["in",["get","value"],["literal",values]]];assert.deepEqual(validateMapFilter(f),f);}
 for(const values of [[],[true],[null],["A",1],Array(65).fill("A"),[Infinity]])assert.throws(()=>validateMapFilter(["in",["get","value"],["literal",values]]));
});

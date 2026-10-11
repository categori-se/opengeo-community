import assert from "node:assert/strict";
import {it} from "node:test";
import {knowledgeChanges} from "../src/lib/knowledgeChanges.js";

it("preserves explicit unknowns, missing fields, exact source text and JSON pointer paths", () => {
  const before={metadata:{source:[{content:" original\n"}],curated:[{value:null}]},"a/b~":null,removed:null};
  const after={metadata:{source:[{content:"original"}],curated:[{value:"restricted"}]},"a/b~":false,added:null};
  const frozen=JSON.stringify(before);
  assert.deepEqual(knowledgeChanges(before,after),[
    {path:"/metadata/source/0/content",kind:"changed",before:" original\n",after:"original"},
    {path:"/metadata/curated/0/value",kind:"changed",before:null,after:"restricted"},
    {path:"/a~1b~0",kind:"changed",before:null,after:false},
    {path:"/removed",kind:"removed",before:null},
    {path:"/added",kind:"added",after:null}
  ]);
  assert.equal(JSON.stringify(before),frozen);
  assert.deepEqual(knowledgeChanges({a:1,b:2},{b:2,a:1}),[]);
});

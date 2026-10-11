import assert from 'node:assert/strict';
import {it} from 'node:test';
import {parseAuthoredKnowledge} from '../src/lib/apiClient.js';
it('keeps authored kind and identity distinct from dataset compatibility parsing',()=>{
 const id='10000000-0000-4000-8000-000000000001';
 const value={kind:'collection',resource_id:id,version:0,can_edit:false,created_by:null,created_at:null,document:{schemaVersion:'1.0.0',metadata:{source:[],normalized:[],curated:[],inferred:[]},distributions:[],context:[]}};
 const parsed=parseAuthoredKnowledge(value,'collection',id);assert.equal(parsed.resourceId,id);assert.equal(parsed.kind,'collection');assert.equal(parsed.datasetId,undefined);
 assert.throws(()=>parseAuthoredKnowledge(value,'project',id));
 assert.throws(()=>parseAuthoredKnowledge({...value,resource_id:'10000000-0000-4000-8000-000000000002'},'collection',id));
});

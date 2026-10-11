import assert from 'node:assert/strict';
import {it} from 'node:test';
import {parseDatasetVersion} from '../src/lib/apiClient.js';
const id='10000000-0000-4000-8000-000000000001';
const version=()=>({id,version_number:1,parent_version_id:null,state:'active',change_message:null,feature_count:1,extent:null,crs:'EPSG:4326',geometry_type:'PointZM',schema_definition:{},quality_results:{warnings:[{code:'display_derivatives_omit_measure',message:'Preview omits M.',evidence:{layout:'XYZM'}}],safety_scan:{engine:'ClamAV',status:'passed'}},created_by:id,created_at:'2026-09-23T00:00:00Z',current:true,objects:[]});
it('retains warning messages, nested evidence and scan provenance without aliasing the payload',()=>{
 const input=version(),output=parseDatasetVersion(input);
 assert.equal(output.qualityResults.warnings[0].message,'Preview omits M.');
 assert.deepEqual(output.qualityResults.safety_scan,{engine:'ClamAV',status:'passed'});
 output.qualityResults.warnings[0].evidence.layout='XY';
 assert.equal(input.quality_results.warnings[0].evidence.layout,'XYZM');
});
it('rejects malformed messages instead of silently discarding them',()=>{
 for(const message of [42,'x'.repeat(8193)]){const input=version();input.quality_results.warnings[0].message=message;assert.throws(()=>parseDatasetVersion(input));}
});

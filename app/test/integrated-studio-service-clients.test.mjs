import assert from "node:assert/strict";
import {test} from "node:test";
import {checkedServiceLink,readServiceHttp} from "../scripts/integrated-studio-service-clients.mjs";
import {verifyTileAppend,verifyDerivedAppend} from "../scripts/integrated-studio-tiles.mjs";

const projectId="50000000-0000-4000-8000-000000000001";
const baseUrl=`http://127.0.0.1:12345/api/projects/${projectId}/services/watershed-pilot/ogc`;
const expected=[1,2].map(value=>({geometry:{type:"Point",coordinates:[value,value]},properties:{name:`Watershed ${value}`,value}}));

test("tile preparation permits only its exact new derivative, preserving all existing version facts and objects",()=>{
  const before=[{id:"version",objects:[{id:"original",checksum_sha256:"original-hash"}]}];
  const render={state:"completed",dataset_version_id:"version",output_object_id:"tile",output_checksum_sha256:"tile-hash",output_size_bytes:99};
  const tile={id:"tile",role:"derived",content_type:"image/png",checksum_sha256:"tile-hash",size_bytes:99};
  const after=[{id:"version",objects:[...before[0].objects,tile]}];
  assert.deepEqual(verifyTileAppend(before,after,render),tile);
  assert.throws(()=>verifyTileAppend(before,[{...after[0],objects:[{id:"original",checksum_sha256:"changed"},tile]}],render));
  assert.throws(()=>verifyTileAppend(before,[{...after[0],objects:[...after[0].objects,{id:"unexpected"}]}],render));
  assert.throws(()=>verifyTileAppend(before,after,{...render,output_checksum_sha256:"wrong"}));
  assert.throws(()=>verifyTileAppend(before,before,render));
});

test("independent discovery refuses foreign origins, projects and credential-bearing links",()=>{
  for(const href of ["https://outside.test/","http://user:password@127.0.0.1:12345/projects/x/",`${baseUrl}#token`,"/projects/other/ogc","//outside.test/path"])assert.throws(()=>checkedServiceLink(href,baseUrl,projectId));
  assert.equal(checkedServiceLink(`/projects/${projectId}/data`,baseUrl,projectId),`http://127.0.0.1:12345/projects/${projectId}/data`);
});

test("coverage preparation permits only its exact TIFF derivative, without broadening tile checks",()=>{
  const before=[{id:"version",objects:[{id:"original",checksum_sha256:"source"}]}];
  const object={id:"derivative",role:"derived",content_type:"image/tiff",checksum_sha256:"output",size_bytes:100};
  const after=[{...before[0],objects:[...before[0].objects,object]}];
  const job={state:"completed",dataset_version_id:"version",output_object_id:"derivative",output_checksum_sha256:"output",output_size_bytes:100};
  assert.deepEqual(verifyDerivedAppend(before,after,job,"image/tiff"),object);
  assert.throws(()=>verifyTileAppend(before,after,job));
  assert.throws(()=>verifyDerivedAppend(before,after,{...job,output_checksum_sha256:"other"},"image/tiff"));
  assert.throws(()=>verifyDerivedAppend(before,after,job,"application/octet-stream"));
});

function peer({loop=false,denied=false}={}) {
  const calls=[];
  const fetchImplementation=async(url,options)=>{
    calls.push({url,options});
    let status=200,body;
    if(!options.headers.authorization){status=401;body={detail:"authentication_required"};}
    else if(url===baseUrl)body={links:[{rel:"data",href:baseUrl+"/collections"}]};
    else if(url===baseUrl+"/collections")body={collections:denied?[]:[{id:"watersheds",links:[{rel:"items",type:"application/geo+json",href:baseUrl+"/collections/watersheds/items"}]}]};
    else if(denied){status=404;body={detail:"not_found"};}
    else {
      const second=new URL(url).searchParams.get("offset")==="1",index=second?1:0;
      body={type:"FeatureCollection",features:[{type:"Feature",id:String(index),...expected[index]}],links:second?[]:[{rel:"next",href:baseUrl+`/collections/watersheds/items?limit=1${loop?"":"&offset=1"}`} ]};
    }
    return new Response(JSON.stringify(body),{status});
  };
  return {calls,fetchImplementation};
}

test("independent client follows discovery and exact two-page feature data with header-only authority",async()=>{
  const fixture=peer();const result=await readServiceHttp({baseUrl,projectId,organizationId:"organization",expected,fetchImplementation:fixture.fetchImplementation});
  assert.equal(result.pages,2);assert.deepEqual(result.features,expected);
  for(const call of fixture.calls){assert.equal(call.options.redirect,"error");assert.equal(call.options.credentials,"omit");assert.equal(call.url.includes("synthetic-local-owner"),false);assert.equal(call.options.body,undefined);}
});

test("pagination loops cannot fabricate completion",async()=>{
  const fixture=peer({loop:true});await assert.rejects(readServiceHttp({baseUrl,projectId,expected,fetchImplementation:fixture.fetchImplementation}),/pagination loop/);
});

test("withdrawal requires both absence from discovery and an exact denied feature read",async()=>{
  const fixture=peer({denied:true});const result=await readServiceHttp({baseUrl,projectId,expected,denied:true,fetchImplementation:fixture.fetchImplementation});
  assert.equal(result.withdrawnItemsDenied,true);assert.equal(result.withdrawnUndiscoverable,true);
  const available=peer();await assert.rejects(readServiceHttp({baseUrl,projectId,expected,denied:true,fetchImplementation:available.fetchImplementation}));
});


test("metadata discovery verifies terms and keeps resource denial separate from available features",async()=>{
  const resourceId="a0000000-0000-4000-8000-000000000001";
  for(const prefix of ["/api", ""]) for(const revoked of [false,true]) {
    const href=`http://127.0.0.1:12345${prefix}/projects/${projectId}/records/collections/resources/items/${resourceId}`;
    const fixture=peer();
    const fetchImplementation=async(url,options)=>{
      if(url===href) return new Response(JSON.stringify(!options.headers.authorization?{detail:'unauthenticated'}:revoked?{detail:'not_found'}:{type:'Feature',id:resourceId,properties:{license:'CC-BY-4.0'}}),{status:!options.headers.authorization?401:revoked?404:200});
      const response=await fixture.fetchImplementation(url,options);
      if(url!==baseUrl+'/collections')return response;
      const body=await response.json();body.collections[0].links.push({rel:'describedby',type:'application/geo+json',href});return new Response(JSON.stringify(body));
    };
    const result=await readServiceHttp({baseUrl,projectId,organizationId:'organization',expected,expectedMetadata:{resourceId,license:'CC-BY-4.0'},metadataDenied:revoked,fetchImplementation});
    assert.equal(result.features.length,2);
    if(revoked)assert.equal(result.metadata.resourceAccessDenied,true);
    else assert.equal(result.metadata.license,'CC-BY-4.0');
    if(revoked)await assert.rejects(readServiceHttp({baseUrl,projectId,expected,expectedMetadata:{resourceId,license:'CC-BY-4.0'},fetchImplementation}));
  }
});

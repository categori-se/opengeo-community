import assert from "node:assert/strict";
import {test} from "node:test";
import {JSDOM} from "jsdom";
import {FieldsOfTheWorld} from "../src/components/FieldsOfTheWorld.js";

const query={countryCode:"NP",year:2024,bounds:[85,27,85.001,27.001]};
const fixture=(count=1)=>({geojson:{type:"FeatureCollection",features:Array.from({length:count},(_,index)=>({type:"Feature",id:`field-${index}`,
  properties:{confidence:null,year:2024},geometry:{type:"Polygon",coordinates:[[[85,27],[85.001,27],[85.001,27.001],[85,27.001],[85,27]]]}}))},
  receipt:{schemaVersion:"opengeo.ftw-query.1.0.0",status:"complete",query:structuredClone(query),
    source:{partitionUrl:"https://data.source.coop/ftw/global-data/predictions/vectors/alpha/NP.parquet",license:"CC-BY-4.0",distributionVersion:"mutable-alpha",etag:'"fixture-edition"',
      attribution:"Fields of the World source attribution",citation:"Producer citation"},
    scope:{kind:"selected-country-partition-query",aoiClipped:false,wholeFootprints:true,providerCoverageVerified:false},
    counts:{candidateGroups:1,scannedRows:10,bboxMatches:count,yearMatches:count,geometryMatches:count},
    usage:{requests:8,bytes:1000,milliseconds:12},ranges:[],limits:{},limitations:["Source topology is assumed valid and was not repaired."]},
  privateClientContext:"Do not export this sibling"});
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function savedQuery() {
  const value=fixture();delete value.privateClientContext;
  Object.assign(value.receipt.source,{catalogUrl:"https://data.source.coop/ftw/global-data/catalog.json",
    collectionUrl:"https://data.source.coop/ftw/global-data/predictions/vectors/collection.json",
    itemUrl:"https://data.source.coop/ftw/global-data/predictions/vectors/alpha/admin:country_code=NP/Nepal.json",
    partitionUrl:"https://data.source.coop/ftw/global-data/predictions/vectors/alpha/admin:country_code=NP/Nepal.parquet",year:2024,sizeBytes:200000});
  value.receipt.method={id:"ftw-bbox-then-footprint"};
  Object.assign(value.geojson.features[0].properties,{id:"field-0","determination:datetime":"2024-01-01T00:00:00Z",
    "determination:method":"auto-imagery","admin:country_code":"NP","admin:subdivision_code":null,
    bbox:{xmin:85,ymin:27,xmax:85.001,ymax:27.001}});
  return value;
}
const waitFor=async predicate=>{for(let attempt=0;attempt<40;attempt++){if(predicate())return;await tick();}assert.fail("Local import did not settle");};
const chooseFile=(view,file)=>{const control=view.input("Open saved field query");Object.defineProperty(control,"files",{value:[file],configurable:true});control.dispatchEvent(new control.ownerDocument.defaultView.Event("change",{bubbles:true}));};

async function withView(options,work) {
  const dom=new JSDOM("<!doctype html><body></body>"),prior=globalThis.document;globalThis.document=dom.window.document;
  const root=FieldsOfTheWorld(options);document.body.append(root);
  const input=name=>root.querySelector(`[aria-label="${name}"]`);
  const set=(name,value,event=null)=>{const control=input(name);control.value=value;if(event)control.dispatchEvent(new dom.window.Event(event,{bubbles:true}));};
  const fill=()=>{set("Country code (two letters)","np");set("Field observation year","2024");
    for(const [name,value] of [["West longitude","85"],["South latitude","27"],["East longitude","85.001"],["North latitude","27.001"]])set(name,value);};
  const button=name=>[...root.querySelectorAll("button")].find(item=>item.textContent===name);
  const submit=()=>root.querySelector("form").dispatchEvent(new dom.window.Event("submit",{bubbles:true,cancelable:true}));
  try {await work({root,input,set,fill,button,submit,status:()=>root.querySelector('[role="status"]').textContent});}
  finally {root.dispose();globalThis.document=prior;dom.window.close();}
}

test("mount, opening and editing do not obtain a client; one deliberate search uses explicit parameters",async()=>{
  let factories=0,calls=0,received,options;const pending=deferred();
  await withView({getClient:()=>{factories++;return {search:(draft,settings)=>{calls++;received=draft;options=settings;return pending.promise;}};}},async view=>{
    assert.equal(factories,0);view.root.open=true;view.fill();view.set("Country code (two letters)","np","input");assert.equal(factories,0);
    view.submit();await tick();assert.equal(factories,1);assert.equal(calls,1);assert.deepEqual(received,query);
    assert.equal(view.button("Find fields").disabled,true);assert.equal(view.button("Cancel field search").disabled,false);
    view.submit();await tick();assert.equal(calls,1);
    options.onStatus("Reading the selected public partition…");assert.match(view.status(),/Reading the selected/);
    pending.resolve(fixture());await tick();assert.equal(view.button("Find fields").disabled,false);assert.match(view.status(),/1 field footprint returned for 2024/);
    assert.match(view.root.textContent,/not a calibrated polygon probability/);assert.match(view.root.textContent,/Source topology is assumed valid/);
    assert.match(view.root.textContent,/Source attribution/);assert.match(view.root.textContent,/1,000/);
  });
});

test("Add is deliberate and once-only; callbacks and producer mutations cannot change the retained export",async()=>{
  const original=fixture(),added=[],downloads=[];
  await withView({getClient:()=>({search:async()=>original}),onAdd:value=>{added.push(value);value.geojson.features[0].id="callback-edit";value.receipt.query.year=2025;},onDownload:value=>downloads.push(value)},async view=>{
    view.fill();view.submit();await tick();assert.equal(added.length,0);assert.equal(downloads.length,0);
    original.geojson.features[0].id="producer-edit";original.receipt.usage.bytes=9999;
    view.button("Add temporary field Layer").click();view.button("Add temporary field Layer").click();await tick();assert.equal(added.length,1);
    assert.equal(view.button("Add temporary field Layer").disabled,true);
    view.button("Download field query JSON").click();assert.equal(downloads.length,1);
    assert.equal(downloads[0].filename,"ftw-np-2024-fields.json");
    const record=JSON.parse(await downloads[0].blob.text());assert.deepEqual(Object.keys(record),["geojson","receipt"]);
    assert.equal(record.geojson.features[0].id,"field-0");assert.equal(record.receipt.query.year,2024);assert.equal(record.receipt.usage.bytes,1000);
    assert.equal(record.privateClientContext,undefined);assert.equal(record.receipt.scope.aoiClipped,false);
  });
});

test("zero matches remain downloadable and do not become an absence or coverage claim",async()=>{
  await withView({getClient:()=>({search:async()=>fixture(0)}),onAdd:()=>assert.fail("Empty Layer added"),onDownload:()=>{}},async view=>{
    view.fill();view.submit();await tick();assert.match(view.status(),/0 field footprints/);assert.match(view.status(),/does not establish that fields are absent/);
    assert.equal(view.button("Add temporary field Layer").disabled,true);assert.equal(view.button("Download field query JSON").disabled,false);
    assert.match(view.root.textContent,/Not independently verified/);
  });
});

test("Cancel aborts the request and rejects a late result or progress update without automatic retry",async()=>{
  let signal,options,calls=0;const pending=deferred();
  await withView({getClient:()=>({search:(_draft,settings)=>{calls++;signal=settings.signal;options=settings;return pending.promise;}}),onAdd:()=>{},onDownload:()=>{}},async view=>{
    view.fill();view.submit();await tick();view.button("Cancel field search").click();assert.equal(signal.aborted,true);
    options.onStatus("Stale progress");pending.resolve(fixture());await tick();assert.match(view.status(),/cancelled/);assert.doesNotMatch(view.root.textContent,/Stale progress/);
    assert.equal(view.button("Add temporary field Layer").disabled,true);assert.equal(view.button("Download field query JSON").disabled,true);assert.equal(calls,1);
  });
});

test("edits abort pending work and clear accepted results without fetching",async()=>{
  let options,calls=0;const pending=deferred();
  await withView({getClient:()=>({search:(_draft,settings)=>{calls++;options=settings;return calls===1?pending.promise:Promise.resolve(fixture());}}),onAdd:()=>{},onDownload:()=>{}},async view=>{
    view.fill();view.submit();await tick();view.set("Field observation year","2025","change");assert.equal(options.signal.aborted,true);
    pending.resolve(fixture());await tick();assert.match(view.status(),/Selection changed/);assert.equal(calls,1);
    view.set("Field observation year","2024","change");view.submit();await tick();assert.equal(calls,2);assert.equal(view.button("Download field query JSON").disabled,false);
    view.set("West longitude","85.0001","input");assert.equal(calls,2);assert.equal(view.button("Download field query JSON").disabled,true);
    assert.equal(view.root.querySelector("dl"),null);
  });
});

test("programmatic selection changes cannot export or add a stale accepted result",async()=>{
  await withView({getClient:()=>({search:async()=>fixture()}),onAdd:()=>assert.fail("Stale result added"),onDownload:()=>assert.fail("Stale result exported")},async view=>{
    view.fill();view.submit();await tick();view.set("Field observation year","2025");view.button("Download field query JSON").click();
    assert.match(view.status(),/Find fields again/);assert.equal(view.button("Add temporary field Layer").disabled,true);
  });
});

test("unsupported selections and limits give actionable text without echoing internal errors",async()=>{
  for(const [code,expected] of [["ftw_limit",/smaller rectangle/],["ftw_native_subset_required",/native subset/],["ftw_snapshot_changed",/source changed/],["ftw_invalid",/Review the selection/],["unexpected",/Fields could not be retrieved/]]) {
    let calls=0;
    await withView({getClient:()=>({search:async()=>{calls++;throw Object.assign(Error("private cryptic internals"),{code});}})},async view=>{
      view.fill();view.submit();await tick();assert.match(view.status(),expected);assert.doesNotMatch(view.status(),/private cryptic|ftw_/);assert.equal(calls,1);
    });
  }
});

test("invalid forms do not obtain a client; disposal aborts and prevents later callbacks",async()=>{
  let factories=0,signal;const pending=deferred();
  await withView({getClient:()=>{factories++;return {search:(_draft,options)=>{signal=options.signal;return pending.promise;}};},onAdd:()=>assert.fail("Disposed result added"),onDownload:()=>assert.fail("Disposed result exported")},async view=>{
    view.submit();await tick();assert.equal(factories,0);
    view.fill();view.set("East longitude","84");view.submit();await tick();assert.equal(factories,0);assert.match(view.status(),/ordered west/);
    view.fill();view.submit();await tick();assert.equal(factories,1);view.root.dispose();assert.equal(signal.aborted,true);
    pending.resolve(fixture());await tick();view.submit();assert.equal(factories,1);assert.equal(view.root.querySelector("dl"),null);
    assert.equal(view.button("Find fields").disabled,true);assert.equal(view.button("Add temporary field Layer").disabled,true);assert.equal(view.button("Download field query JSON").disabled,true);
  });
});

test("opening a saved field query restores explicit controls and uses existing Add/export without provider queries",async()=>{
  let clients=0;const added=[],downloads=[];
  await withView({getClient:()=>{clients++;throw Error("A local file must not obtain a provider client");},onAdd:value=>added.push(value),onDownload:value=>downloads.push(value)},async view=>{
    chooseFile(view,new File([JSON.stringify(savedQuery())],"retained-query.json",{type:"application/json"}));
    await waitFor(()=>!view.button("Find fields").disabled);
    assert.match(view.status(),/Opened a user-supplied saved query/);assert.match(view.status(),/No provider was contacted or reverified/);
    assert.equal(clients,0);assert.equal(added.length,0);assert.equal(view.input("Country code (two letters)").value,"NP");
    assert.equal(view.input("Field observation year").value,"2024");assert.equal(view.input("West longitude").value,"85");
    assert.match(view.root.textContent,/User-supplied local query/);view.button("Add temporary field Layer").click();await tick();assert.equal(added.length,1);
    assert.equal(added[0].receipt.localImport.providerReverified,false);
    view.button("Download field query JSON").click();const exported=JSON.parse(await downloads[0].blob.text());
    assert.equal(exported.receipt.localImport.filename,"retained-query.json");assert.match(exported.receipt.localImport.sha256,/^[a-f0-9]{64}$/);
  });
});

test("file-import edits, cancellation and disposal discard late file bytes without a provider retry",async()=>{
  const bytes=new TextEncoder().encode(JSON.stringify(savedQuery())).buffer;
  for(const departure of ["edit","cancel","dispose"]) {
    let clients=0;const pending=deferred();
    await withView({getClient:()=>{clients++;},onAdd:()=>assert.fail("Stale import added"),onDownload:()=>assert.fail("Stale import exported")},async view=>{
      chooseFile(view,{name:"delayed.json",size:bytes.byteLength,arrayBuffer:()=>pending.promise});await tick();
      if(departure==="edit")view.set("West longitude","84","input");
      else if(departure==="cancel")view.button("Cancel field search").click();else view.root.dispose();
      pending.resolve(bytes);await tick();await tick();assert.equal(clients,0);assert.equal(view.root.querySelector("dl"),null);
      assert.equal(view.button("Add temporary field Layer").disabled,true);assert.equal(view.button("Download field query JSON").disabled,true);
    });
  }
});

function confidenceQuery(scores) {
  const value=savedQuery(),original=value.geojson.features[0];
  value.geojson.features=scores.map((confidence,index)=>({...structuredClone(original),id:`field-${index}`,
    properties:{...structuredClone(original.properties),id:`field-${index}`,confidence}}));
  value.receipt.counts.geometryMatches=scores.length;
  return value;
}

test("confidence inspection retains zero, missing and exact scores; threshold review never changes the query or Add",async()=>{
  const source=confidenceQuery([0,38.25,null,100]),before=structuredClone(source),downloads=[];let calls=0,added;
  await withView({getClient:()=>({search:async()=>{calls++;return source;}}),onAdd:value=>{added=value;},onDownload:value=>downloads.push(value)},async view=>{
    view.fill();view.submit();await tick();
    const section=view.root.querySelector('.gis-field-confidence');assert(section);assert(!section.closest('form'));
    assert.equal(view.button('Download confidence JSON').disabled,true);
    view.button('Review field confidence').click();
    assert.match(section.textContent,/Threshold not selected/);assert.match(section.textContent,/Not supplied/);
    view.set('Flag scores below (optional, 0–100)','38.25','input');
    assert.equal(view.button('Download confidence JSON').disabled,true);assert.equal(view.button('Download field query JSON').disabled,false);
    view.button('Review field confidence').click();
    view.button('Download confidence JSON').click();view.button('Download confidence CSV').click();
    const report=JSON.parse(await downloads[0].blob.text());
    assert.equal(report.method.threshold,38.25);assert.equal(report.summary.scoredCount,3);assert.equal(report.summary.missingCount,1);
    assert.equal(report.summary.minScore,0);assert.equal(report.summary.maxScore,100);
    assert.equal(report.summary.belowThresholdCount,1);assert.equal(report.summary.atOrAboveThresholdCount,2);
    assert.deepEqual(report.rows.map(row=>row.sourceConfidence),[0,38.25,null,100]);
    assert.match(await downloads[1].blob.text(),/38.25/);
    view.button('Download field query JSON').click();assert.deepEqual(JSON.parse(await downloads[2].blob.text()),before);
    view.button('Add temporary field Layer').click();await tick();assert.deepEqual(added,before);assert.deepEqual(source,before);assert.equal(calls,1);
  });
});

test("saved-query confidence inspection keeps unverified local-import provenance and obtains no client",async()=>{
  const value=confidenceQuery([null]),bytes=new TextEncoder().encode(JSON.stringify(value));let factories=0,download;
  await withView({getClient:()=>{factories++;throw Error('No provider work');},onDownload:value=>{download=value;}},async view=>{
    chooseFile(view,{name:'retained-fields.json',size:bytes.length,arrayBuffer:async()=>bytes.buffer});
    await waitFor(()=>view.root.querySelector('.gis-field-confidence'));
    view.set('Flag scores below (optional, 0–100)','60','input');view.button('Review field confidence').click();
    view.button('Download confidence JSON').click();const report=JSON.parse(await download.blob.text());
    assert.equal(report.summary.scoredCount,0);assert.equal(report.summary.missingCount,1);assert.equal(report.summary.minScore,null);
    assert.equal(report.summary.belowThresholdCount,0);assert.equal(report.rows[0].sourceConfidence,null);
    assert.equal(report.sourceEvidence.localImport.providerReverified,false);assert.equal(report.sourceEvidence.localImport.filename,'retained-fields.json');
    assert.equal(factories,0);
  });
});

test("confidence exports reject changed settings and are disposed by query edits, cancellation and closure",async()=>{
  for(const departure of ['edit','cancel','dispose']){
    let calls=0,downloads=0;
    await withView({getClient:()=>({search:async()=>{calls++;return confidenceQuery([20]);}}),onDownload:()=>{downloads++;}},async view=>{
      view.fill();view.submit();await tick();view.button('Review field confidence').click();
      view.set('Flag scores below (optional, 0–100)','30');view.button('Download confidence JSON').click();
      assert.equal(downloads,0);assert.equal(view.button('Download confidence JSON').disabled,true);
      view.set('Flag scores below (optional, 0–100)','101','input');view.button('Review field confidence').click();assert.equal(view.button('Download confidence JSON').disabled,true);
      view.set('Flag scores below (optional, 0–100)','30','input');view.button('Review field confidence').click();
      const json=view.button('Download confidence JSON'),csv=view.button('Download confidence CSV');
      if(departure==='edit')view.set('West longitude','84','input');else if(departure==='cancel')view.button('Cancel field search').onclick();else view.root.dispose();
      assert.equal(json.disabled,true);assert.equal(csv.disabled,true);json.onclick();csv.onclick();assert.equal(downloads,0);assert.equal(calls,1);
    });
  }
});

test("confidence inspection pages all fields locally and leaves empty-query inspection disabled",async()=>{
  for(const count of [55,0]){
    const downloads=[];let calls=0;
    await withView({getClient:()=>({search:async()=>{calls++;return confidenceQuery(Array(count).fill(100));}}),onDownload:value=>downloads.push(value)},async view=>{
      view.fill();view.submit();await tick();
      if(!count){assert.equal(view.button('Review field confidence').disabled,true);return;}
      view.button('Review field confidence').click();const section=view.root.querySelector('.gis-field-confidence');
      assert.equal(section.querySelectorAll('tbody tr').length,25);assert.match(section.textContent,/Fields 1–25 of 55/);
      view.button('Next confidence fields').click();assert.match(section.textContent,/Fields 26–50 of 55/);
      view.button('Next confidence fields').click();assert.equal(section.querySelectorAll('tbody tr').length,5);assert.equal(view.button('Next confidence fields').disabled,true);
      view.button('Previous confidence fields').click();assert.match(section.textContent,/Fields 26–50 of 55/);
      view.button('Download confidence JSON').click();assert.equal(JSON.parse(await downloads[0].blob.text()).rows.length,55);assert.equal(calls,1);
    });
  }
});

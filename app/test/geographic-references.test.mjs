import assert from 'node:assert/strict';
import {it} from 'node:test';
import {appendPlaceReference, placeIdentity} from '../src/lib/geographicReferences.js';
it('normalizes supported place identities without fetching or accepting arbitrary provider URLs',()=>{
 assert.equal(placeIdentity('https://www.wikidata.org/wiki/Q837'),'http://www.wikidata.org/entity/Q837');
 assert.equal(placeIdentity('http://sws.geonames.org/1282988/'),'https://sws.geonames.org/1282988/');
 for(const input of ['javascript:alert(1)','https://www.wikidata.org.evil.test/wiki/Q837','https://user:secret@www.wikidata.org/wiki/Q837','https://www.wikidata.org/wiki/Q837?token=secret','https://www.wikidata.org/wiki/Q0']) assert.throws(()=>placeIdentity(input));
 const doc={metadata:{curated:[],source:[{content:' unchanged '}],normalized:[],inferred:[]}};
 const args={name:'Nepal',identity:'https://www.wikidata.org/wiki/Q837',relationship:'http://purl.org/dc/terms/spatial'};
 const next=appendPlaceReference(doc,args);assert.equal(doc.metadata.curated.length,0);assert.deepEqual(next.metadata.source,doc.metadata.source);
 assert.throws(()=>appendPlaceReference(next,args),/already recorded/);
 assert.throws(()=>appendPlaceReference(doc,{...args,relationship:'http://www.wikidata.org/prop/direct/P17'}),/Choose how/);
});

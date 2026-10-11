import assert from 'node:assert/strict';
import {it} from 'node:test';
import {explainPlaceMatch,placeMatchText} from '../src/lib/placeMatch.js';
import {PLACE_CONTEXT_METHOD} from '../src/lib/geographicReferences.js';
it('explains active tags through only their last valid retained snapshot',()=>{
 const uri=id=>'http://www.wikidata.org/entity/'+id;
 const edge=(a,b,p)=>({subject:uri(a),object:uri(b),property:'http://www.wikidata.org/prop/direct/'+p,rank:'normal'});
 const snapshot={provider:'Wikidata',item:'Q3037',relationships:[edge('Q3037','Q837','P17'),edge('Q837','Q48','P30'),edge('Q48','Q3037','P17')]};
 const claim={subject:'resource',property:'http://purl.org/dc/terms/relation',method:PLACE_CONTEXT_METHOD,value:{'@id':uri('Q3037'),'http://www.w3.org/1999/02/22-rdf-syntax-ns#value':snapshot}};
 const doc={metadata:{curated:[{subject:'resource',property:'http://purl.org/dc/terms/subject',provenance:'curator_asserted',value:{'@id':uri('Q3037')}}],normalized:[claim]}};
 assert.equal(explainPlaceMatch(doc,uri('Q3037')).path.length,0);
 const match=explainPlaceMatch(doc,uri('Q48'));assert.equal(match.path.length,2);assert.equal(placeMatchText(match).association,'Discusses this place');
 assert.equal(explainPlaceMatch(doc,uri('Q999')),null);
 const latest=structuredClone(claim);latest.value['http://www.w3.org/1999/02/22-rdf-syntax-ns#value'].relationships=[];doc.metadata.normalized.push(latest);
 assert.equal(explainPlaceMatch(doc,uri('Q48')),null);
 doc.metadata.curated=[];assert.equal(explainPlaceMatch(doc,uri('Q3037')),null);
});

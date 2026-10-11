import assert from 'node:assert/strict';
import {test} from 'node:test';
import {artifactSourceLayout,nextArtifactPath,publicationArtifactEmbed,publicArtifactEmbed,insertPublicArtifact} from '../src/lib/publicationArtifactEmbed.js';
test('saved roots and nested-page embeds preserve relative paths and avoid existing files',()=>{
 const layout=artifactSourceLayout({entryPath:'src/index.md',files:[{relativePath:'package.json'},{relativePath:'src/index.md'},{relativePath:'src/chapters/report.md'},{relativePath:'src/maps/artifact-1.html'}]});
 assert.equal(layout.root,'src');assert.equal(nextArtifactPath(layout,[{path:'src/maps/artifact-2.html'}]),'src/maps/artifact-3.html');
 assert.match(publicationArtifactEmbed(layout,'src/maps/artifact-3.html','src/chapters/report.md'),/src="\.\.\/maps\/artifact-3.html"/);
 assert.match(publicationArtifactEmbed(layout,'src/maps/artifact-3.html'),/sandbox="allow-scripts"/);
 assert.throws(()=>publicationArtifactEmbed(layout,'maps/outside.html'));
 assert.throws(()=>publicationArtifactEmbed(layout,'src/maps/evil".html'));
 const html=artifactSourceLayout({entryPath:'report/index.html',files:[{relativePath:'report/index.html'}]});
 assert.equal(nextArtifactPath(html,[]),'report/maps/artifact-1.html');
 assert.match(publicationArtifactEmbed(html,'report/maps/artifact-1.html'),/src="maps\/artifact-1.html"/);
});

test('public release links preserve identity, escape titles and reject private or capability URLs',()=>{
 const id='11111111-1111-4111-8111-111111111111';
 const url=`https://api.example.test/public/organizations/${id}/artifact-releases/${id}/view`;
 const embed=publicArtifactEmbed({url,title:'Water & <land> "map"'});
 assert.ok(embed.includes(`src="${url}"`));
 assert.match(embed,/Water &amp; &lt;land&gt; &quot;map&quot;/);
 for(const unsafe of [url+'?token=secret',url+'#secret',url.replace('https:','http:'),url.replace('/public/','/private/'),url.replace('https://','https://user:password@')]) {
  assert.throws(()=>publicArtifactEmbed({url:unsafe}));
 }
 const source='<!doctype html><body><h1>Report</h1></body>';
 const insert=insertPublicArtifact({path:'report.html',source,url});
 assert.equal(insert.insertOffset,source.indexOf('</body>'));
 assert.ok(insert.snippet.includes(url));
 assert.throws(()=>insertPublicArtifact({path:'index.html',source:'<notebook><title>Report</title></notebook>',url}));
});

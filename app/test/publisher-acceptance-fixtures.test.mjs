import assert from 'node:assert/strict';
import {test} from 'node:test';
import {acceptanceFixture} from '../scripts/publisher-acceptance-fixtures.mjs';

for (const format of ['map','framework','notebook','jupyter']) {
  test(`bounded synthetic ${format} acceptance fixture`,async()=>{
    const fixture=await acceptanceFixture(format);
    const files=new Map(fixture.files.map(file=>[file.relativePath,file.text]));
    assert.equal(files.size,fixture.files.length);
    assert.ok(files.has(fixture.entryPath));
    assert.ok(fixture.files.every(file=>Buffer.byteLength(file.text)<4_194_304));
    const prefix=fixture.entryPath.includes('/')?'src/':'';
    assert.equal(JSON.parse(files.get(prefix+'opengeo.publication.json')).format,format);
    if(format==='framework') {
      assert.equal(fixture.lockfilePath,'package-lock.json');
      assert.equal(JSON.parse(files.get('package-lock.json')).lockfileVersion,3);
      assert.ok(files.get(fixture.entryPath).includes('${total}'));
      assert.equal(fixture.files.filter(f=>f.relativePath.endsWith('.md')).length,3);
    } else if(format==='jupyter') {
      const notebook=JSON.parse(files.get(fixture.entryPath));
      assert.equal(notebook.nbformat,4);
      assert.equal(notebook.cells[1].outputs[0].text,'21\n');
    } else if(format==='notebook') {
      assert.match(files.get(fixture.entryPath),/FileAttachment/);
      assert.match(files.get(fixture.entryPath),/\$\{total\}/);
    } else {
      assert.match(files.get(fixture.entryPath),/Synthetic observations/);
      assert.ok(files.get(fixture.entryPath).includes('connect-src &#39;none&#39;'));
      assert.match(files.get(fixture.entryPath),/new maplibregl.Map/);
    }
  });
}

test('Framework consumption of view is in a downstream reactive cell',async()=>{
  const fixture=await acceptanceFixture('framework',{version:2});
  const page=fixture.files.find(file=>file.relativePath===fixture.entryPath).text;
  const cells=page.split('```js').slice(1).map(cell=>cell.split('```')[0]);
  assert.equal(cells.length,2);
  assert.ok(cells[0].includes('view(Inputs.range'));
  assert.ok(!cells[0].includes('const total'));
  assert.ok(cells[1].includes('sum(rows) * multiplier'));
});

import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

// Execute the actual repository SQL, not a rewritten approximation. This small
// schema exercises join/visibility predicates; it is not a replacement for RLS tests.
it("catalog SQL preserves project uses, layers, pagination and map-read boundaries", async () => {
  const source = await readFile(new URL("../../services/api/src/opengeo_api/layer_catalog.py", import.meta.url), "utf8");
  let index = 0;
  const sql = source.match(/"""\s+(WITH member AS[\s\S]+?)"""/)[1].replace(/%s/g, () => `$${++index}`);
  const db = new PGlite();
  const id = n => `10000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
  const [org, otherOrg, reader, restricted, outsider, a, b, c, d, dataset, foreignDataset] = Array.from({length:11}, (_, i) => id(i+1));
  try {
    await db.exec(`CREATE SCHEMA app;
      CREATE TABLE app.organization_memberships (organization_id uuid,user_id uuid,role text);
      CREATE TABLE app.projects (id uuid,organization_id uuid,name text,client_id uuid);
      CREATE TABLE app.project_memberships (project_id uuid,user_id uuid,role text);
      CREATE FUNCTION app.current_user_id() RETURNS uuid LANGUAGE sql AS $$ SELECT current_setting('app.user_id')::uuid $$;
      CREATE FUNCTION app.effective_project_role(project uuid) RETURNS text LANGUAGE sql AS $$ SELECT role FROM app.project_memberships WHERE project_id=project AND user_id=app.current_user_id() $$;
      CREATE TABLE app.datasets (id uuid,organization_id uuid,name text,description text,format text,classification text,source_type text,updated_at timestamptz,owner_user_id uuid,status text DEFAULT 'active');
      CREATE TABLE app.external_sources (organization_id uuid,dataset_id uuid,source_type text,access_mode text,credential_mode text);
      CREATE TABLE app.external_source_revisions (organization_id uuid,dataset_id uuid,version_number int,source_url text,configuration jsonb);
      CREATE TABLE app.project_datasets (dataset_id uuid,organization_id uuid,project_id uuid);
      CREATE TABLE app.dataset_permissions (dataset_id uuid,organization_id uuid,user_id uuid,role text);
      CREATE TABLE app.maps (id uuid,organization_id uuid,project_id uuid,version int,definition jsonb,status text);
      INSERT INTO app.organization_memberships VALUES ('${org}','${reader}','member'),('${org}','${restricted}','member'),('${otherOrg}','${outsider}','member');
      INSERT INTO app.projects VALUES ('${a}','${org}','A',null),('${b}','${org}','B',null),('${c}','${otherOrg}','C',null),('${d}','${org}','D',null);
      INSERT INTO app.project_memberships VALUES ('${a}','${reader}','owner'),('${b}','${reader}','owner'),('${c}','${outsider}','owner');
      INSERT INTO app.datasets VALUES ('${dataset}','${org}','Shared','Indicators','geojson','public','external',now(),null),('${foreignDataset}','${otherOrg}','Foreign','Other tenant','geojson','public','external',now(),null);
      INSERT INTO app.project_datasets VALUES ('${dataset}','${org}','${a}'),('${dataset}','${org}','${b}'),('${dataset}','${org}','${d}'),('${foreignDataset}','${otherOrg}','${c}');
      INSERT INTO app.dataset_permissions VALUES ('${dataset}','${org}','${restricted}','viewer');`);
    const layer = (title, datasetId, n=0) => ({layerId:title, title, datasetId, visible:true,
      sourceType:"arcgis-feature", sourceUrl:`https://services.example.org/arcgis/rest/services/Screening/FeatureServer/${n}`,
      sourceVersion:2, geometryType:"Polygon", style:{graduated:{field:title}}});
    for (const [i, project, organization, layers] of [[21,a,org,[layer("Heat",dataset),layer("Cancer",dataset)]],
      [22,b,org,[layer("Heat",dataset)]], [23,d,org,[layer("PrivateMap",dataset)]], [24,c,otherOrg,[layer("Foreign",foreignDataset)]]]) {
      await db.query("INSERT INTO app.maps VALUES ($1,$2,$3,2,$4,'active')", [id(i),organization,project,JSON.stringify({layers})]);
    }
    async function query(user, organization, limit=100, offset=0) {
      await db.query("SELECT set_config('app.user_id',$1,false)",[user]);
      return (await db.query(sql,[organization,user,organization,null,null,null,null,null,null,organization,null,null,limit,offset])).rows;
    }
    const rows = await query(reader,org);
    assert.equal(rows.length,3);
    assert.deepEqual(rows.map(row=>row.title),["Cancer","Heat","Heat"]);
    assert.equal(new Set(rows.map(row=>row.project_id)).size,2);
    assert.equal(rows[0].source_version,2);
    assert.equal((await query(reader,org,1,1))[0].project_id,rows[1].project_id);
    const dataOnly = await query(restricted,org);
    assert.equal(dataOnly.length,3);
    assert.ok(dataOnly.every(row=>row.map_id===null && row.provider_url===null));
    assert.deepEqual((await query(outsider,otherOrg)).map(row=>row.title),["Foreign"]);
    assert.equal((await query(outsider,org)).length,0);
    // A registered connection is discoverable without any saved-map presentation.
    const connection=id(30), url="https://services.example.org/arcgis/rest/services/Context/FeatureServer/0";
    await db.query("INSERT INTO app.datasets VALUES ($1,$2,'Context','Registered source','arcgis','internal','arcgis',now(),null)",[connection,org]);
    await db.query("INSERT INTO app.project_datasets VALUES ($1,$2,$3)",[connection,org,a]);
    await db.query("INSERT INTO app.external_sources VALUES ($1,$2,'arcgis','direct_browser','none')",[org,connection]);
    for (const [version,endpoint] of [[1,url.replace('Context','Old')],[2,url]]) {
      await db.query("INSERT INTO app.external_source_revisions VALUES ($1,$2,$3,$4,$5)",[org,connection,version,endpoint,JSON.stringify({geometry_type:"MultiPolygon"})]);
    }
    const registered=(await query(reader,org)).find(r=>r.id===connection);
    assert.equal(registered.map_id,null);assert.equal(registered.provider_url,url);
    assert.equal(registered.source_version,2);assert.equal(registered.geometry_type,"MultiPolygon");
    await db.query("INSERT INTO app.dataset_permissions VALUES ($1,$2,$3,'viewer')",[connection,org,restricted]);
    assert.equal((await query(restricted,org)).find(r=>r.id===connection).provider_url,null,"no widening of dataset-only service disclosure");
    await db.query("UPDATE app.external_sources SET credential_mode='token' WHERE dataset_id=$1",[connection]);
    assert.equal((await query(reader,org)).find(r=>r.id===connection).provider_url,null);
    await db.query("UPDATE app.external_sources SET credential_mode='none' WHERE dataset_id=$1",[connection]);
    await db.query("UPDATE app.datasets SET status='archived' WHERE id=$1",[connection]);
    assert.equal((await query(reader,org)).find(r=>r.id===connection).provider_url,null);
    // A registered revision must never replace the endpoint pinned in a saved map.
    await db.query("INSERT INTO app.external_sources VALUES ($1,$2,'arcgis','direct_browser','none')",[org,dataset]);
    await db.query("INSERT INTO app.external_source_revisions VALUES ($1,$2,99,$3,'{}')",[org,dataset,url]);
    assert.ok((await query(reader,org)).filter(r=>r.id===dataset).every(r=>r.provider_url.includes('/Screening/')));
  } finally {await db.close();}
});

import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

it("filters dataset-linked metadata using independent resource grants before pagination", async () => {
  const source=await readFile(new URL("../../services/api/src/opengeo_api/resources.py",import.meta.url),"utf8");
  const implementation=source.slice(source.indexOf("class PostgresResourceRepository"));
  const method=implementation.slice(implementation.indexOf("    async def list_dataset_resources("));
  const tail=method.match(/f"""\{self\._summary_select\(\)\}([\s\S]+?)"""/)[1];
  const select=source.slice(source.indexOf("    def _summary_select()")).match(/return """([\s\S]+?)"""/)[1];
  let n=0;const sql=(select+tail).replace(/%s/g,()=>`$${++n}`);
  const db=new PGlite();const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
  const [org,foreign,user,owner,dataset,projectA,projectB,recordA,recordB,recordC]=Array.from({length:10},(_,i)=>id(i+1));
  try {
    await db.exec(`CREATE SCHEMA app;
      CREATE TABLE app.organization_memberships(organization_id uuid,user_id uuid,role text);
      CREATE TABLE app.project_memberships(project_id uuid,user_id uuid,role text);
      CREATE FUNCTION app.effective_project_role(project uuid,person uuid) RETURNS text LANGUAGE sql AS $$ SELECT role FROM app.project_memberships WHERE project_id=project AND user_id=person $$;
      CREATE TABLE app.governed_resources(id uuid,organization_id uuid,project_id uuid,dataset_id uuid,map_id uuid,kind text,slug text,visibility text,state text,owner_user_id uuid,current_version_id uuid,created_at timestamptz,updated_at timestamptz);
      CREATE TABLE app.governed_resource_versions(id uuid,organization_id uuid,resource_id uuid,version_number int,title text,abstract text,language text,license text,attribution text,keywords text[],spatial_extent jsonb,temporal_start timestamptz,temporal_end timestamptz);
      CREATE TABLE app.governed_resource_permissions(organization_id uuid,resource_id uuid,user_id uuid,role text);
      CREATE TABLE app.governed_resource_external_identifiers(organization_id uuid,resource_id uuid,namespace text,identifier text);
      CREATE TABLE app.governed_metadata_source_documents(organization_id uuid,resource_id uuid,source_namespace text,source_identifier text,imported_at timestamptz,id uuid);
      CREATE TABLE app.governed_resource_relationships(organization_id uuid,project_id uuid,source_resource_id uuid,target_resource_id uuid);
    `);
    await db.query("INSERT INTO app.organization_memberships VALUES($1,$2,'member')",[org,user]);
    for(const [r,p,o] of [[recordA,projectA,org],[recordB,projectB,org],[recordC,projectA,foreign]]){
      await db.query("INSERT INTO app.governed_resources(id,organization_id,project_id,dataset_id,owner_user_id,current_version_id) VALUES($1,$2,$3,$4,$5,$1)",[r,o,p,dataset,owner]);
      await db.query("INSERT INTO app.governed_resource_versions(id,organization_id,resource_id,version_number,title) VALUES($1,$2,$1,1,'Retained metadata')",[r,o]);
    }
    const read=async(limit=50,offset=0)=>(await db.query(sql,[user,org,dataset,limit,offset])).rows.map(r=>r.id);
    assert.deepEqual(await read(),[],"dataset identity does not confer record authority");
    await db.query("INSERT INTO app.project_memberships VALUES($1,$2,'viewer')",[projectA,user]);
    assert.deepEqual(await read(),[recordA],"restricted sibling and foreign tenant excluded");
    await db.query("INSERT INTO app.governed_resource_permissions VALUES($1,$2,$3,'view')",[org,recordB,user]);
    assert.deepEqual(await read(),[recordA,recordB],"direct record grant works without project grant");
    assert.deepEqual(await read(1,1),[recordB]);
    await db.exec("DELETE FROM app.project_memberships; DELETE FROM app.governed_resource_permissions;");
    await db.query("UPDATE app.governed_resources SET owner_user_id=$1 WHERE id=$2",[user,recordB]);
    assert.deepEqual(await read(),[recordB]);
    await db.exec("UPDATE app.organization_memberships SET role='admin'");
    assert.deepEqual(await read(),[recordA,recordB]);
    await db.exec("DELETE FROM app.organization_memberships");
    assert.deepEqual(await read(),[],"membership withdrawal removes discovery");
  } finally {await db.close();}
});

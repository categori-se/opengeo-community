import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

it("canonical resource SQL and metadata revisions preserve identity, history and account boundaries", async () => {
  const db = new PGlite();
  const id = n => `10000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
  const [org, otherOrg, reader, outsider, projectA, projectB, dataset, foreignDataset] = Array.from({length:8},(_,i)=>id(i+1));
  const source = await readFile(new URL("../../services/api/src/opengeo_api/ingestion.py", import.meta.url), "utf8");
  const selector = source.slice(source.indexOf("    def _dataset_select("), source.indexOf("    @staticmethod\n    def _dataset("))
    .match(/return f"""([\s\S]+?)"""/)[1].replace("{project_relation}", "app.project_datasets project_dataset").replace("'{{}}'", "'{}'");
  const load = source.slice(source.indexOf("    async def _load_catalog_dataset("),source.indexOf("    async def get_dataset_knowledge(",source.indexOf("class PostgresIngestionRepository")));
  let n=0;
  const query = load.match(/f"""\{self\._dataset_select\(\)\}([\s\S]+?)"""/)[1];
  const sql=(selector+query).replace(/%s/g,()=>`$${++n}`);
  try {
    await db.exec(`CREATE SCHEMA app;
      CREATE ROLE opengeo_runtime NOLOGIN; CREATE ROLE opengeo_worker NOLOGIN;
      GRANT USAGE ON SCHEMA app TO opengeo_runtime;
      CREATE TABLE app.users (id uuid PRIMARY KEY);
      CREATE TABLE app.datasets (id uuid, organization_id uuid, name text, description text,
        classification text, source_type text, format text, status text, owner_user_id uuid,
        current_version_id uuid,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),
        UNIQUE (organization_id,id));
      CREATE TABLE app.project_datasets (organization_id uuid,project_id uuid,dataset_id uuid);
      CREATE TABLE app.dataset_versions (organization_id uuid,dataset_id uuid,id uuid,version_number int,
        state text,feature_count int,extent float[],crs text,geometry_type text,quality_results jsonb);
      CREATE TABLE app.processing_jobs (organization_id uuid,dataset_version_id uuid,job_type text,state text,error_code text);
      CREATE TABLE app.dataset_tags (organization_id uuid,dataset_id uuid,tag_id uuid);
      CREATE TABLE app.tags (organization_id uuid,id uuid,name text);
      CREATE TABLE app.dataset_permissions (organization_id uuid,dataset_id uuid,user_id uuid,role text);
      CREATE TABLE app.project_memberships (project_id uuid,user_id uuid,role text);
      CREATE FUNCTION app.current_user_id() RETURNS uuid LANGUAGE sql AS $$ SELECT current_setting('app.user_id')::uuid $$;
      CREATE FUNCTION app.current_organization_id() RETURNS uuid LANGUAGE sql AS $$ SELECT current_setting('app.organization_id')::uuid $$;
      CREATE FUNCTION app.effective_project_role(project uuid) RETURNS text LANGUAGE sql AS $$ SELECT role FROM app.project_memberships WHERE project_id=project AND user_id=app.current_user_id() $$;
    `);
    const governed=await readFile(new URL("../migrations/0009_governed_resources.sql",import.meta.url),"utf8");
    await db.exec(governed.match(/CREATE FUNCTION app.reject_governed_resource_history_mutation\(\)[\s\S]+?\$\$;/)[0]);
    await db.exec(await readFile(new URL("../migrations/0105_dataset_knowledge.sql",import.meta.url),"utf8"));
    for (const user of [reader,outsider]) await db.query("INSERT INTO app.users VALUES ($1)",[user]);
    for (const [resource,account] of [[dataset,org],[foreignDataset,otherOrg]]) {
      await db.query("INSERT INTO app.datasets(id,organization_id,name) VALUES($1,$2,'Boundaries')",[resource,account]);
    }
    for (const project of [projectA,projectB]) await db.query("INSERT INTO app.project_datasets VALUES($1,$2,$3)",[org,project,dataset]);
    await db.query("INSERT INTO app.project_memberships VALUES($1,$2,'viewer')",[projectB,reader]);
    await db.query("SELECT set_config('app.user_id',$1,false),set_config('app.organization_id',$2,false)",[reader,org]);
    let result=await db.query(sql,[org,dataset,false]);
    assert.equal(result.rows.length,1);
    assert.equal(result.rows[0].id,dataset);assert.equal(result.rows[0].project_id,projectB,"selects accessible use, not creator link");
    assert.equal((await db.query(sql,[org,foreignDataset,false])).rows.length,0);
    await db.query("SELECT set_config('app.user_id',$1,false)",[outsider]);
    assert.equal((await db.query(sql,[org,dataset,false])).rows.length,0);
    await db.query("INSERT INTO app.dataset_permissions VALUES($1,$2,$3,'view')",[org,dataset,outsider]);
    assert.equal((await db.query(sql,[org,dataset,false])).rows[0].id,dataset,"explicit dataset grant works without map membership");
    const original=' {"nested": {"population": 42}}\n';
    const document={schemaVersion:"1.0.0",distributions:[],metadata:{source:[{content:original}],normalized:[],curated:[],inferred:[]},context:[]};
    await db.exec("SET ROLE opengeo_runtime");
    for (const version of [1,2]) await db.query("INSERT INTO app.dataset_knowledge_revisions(organization_id,dataset_id,version_number,document,created_by) VALUES($1,$2,$3,$4,$5)",[org,dataset,version,JSON.stringify(document),reader]);
    await assert.rejects(db.query("INSERT INTO app.dataset_knowledge_revisions(organization_id,dataset_id,version_number,document,created_by) VALUES($1,$2,1,$3,$4)",[org,dataset,JSON.stringify(document),reader]),/unique|duplicate/);
    assert.equal((await db.query("SELECT document FROM app.dataset_knowledge_revisions WHERE version_number=1")).rows[0].document.metadata.source[0].content,original);
    await assert.rejects(db.exec("DELETE FROM app.dataset_knowledge_revisions"),/permission denied/);
    await db.query("SELECT set_config('app.organization_id',$1,false)",[otherOrg]);
    assert.equal((await db.query("SELECT * FROM app.dataset_knowledge_revisions")).rows.length,0);
    await assert.rejects(db.query("INSERT INTO app.dataset_knowledge_revisions(organization_id,dataset_id,version_number,document,created_by) VALUES($1,$2,3,$3,$4)",[org,dataset,JSON.stringify(document),reader]),/row-level security/);
    await db.exec("RESET ROLE");
    await assert.rejects(db.exec("UPDATE app.dataset_knowledge_revisions SET version_number=9"),/immutable/);
    await db.query("DELETE FROM app.project_datasets WHERE project_id=$1",[projectA]);
    assert.equal((await db.query("SELECT count(*)::int AS total FROM app.dataset_knowledge_revisions")).rows[0].total,2,"knowledge survives removal of a project reference");
  } finally {await db.close();}
});

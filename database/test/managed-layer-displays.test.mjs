import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';

test('reviewed displays retain workspace RLS, exact-origin FKs and no runtime write grant',async()=>{
 const db=new PGlite();
 const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
 const [org,foreign,project,otherProject,dataset,version,user]=Array.from({length:7},(_,i)=>id(i+1));
 try{
  await db.exec(`CREATE SCHEMA app; CREATE ROLE opengeo_runtime; CREATE ROLE opengeo_worker;
   CREATE TABLE app.users(id uuid PRIMARY KEY);
   CREATE TABLE app.projects(organization_id uuid,id uuid,PRIMARY KEY(organization_id,id));
   CREATE TABLE app.external_source_revisions(organization_id uuid,dataset_id uuid,version_number bigint,PRIMARY KEY(organization_id,dataset_id,version_number));
   CREATE TABLE app.dataset_versions(organization_id uuid,dataset_id uuid,id uuid,PRIMARY KEY(organization_id,dataset_id,id));
   CREATE FUNCTION app.current_organization_id() RETURNS uuid LANGUAGE sql AS $$ SELECT current_setting('app.org')::uuid $$;
   CREATE FUNCTION app.effective_project_role(project uuid) RETURNS text LANGUAGE sql AS $$ SELECT CASE WHEN project=current_setting('app.project')::uuid THEN 'editor' END $$;
   INSERT INTO app.users VALUES('${user}');
   INSERT INTO app.projects VALUES('${org}','${project}'),('${org}','${otherProject}'),('${foreign}','${project}');
   INSERT INTO app.external_source_revisions VALUES('${org}','${dataset}',1);
   INSERT INTO app.dataset_versions VALUES('${org}','${dataset}','${version}'),('${foreign}','${dataset}','${version}');
   GRANT USAGE ON SCHEMA app TO opengeo_runtime;`);
  for(const migration of ['0135_layer_archive_distributions.sql','0136_archive_unknown_capture_time.sql','0138_managed_layer_displays.sql']){
   await db.exec(await readFile(new URL(`../migrations/${migration}`,import.meta.url),'utf8'));
  }
  const insert=async(n,{tenant=org,scope=project,revision=null,saved=version,enabled=true}={})=>db.query(
   'INSERT INTO app.layer_archive_distributions(organization_id,project_id,dataset_id,source_version,dataset_version_id,id,title,descriptor,enabled,reviewed_by) VALUES($1,$2,$3,$4,$5,$6,\'display\',\'{}\',$7,$8)',
   [tenant,scope,dataset,revision,saved,id(n),enabled,user]);
  await insert(10);await insert(11,{enabled:false});await insert(12,{scope:otherProject});await insert(13,{tenant:foreign});
  await insert(14,{saved:null,revision:1});
  await assert.rejects(insert(15,{saved:null}),/layer_archive_exact_origin/);
  await assert.rejects(insert(16,{revision:1}),/layer_archive_exact_origin/);
  await assert.rejects(insert(17,{saved:id(99)}),/layer_archive_managed_version/);
  await db.query("SELECT set_config('app.org',$1,false),set_config('app.project',$2,false)",[org,project]);
  await db.exec('SET ROLE opengeo_runtime');
  const rows=(await db.query('SELECT id,source_version,dataset_version_id FROM app.layer_archive_distributions ORDER BY id')).rows;
  assert.deepEqual(rows.map(r=>r.id),[id(10),id(14)]);
  assert.equal(rows[0].dataset_version_id,version);
  assert.equal(rows[1].dataset_version_id,null);
  await assert.rejects(db.exec('UPDATE app.layer_archive_distributions SET enabled=true'),/permission denied/);
  await assert.rejects(db.exec('DELETE FROM app.layer_archive_distributions'),/permission denied/);
 }finally{await db.close();}
});

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';

// Execute the actual migration trigger in isolation; existing RLS is unchanged.
test('pending upload renewal preserves its seal and terminal transitions', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE SCHEMA app;
      CREATE TABLE app.upload_intents (
        id text, organization_id text, project_id text, dataset_id text, created_by text,
        original_filename text, content_type text, expected_size_bytes bigint,
        expected_sha256 text, bucket text, object_key text, staged_base_version_id text,
        created_at timestamptz, expires_at timestamptz, completed_at timestamptz,
        completed_object_id text, state text, purpose text NOT NULL DEFAULT 'ingest');
      INSERT INTO app.upload_intents VALUES ('upload','org','project','dataset','user',
        'notes.pdf','application/pdf',5,'checksum','bucket','key',NULL,
        now()-interval '2 days',now()-interval '1 day',NULL,NULL,'pending','ingest');`);
    await db.exec(await readFile(new URL('../migrations/0150_upload_intent_renewal.sql', import.meta.url), 'utf8'));
    const preservation = await readFile(new URL('../migrations/0173_preserved_pmtiles_originals.sql', import.meta.url), 'utf8');
    await db.exec('CREATE FUNCTION app.enforce_upload_intent_purpose()' + preservation.split('CREATE FUNCTION app.enforce_upload_intent_purpose()')[1].split('CREATE TRIGGER upload_intent_purpose_immutable')[0]);
    await db.exec(`CREATE TRIGGER upload_intents_enforce_transition BEFORE UPDATE ON app.upload_intents
      FOR EACH ROW EXECUTE FUNCTION app.enforce_upload_intent_transition();
      CREATE TRIGGER upload_intent_purpose_immutable BEFORE UPDATE ON app.upload_intents
      FOR EACH ROW EXECUTE FUNCTION app.enforce_upload_intent_purpose();
      UPDATE app.upload_intents SET expires_at=clock_timestamp()+interval '15 minutes';`);
    for (const mutation of ["object_key='other'", "expected_sha256='other'", "dataset_id='other'",
      "purpose='pmtiles_original'",
      "staged_base_version_id='other'", "completed_object_id='other'", "expires_at=now()-interval '1 day'",
      "expires_at=now()+interval '2 hours'"]) {
      await assert.rejects(db.exec(`UPDATE app.upload_intents SET ${mutation}`), /immutable|forward-only/);
    }
    await db.exec(`UPDATE app.upload_intents SET state='completed',completed_at=now(),completed_object_id='object';`);
    await assert.rejects(db.exec(`UPDATE app.upload_intents SET expires_at=now()+interval '30 minutes'`), /forward-only/);
    assert.equal((await db.query('SELECT object_key FROM app.upload_intents')).rows[0].object_key, 'key');
  } finally {await db.close();}
});

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {it} from 'node:test';
import {PGlite} from '@electric-sql/pglite';

it('migration 0098 preserves Markdown entries and admits only safe static home entries', async () => {
  const original = await readFile(new URL('../migrations/0045_observable_source_projects.sql', import.meta.url), 'utf8');
  const validator = original.match(/CREATE FUNCTION app\.observable_source_path_is_safe\(p_path text\)[\s\S]*?\$\$;/)[0];
  const head = (await readFile(new URL('../migrations/0087_observable_revision_data_bindings.sql', import.meta.url), 'utf8'))
    .match(/CREATE OR REPLACE FUNCTION app\.enforce_observable_source_project_head\(\)[\s\S]*?\$\$;/)[0];
  const migration = await readFile(new URL('../migrations/0098_static_html_publication_entries.sql', import.meta.url), 'utf8');
  const db = new PGlite();
  try {
    // Isolate the changed constraint, using the actual path validator and migration.
    // Other table constraints, authorization and RLS are covered separately.
    await db.exec(`CREATE SCHEMA app; ${validator}
      CREATE TABLE app.observable_source_revisions(entry_path text NOT NULL, lockfile_path text,
        CONSTRAINT observable_source_revisions_paths_safe CHECK (entry_path ~* '\\.md$'));
      INSERT INTO app.observable_source_revisions VALUES ('src/index.md','package-lock.json'); ${head}`);
    await db.exec(migration);
    for (const path of ['index.html', 'pages/index.html', 'src/analysis.md']) {
      await db.query('INSERT INTO app.observable_source_revisions VALUES ($1, null)', [path]);
    }
    for (const [path, lock] of [['../index.html', null], ['dist/index.html', null], ['page.html', null], ['index.html','package-lock.json']]) {
      await assert.rejects(db.query('INSERT INTO app.observable_source_revisions VALUES ($1,$2)', [path,lock]), /observable_source_revisions_paths_safe/);
    }
    assert.equal((await db.query('SELECT count(*)::int AS count FROM app.observable_source_revisions')).rows[0].count, 4);
  } finally {await db.close();}
});

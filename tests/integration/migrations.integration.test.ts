import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { getTableName, is } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from '../../packages/core/src/schema.js';

// Stage 01 item 1.05: the committed migration, the Drizzle schema, the journal and the snapshot
// must describe the same database. Nothing here touches the project database: every test creates
// and drops its own fresh database on the PostgreSQL named by DATABASE_URL.

const root = fileURLToPath(new URL('../..', import.meta.url));
const migrationsFolder = join(root, 'migrations');
const baseline = '0000_initial_schema';

type Journal = {
  version: string;
  dialect: string;
  entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
};
type Snapshot = { id: string; prevId: string; version: string; dialect: string };

const tables = Object.values(schema as Record<string, unknown>).filter((value): value is PgTable =>
  is(value, PgTable),
);

async function freshDatabase<T>(run: (pool: pg.Pool) => Promise<T>) {
  const configured = process.env.DATABASE_URL;
  assert.ok(configured, 'Integration tests require DATABASE_URL');
  const url = new URL(configured);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'Tests require local PostgreSQL');
  const admin = new pg.Pool({ connectionString: configured, max: 1 });
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.href, max: 2 });
  try {
    return await run(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE "${name}"`);
    await admin.end();
  }
}

async function readJson<T>(path: string) {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

/** Applies the committed SQL exactly as written, statement by statement, without the Drizzle migrator. */
async function applyBaseline(pool: pg.Pool) {
  const sql = await readFile(join(migrationsFolder, `${baseline}.sql`), 'utf8');
  const statements = sql
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean);
  assert.ok(statements.length > 0);
  for (const statement of statements) await pool.query(statement);
  return statements.length;
}

/** PostgreSQL truncates identifiers to 63 bytes, so generated names longer than that are stored cut. */
const identifier = (name: string) => name.slice(0, 63);

const normaliseType = (type: string) =>
  type
    .replace(/^character varying/, 'varchar')
    .replace(/^bigserial$/, 'bigint')
    .replace(/^serial$/, 'integer')
    .replace(/\s+/g, ' ')
    .trim();

test('the Drizzle schema declares a full set of uniquely named tables', () => {
  assert.ok(tables.length >= 25, `expected the full schema, found ${tables.length} tables`);
  const names = tables.map((table) => getTableName(table));
  assert.equal(new Set(names).size, names.length, 'table names must be unique');
});

test('migrations/0000_initial_schema.sql applies to a fresh database and matches schema.ts', async () => {
  await freshDatabase(async (pool) => {
    await applyBaseline(pool);

    const present = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const actualTables = new Set(present.rows.map((row) => row.table_name));
    const expectedTables = new Set(tables.map((table) => getTableName(table)));
    assert.deepEqual(
      [...expectedTables].filter((name) => !actualTables.has(name)),
      [],
      'every table in schema.ts must exist after the migration',
    );
    assert.deepEqual(
      [...actualTables].filter((name) => !expectedTables.has(name)),
      [],
      'the migration must not create tables that schema.ts does not declare',
    );

    for (const table of tables) {
      const config = getTableConfig(table);
      const name = config.name;

      const columns = await pool.query<{ name: string; type: string; notnull: boolean }>(
        `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull
         FROM pg_attribute a WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped`,
        [`public.${name}`],
      );
      const actual = new Map(columns.rows.map((row) => [row.name, row]));
      assert.deepEqual(
        [...actual.keys()].sort(),
        config.columns.map((column) => column.name).sort(),
        `${name}: column set`,
      );
      for (const column of config.columns) {
        const live = actual.get(column.name)!;
        assert.equal(
          normaliseType(live.type),
          normaliseType(column.getSQLType()),
          `${name}.${column.name}: type`,
        );
        // A primary key column is NOT NULL in the database even when the builder omits it.
        assert.equal(
          live.notnull,
          column.notNull || column.primary,
          `${name}.${column.name}: nullability`,
        );
      }

      const indexes = await pool.query<{ name: string; is_unique: boolean }>(
        `SELECT c.relname AS name, i.indisunique AS is_unique
         FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
         WHERE i.indrelid = $1::regclass AND NOT i.indisprimary`,
        [`public.${name}`],
      );
      const declaredIndexes = config.indexes.map((index) => index.config);
      // Column-level .unique() lives on the column, table-level unique() on the config.
      const declaredUniques = [
        ...config.uniqueConstraints.map((constraint) => constraint.name ?? constraint.getName()),
        ...config.columns
          .filter((column) => column.isUnique)
          .map((column) => column.uniqueName ?? `${name}_${column.name}_unique`),
      ];
      for (const index of declaredIndexes) {
        const live = indexes.rows.find((row) => row.name === identifier(index.name ?? ''));
        assert.ok(live, `${name}: index ${index.name} must exist`);
        assert.equal(
          live.is_unique,
          Boolean(index.unique),
          `${name}: index ${index.name} uniqueness`,
        );
      }
      for (const unique of declaredUniques) {
        assert.ok(
          indexes.rows.some((row) => row.name === identifier(unique ?? '') && row.is_unique),
          `${name}: unique constraint ${unique} must exist`,
        );
      }
      assert.equal(
        indexes.rows.length,
        declaredIndexes.length + declaredUniques.length,
        `${name}: the database has an index schema.ts does not declare`,
      );

      const constraints = await pool.query<{ name: string; type: string }>(
        `SELECT conname AS name, contype AS type FROM pg_constraint WHERE conrelid = $1::regclass`,
        [`public.${name}`],
      );
      for (const foreignKey of config.foreignKeys) {
        const fkName = identifier(foreignKey.getName());
        assert.ok(
          constraints.rows.some((row) => row.name === fkName && row.type === 'f'),
          `${name}: foreign key ${fkName} must exist`,
        );
      }
      assert.equal(
        constraints.rows.filter((row) => row.type === 'f').length,
        config.foreignKeys.length,
        `${name}: foreign key count`,
      );
      for (const check of config.checks) {
        assert.ok(
          constraints.rows.some((row) => row.name === identifier(check.name) && row.type === 'c'),
          `${name}: check constraint ${check.name} must exist`,
        );
      }
      assert.equal(
        constraints.rows.filter((row) => row.type === 'c').length,
        config.checks.length,
        `${name}: check constraint count`,
      );
      const hasPrimaryKey =
        config.primaryKeys.length > 0 || config.columns.some((column) => column.primary);
      assert.equal(
        constraints.rows.some((row) => row.type === 'p'),
        hasPrimaryKey,
        `${name}: primary key presence`,
      );
    }
  });
});

test('drizzle-orm migrate() on a fresh database records exactly the journal entries and is repeatable', async () => {
  const journal = await readJson<Journal>(join(migrationsFolder, 'meta', '_journal.json'));
  await freshDatabase(async (pool) => {
    const db = drizzle({ client: pool, schema });
    await migrate(db, { migrationsFolder });
    await migrate(db, { migrationsFolder });
    const applied = await pool.query<{ count: string }>(
      'SELECT count(*) FROM drizzle.__drizzle_migrations',
    );
    assert.equal(Number(applied.rows[0]!.count), journal.entries.length);
    const present = await pool.query<{ count: string }>(
      `SELECT count(*) FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    assert.equal(Number(present.rows[0]!.count), tables.length);
  });
});

test('schema.ts produces no diff against the committed snapshot', async () => {
  const snapshots = (await readdir(join(migrationsFolder, 'meta')))
    .filter((file) => file.endsWith('_snapshot.json'))
    .sort();
  const latest = snapshots.at(-1);
  assert.ok(latest, 'a snapshot must exist');
  const previous = await readJson<Snapshot>(join(migrationsFolder, 'meta', latest));
  const current = generateDrizzleJson(schema, previous.id);
  const statements = await generateMigration(
    previous as unknown as Parameters<typeof generateMigration>[0],
    current,
  );
  assert.deepEqual(
    statements,
    [],
    'schema.ts differs from the latest snapshot: run npm run db:generate and commit the migration',
  );
});

test('drizzle-kit check passes', () => {
  const result = spawnSync(
    process.execPath,
    [join(root, 'node_modules', 'drizzle-kit', 'bin.cjs'), 'check'],
    { cwd: root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Everything/);
});

test('journal, SQL files and snapshots are consistent', async () => {
  const journal = await readJson<Journal>(join(migrationsFolder, 'meta', '_journal.json'));
  assert.equal(journal.dialect, 'postgresql');
  assert.ok(journal.entries.length >= 1);
  journal.entries.forEach((entry, index) => {
    assert.equal(entry.idx, index, 'journal indexes are contiguous from zero');
    assert.equal(entry.version, journal.version);
    assert.equal(entry.breakpoints, true);
    assert.match(entry.tag, new RegExp(`^${String(index).padStart(4, '0')}_[a-z0-9_]+$`));
    if (index > 0) {
      assert.ok(entry.when > journal.entries[index - 1]!.when, 'journal timestamps increase');
    }
  });
  assert.equal(journal.entries[0]!.tag, baseline);

  const files = await readdir(migrationsFolder);
  const sqlFiles = files.filter((file) => file.endsWith('.sql')).sort();
  assert.deepEqual(
    sqlFiles,
    journal.entries.map((entry) => `${entry.tag}.sql`),
    'every SQL file is journalled and every journal entry has a SQL file',
  );
  const snapshotFiles = (await readdir(join(migrationsFolder, 'meta')))
    .filter((file) => file.endsWith('_snapshot.json'))
    .sort();
  assert.deepEqual(
    snapshotFiles,
    journal.entries.map((entry) => `${entry.tag.slice(0, 4)}_snapshot.json`),
    'every journal entry has exactly one snapshot',
  );

  let previousId = '00000000-0000-0000-0000-000000000000';
  const seen = new Set<string>();
  for (const file of snapshotFiles) {
    const snapshot = await readJson<Snapshot>(join(migrationsFolder, 'meta', file));
    assert.equal(snapshot.version, journal.version, `${file}: version`);
    assert.equal(snapshot.dialect, journal.dialect, `${file}: dialect`);
    assert.equal(snapshot.prevId, previousId, `${file}: prevId must chain from the previous one`);
    assert.ok(!seen.has(snapshot.id), `${file}: snapshot ids are unique`);
    seen.add(snapshot.id);
    previousId = snapshot.id;
  }
});

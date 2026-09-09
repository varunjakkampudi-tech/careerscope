/**
 * The database handle.
 *
 * ## Why `node:sqlite` and not better-sqlite3 + Drizzle
 *
 * The plan called for better-sqlite3 with Drizzle; this uses Node's built-in
 * `node:sqlite` instead. Three reasons, in order of weight:
 *
 *  1. **No native build step.** better-sqlite3 compiles against the running
 *     Node ABI. On EC2 that means a compiler in the image, and a rebuild every
 *     time Node is upgraded — a deploy that fails at `npm ci` on a box you are
 *     ssh'd into at the time. `node:sqlite` is in the runtime already.
 *  2. **The query surface is small.** Eight tables and roughly thirty
 *     statements, most of them a `SELECT` by primary key. Drizzle earns its
 *     keep on a schema with dozens of joins; here it would add a codegen step
 *     and a second dialect to learn for type-safety that `parse()` on the way
 *     out already provides — every row goes through its Zod schema anyway.
 *  3. **One less dependency in the supply chain** for a personal app holding a
 *     resume and a set of API keys.
 *
 * The cost is real and worth stating: no compile-time checking of SQL, and no
 * ready-made migration tooling. The first is mitigated by every read going
 * through a Zod parse (`repo/*.ts`), so a column rename fails loudly in tests.
 * The second is deferred honestly — `user_version` is set below so the first
 * real migration knows what it is starting from.
 *
 * ## Concurrency
 *
 * `DatabaseSync` is synchronous and this process is single-threaded, so no two
 * statements can interleave; there is no connection pool to reason about. WAL is
 * on so the search worker writing leads never blocks a request reading them.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';

export type Row = Record<string, SQLOutputValue>;
export type Params = Record<string, SQLInputValue>;

/**
 * `node:sqlite` throws on `undefined` rather than treating it as NULL — a real
 * trap, because an optional field that is simply absent is the common case and
 * the error names only a parameter index. Everything on the way in goes through
 * here.
 */
export function bind(params: Record<string, unknown>): Params {
  const out: Params = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) {
      out[key] = null;
    } else if (typeof value === 'boolean') {
      out[key] = value ? 1 : 0;
    } else if (value instanceof Date) {
      out[key] = value.toISOString();
    } else if (typeof value === 'object') {
      // Arrays and plain objects are stored as JSON text; see schema.ts.
      out[key] = JSON.stringify(value);
    } else {
      out[key] = value as SQLInputValue;
    }
  }
  return out;
}

export class Db {
  readonly raw: DatabaseSync;
  /** Prepared statements are reused; SQLite's own cache does not cross handles. */
  readonly #statements = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  #txDepth = 0;

  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);

    // WAL lets the search worker append leads while a request reads them.
    // NORMAL synchronous is the standard WAL pairing: a crash can lose the last
    // transaction, which for a re-runnable job search is an acceptable trade
    // against fsync on every write.
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA synchronous = NORMAL');
    this.raw.exec('PRAGMA foreign_keys = ON');
    // Without this, a run holding a write while a request writes a lead status
    // fails instantly rather than waiting the moment it takes to clear.
    this.raw.exec('PRAGMA busy_timeout = 5000');
  }

  #prepare(sql: string) {
    const cached = this.#statements.get(sql);
    if (cached) return cached;
    const statement = this.raw.prepare(sql);
    this.#statements.set(sql, statement);
    return statement;
  }

  all(sql: string, params: Record<string, unknown> = {}): Row[] {
    return this.#prepare(sql).all(bind(params));
  }

  get(sql: string, params: Record<string, unknown> = {}): Row | undefined {
    return this.#prepare(sql).get(bind(params));
  }

  run(sql: string, params: Record<string, unknown> = {}): { changes: number } {
    const result = this.#prepare(sql).run(bind(params));
    return { changes: Number(result.changes) };
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /**
   * Runs `fn` in a transaction, rolling back if it throws.
   *
   * Nesting uses SAVEPOINT rather than failing, because the callers that need a
   * transaction — writing a run's leads, updating a batch of statuses — are the
   * same ones most likely to be composed with each other later.
   */
  tx<T>(fn: () => T): T {
    const depth = this.#txDepth;
    const name = `sp_${depth}`;
    this.raw.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${name}`);
    this.#txDepth = depth + 1;
    try {
      const result = fn();
      this.raw.exec(depth === 0 ? 'COMMIT' : `RELEASE ${name}`);
      return result;
    } catch (error) {
      // Best-effort: if the rollback itself fails the original error is the one
      // worth surfacing, so it is rethrown regardless.
      try {
        this.raw.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}`);
      } catch {
        /* the connection is already broken; the throw below says why */
      }
      throw error;
    } finally {
      this.#txDepth = depth;
    }
  }

  close(): void {
    this.#statements.clear();
    // Collapses the WAL back into the main file, so a copied database file is
    // complete on its own — which is what makes "back it up with cp" true.
    try {
      this.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      /* nothing to checkpoint */
    }
    this.raw.close();
  }
}

/** Applies the DDL and stamps the schema version. Safe to call on every boot. */
export function migrate(db: Db): { from: number; to: number } {
  const row = db.get('PRAGMA user_version');
  const from = Number(row?.['user_version'] ?? 0);

  db.exec(SCHEMA_SQL);
  // Interpolated because PRAGMA does not accept a bound parameter. The value is
  // a module constant, never user input.
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);

  return { from, to: SCHEMA_VERSION };
}

export function openDatabase(path: string): Db {
  const db = new Db(path);
  migrate(db);
  return db;
}

/* -------------------------------------------------------------------------- */
/* Row helpers                                                                */
/* -------------------------------------------------------------------------- */

/**
 * One column of one row.
 *
 * `undefined` is in the union because `noUncheckedIndexedAccess` is on and
 * `row['typo']` is a real mistake to make — an alias renamed in the SELECT but
 * not in the mapper. Every helper treats it exactly like NULL, which turns that
 * mistake into a Zod parse failure naming the field rather than a crash on
 * `undefined.toString()` three frames away.
 */
export type Cell = SQLOutputValue | undefined;

/**
 * SQLite has no boolean type, so a column written as `1` reads back as the
 * number `1`. Every `INTEGER NOT NULL DEFAULT 0` flag column comes through here.
 */
export function toBool(value: Cell): boolean {
  return value === 1 || value === 1n;
}

export function toStringOrNull(value: Cell): string | null {
  return typeof value === 'string' ? value : null;
}

export function toNumberOrNull(value: Cell): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return null;
}

export function toText(value: Cell): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Parses a JSON column. A row that fails to parse is a bug in whatever wrote
 * it, so the error names the column rather than letting `JSON.parse`'s
 * "Unexpected token" surface with no context.
 */
export function fromJson<T>(value: Cell, column: string): T {
  if (typeof value !== 'string') {
    throw new Error(
      `Column "${column}" is ${value === undefined ? 'missing' : typeof value}, expected JSON text`,
    );
  }
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Column "${column}" holds invalid JSON: ${reason}`);
  }
}

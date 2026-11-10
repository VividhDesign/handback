import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { env, ROOT } from './env.ts';

mkdirSync(env.DATA_DIR, { recursive: true });
mkdirSync(path.join(env.DATA_DIR, 'photos'), { recursive: true });

export const db = new DatabaseSync(process.env.DB_PATH ?? path.join(env.DATA_DIR, 'handback.db'));
db.exec(readFileSync(path.join(ROOT, 'server', 'schema.sql'), 'utf8'));

export type Row = Record<string, any>;

export function all<T = Row>(sql: string, ...params: any[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}
export function get<T = Row>(sql: string, ...params: any[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}
export function run(sql: string, ...params: any[]) {
  return db.prepare(sql).run(...params);
}

let depth = 0;
/** Runs fn in one SQLite transaction (nested calls join the outer one). */
export function tx<T>(fn: () => T): T {
  if (depth > 0) return fn();
  depth++;
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    depth--;
  }
}

export const nowISO = () => new Date().toISOString();

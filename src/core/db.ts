import { DatabaseSync, type StatementSync, type SQLInputValue } from 'node:sqlite'

const MIGRATIONS: string[] = [
  `
  CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE accounts(
    id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL,
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    secret TEXT,
    config TEXT NOT NULL DEFAULT '{}',
    state TEXT NOT NULL DEFAULT 'new',
    error TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE folders(
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    role TEXT NOT NULL,
    uidvalidity TEXT,
    uidnext INTEGER,
    synced_at INTEGER,
    UNIQUE(account_id, path)
  );

  CREATE TABLE threads(
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    subject TEXT NOT NULL DEFAULT '',
    snippet TEXT NOT NULL DEFAULT '',
    last_date INTEGER NOT NULL DEFAULT 0,
    bump_date INTEGER,
    from_name TEXT NOT NULL DEFAULT '',
    from_addr TEXT NOT NULL DEFAULT '',
    participants TEXT NOT NULL DEFAULT '[]',
    msg_count INTEGER NOT NULL DEFAULT 0,
    unread_count INTEGER NOT NULL DEFAULT 0,
    starred INTEGER NOT NULL DEFAULT 0,
    has_attachments INTEGER NOT NULL DEFAULT 0,
    in_inbox INTEGER NOT NULL DEFAULT 0,
    in_sent INTEGER NOT NULL DEFAULT 0,
    is_list INTEGER NOT NULL DEFAULT 0,
    has_invite INTEGER NOT NULL DEFAULT 0,
    is_automated INTEGER NOT NULL DEFAULT 0,
    snoozed_until INTEGER,
    reminded INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX threads_inbox ON threads(in_inbox, last_date);

  CREATE TABLE thread_refs(
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    msgid TEXT NOT NULL,
    thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    PRIMARY KEY(account_id, msgid)
  ) WITHOUT ROWID;
  CREATE INDEX thread_refs_thread ON thread_refs(thread_id);

  CREATE TABLE messages(
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    refs TEXT NOT NULL DEFAULT '[]',
    from_name TEXT NOT NULL DEFAULT '',
    from_addr TEXT NOT NULL DEFAULT '',
    to_json TEXT NOT NULL DEFAULT '[]',
    cc_json TEXT NOT NULL DEFAULT '[]',
    bcc_json TEXT NOT NULL DEFAULT '[]',
    subject TEXT NOT NULL DEFAULT '',
    date INTEGER NOT NULL,
    snippet TEXT NOT NULL DEFAULT '',
    seen INTEGER NOT NULL DEFAULT 0,
    flagged INTEGER NOT NULL DEFAULT 0,
    is_sent INTEGER NOT NULL DEFAULT 0,
    has_attachments INTEGER NOT NULL DEFAULT 0,
    is_list INTEGER NOT NULL DEFAULT 0,
    has_invite INTEGER NOT NULL DEFAULT 0,
    is_automated INTEGER NOT NULL DEFAULT 0,
    body_text TEXT,
    body_html TEXT,
    attachments TEXT NOT NULL DEFAULT '[]',
    body_state INTEGER NOT NULL DEFAULT 0,
    UNIQUE(account_id, message_id)
  );
  CREATE INDEX messages_thread ON messages(thread_id, date);

  CREATE TABLE locations(
    id INTEGER PRIMARY KEY,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    uid INTEGER NOT NULL,
    removed INTEGER NOT NULL DEFAULT 0,
    UNIQUE(folder_id, uid)
  );
  CREATE INDEX locations_message ON locations(message_id);

  CREATE VIRTUAL TABLE msg_fts USING fts5(
    subject, sender, recipients, body,
    tokenize = 'unicode61 remove_diacritics 2'
  );

  CREATE TABLE actions(
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    thread_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    batch TEXT NOT NULL,
    run_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT
  );
  CREATE INDEX actions_due ON actions(state, run_at);
  CREATE INDEX actions_thread ON actions(thread_id, state);

  CREATE TABLE outbox(
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    draft TEXT NOT NULL,
    send_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT
  );

  CREATE TABLE reminders(
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    msgid TEXT,
    thread_id INTEGER,
    due_at INTEGER NOT NULL,
    if_no_reply INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE splits(
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    rule TEXT NOT NULL
  );
  `,
]

export type Row = Record<string, any>

/** Thin wrapper over node:sqlite with cached statements and nested-safe transactions. */
export class Db {
  private raw: DatabaseSync
  private cache = new Map<string, StatementSync>()
  private depth = 0

  constructor(path: string) {
    this.raw = new DatabaseSync(path)
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;')
    this.migrate()
  }

  private migrate() {
    const version = (this.raw.prepare('PRAGMA user_version').get() as Row).user_version as number
    for (let i = version; i < MIGRATIONS.length; i++) {
      this.raw.exec('BEGIN')
      this.raw.exec(MIGRATIONS[i])
      this.raw.exec(`PRAGMA user_version = ${i + 1}`)
      this.raw.exec('COMMIT')
    }
  }

  private stmt(sql: string) {
    let s = this.cache.get(sql)
    if (!s) {
      s = this.raw.prepare(sql)
      this.cache.set(sql, s)
    }
    return s
  }

  run(sql: string, ...params: unknown[]) {
    const r = this.stmt(sql).run(...(params.map(norm) as SQLInputValue[]))
    return { changes: Number(r.changes), id: Number(r.lastInsertRowid) }
  }

  get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
    return this.stmt(sql).get(...(params.map(norm) as SQLInputValue[])) as T | undefined
  }

  all<T = Row>(sql: string, ...params: unknown[]): T[] {
    return this.stmt(sql).all(...(params.map(norm) as SQLInputValue[])) as T[]
  }

  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn()
    this.raw.exec('BEGIN IMMEDIATE')
    this.depth++
    try {
      const out = fn()
      this.raw.exec('COMMIT')
      return out
    } catch (e) {
      this.raw.exec('ROLLBACK')
      throw e
    } finally {
      this.depth--
    }
  }

  close() {
    this.cache.clear()
    this.raw.close()
  }
}

function norm(v: unknown): unknown {
  if (v === undefined) return null
  if (typeof v === 'boolean') return v ? 1 : 0
  return v
}

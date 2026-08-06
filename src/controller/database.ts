import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";

export type Upstream = {
  id: string;
  name: string;
  apiBase: string;
  apiKey: string;
  createdAt: string;
  updatedAt: string;
};

export type PublicUpstream = Omit<Upstream, "apiKey"> & { apiKeyConfigured: boolean };

mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
const databasePath = path.join(config.dataDir, "gateway.sqlite");
export const database = new DatabaseSync(databasePath);
try { chmodSync(databasePath, 0o600); } catch (_) {}

database.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS upstreams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    api_base TEXT NOT NULL,
    api_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS gateway_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

function rowToUpstream(row: Record<string, unknown>): Upstream {
  return {
    id: String(row.id), name: String(row.name), apiBase: String(row.api_base), apiKey: String(row.api_key),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  };
}

export function listUpstreams(): PublicUpstream[] {
  return database.prepare("SELECT * FROM upstreams ORDER BY created_at ASC").all()
    .map((row) => {
      const upstream = rowToUpstream(row as Record<string, unknown>);
      const { apiKey, ...publicUpstream } = upstream;
      return { ...publicUpstream, apiKeyConfigured: Boolean(apiKey) };
    });
}

export function getUpstream(id: string): Upstream | undefined {
  const row = database.prepare("SELECT * FROM upstreams WHERE id = ?").get(id);
  return row ? rowToUpstream(row as Record<string, unknown>) : undefined;
}

export function createUpstream(input: Pick<Upstream, "id" | "name" | "apiBase" | "apiKey">): PublicUpstream {
  const now = new Date().toISOString();
  database.prepare("INSERT INTO upstreams (id, name, api_base, api_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(input.id, input.name, input.apiBase, input.apiKey, now, now);
  return { id: input.id, name: input.name, apiBase: input.apiBase, createdAt: now, updatedAt: now, apiKeyConfigured: Boolean(input.apiKey) };
}

export function updateUpstream(id: string, input: Partial<Pick<Upstream, "name" | "apiBase" | "apiKey">>): PublicUpstream | undefined {
  const existing = getUpstream(id);
  if (!existing) return undefined;
  const next = { ...existing, ...input, updatedAt: new Date().toISOString() };
  database.prepare("UPDATE upstreams SET name = ?, api_base = ?, api_key = ?, updated_at = ? WHERE id = ?")
    .run(next.name, next.apiBase, next.apiKey, next.updatedAt, id);
  const { apiKey, ...publicUpstream } = next;
  return { ...publicUpstream, apiKeyConfigured: Boolean(apiKey) };
}

export function deleteUpstream(id: string): boolean {
  return database.prepare("DELETE FROM upstreams WHERE id = ?").run(id).changes > 0;
}

export function activeUpstreamId(): string | null {
  const row = database.prepare("SELECT value FROM gateway_state WHERE key = 'active_upstream_id'").get() as { value?: string } | undefined;
  return row?.value ?? null;
}

export function activeUpstream(): Upstream | undefined {
  const id = activeUpstreamId();
  return id ? getUpstream(id) : undefined;
}

export function setActiveUpstream(id: string): void {
  database.prepare("INSERT INTO gateway_state (key, value) VALUES ('active_upstream_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(id);
}

export function clearActiveUpstream(): void {
  database.prepare("DELETE FROM gateway_state WHERE key = 'active_upstream_id'").run();
}

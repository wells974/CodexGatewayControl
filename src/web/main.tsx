import { FormEvent, StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Upstream = { id: string; name: string; apiBase: string; apiKeyConfigured: boolean; healthy?: boolean; latencyMs?: number; error?: string };
type Status = { gateway: { healthy: boolean; baseUrl: string }; activeUpstream: Pick<Upstream, "id" | "name" | "apiBase"> | null; upstreams: Upstream[]; notice: string };
type Draft = { id: string; name: string; apiBase: string; apiKey: string };
const emptyDraft: Draft = { id: "", name: "", apiBase: "", apiKey: "" };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data;
}

function App() {
  const [status, setStatus] = useState<Status>();
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string>();
  const [message, setMessage] = useState<string>();
  const refresh = useCallback(async () => { try { setStatus(await api<Status>("/api/status")); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } }, []);

  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 5_000); return () => window.clearInterval(timer); }, [refresh]);
  const set = (key: keyof Draft, value: string) => setDraft((current) => ({ ...current, [key]: value }));

  async function run(key: string, action: () => Promise<unknown>) {
    setBusy(key); setMessage(undefined);
    try { const result = await action() as { message?: string }; setMessage(result.message ?? "Saved."); await refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(undefined); }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const payload = editing ? { name: draft.name, apiBase: draft.apiBase, ...(draft.apiKey ? { apiKey: draft.apiKey } : {}) } : draft;
    void run(editing ? `edit-${editing}` : "create", async () => {
      const result = await api(`/api/upstreams${editing ? `/${editing}` : ""}`, { method: editing ? "PATCH" : "POST", body: JSON.stringify(payload) });
      setDraft(emptyDraft); setEditing(null); return result;
    });
  }

  function edit(upstream: Upstream) {
    setEditing(upstream.id); setDraft({ id: upstream.id, name: upstream.name, apiBase: upstream.apiBase, apiKey: "" });
  }

  return <main>
    <header><div><p className="eyebrow">LOCAL OPENAI-COMPATIBLE GATEWAY</p><h1>Codex Gateway Control</h1></div><div className="proxy ok"><i /> Gateway online</div></header>
    <section className="route"><div><span>Active upstream</span><strong>{status?.activeUpstream?.name ?? "none selected"}</strong></div><div className="route-arrow">transparent proxy</div><div><span>Codex model</span><strong>forwarded unchanged</strong></div><div className="route-meta">{status?.gateway.baseUrl ?? "http://127.0.0.1:4000"}/v1</div></section>
    <section className="notice"><b>Routing boundary</b><span>{status?.notice ?? "Loading current gateway state..."}</span></section>
    {message && <p className="message" role="status">{message}</p>}

    <section className="management">
      <form onSubmit={submit}><div className="form-title"><h2>{editing ? `Edit ${editing}` : "Add upstream"}</h2>{editing && <button type="button" onClick={() => { setEditing(null); setDraft(emptyDraft); }}>Cancel</button>}</div>
        <label>Identifier<input required disabled={Boolean(editing)} value={draft.id} onChange={(event) => set("id", event.target.value)} placeholder="provider-a" pattern="[A-Za-z0-9_-]+" /></label>
        <label>Name<input required value={draft.name} onChange={(event) => set("name", event.target.value)} placeholder="Provider A" /></label>
        <label>OpenAI-compatible base URL<input required type="url" value={draft.apiBase} onChange={(event) => set("apiBase", event.target.value)} placeholder="https://gateway.example.com/v1" /></label>
        <label>API key<input required={!editing} type="password" value={draft.apiKey} onChange={(event) => set("apiKey", event.target.value)} placeholder={editing ? "Leave blank to keep current key" : "Stored only in local SQLite"} /></label>
        <button className="switch" disabled={Boolean(busy)} type="submit">{editing ? "Save upstream" : "Add upstream"}</button>
      </form>
      <section className="upstreams" aria-label="Upstreams">
        {status?.upstreams.map((upstream) => <article className={status.activeUpstream?.id === upstream.id ? "active" : ""} key={upstream.id}>
          <div className="card-head"><h2>{upstream.name}</h2><span className={`health ${upstream.healthy === undefined ? "unknown" : upstream.healthy ? "ok" : "bad"}`}>{upstream.healthy === undefined ? "unchecked" : upstream.healthy ? "healthy" : "unavailable"}</span></div>
          <dl><div><dt>ID</dt><dd>{upstream.id}</dd></div><div><dt>Endpoint</dt><dd title={upstream.apiBase}>{upstream.apiBase}</dd></div><div><dt>Credential</dt><dd>{upstream.apiKeyConfigured ? "stored locally" : "missing"}</dd></div><div><dt>Latency</dt><dd>{upstream.latencyMs ? `${upstream.latencyMs} ms` : "-"}</dd></div></dl>
          {upstream.error && <p className="error">Latest error: {upstream.error}</p>}
          <div className="actions"><button disabled={Boolean(busy)} onClick={() => run(`test-${upstream.id}`, () => api(`/api/upstreams/${upstream.id}/test`, { method: "POST" }))}>Test</button><button disabled={Boolean(busy)} onClick={() => edit(upstream)}>Edit</button><button className="switch" disabled={Boolean(busy) || status.activeUpstream?.id === upstream.id} onClick={() => run(`activate-${upstream.id}`, () => api(`/api/upstreams/${upstream.id}/activate`, { method: "POST" }))}>{status.activeUpstream?.id === upstream.id ? "Current" : "Use"}</button><button className="danger" disabled={Boolean(busy)} onClick={() => { if (window.confirm(`Delete ${upstream.name}?`)) void run(`delete-${upstream.id}`, () => api(`/api/upstreams/${upstream.id}`, { method: "DELETE" })); }}>Delete</button></div>
        </article>)}
      </section>
    </section>
  </main>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);

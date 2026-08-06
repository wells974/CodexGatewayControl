import { FormEvent, StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Upstream = { id: string; name: string; apiBase: string; apiKeyConfigured: boolean; healthy?: boolean; latencyMs?: number; error?: string };
type Status = { gateway: { healthy: boolean; baseUrl: string }; activeUpstream: Pick<Upstream, "id" | "name" | "apiBase"> | null; upstreams: Upstream[]; notice: string };
type Draft = { id: string; name: string; apiBase: string; apiKey: string };
type TestTarget = Pick<Upstream, "id" | "name" | "apiBase">;
type TestResult = { endpoint: "/v1/responses"; stream: boolean; status: number; outputText: string | null; truncated: boolean };
type ModelList = { models: string[] };
const emptyDraft: Draft = { id: "", name: "", apiBase: "", apiKey: "" };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `请求失败（${response.status}）`);
  return data;
}

function sseFrames(chunk: string): { frames: string[]; pending: string } {
  const frames: string[] = [];
  let pending = chunk;
  let boundary = pending.search(/\r?\n\r?\n/);
  while (boundary >= 0) {
    frames.push(pending.slice(0, boundary));
    pending = pending.slice(boundary).replace(/^\r?\n\r?\n/, "");
    boundary = pending.search(/\r?\n\r?\n/);
  }
  return { frames, pending };
}

function App() {
  const [status, setStatus] = useState<Status>();
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [testModel, setTestModel] = useState("");
  const [testModels, setTestModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelsError, setModelsError] = useState<string>();
  const [testPrompt, setTestPrompt] = useState("hi");
  const [testResult, setTestResult] = useState<TestResult>();
  const [streamingText, setStreamingText] = useState("");
  const [testOpen, setTestOpen] = useState(false);
  const [testTarget, setTestTarget] = useState<TestTarget>();
  const refresh = useCallback(async () => { try { setStatus(await api<Status>("/api/status")); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } }, []);

  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 5_000); return () => window.clearInterval(timer); }, [refresh]);
  const set = (key: keyof Draft, value: string) => setDraft((current) => ({ ...current, [key]: value }));

  async function run(key: string, action: () => Promise<unknown>) {
    setBusy(key); setMessage(undefined);
    try { const result = await action() as { message?: string }; setMessage(result.message ?? "已保存。"); await refresh(); }
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

  function runCodexTest(event: FormEvent) {
    event.preventDefault();
    void runStreamingTest();
  }

  async function runStreamingTest() {
    if (!testTarget) return;
    setBusy("codex-test");
    setMessage(undefined);
    setTestResult(undefined);
    setStreamingText("");
    try {
      const endpoint = status?.activeUpstream?.id === testTarget.id ? "/api/test-request" : `/api/upstreams/${testTarget.id}/test-request`;
      const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: testModel, prompt: testPrompt, stream: true }) });
      if (!response.ok) {
        const data = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? `请求失败（${response.status}）`);
      }
      if (!response.body) throw new Error("Controller 没有返回流式响应。");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      let completed = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const parsed = sseFrames(pending + decoder.decode(value, { stream: true }));
        pending = parsed.pending;
        for (const frame of parsed.frames) {
          const event = frame.match(/^event:\s*(.+)$/m)?.[1]?.trim();
          const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
          if (!data) continue;
          const payload = JSON.parse(data) as { text?: string; error?: string; endpoint?: "/v1/responses"; stream?: boolean; status?: number; truncated?: boolean };
          if (event === "delta" && typeof payload.text === "string") setStreamingText((current) => current + payload.text);
          if (event === "error") throw new Error(payload.error ?? "接收流式响应失败。");
          if (event === "complete") {
            setTestResult({ endpoint: payload.endpoint ?? "/v1/responses", stream: true, status: payload.status ?? 200, outputText: null, truncated: payload.truncated === true });
            completed = true;
          }
        }
      }
      if (!completed) throw new Error("中转在完成前关闭了流式响应。");
      setMessage("流式响应已完成。");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(undefined);
    }
  }

  async function openTest(upstream: TestTarget) {
    setTestResult(undefined);
    setStreamingText("");
    setTestOpen(true);
    setTestTarget(upstream);
    setTestModel("");
    setTestModels([]);
    setModelsError(undefined);
    setLoadingModels(true);
    try {
      const result = await api<ModelList>(`/api/upstreams/${upstream.id}/models`);
      setTestModels(result.models);
      setTestModel(result.models[0] ?? "");
      if (!result.models.length) setModelsError("该中转没有返回可测试的模型。");
      await refresh();
    } catch (error) {
      setModelsError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingModels(false);
    }
  }

  return <main>
    <header><div><p className="eyebrow">本地 OPENAI 兼容网关</p><h1>Codex Gateway Control</h1></div><div className="header-actions"><div className="proxy ok"><i /> 网关在线</div><button className="switch" disabled={!status?.activeUpstream} onClick={() => { if (status?.activeUpstream) void openTest(status.activeUpstream); }}>测试当前中转</button></div></header>
    <section className="route"><div><span>当前中转</span><strong>{status?.activeUpstream?.name ?? "尚未选择"}</strong></div><div className="route-arrow">透明转发</div><div><span>Codex 模型</span><strong>原样透传</strong></div><div className="route-meta">{status?.gateway.baseUrl ?? "http://127.0.0.1:4000"}/v1</div></section>
    <section className="notice"><b>路由规则</b><span>{status?.notice ?? "正在读取网关状态..."}</span></section>
    {message && <p className="message" role="status">{message}</p>}
    <section className="management">
      <form onSubmit={submit}><div className="form-title"><h2>{editing ? `编辑 ${editing}` : "新增中转"}</h2>{editing && <button type="button" onClick={() => { setEditing(null); setDraft(emptyDraft); }}>取消</button>}</div>
        <label>标识符<input required disabled={Boolean(editing)} value={draft.id} onChange={(event) => set("id", event.target.value)} placeholder="provider-a" pattern="[A-Za-z0-9_-]+" /></label>
        <label>名称<input required value={draft.name} onChange={(event) => set("name", event.target.value)} placeholder="中转 A" /></label>
        <label>OpenAI 兼容基础 URL<input required type="url" value={draft.apiBase} onChange={(event) => set("apiBase", event.target.value)} placeholder="https://gateway.example.com/v1" /></label>
        <label>API Key<input required={!editing} type="password" value={draft.apiKey} onChange={(event) => set("apiKey", event.target.value)} placeholder={editing ? "留空则保留现有 API Key" : "仅保存在本地 SQLite"} /></label>
        <button className="switch" disabled={Boolean(busy)} type="submit">{editing ? "保存中转" : "添加中转"}</button>
      </form>
      <section className="upstreams" aria-label="中转列表">
        {status?.upstreams.map((upstream) => <article className={status.activeUpstream?.id === upstream.id ? "active" : ""} key={upstream.id}>
          <div className="card-head"><h2>{upstream.name}</h2><span className={`health ${upstream.healthy === undefined ? "unknown" : upstream.healthy ? "ok" : "bad"}`}>{upstream.healthy === undefined ? "未检查" : upstream.healthy ? "可用" : "不可用"}</span></div>
          <dl><div><dt>标识符</dt><dd>{upstream.id}</dd></div><div><dt>地址</dt><dd title={upstream.apiBase}>{upstream.apiBase}</dd></div><div><dt>凭据</dt><dd>{upstream.apiKeyConfigured ? "已保存在本地" : "缺失"}</dd></div><div><dt>延迟</dt><dd>{upstream.latencyMs ? `${upstream.latencyMs} ms` : "-"}</dd></div></dl>
          {upstream.error && <p className="error">最近错误：{upstream.error}</p>}
          <div className="actions"><button disabled={Boolean(busy)} onClick={() => void openTest(upstream)}>测试</button><button disabled={Boolean(busy)} onClick={() => edit(upstream)}>编辑</button><button className="switch" disabled={Boolean(busy) || status.activeUpstream?.id === upstream.id} onClick={() => run(`activate-${upstream.id}`, () => api(`/api/upstreams/${upstream.id}/activate`, { method: "POST" }))}>{status.activeUpstream?.id === upstream.id ? "当前使用中" : "使用此中转"}</button><button className="danger" disabled={Boolean(busy)} onClick={() => { if (window.confirm(`确定删除 ${upstream.name}？`)) void run(`delete-${upstream.id}`, () => api(`/api/upstreams/${upstream.id}`, { method: "DELETE" })); }}>删除</button></div>
        </article>)}
      </section>
    </section>
    {testOpen && testTarget && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setTestOpen(false); }}>
      <section className="test-modal" role="dialog" aria-modal="true" aria-labelledby="test-title">
        <header className="modal-header"><h2 id="test-title">测试当前中转</h2><button className="icon-button" type="button" aria-label="关闭测试窗口" disabled={Boolean(busy)} onClick={() => setTestOpen(false)}>×</button></header>
        <div className="modal-body">
          <div className="test-target"><div className="target-mark">↗</div><div><strong>{testTarget.name}</strong><p><code>{testTarget.id}</code><span>{status?.activeUpstream?.id === testTarget.id ? "当前使用中转" : "不会切换当前路由"}</span></p></div><b>{status?.activeUpstream?.id === testTarget.id ? "使用中" : "测试目标"}</b></div>
          <form className="test-form" id="test-request-form" onSubmit={runCodexTest}>
            <label>选择测试模型<select required autoFocus disabled={loadingModels || Boolean(modelsError)} value={testModel} onChange={(event) => setTestModel(event.target.value)}><option value="">{loadingModels ? "正在读取中转模型..." : "请选择模型"}</option>{testModels.map((model) => <option key={model} value={model}>{model}</option>)}</select>{modelsError && <small className="model-error">{modelsError}</small>}</label>
            <label>测试消息<textarea required value={testPrompt} onChange={(event) => setTestPrompt(event.target.value)} rows={3} /></label>
            <p className="request-hint">会通过 <code>POST /v1/responses</code> 发起一次真实流式请求，模型名与请求路径原样透传。</p>
          </form>
          <section className="test-console" aria-live="polite"><div className="console-status"><span>请求路径：<b>/v1/responses</b></span><span>目标：<b>{testTarget.name}</b></span></div><p>使用模型：<em>{testModel || "等待选择模型"}</em></p><p>测试消息：<em>{testPrompt || "等待填写测试消息"}</em></p>{busy === "codex-test" ? <><p>模型回复：</p><div className="model-output streaming-output">{streamingText || "正在等待第一个文本增量..."}</div><div className="console-streaming">正在实时接收...</div></> : testResult ? <><p>HTTP 状态：<em className={testResult.status >= 200 && testResult.status < 300 ? "success" : "failure"}>{testResult.status}</em></p><p>模型回复：</p><div className="model-output">{streamingText || "模型未返回可显示的文本内容。"}</div><div className="console-finish">{testResult.status >= 200 && testResult.status < 300 ? "测试完成" : "请求已返回错误"}{testResult.truncated ? "，响应内容已截断" : ""}</div></> : <p className="console-idle">尚未发送请求。请求结果会显示在这里。</p>}</section>
        </div>
        <footer className="modal-footer"><span>本次测试可能消耗上游额度</span><div><button type="button" disabled={Boolean(busy)} onClick={() => setTestOpen(false)}>关闭</button><button className="switch" form="test-request-form" type="submit" disabled={Boolean(busy) || loadingModels || !testModel}>{busy === "codex-test" ? "正在发送..." : testResult ? "重试" : "发送测试请求"}</button></div></footer>
      </section>
    </div>}
  </main>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);

import { type FormEvent, StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowRight,
  Check,
  ChevronsUpDown,
  CircleAlert,
  CircleCheck,
  CircleX,
  CircleHelp,
  FlaskConical,
  Gauge,
  KeyRound,
  LoaderCircle,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Route,
  Server,
  Settings2,
  Trash2
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { Toast, ToastClose, ToastDescription, ToastProvider, ToastTitle, ToastViewport } from "@/components/ui/toast";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import "./styles.css";

type Upstream = {
  id: string;
  name: string;
  apiBase: string;
  apiKeyConfigured: boolean;
  healthy?: boolean;
  latencyMs?: number;
  error?: string;
};
type Status = {
  gateway: { healthy: boolean; baseUrl: string };
  codexConfiguration: { available: boolean; automaticMigrationError: string | null };
  activeUpstream: Pick<Upstream, "id" | "name" | "apiBase"> | null;
  upstreams: Upstream[];
  notice: string;
};
type Draft = { id: string; name: string; apiBase: string; apiKey: string };
type TestTarget = Pick<Upstream, "id" | "name" | "apiBase">;
type TestResult = { endpoint: "/v1/responses"; stream: boolean; status: number; outputText: string | null; truncated: boolean };
type ModelList = { models: string[] };
type ToastMessage = { id: number; title: string; description: string; variant: "default" | "destructive" };
type ConfigurationPreview = {
  software: { provider: string; model: string | null; currentBaseUrl: string | null; plannedBaseUrl: string };
  image: { currentBaseUrl: string | null; currentApiKeyConfigured: boolean; gatewayApiKeyAvailable: boolean; plannedBaseUrl: string; persistence: string };
};
type ConfigurationSelection = { software: boolean; image: boolean; softwareBaseUrl: string; imageBaseUrl: string; softwareApiKey: string; imageApiKey: string };

const emptyDraft: Draft = { id: "", name: "", apiBase: "", apiKey: "" };

/**
 * 调用本地 Controller 管理接口，并将服务端错误转换为可展示的异常。
 * @param url Controller 相对路径。
 * @param init 请求配置。
 * @returns 已解析的响应数据。
 * @throws 当 Controller 返回非成功状态时抛出中文错误。
 */
async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, credentials: "include", headers: { "content-type": "application/json", ...init?.headers } });
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `请求失败（${response.status}）`);
  return data;
}

/**
 * 从不完整的 SSE 文本中切出已接收完整帧，并保留待下一批数据拼接的尾部。
 * @param chunk 追加到当前缓冲区后的 SSE 文本。
 * @returns 已完成帧与尚未完成的尾部。
 * @remarks SSE 帧可能被网络分割，不能假设单次读取就是完整事件。
 */
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

/**
 * 为模型选择提供可搜索且限高滚动的 shadcn 组合控件。
 * @param props 当前模型、可用模型和选择回调。
 * @returns 模型选择弹出层。
 * @remarks 模型列表来自目标中转，最多由 Controller 返回 500 项。
 */
function ModelPicker({
  value,
  models,
  disabled,
  onValueChange,
  portalContainer
}: {
  value: string;
  models: string[];
  disabled: boolean;
  onValueChange: (model: string) => void;
  portalContainer: HTMLElement | null;
}) {
  const [open, setOpen] = useState(false);

  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <Button
        aria-expanded={open}
        aria-haspopup="listbox"
        className="h-10 w-full justify-between border-border bg-background font-mono text-xs font-normal hover:bg-accent"
        disabled={disabled}
        role="combobox"
        type="button"
        variant="outline"
      >
        <span className="truncate">{value || "请选择模型"}</span>
        <ChevronsUpDown className="ml-2 shrink-0 text-muted-foreground" />
      </Button>
    </PopoverTrigger>
    <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0" container={portalContainer}>
      <Command>
        <CommandInput placeholder="搜索模型" />
        <CommandList className="max-h-60 overscroll-contain">
          <CommandEmpty>没有匹配的模型</CommandEmpty>
          <CommandGroup heading="可测试模型">
            {models.map((model) => <CommandItem
              key={model}
              onSelect={() => { onValueChange(model); setOpen(false); }}
              value={model}
            >
              <Check className={cn("text-primary", value === model ? "opacity-100" : "opacity-0")} />
              <span className="truncate font-mono text-xs">{model}</span>
            </CommandItem>)}
          </CommandGroup>
        </CommandList>
      </Command>
    </PopoverContent>
  </Popover>;
}

/**
 * 渲染网关管理工作台并协调中转管理、健康检查和流式测试状态。
 * @returns 完整的本地管理页。
 * @remarks 所有敏感操作都通过同源 Controller 会话执行，浏览器不持有上游密钥。
 */
function App() {
  const [status, setStatus] = useState<Status>();
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editing, setEditing] = useState<string | null>(null);
  const [upstreamDialogOpen, setUpstreamDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Upstream>();
  const [activateTarget, setActivateTarget] = useState<Upstream>();
  const [routeGuideOpen, setRouteGuideOpen] = useState(false);
  const [codexConfigurationDialogOpen, setCodexConfigurationDialogOpen] = useState(false);
  const [configurationPreview, setConfigurationPreview] = useState<ConfigurationPreview>();
  const [configurationPreviewError, setConfigurationPreviewError] = useState<string>();
  const [configurationLogSource, setConfigurationLogSource] = useState("");
  const [configurationTypedLength, setConfigurationTypedLength] = useState(0);
  const [configurationStreamComplete, setConfigurationStreamComplete] = useState(false);
  const [configurationCompletionMessage, setConfigurationCompletionMessage] = useState<string>();
  const [softwareConfigurationSelected, setSoftwareConfigurationSelected] = useState(true);
  const [imageConfigurationSelected, setImageConfigurationSelected] = useState(true);
  const [softwareBaseUrl, setSoftwareBaseUrl] = useState("");
  const [imageBaseUrl, setImageBaseUrl] = useState("");
  const [softwareApiKey, setSoftwareApiKey] = useState("");
  const [imageApiKey, setImageApiKey] = useState("");
  const [editingSoftwareBaseUrl, setEditingSoftwareBaseUrl] = useState(false);
  const [editingImageBaseUrl, setEditingImageBaseUrl] = useState(false);
  const [editingSoftwareApiKey, setEditingSoftwareApiKey] = useState(false);
  const [editingImageApiKey, setEditingImageApiKey] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [toastMessage, setToastMessage] = useState<ToastMessage>();
  const [testModel, setTestModel] = useState("");
  const [testModels, setTestModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelsError, setModelsError] = useState<string>();
  const [testPrompt, setTestPrompt] = useState("hi");
  const [testResult, setTestResult] = useState<TestResult>();
  const [streamingText, setStreamingText] = useState("");
  const [testOpen, setTestOpen] = useState(false);
  const [testTarget, setTestTarget] = useState<TestTarget>();
  const [testDialogElement, setTestDialogElement] = useState<HTMLDivElement | null>(null);

  /**
   * 在嵌入式 Gateway 完成首次 React 渲染后通知 Codex 注入层。
   * @returns 清理函数；当前无需额外清理时返回 undefined。
   * @remarks 消息不包含会话令牌、上游凭据或 Controller 私密数据；父页面会校验 iframe 窗口与 loopback origin。
   */
  useEffect(() => {
    if (window.parent === window) return;
    window.parent.postMessage({ type: "codex-gateway:ready" }, "*");
  }, []);

  /**
   * 显示统一的短暂操作反馈。
   * @param variant 反馈的成功或错误状态。
   * @param description 显示给用户的具体内容。
   * @returns 无返回值。
   */
  function notify(variant: ToastMessage["variant"], description: string): void {
    setToastMessage({ id: Date.now(), title: variant === "destructive" ? "操作失败" : "操作完成", description, variant });
  }

  /** 读取公开状态并同步页面中的中转和当前路由信息。 */
  const refresh = useCallback(async () => {
    try {
      setStatus(await api<Status>("/api/status"));
    } catch (error) {
      notify("destructive", error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * 在打开确认框时读取不含凭据的当前配置摘要。
   * @returns 无返回值。
   * @remarks 摘要接口受 HttpOnly 本地会话保护，页面只接收 provider、模型和目标地址。
   */
  useEffect(() => {
    if (!codexConfigurationDialogOpen || busy === "codex-configure") return;
    setConfigurationPreview(undefined);
    setConfigurationPreviewError(undefined);
    void api<ConfigurationPreview>("/api/codex/configuration-preview")
      .then((preview) => {
        setConfigurationPreview(preview);
        setSoftwareBaseUrl(preview.software.plannedBaseUrl);
        setImageBaseUrl(preview.image.plannedBaseUrl);
        setSoftwareApiKey("");
        setImageApiKey("");
        setEditingSoftwareBaseUrl(false);
        setEditingImageBaseUrl(false);
        setEditingSoftwareApiKey(false);
        setEditingImageApiKey(false);
      })
      .catch((error) => setConfigurationPreviewError(error instanceof Error ? error.message : String(error)));
  }, [codexConfigurationDialogOpen, busy]);

  /**
   * 将服务端阶段日志逐字写入终端区域，并在最后一个字符出现后显示成功反馈并解除忙碌状态。
   * @returns 清理当前字符计时器的函数，或无需清理时返回 undefined。
   * @remarks 仅动画展示服务端已过滤的安全文本，不会处理或显示认证材料。
   */
  useEffect(() => {
    if (configurationTypedLength < configurationLogSource.length) {
      const timer = window.setTimeout(() => setConfigurationTypedLength((current) => current + 1), 14);
      return () => window.clearTimeout(timer);
    }
    if (configurationStreamComplete && busy === "codex-configure") {
      if (configurationCompletionMessage) {
        notify("default", configurationCompletionMessage);
        setConfigurationCompletionMessage(undefined);
      }
      setBusy(undefined);
    }
  }, [busy, configurationCompletionMessage, configurationLogSource, configurationStreamComplete, configurationTypedLength]);

  /** 更新弹窗表单中的单个中转字段。 */
  const set = (key: keyof Draft, value: string) => setDraft((current) => ({ ...current, [key]: value }));

  /**
   * 在执行写操作时统一维护忙碌状态、反馈信息和后续状态刷新。
   * @param key 本次操作的唯一忙碌标识。
   * @param action 实际请求。
   * @param successMessage 没有服务端消息时显示的成功提示。
   * @returns 请求结束后的 Promise。
   */
  async function run(key: string, action: () => Promise<unknown>, successMessage: string): Promise<void> {
    setBusy(key);
    try {
      const result = await action() as { message?: string };
      notify("default", result.message ?? successMessage);
      await refresh();
    } catch (error) {
      notify("destructive", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(undefined);
    }
  }

  /**
   * 提交新增或编辑中转的表单。
   * @param event 原生表单提交事件。
   * @returns 无返回值。
   * @remarks 编辑时空 API Key 表示保留本地已有凭据。
   */
  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const payload = editing
      ? { name: draft.name, apiBase: draft.apiBase, ...(draft.apiKey ? { apiKey: draft.apiKey } : {}) }
      : draft;
    void run(editing ? `edit-${editing}` : "create", async () => {
      const result = await api(`/api/upstreams${editing ? `/${editing}` : ""}`, {
        method: editing ? "PATCH" : "POST",
        body: JSON.stringify(payload)
      });
      setDraft(emptyDraft);
      setEditing(null);
      setUpstreamDialogOpen(false);
      return result;
    }, editing ? "中转已更新。" : "中转已添加。");
  }

  /** 打开空白表单以新增中转。 */
  function openCreate(): void {
    setEditing(null);
    setDraft(emptyDraft);
    setUpstreamDialogOpen(true);
  }

  /**
   * 确认后请求 Controller 写入当前用户的 Codex 配置。
   * @returns 无返回值。
   * @remarks 浏览器不会接收或持有本地 Gateway 令牌；用户主动填写的自定义密钥仅随本次本地请求提交。
   */
  function configureCurrentCodex(): void {
    void streamConfiguration({
      software: softwareConfigurationSelected,
      image: imageConfigurationSelected,
      softwareBaseUrl,
      imageBaseUrl,
      softwareApiKey,
      imageApiKey
    });
  }

  /**
   * 打开一键配置确认框并恢复默认的两项配置选择。
   * @returns 无返回值。
   * @remarks 每次新建配置操作都默认选择软件和生图配置，用户可在确认前取消任意一项。
   */
  function openCodexConfiguration(): void {
    setSoftwareConfigurationSelected(true);
    setImageConfigurationSelected(true);
    setConfigurationStreamComplete(false);
    setSoftwareBaseUrl("");
    setImageBaseUrl("");
    setSoftwareApiKey("");
    setImageApiKey("");
    setEditingSoftwareBaseUrl(false);
    setEditingImageBaseUrl(false);
    setEditingSoftwareApiKey(false);
    setEditingImageApiKey(false);
    setCodexConfigurationDialogOpen(true);
  }

  /**
   * 接收软件与生图配置的 SSE 进度，并只追加服务端提供的安全日志文本。
   * @param selection 用户确认要写入的配置步骤。
   * @returns 流处理完成后的 Promise。
   * @remarks 完成事件抵达后仍等待逐字动画结束，确保用户可读到完整结果。
   */
  async function streamConfiguration(selection: ConfigurationSelection): Promise<void> {
    setBusy("codex-configure");
    setConfigurationLogSource("");
    setConfigurationTypedLength(0);
    setConfigurationStreamComplete(false);
    setConfigurationCompletionMessage(undefined);
    try {
      const response = await fetch("/api/codex/configure/stream", {
        body: JSON.stringify(selection),
        credentials: "include",
        headers: { "content-type": "application/json" },
        method: "POST"
      });
      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? `请求失败（${response.status}）`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const parsed = sseFrames(pending + decoder.decode(value, { stream: true }));
        pending = parsed.pending;
        for (const frame of parsed.frames) {
          const event = frame.match(/^event:\s*(.+)$/m)?.[1]?.trim();
          const payload = JSON.parse(frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n")) as { message?: string; error?: string };
          if (event === "log" && payload.message) setConfigurationLogSource((current) => `${current}${current ? "\n" : ""}${payload.message}`);
          if (event === "complete" && payload.message) {
            setConfigurationLogSource((current) => `${current}${current ? "\n" : ""}${payload.message}`);
            setConfigurationCompletionMessage(payload.message);
          }
          if (event === "error") throw new Error(payload.error ?? "一键配置失败。");
        }
      }
      await refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setConfigurationLogSource((current) => `${current}${current ? "\n" : ""}[失败] ${message}`);
      notify("destructive", message);
    } finally {
      setConfigurationStreamComplete(true);
    }
  }

  /**
   * 以现有中转信息打开编辑表单。
   * @param upstream 要编辑的中转。
   * @returns 无返回值。
   */
  function openEdit(upstream: Upstream): void {
    setEditing(upstream.id);
    setDraft({ id: upstream.id, name: upstream.name, apiBase: upstream.apiBase, apiKey: "" });
    setUpstreamDialogOpen(true);
  }

  /**
   * 提交测试表单并启动真实的 Responses SSE 请求。
   * @param event 原生表单提交事件。
   * @returns 无返回值。
   */
  function runCodexTest(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void runStreamingTest();
  }

  /**
   * 发起流式测试并逐帧追加 Controller 提取后的模型文本。
   * @returns 流完成后的 Promise。
   * @remarks 当前中转通过 Gateway 回环测试，其他中转只直连测试，不会改变实际路由。
   */
  async function runStreamingTest(): Promise<void> {
    if (!testTarget) return;
    setBusy("codex-test");
    setTestResult(undefined);
    setStreamingText("");
    try {
      const endpoint = status?.activeUpstream?.id === testTarget.id
        ? "/api/test-request"
        : `/api/upstreams/${testTarget.id}/test-request`;
      const response = await fetch(endpoint, {
        credentials: "include",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: testModel, prompt: testPrompt, stream: true })
      });
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
          const data = frame.split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("\n");
          if (!data) continue;
          const payload = JSON.parse(data) as {
            text?: string;
            error?: string;
            endpoint?: "/v1/responses";
            status?: number;
            truncated?: boolean;
          };
          if (event === "delta" && typeof payload.text === "string") setStreamingText((current) => current + payload.text);
          if (event === "error") throw new Error(payload.error ?? "接收流式响应失败。");
          if (event === "complete") {
            setTestResult({
              endpoint: payload.endpoint ?? "/v1/responses",
              stream: true,
              status: payload.status ?? 200,
              outputText: null,
              truncated: payload.truncated === true
            });
            completed = true;
          }
        }
      }
      if (!completed) throw new Error("中转在完成前关闭了流式响应。");
      notify("default", "流式响应已完成。");
      await refresh();
    } catch (error) {
      notify("destructive", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(undefined);
    }
  }

  /**
   * 打开指定中转的测试窗口并读取其可用模型列表。
   * @param upstream 将要测试的中转。
   * @returns 模型列表读取结束后的 Promise。
   */
  async function openTest(upstream: TestTarget): Promise<void> {
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

  const activeUpstream = status?.activeUpstream;
  const gatewayOnline = status?.gateway.healthy === true;
  const upstreams = status?.upstreams ?? [];

  return <ToastProvider label="通知">
    <TooltipProvider>
      <main className="min-h-screen bg-background px-4 py-5 text-foreground sm:px-7 sm:py-7">
        <div className="mx-auto max-w-7xl">
          <section aria-labelledby="route-title" className="relative overflow-hidden rounded-[20px] bg-[#292d58] px-5 py-6 text-white shadow-[0_16px_32px_rgb(40_44_84/16%)] sm:px-7 sm:py-7">
            <div aria-hidden="true" className="absolute -top-14 right-[22%] size-40 rounded-full border border-white/10 bg-white/5" />
            <div aria-hidden="true" className="absolute -right-10 -bottom-16 size-52 rounded-full bg-[#7d7cf6]/25 blur-2xl" />
            <div className="relative grid gap-6 lg:grid-cols-[minmax(0,1fr)_auto_minmax(280px,0.9fr)] lg:items-center">
              <div>
                <div className="mb-3 flex items-center gap-2 text-xs font-medium text-indigo-200"><Route className="size-3.5" />当前转发路由</div>
                {activeUpstream ? <>
                  <h2 id="route-title" className="text-2xl font-semibold sm:text-3xl">{activeUpstream.name}</h2>
                  <p className="mt-2 max-w-xl truncate font-mono text-sm text-indigo-100/80" title={activeUpstream.apiBase}>{activeUpstream.apiBase}</p>
                </> : <>
                  <h2 id="route-title" className="text-2xl font-semibold sm:text-3xl">尚未选择中转</h2>
                  <p className="mt-2 text-sm text-indigo-100/80">添加中转后，即可将 Codex 请求转发到指定服务。</p>
                </>}
              </div>
              <div className="hidden items-center gap-2 text-indigo-200 lg:flex"><span className="grid size-9 place-items-center rounded-full border border-white/15 bg-white/8"><Server className="size-4" /></span><ArrowRight className="size-4" /><span className="grid size-9 place-items-center rounded-full border border-white/15 bg-white/8"><Network className="size-4" /></span></div>
              <div className="rounded-xl border border-white/12 bg-white/8 p-4 backdrop-blur-sm">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2 text-xs text-indigo-100/70"><Activity className="size-3.5 shrink-0" />Codex 请求入口</div>
                  <Tooltip><TooltipTrigger asChild><Button aria-label="一键配置当前机器" className="shrink-0" disabled={!status?.codexConfiguration.available || Boolean(busy)} onClick={openCodexConfiguration} size="sm" type="button" variant="secondary"><Settings2 />一键配置</Button></TooltipTrigger><TooltipContent>{status?.codexConfiguration.available ? "配置 Codex 与生图环境" : "请先设置 GATEWAY_ACCESS_TOKEN"}</TooltipContent></Tooltip>
                </div>
                <p className="mt-2 truncate font-mono text-sm font-medium">{status?.gateway.baseUrl ? `${status.gateway.baseUrl}/v1` : "等待 Gateway 连接"}</p>
                <p className="mt-2 text-xs leading-5 text-indigo-100/70">模型名、请求体与 SSE 响应均原样透传。</p>
              </div>
            </div>
          </section>

          <section aria-label="网关概览" className="mt-5 grid gap-3 sm:grid-cols-3">
            <article className="rounded-2xl border border-border bg-card p-4 shadow-[0_4px_14px_rgb(25_34_68/4%)]">
              <div className="flex items-center justify-between"><span className="grid size-9 place-items-center rounded-lg bg-[#eeeefe] text-primary"><Network className="size-4" /></span><Badge variant="outline">本机</Badge></div>
              <p className="mt-4 text-sm text-muted-foreground">网关状态</p>
              <p className="mt-1 text-lg font-semibold">{gatewayOnline ? "运行正常" : "等待连接"}</p>
            </article>
            <article className="rounded-2xl border border-border bg-card p-4 shadow-[0_4px_14px_rgb(25_34_68/4%)]">
              <div className="flex items-center justify-between"><span className="grid size-9 place-items-center rounded-lg bg-[#e8f5ff] text-[#3d80c4]"><Server className="size-4" /></span><span className="text-xs font-medium text-muted-foreground">可管理节点</span></div>
              <p className="mt-4 text-sm text-muted-foreground">中转数量</p>
              <p className="mt-1 text-lg font-semibold">{upstreams.length} <span className="text-sm font-medium text-muted-foreground">个节点</span></p>
            </article>
            <article className="rounded-2xl border border-border bg-card p-4 shadow-[0_4px_14px_rgb(25_34_68/4%)]">
              <div className="flex items-center justify-between"><span className="grid size-9 place-items-center rounded-lg bg-[#eaf8f1] text-[#24946b]"><Gauge className="size-4" /></span><span className="text-xs font-medium text-muted-foreground">当前延迟</span></div>
              <p className="mt-4 text-sm text-muted-foreground">当前中转</p>
              <p className="mt-1 truncate text-lg font-semibold">{activeUpstream?.name ?? "未选择"}</p>
            </article>
          </section>

          <section className="mt-8">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-xs font-medium text-primary">上游管理</p>
                <h2 className="mt-1 text-xl font-semibold">中转节点</h2>
                <p className="mt-1 text-sm text-muted-foreground">选择一个节点作为当前路由，其他节点仍可独立检查和测试。</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge className={cn("gap-1.5 border-0 px-2.5 py-1", gatewayOnline ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700")} variant="secondary">
                  <span className={cn("size-1.5 rounded-full", gatewayOnline ? "bg-emerald-500" : "bg-destructive")} />
                  {gatewayOnline ? "网关运行中" : "网关状态未知"}
                </Badge>
                <Button onClick={() => setRouteGuideOpen(true)} size="sm" variant="ghost">
                  <CircleHelp className="size-3.5" aria-hidden="true" />
                  路由说明
                </Button>
                <Button onClick={() => void refresh()} size="sm" variant="outline">
                  <RefreshCw className="size-3.5" aria-hidden="true" />
                  刷新状态
                </Button>
                <Button onClick={openCreate} size="sm">
                  <Plus className="size-4" aria-hidden="true" />
                  添加中转
                </Button>
              </div>
            </div>
            <section aria-label="中转列表" className="mt-4 grid gap-3">
              {upstreams.length === 0 && <div className="rounded-2xl border border-dashed border-border bg-card py-16 text-center shadow-[0_4px_14px_rgb(25_34_68/4%)]">
                <Network className="mx-auto size-8 text-primary" aria-hidden="true" />
                <p className="mt-4 text-sm font-semibold">尚无中转节点</p>
                <p className="mt-1 text-sm text-muted-foreground">添加后即可让 Codex 经本机网关转发。</p>
                <Button className="mt-5" onClick={openCreate} size="sm"><Plus />添加第一个中转</Button>
              </div>}
              {upstreams.map((upstream) => {
                const isActive = activeUpstream?.id === upstream.id;
                const health = upstream.healthy === undefined ? "未检查" : upstream.healthy ? "连接正常" : "连接异常";
                const healthVariant = upstream.healthy === false ? "destructive" : upstream.healthy === true ? "secondary" : "outline";
                return <article className={cn("rounded-2xl border border-border bg-card p-4 shadow-[0_4px_14px_rgb(25_34_68/4%)] transition-colors sm:p-5", isActive && "border-primary/25 bg-[#fbfbff] shadow-[0_10px_24px_rgb(91_92_240/10%)]")} key={upstream.id}>
                  <div className="grid gap-5 lg:grid-cols-[auto_minmax(0,1fr)_auto] lg:items-center">
                    <div className={cn("grid size-11 place-items-center rounded-xl bg-muted text-muted-foreground", isActive && "bg-primary text-primary-foreground")}><Server className="size-5" /></div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{upstream.name}</h3>{isActive && <Badge className="gap-1" variant="default"><Check className="size-3" />当前路由</Badge>}<Badge className="gap-1" variant={healthVariant}>{upstream.healthy === false ? <CircleX /> : upstream.healthy === true ? <CircleCheck /> : <Gauge />}{health}</Badge></div>
                      <p className="mt-2 truncate font-mono text-xs text-muted-foreground" title={upstream.apiBase}>{upstream.apiBase}</p>
                      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground"><span>标识符 <b className="ml-1 font-mono font-medium text-foreground">{upstream.id}</b></span><span>延迟 <b className="ml-1 font-medium text-foreground">{upstream.latencyMs === undefined ? "待测" : `${upstream.latencyMs} ms`}</b></span><span>凭据 <b className="ml-1 font-medium text-foreground">{upstream.apiKeyConfigured ? "已配置" : "缺失"}</b></span></div>
                      {upstream.error && <p className="mt-3 flex items-start gap-1.5 text-xs leading-5 text-destructive"><CircleAlert className="mt-0.5 size-3.5 shrink-0" />最近错误：{upstream.error}</p>}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 lg:justify-end">
                      <Tooltip><TooltipTrigger asChild><Button aria-label={`检查 ${upstream.name} 的连通性`} disabled={Boolean(busy)} onClick={() => void run(`probe-${upstream.id}`, () => api(`/api/upstreams/${upstream.id}/test`, { method: "POST" }), "连通性检查已完成。")} size="icon-sm" type="button" variant="ghost"><Activity /></Button></TooltipTrigger><TooltipContent>检查连通性</TooltipContent></Tooltip>
                      <Tooltip><TooltipTrigger asChild><Button aria-label={`测试 ${upstream.name}`} disabled={Boolean(busy)} onClick={() => void openTest(upstream)} size="icon-sm" type="button" variant="ghost"><FlaskConical /></Button></TooltipTrigger><TooltipContent>发送真实测试请求</TooltipContent></Tooltip>
                      <Tooltip><TooltipTrigger asChild><Button aria-label={`编辑 ${upstream.name}`} disabled={Boolean(busy)} onClick={() => openEdit(upstream)} size="icon-sm" type="button" variant="ghost"><Pencil /></Button></TooltipTrigger><TooltipContent>编辑中转</TooltipContent></Tooltip>
                      <Tooltip><TooltipTrigger asChild><Button aria-label={`删除 ${upstream.name}`} disabled={Boolean(busy)} onClick={() => setDeleteTarget(upstream)} size="icon-sm" type="button" variant="ghost"><Trash2 className="text-destructive" /></Button></TooltipTrigger><TooltipContent>删除中转</TooltipContent></Tooltip>
                      <Button disabled={Boolean(busy) || isActive} onClick={() => setActivateTarget(upstream)} size="sm" type="button" variant={isActive ? "secondary" : "default"}>{isActive ? <><Check />正在使用</> : "设为当前"}</Button>
                    </div>
                  </div>
                </article>;
              })}
            </section>
          </section>
        </div>
      </main>

    <Dialog onOpenChange={(open) => { if (open || !busy) setUpstreamDialogOpen(open); }} open={upstreamDialogOpen}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{editing ? "编辑中转" : "添加中转"}</DialogTitle>
          <DialogDescription>{editing ? "留空 API Key 即保留本机已有的凭据。" : "凭据仅保存到本机 SQLite，不会发送到页面以外的地方。"}</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit}>
          <label className="grid gap-2 text-sm font-medium">标识符
            <Input disabled={Boolean(editing)} onChange={(event) => set("id", event.target.value)} pattern="[A-Za-z0-9_-]+" placeholder="provider-a" required value={draft.id} />
            <span className="text-xs font-normal text-muted-foreground">仅支持字母、数字、连字符和下划线，创建后不可修改。</span>
          </label>
          <label className="grid gap-2 text-sm font-medium">名称
            <Input onChange={(event) => set("name", event.target.value)} placeholder="中转 A" required value={draft.name} />
          </label>
          <label className="grid gap-2 text-sm font-medium">OpenAI 兼容基础 URL
            <Input onChange={(event) => set("apiBase", event.target.value)} placeholder="https://gateway.example.com/v1" required type="url" value={draft.apiBase} />
          </label>
          <label className="grid gap-2 text-sm font-medium">API Key
            <Input onChange={(event) => set("apiKey", event.target.value)} placeholder={editing ? "留空则保留现有 API Key" : "仅保存在本地 SQLite"} required={!editing} type="password" value={draft.apiKey} />
          </label>
          <DialogFooter className="pt-2">
            <Button disabled={Boolean(busy)} onClick={() => setUpstreamDialogOpen(false)} type="button" variant="outline">取消</Button>
            <Button disabled={Boolean(busy)} type="submit">{busy?.startsWith("edit-") || busy === "create" ? <LoaderCircle className="animate-spin" /> : <Check />}{editing ? "保存更改" : "添加中转"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    <Dialog onOpenChange={(open) => { if (open || busy !== "codex-configure") setCodexConfigurationDialogOpen(open); }} open={codexConfigurationDialogOpen}>
      <DialogContent className="grid max-h-[calc(100vh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-xl" showCloseButton={busy !== "codex-configure"}>
        <DialogHeader className="border-b border-border px-5 py-4 pr-12 sm:px-6">
          <DialogTitle>配置当前机器</DialogTitle>
          <DialogDescription>{busy === "codex-configure" ? "正在执行本机配置，请保持此窗口打开。" : "将软件请求和生图环境统一切换到本机 Gateway。"}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto px-5 py-5 sm:px-6">
          {busy === "codex-configure" || configurationStreamComplete ? <section aria-live="polite" className="rounded-xl border border-slate-700 bg-slate-950 p-4 font-mono text-xs leading-6 text-slate-300"><p className="mb-3 flex items-center gap-2 border-b border-slate-700 pb-2 text-cyan-300"><Activity className="size-3.5" />本机配置执行日志</p><p className="min-h-32 whitespace-pre-wrap break-words text-emerald-300">{configurationLogSource.slice(0, configurationTypedLength) || "正在建立本机配置通道..."}{configurationTypedLength < configurationLogSource.length && <span className="streaming-cursor" />}</p></section> : <div className="space-y-4 text-sm leading-6 text-muted-foreground">
            {configurationPreviewError ? <p className="text-destructive">{configurationPreviewError}</p> : !configurationPreview ? <p className="flex items-center gap-2"><LoaderCircle className="size-4 animate-spin" />正在读取当前配置...</p> : <>
              <section className={cn("rounded-xl border border-border bg-secondary/35 p-4", !softwareConfigurationSelected && "opacity-60")}><div className="flex items-center gap-3 font-medium text-foreground"><Checkbox checked={softwareConfigurationSelected} id="configure-software" onCheckedChange={(checked) => setSoftwareConfigurationSelected(checked === true)} /><label className="flex cursor-pointer items-center gap-2" htmlFor="configure-software"><Settings2 className="size-4 text-primary" />软件配置</label></div><dl className="mt-3 grid gap-1.5 text-xs"><div className="flex justify-between gap-4"><dt>当前 provider</dt><dd className="truncate font-mono text-foreground">{configurationPreview.software.provider}</dd></div><div className="flex justify-between gap-4"><dt>当前模型</dt><dd className="truncate font-mono text-foreground">{configurationPreview.software.model ?? "使用 Codex 默认值"}</dd></div><div className="flex justify-between gap-4"><dt>当前请求地址</dt><dd className="truncate font-mono text-foreground">{configurationPreview.software.currentBaseUrl ?? "未设置"}</dd></div><div className="flex items-center justify-between gap-4"><dt>待写入密钥</dt><dd className="flex min-w-0 items-center gap-1"><Input aria-label="软件配置写入密钥" autoComplete="new-password" className={cn("h-8 w-52 max-w-[60vw] font-mono text-xs", !editingSoftwareApiKey && "hidden")} maxLength={8192} onChange={(event) => setSoftwareApiKey(event.target.value)} placeholder="留空则使用网关密钥" type="password" value={softwareApiKey} /><span className={cn("truncate text-foreground", editingSoftwareApiKey && "hidden")}>{softwareApiKey ? "已填写，不显示值" : configurationPreview.image.gatewayApiKeyAvailable ? "使用网关密钥，不显示值" : "未准备"}</span><Tooltip><TooltipTrigger asChild><Button aria-label="编辑软件配置写入密钥" onClick={() => setEditingSoftwareApiKey((current) => !current)} size="icon-xs" type="button" variant="ghost"><Pencil /></Button></TooltipTrigger><TooltipContent>{editingSoftwareApiKey ? "收起密钥编辑" : "编辑写入密钥"}</TooltipContent></Tooltip></dd></div><div className="flex items-center justify-between gap-4"><dt>确认后地址</dt><dd className="flex min-w-0 items-center gap-1"><Input aria-label="软件配置写入地址" className={cn("h-8 w-52 max-w-[60vw] font-mono text-xs", !editingSoftwareBaseUrl && "hidden")} onChange={(event) => setSoftwareBaseUrl(event.target.value)} type="url" value={softwareBaseUrl} /><span className={cn("truncate font-mono text-foreground", editingSoftwareBaseUrl && "hidden")}>{softwareBaseUrl}</span><Tooltip><TooltipTrigger asChild><Button aria-label="编辑软件配置写入地址" onClick={() => setEditingSoftwareBaseUrl((current) => !current)} size="icon-xs" type="button" variant="ghost"><Pencil /></Button></TooltipTrigger><TooltipContent>{editingSoftwareBaseUrl ? "收起地址编辑" : "编辑写入地址"}</TooltipContent></Tooltip></dd></div></dl></section>
              <section className={cn("rounded-xl border border-border bg-secondary/35 p-4", !imageConfigurationSelected && "opacity-60")}><div className="flex items-center gap-3 font-medium text-foreground"><Checkbox checked={imageConfigurationSelected} id="configure-image" onCheckedChange={(checked) => setImageConfigurationSelected(checked === true)} /><label className="flex cursor-pointer items-center gap-2" htmlFor="configure-image"><Activity className="size-4 text-[#24946b]" />生图配置</label></div><dl className="mt-3 grid gap-1.5 text-xs"><div className="flex justify-between gap-4"><dt>当前 OPENAI_BASE_URL</dt><dd className="truncate font-mono text-foreground">{configurationPreview.image.currentBaseUrl ?? "当前进程未检测到"}</dd></div><div className="flex justify-between gap-4"><dt>当前 OPENAI_API_KEY</dt><dd className="text-foreground">{configurationPreview.image.currentApiKeyConfigured ? "当前进程已检测到，不显示值" : "当前进程未检测到"}</dd></div><div className="flex items-center justify-between gap-4"><dt>待写入密钥</dt><dd className="flex min-w-0 items-center gap-1"><Input aria-label="生图配置写入密钥" autoComplete="new-password" className={cn("h-8 w-52 max-w-[60vw] font-mono text-xs", !editingImageApiKey && "hidden")} maxLength={8192} onChange={(event) => setImageApiKey(event.target.value)} placeholder="留空则使用网关密钥" type="password" value={imageApiKey} /><span className={cn("truncate text-foreground", editingImageApiKey && "hidden")}>{imageApiKey ? "已填写，不显示值" : configurationPreview.image.gatewayApiKeyAvailable ? "使用网关密钥，不显示值" : "未准备"}</span><Tooltip><TooltipTrigger asChild><Button aria-label="编辑生图配置写入密钥" onClick={() => setEditingImageApiKey((current) => !current)} size="icon-xs" type="button" variant="ghost"><Pencil /></Button></TooltipTrigger><TooltipContent>{editingImageApiKey ? "收起密钥编辑" : "编辑写入密钥"}</TooltipContent></Tooltip></dd></div><div className="flex items-center justify-between gap-4"><dt>确认后地址</dt><dd className="flex min-w-0 items-center gap-1"><Input aria-label="生图配置写入地址" className={cn("h-8 w-52 max-w-[60vw] font-mono text-xs", !editingImageBaseUrl && "hidden")} onChange={(event) => setImageBaseUrl(event.target.value)} type="url" value={imageBaseUrl} /><span className={cn("truncate font-mono text-foreground", editingImageBaseUrl && "hidden")}>{imageBaseUrl}</span><Tooltip><TooltipTrigger asChild><Button aria-label="编辑生图配置写入地址" onClick={() => setEditingImageBaseUrl((current) => !current)} size="icon-xs" type="button" variant="ghost"><Pencil /></Button></TooltipTrigger><TooltipContent>{editingImageBaseUrl ? "收起地址编辑" : "编辑写入地址"}</TooltipContent></Tooltip></dd></div><div className="flex justify-between gap-4"><dt>持久化位置</dt><dd className="text-right text-foreground">{configurationPreview.image.persistence}</dd></div></dl></section>
              <p>软件配置会备份并更新 <code className="font-mono text-xs text-foreground">config.toml</code> 与 <code className="font-mono text-xs text-foreground">auth.json</code>，不会创建或改名 provider；生图配置会写入当前用户环境。取消勾选的项目不会被修改。</p>
            </>}
          </div>}
        </div>
        <DialogFooter className="border-t border-border bg-secondary/45 px-5 py-4 sm:px-6">
          {busy === "codex-configure" ? <span className="mr-auto flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />正在写入本机配置</span> : <><Button onClick={() => setCodexConfigurationDialogOpen(false)} type="button" variant="outline">{configurationStreamComplete ? "关闭" : "取消"}</Button>{!configurationStreamComplete && <Button disabled={!configurationPreview || Boolean(configurationPreviewError) || (!softwareConfigurationSelected && !imageConfigurationSelected)} onClick={configureCurrentCodex} type="button"><Settings2 />确认配置</Button>}</>}
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog onOpenChange={(open) => { if (open || busy !== "codex-test") setTestOpen(open); }} open={testOpen}>
      <DialogContent className="grid max-h-[calc(100vh-2rem)] gap-0 overflow-visible p-0 sm:max-w-2xl" ref={setTestDialogElement} showCloseButton={busy !== "codex-test"}>
        {testTarget && <>
          <DialogHeader className="border-b border-border px-5 py-4 pr-12 sm:px-6">
            <DialogTitle>测试中转</DialogTitle>
            <DialogDescription>通过 <code className="font-mono text-xs text-foreground">POST /v1/responses</code> 发送一次真实流式请求。</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto px-5 py-5 sm:px-6">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-secondary/35 p-3">
              <div className="min-w-0">
                <p className="font-medium">{testTarget.name}</p>
                <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{testTarget.apiBase}</p>
              </div>
              <Badge variant={activeUpstream?.id === testTarget.id ? "default" : "outline"}>{activeUpstream?.id === testTarget.id ? "当前路由" : "仅测试，不切换"}</Badge>
            </div>
            <form className="mt-5 grid gap-4" id="test-request-form" onSubmit={runCodexTest}>
              <label className="grid gap-2 text-sm font-medium">选择测试模型
                <ModelPicker disabled={loadingModels || Boolean(modelsError)} models={testModels} onValueChange={setTestModel} portalContainer={testDialogElement} value={testModel} />
                {loadingModels && <span className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground"><LoaderCircle className="size-3 animate-spin" />正在读取中转模型...</span>}
                {modelsError && <span className="text-xs font-normal text-destructive">{modelsError}</span>}
              </label>
              <label className="grid gap-2 text-sm font-medium">测试消息
                <Textarea className="min-h-20 resize-y" onChange={(event) => setTestPrompt(event.target.value)} required rows={3} value={testPrompt} />
              </label>
            </form>
            <section aria-live="polite" className="mt-5 rounded-xl border border-slate-700 bg-slate-950 p-4 font-mono text-xs leading-5 text-slate-300">
              <div className="flex flex-wrap gap-x-5 gap-y-1 border-b border-slate-700 pb-2 text-slate-400">
                <span>路径 <b className="font-medium text-slate-100">/v1/responses</b></span>
                <span>模型 <b className="font-medium text-slate-100">{testModel || "等待选择"}</b></span>
              </div>
              {busy === "codex-test" ? <div className="pt-3">
                <p className="text-amber-300">正在实时接收模型文本...</p>
                <p className="mt-2 whitespace-pre-wrap break-words text-emerald-300">{streamingText || "正在等待第一个文本增量..."}<span className="streaming-cursor" /></p>
              </div> : testResult ? <div className="pt-3">
                <p>HTTP 状态 <b className={cn("font-medium", testResult.status >= 200 && testResult.status < 300 ? "text-emerald-300" : "text-red-300")}>{testResult.status}</b></p>
                <p className="mt-2 whitespace-pre-wrap break-words text-emerald-300">{streamingText || "模型未返回可显示的文本内容。"}</p>
                <p className="mt-2 text-slate-400">{testResult.truncated ? "响应内容已截断。" : "流式响应已完成。"}</p>
              </div> : <p className="pt-3 text-slate-400">尚未发送请求，模型文本会在这里实时显示。</p>}
            </section>
          </div>
          <DialogFooter className="border-t border-border bg-secondary/45 px-5 py-4 sm:px-6">
            <span className="mr-auto text-xs text-muted-foreground">本次测试可能消耗上游额度</span>
            <Button disabled={busy === "codex-test"} onClick={() => setTestOpen(false)} type="button" variant="outline">关闭</Button>
            <Button disabled={busy === "codex-test" || loadingModels || !testModel} form="test-request-form" type="submit">{busy === "codex-test" ? <LoaderCircle className="animate-spin" /> : <FlaskConical />}{testResult ? "重新测试" : "发送测试"}</Button>
          </DialogFooter>
        </>}
      </DialogContent>
    </Dialog>

    <Dialog onOpenChange={setRouteGuideOpen} open={routeGuideOpen}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>路由说明</DialogTitle>
          <DialogDescription>了解 Codex 请求如何经本机 Gateway 转发到当前中转。</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-sm leading-6 text-muted-foreground">
          <div className="border-l-2 border-primary pl-3 text-foreground">{status?.notice ?? "正在读取网关状态..."}</div>
          <div className="flex gap-3"><KeyRound className="mt-1 size-4 shrink-0 text-primary" /><p><strong className="font-medium text-foreground">凭据只留在本机</strong><br />上游 API Key 仅保存在本机 SQLite，管理页、iframe 和 CDP 注入脚本均不会接收该信息。</p></div>
          <div className="flex gap-3"><RefreshCw className="mt-1 size-4 shrink-0 text-primary" /><p><strong className="font-medium text-foreground">切换只影响后续请求</strong><br />已开始的流会继续由原中转完成，不会被迁移到新的中转。</p></div>
          <div className="flex gap-3"><Server className="mt-1 size-4 shrink-0 text-primary" /><p><strong className="font-medium text-foreground">请求保持原样</strong><br />Gateway 不改写模型名、请求路径、请求体或 SSE 响应。</p></div>
        </div>
        <DialogFooter><Button onClick={() => setRouteGuideOpen(false)} type="button">知道了</Button></DialogFooter>
      </DialogContent>
    </Dialog>

    <AlertDialog onOpenChange={(open) => { if (!open && !busy) setActivateTarget(undefined); }} open={Boolean(activateTarget)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>切换到“{activateTarget?.name}”？</AlertDialogTitle>
          <AlertDialogDescription>切换只影响后续 Codex 请求。已开始的流会继续由原中转完成，不会迁移或中断。</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={Boolean(busy)}>取消</AlertDialogCancel>
          <AlertDialogAction disabled={Boolean(busy)} onClick={(event) => {
            event.preventDefault();
            if (!activateTarget) return;
            void run(`activate-${activateTarget.id}`, async () => {
              const result = await api(`/api/upstreams/${activateTarget.id}/activate`, { method: "POST" });
              setActivateTarget(undefined);
              return result;
            }, `${activateTarget.name} 已设为当前路由。`);
          }}>{busy?.startsWith("activate-") ? <LoaderCircle className="animate-spin" /> : <Check />}确认切换</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <AlertDialog onOpenChange={(open) => { if (!open) setDeleteTarget(undefined); }} open={Boolean(deleteTarget)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除中转？</AlertDialogTitle>
          <AlertDialogDescription>将删除“{deleteTarget?.name}”及其本机保存的 API Key。若它是当前路由，网关将不再转发后续请求。</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={Boolean(busy)}>取消</AlertDialogCancel>
          <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" disabled={Boolean(busy)} onClick={(event) => {
            event.preventDefault();
            if (!deleteTarget) return;
            void run(`delete-${deleteTarget.id}`, async () => {
              const result = await api(`/api/upstreams/${deleteTarget.id}`, { method: "DELETE" });
              setDeleteTarget(undefined);
              return result;
            }, "中转已删除。");
          }}>删除</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
      {toastMessage && <Toast key={toastMessage.id} onOpenChange={(open) => { if (!open) setToastMessage(undefined); }} open variant={toastMessage.variant}>
        {toastMessage.variant === "destructive" ? <CircleAlert className="mt-0.5 size-4 text-destructive" /> : <CircleCheck className="mt-0.5 size-4 text-primary" />}
        <div>
          <ToastTitle>{toastMessage.title}</ToastTitle>
          <ToastDescription>{toastMessage.description}</ToastDescription>
        </div>
        <ToastClose />
      </Toast>}
      <ToastViewport />
    </TooltipProvider>
  </ToastProvider>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);

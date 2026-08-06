import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "@iarna/toml";

const windowsRetryCount = 3;
const windowsRetryDelayMs = 80;

type PathApi = Pick<typeof path, "join" | "resolve">;
type JsonObject = Record<string, unknown>;
type RenameOperation = (from: string, to: string) => Promise<void>;

export type CodexConfigurationResult = {
  configured: true;
  backupsCreated: number;
  message: string;
};

export type CodexConfigurationOptions = {
  accessToken: string;
  gatewayHost: string;
  gatewayPort: number;
  codexHome?: string;
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  platform?: NodeJS.Platform;
};

/**
 * 根据 Codex 环境变量或当前用户目录计算配置目录。
 * @param environment 运行 Controller 的环境变量。
 * @param homeDirectory 当前用户主目录，用于未设置 CODEX_HOME 时的默认值。
 * @param paths 参与路径运算的平台路径实现，测试可传入 path.win32。
 * @returns 绝对的 Codex 配置目录。
 * @remarks 使用 Node 路径 API，避免依赖 shell 展开或特定操作系统命令。
 */
export function resolveCodexHome(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = os.homedir(),
  paths: PathApi = path
): string {
  const configuredHome = environment.CODEX_HOME?.trim();
  return configuredHome ? paths.resolve(configuredHome) : paths.join(homeDirectory, ".codex");
}

/**
 * 拒绝将配置目录解析为文件系统根目录，防止错误环境变量扩大权限修改范围。
 * @param codexHome 已解析或待解析的 Codex 配置目录。
 * @returns 可安全用于创建和设置权限的绝对目录。
 * @throws 目录为文件系统根目录时抛出中文错误。
 */
function safeCodexHome(codexHome: string): string {
  const resolved = path.resolve(codexHome);
  if (resolved === path.parse(resolved).root) throw new Error("Codex 配置目录无效，未执行配置。");
  return resolved;
}

/**
 * 生成可同时用于 macOS 与 Windows 文件名的 UTC 备份时间戳。
 * @param date 需要格式化的时间，默认使用当前时间。
 * @returns 不含冒号等 Windows 保留字符的 UTC 时间戳。
 */
export function backupTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace(/[-:.]/g, "");
}

/**
 * 在 Windows 文件被短暂占用时重试原子替换操作。
 * @param from 同目录下已写入完成的临时文件。
 * @param to 要替换的目标文件。
 * @param platform 当前平台标识。
 * @param operation 实际的重命名操作，测试时可注入。
 * @param retryDelayMs 每次重试前的等待时间。
 * @returns 替换完成后的 Promise。
 * @throws 非 Windows 错误、不可重试错误或超过重试次数时抛出原始错误。
 */
export async function replaceFileWithRetry(
  from: string,
  to: string,
  platform: NodeJS.Platform,
  operation: RenameOperation = rename,
  retryDelayMs: number = windowsRetryDelayMs
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await operation(from, to);
      return;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : "";
      const retryable = platform === "win32" && ["EPERM", "EACCES"].includes(code) && attempt < windowsRetryCount;
      if (!retryable) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}

/**
 * 将字符串编码为适合 TOML 基本字符串的字面量。
 * @param value 要写入 TOML 的字符串。
 * @returns 已转义的 TOML 字符串字面量。
 */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * 读取可选的 UTF-8 文本文件，并区分文件不存在与读取失败。
 * @param filePath 要读取的文件路径。
 * @returns 文件不存在时为 null，否则为完整文本。
 * @throws 除 ENOENT 外的文件系统错误会原样抛出。
 */
async function readOptionalText(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * 验证 JSON 文本为可合并的对象。
 * @param content auth.json 原始文本。
 * @returns 已解析的 JSON 对象。
 * @throws JSON 非法或根节点不是对象时抛出中文错误。
 */
function parseAuthObject(content: string): JsonObject {
  try {
    const value: unknown = JSON.parse(content);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("根节点不是对象");
    return value as JsonObject;
  } catch (_) {
    throw new Error("当前 Codex auth.json 格式无效，未执行配置。");
  }
}

/**
 * 确保已有或待写入的 TOML 可以被完整解析。
 * @param content TOML 文本。
 * @param phase 用于定位错误阶段的中文名称。
 * @returns 无返回值。
 * @throws TOML 非法时抛出不包含原文的中文错误。
 */
function parseTomlConfig(content: string, phase: "当前" | "生成的"): JsonObject {
  try {
    return parseToml(content) as JsonObject;
  } catch (_) {
    throw new Error(`${phase} Codex config.toml 格式无效，未执行配置。`);
  }
}

/**
 * 确保已有或待写入的 TOML 可以被完整解析。
 * @param content TOML 文本。
 * @param phase 用于定位错误阶段的中文名称。
 * @returns 无返回值。
 * @throws TOML 非法时抛出不包含原文的中文错误。
 */
function validateToml(content: string, phase: "当前" | "生成的"): void {
  parseTomlConfig(content, phase);
}

/**
 * 更新或插入 TOML 顶层字符串配置，不改变其它字段及注释。
 * @param content 当前 TOML 文本。
 * @param key 要写入的顶层字段名。
 * @param value 要写入的字符串值。
 * @returns 更新后的 TOML 文本。
 * @remarks TOML 顶层键必须位于首个表之前；此处只处理本功能固定的简单字符串键。
 */
function setRootString(content: string, key: string, value: string): string {
  return setRootValue(content, key, tomlString(value));
}

/**
 * 更新或插入 TOML 顶层值，不改变其它字段及注释。
 * @param content 当前 TOML 文本。
 * @param key 要写入的顶层字段名。
 * @param value 要写入的 TOML 字面量。
 * @returns 更新后的 TOML 文本。
 * @remarks 顶层键必须位于首个表之前；此处仅处理本功能固定的简单值。
 */
function setRootValue(content: string, key: string, value: string): string {
  const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
  const tableIndex = content.search(/^\s*\[/m);
  const rootEnd = tableIndex < 0 ? content.length : tableIndex;
  const root = content.slice(0, rootEnd);
  const rest = content.slice(rootEnd);
  const expression = new RegExp(`^([\\t ]*${key}[\\t ]*=[\\t ]*)[^#\\r\\n]*((?:[\\t ]*#.*)?)$`, "m");
  if (expression.test(root)) return `${root.replace(expression, `$1${value}$2`)}${rest}`;

  const insertion = `${key} = ${value}${lineEnding}`;
  return `${root}${root && !root.endsWith("\n") && !root.endsWith("\r") ? lineEnding : ""}${insertion}${rest}`;
}

/**
 * 转义动态生成的正则表达式文本。
 * @param value 要作为正则字面量匹配的文本。
 * @returns 可安全嵌入正则表达式的文本。
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 更新当前自定义 provider 表中的单个键，不创建新的 provider 表。
 * @param content 当前 TOML 文本。
 * @param providerId 当前 model_provider 标识。
 * @param key 要更新的 provider 字段。
 * @param value 要写入的 TOML 字面量。
 * @returns 更新后的 TOML 文本。
 * @throws 找不到当前 provider 的顶层表时抛出中文错误。
 */
function setProviderValue(content: string, providerId: string, key: string, value: string): string {
  const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
  const header = new RegExp(`^[\\t ]*\\[\\s*model_providers\\.${escapeRegExp(providerId)}\\s*\\][^\\r\\n]*(?:\\r?\\n|$)`, "m");
  const match = header.exec(content);
  if (!match || match.index === undefined) throw new Error("当前 model_provider 未定义可更新的 provider，未执行配置。");
  const bodyStart = match.index + match[0].length;
  const nextTable = content.slice(bodyStart).search(/^\s*\[/m);
  const bodyEnd = nextTable < 0 ? content.length : bodyStart + nextTable;
  const before = content.slice(0, bodyStart);
  const body = content.slice(bodyStart, bodyEnd);
  const after = content.slice(bodyEnd);
  const expression = new RegExp(`^([\\t ]*${key}[\\t ]*=[\\t ]*)[^#\\r\\n]*((?:[\\t ]*#.*)?)$`, "m");
  const nextBody = expression.test(body)
    ? body.replace(expression, `$1${value}$2`)
    : `${key} = ${value}${lineEnding}${body}`;
  return `${before}${nextBody}${after}`;
}

/**
 * 将已有配置文本合并为可供本地 Gateway 使用的 Codex 配置。
 * @param current 当前 config.toml 文本；null 表示文件尚不存在。
 * @param gatewayHost 本地 Gateway 监听地址。
 * @param gatewayPort 本地 Gateway 监听端口。
 * @returns 已通过 TOML 语法校验的配置文本。
 * @throws 现有配置、认证冲突或当前 provider 不存在时抛出中文错误。
 */
export function mergeCodexConfig(current: string | null, gatewayHost: string, gatewayPort: number): string {
  if (!Number.isInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65_535) throw new Error("本地 Gateway 端口无效，未执行配置。");
  if (!gatewayHost || /[\r\n]/.test(gatewayHost)) throw new Error("本地 Gateway 地址无效，未执行配置。");
  const existing = current ?? "";
  const parsed = current === null ? {} : parseTomlConfig(existing, "当前");
  const currentProvider = typeof parsed.model_provider === "string" && parsed.model_provider.trim()
    ? parsed.model_provider.trim()
    : "openai";
  const baseUrl = `http://${gatewayHost}:${gatewayPort}/v1`;
  let merged = existing;
  merged = setRootString(merged, "preferred_auth_method", "apikey");
  merged = setRootString(merged, "cli_auth_credentials_store", "file");
  if (currentProvider === "openai") {
    merged = setRootString(merged, "openai_base_url", baseUrl);
  } else {
    const providers = parsed.model_providers;
    const provider = providers && typeof providers === "object" && !Array.isArray(providers)
      ? (providers as JsonObject)[currentProvider]
      : undefined;
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
      throw new Error("当前 model_provider 未定义可更新的 provider，未执行配置。");
    }
    const providerConfig = provider as JsonObject;
    if ("env_key" in providerConfig || "auth" in providerConfig || "experimental_bearer_token" in providerConfig) {
      throw new Error("当前 provider 使用了不兼容的认证方式，未执行配置。");
    }
    merged = setProviderValue(merged, currentProvider, "base_url", tomlString(baseUrl));
    merged = setProviderValue(merged, currentProvider, "wire_api", '"responses"');
    merged = setProviderValue(merged, currentProvider, "requires_openai_auth", "true");
  }
  validateToml(merged, "生成的");
  return merged;
}

/**
 * 将已有认证对象合并为本地 Gateway 的 API Key 认证文件。
 * @param current 当前 auth.json 文本；null 表示文件尚不存在。
 * @param accessToken Controller 内存中的本地 Gateway 访问令牌。
 * @returns 格式化后的 auth.json 文本。
 * @throws 认证文件非法或令牌为空时抛出中文错误。
 */
function mergeAuthConfig(current: string | null, accessToken: string): string {
  const token = accessToken.trim();
  if (!token) throw new Error("未设置 GATEWAY_ACCESS_TOKEN，无法配置 Codex 认证。");
  const existing = current === null ? {} : parseAuthObject(current);
  return `${JSON.stringify({ ...existing, auth_mode: "apikey", OPENAI_API_KEY: token }, null, 2)}\n`;
}

/**
 * 在同一目录写入临时文件并将其原子替换为目标文件。
 * @param filePath 最终目标文件路径。
 * @param content 已校验的文件文本。
 * @param platform 当前平台标识。
 * @returns 无返回值。
 * @throws 无法写入、同步或替换时抛出底层错误。
 */
async function atomicWrite(filePath: string, content: string, platform: NodeJS.Platform): Promise<void> {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (platform !== "win32") await chmod(temporaryPath, 0o600);
    await replaceFileWithRetry(temporaryPath, filePath, platform);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

/**
 * 创建原始配置文件的受限权限备份。
 * @param filePath 原始文件路径。
 * @param content 原始文件内容；null 时不创建备份。
 * @param timestamp 用于构造安全备份文件名的时间戳。
 * @param platform 当前平台标识。
 * @returns 实际创建的备份数量。
 */
async function backupIfPresent(filePath: string, content: string | null, timestamp: string, platform: NodeJS.Platform): Promise<number> {
  if (content === null) return 0;
  const backupPath = `${filePath}.gateway-backup-${timestamp}`;
  await writeFile(backupPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  if (platform !== "win32") await chmod(backupPath, 0o600);
  return 1;
}

/**
 * 尝试在后续文件替换失败时恢复已经替换的文件。
 * @param filePath 需要恢复的目标文件。
 * @param original 原始文本；null 表示原文件不存在。
 * @param platform 当前平台标识。
 * @returns 是否已成功恢复。
 * @remarks 恢复失败时仍保留先前创建的备份，调用方不会暴露具体路径。
 */
async function restoreOriginal(filePath: string, original: string | null, platform: NodeJS.Platform): Promise<boolean> {
  try {
    if (original === null) {
      await rm(filePath, { force: true });
    } else {
      await atomicWrite(filePath, original, platform);
    }
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 安全地将当前机器的 Codex 全局配置切换为本地 Gateway。
 * @param options Gateway 地址、访问令牌及可测试的目录和平台覆盖项。
 * @returns 不含路径和凭据的一键配置结果。
 * @throws 输入、现有配置或文件系统失败时抛出中文错误；已替换的文件会尽力回滚。
 */
export async function configureCodex(options: CodexConfigurationOptions): Promise<CodexConfigurationResult> {
  if (!options.accessToken.trim()) throw new Error("未设置 GATEWAY_ACCESS_TOKEN，无法配置 Codex 认证。");
  const platform = options.platform ?? process.platform;
  const codexHome = safeCodexHome(options.codexHome ?? resolveCodexHome(options.environment, options.homeDirectory));
  const configPath = path.join(codexHome, "config.toml");
  const authPath = path.join(codexHome, "auth.json");

  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  if (platform !== "win32") await chmod(codexHome, 0o700);

  const [currentConfig, currentAuth] = await Promise.all([readOptionalText(configPath), readOptionalText(authPath)]);
  const nextConfig = mergeCodexConfig(currentConfig, options.gatewayHost, options.gatewayPort);
  const nextAuth = mergeAuthConfig(currentAuth, options.accessToken);
  const timestamp = `${backupTimestamp()}-${randomUUID()}`;
  const backupsCreated = (await backupIfPresent(configPath, currentConfig, timestamp, platform))
    + (await backupIfPresent(authPath, currentAuth, timestamp, platform));

  let configReplaced = false;
  let authReplaced = false;
  try {
    await atomicWrite(configPath, nextConfig, platform);
    configReplaced = true;
    await atomicWrite(authPath, nextAuth, platform);
    authReplaced = true;
  } catch (_) {
    const recoveredConfig = !configReplaced || await restoreOriginal(configPath, currentConfig, platform);
    const recoveredAuth = !authReplaced || await restoreOriginal(authPath, currentAuth, platform);
    if (!recoveredConfig || !recoveredAuth) throw new Error("写入 Codex 配置失败，已保留备份，请手动恢复。");
    throw new Error("写入 Codex 配置失败，原配置未被修改。");
  }

  return { configured: true, backupsCreated, message: "Codex 已配置为使用本地 Gateway，请重启 Codex 后继续使用。" };
}

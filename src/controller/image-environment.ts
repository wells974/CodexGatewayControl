import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const shellBlockStart = "# >>> Codex Gateway Control OpenAI environment >>>";
const shellBlockEnd = "# <<< Codex Gateway Control OpenAI environment <<<";
const shellBlockStartPattern = /^# >>> Codex Gateway Control OpenAI[^\r\n]*>>>[ \t]*(?:\r?\n|$)/gm;
const shellBlockEndPattern = /^# <<< Codex Gateway Control OpenAI[^\r\n]*<<<[ \t]*(?:\r?\n|$)/gm;
const localProxyBypassHosts = "127.0.0.1,localhost,::1";

export type ImageEnvironmentOptions = {
  accessToken: string;
  baseUrl: string;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  executeCommand?: (file: string, arguments_: string[]) => Promise<unknown>;
};

export type ImageEnvironmentResult = {
  configured: true;
  message: string;
};

/**
 * 将本机地址加入 Windows 当前用户的代理绕过列表。
 * @param executeCommand 可执行系统命令的函数，测试时可注入替身。
 * @param environment 当前进程环境，用于合并已有的大小写变量值。
 * @returns 环境变量写入完成后的 Promise。
 * @throws setx 执行失败时抛出底层错误。
 * @remarks 只增加本机地址，不关闭或覆盖用户已有的代理配置；新启动的 Codex 进程才会读取变更。
 */
export async function configureWindowsProxyBypass(
  executeCommand: (file: string, arguments_: string[]) => Promise<unknown> = executeFile,
  environment: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const current = [environment.NO_PROXY, environment.no_proxy]
    .filter((value): value is string => Boolean(value?.trim()))
    .flatMap((value) => value.split(/[;,]/).map((entry) => entry.trim()))
    .filter(Boolean);
  const entries = [...new Set([...current, ...localProxyBypassHosts.split(",")])];
  const value = entries.join(",");
  await executeCommand("setx", ["NO_PROXY", value]);
  await executeCommand("setx", ["no_proxy", value]);
  environment.NO_PROXY = value;
  environment.no_proxy = value;
}

/**
 * 将本机地址加入 macOS 图形会话和常用 Shell 的代理绕过列表。
 * @param homeDirectory 当前用户主目录，用于定位 Shell 启动文件。
 * @param executeCommand 可执行 launchctl 的函数，测试时可注入替身。
 * @returns 代理绕过配置完成后的 Promise。
 * @throws 启动文件读写或 launchctl 执行失败时抛出底层错误。
 * @remarks 保留已有 NO_PROXY/no_proxy 地址；新启动的 Codex 进程才会读取 Shell 配置变更。
 */
export async function configureMacProxyBypass(
  homeDirectory: string = homedir(),
  executeCommand: (file: string, arguments_: string[]) => Promise<unknown> = executeFile
): Promise<void> {
  for (const filePath of macShellProfilePaths(homeDirectory)) {
    const current = await readOptionalText(filePath);
    const lineEnding = current?.includes("\r\n") ? "\r\n" : "\n";
    const lines = (current ?? "").split(/\r?\n/);
    const found = new Set<string>();
    const updated = lines.flatMap((line) => {
      const match = line.match(/^\s*(?:export\s+)?(NO_PROXY|no_proxy)\s*=/);
      if (!match) return [line];
      const name = match[1];
      if (found.has(name)) return [];
      found.add(name);
      const currentValue = line.slice(line.indexOf("=") + 1).trim().replace(/^['\"]|['\"]$/g, "");
      const entries = [...new Set([...currentValue.split(/[;,]/).map((entry) => entry.trim()).filter(Boolean), ...localProxyBypassHosts.split(",")])];
      return [`export ${name}=${shellSingleQuote(entries.join(","))}`];
    });
    for (const name of ["NO_PROXY", "no_proxy"]) {
      if (!found.has(name)) updated.push(`export ${name}=${shellSingleQuote(localProxyBypassHosts)}`);
    }
    await atomicWriteShellProfile(filePath, `${updated.join(lineEnding).replace(/(?:\r?\n)*$/, "")}${lineEnding}`);
  }
  await executeCommand("launchctl", ["setenv", "NO_PROXY", localProxyBypassHosts]);
  await executeCommand("launchctl", ["setenv", "no_proxy", localProxyBypassHosts]);
}

/**
 * 返回 macOS 上需要维护的 Zsh 与 Bash 启动文件路径。
 * @param homeDirectory 当前用户的主目录，测试时可传入临时目录。
 * @returns 按 Shell 启动场景覆盖的配置文件绝对路径。
 * @remarks `.zprofile` 覆盖 Zsh login shell，`.zshrc` 覆盖交互式 Zsh；Bash 对应使用 `.bash_profile` 与 `.bashrc`。
 */
export function macShellProfilePaths(homeDirectory: string): string[] {
  return [".zprofile", ".zshrc", ".bash_profile", ".bashrc"].map((fileName) => path.join(homeDirectory, fileName));
}

/**
 * 将值转换为可安全嵌入 POSIX Shell 单引号字面量的形式。
 * @param value 需要写入环境变量的值。
 * @returns 不会被 Shell 解释为命令的单引号字面量。
 * @remarks 单引号会拆分为相邻的单引号与双引号片段；换行由调用方预先拒绝。
 */
function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

/**
 * 合并本功能受管理的 macOS Shell 环境变量区块。
 * @param current 配置文件当前内容；文件不存在时传入 null。
 * @param accessToken 要写入的本地 Gateway 认证令牌。
 * @param baseUrl 要写入的 OpenAI API 基础地址。
 * @returns 保留用户无关内容且只含一个受管理区块的新文件内容。
 * @throws 标记区块残缺、重复或顺序错误时抛出错误，避免猜测性覆盖用户配置。
 */
export function mergeMacShellEnvironment(current: string | null, accessToken: string, baseUrl: string): string {
  const originalContent = current ?? "";
  const lineEnding = originalContent.includes("\r\n") ? "\r\n" : "\n";
  const starts = [...originalContent.matchAll(shellBlockStartPattern)];
  const ends = [...originalContent.matchAll(shellBlockEndPattern)];
  if (starts.length !== ends.length || starts.length > 1 || (starts.length === 1 && (starts[0].index ?? -1) > (ends[0].index ?? -1))) {
    throw new Error("检测到生图环境变量配置区块不完整，已停止写入以保护现有 Shell 配置。");
  }

  const content = starts.length === 1
    ? `${originalContent.slice(0, starts[0].index ?? 0)}${originalContent.slice((ends[0].index ?? 0) + ends[0][0].length)}`
    : originalContent;
  const existing = replaceExistingEnvironmentAssignments(content, accessToken, baseUrl, lineEnding);
  const missingNames = ["OPENAI_API_KEY", "OPENAI_BASE_URL"].filter((name) => !existing.found.has(name));
  if (!missingNames.length) return existing.content;

  const values: Record<string, string> = {
    OPENAI_API_KEY: accessToken,
    OPENAI_BASE_URL: baseUrl
  };
  const block = [
    shellBlockStart,
    ...missingNames.map((name) => `export ${name}=${shellSingleQuote(values[name])}`),
    shellBlockEnd
  ].join(lineEnding);
  if (!existing.content) return `${block}${lineEnding}`;
  const separator = existing.content.endsWith("\n") || existing.content.endsWith("\r") ? lineEnding : `${lineEnding}${lineEnding}`;
  return `${existing.content}${separator}${block}${lineEnding}`;
}

/**
 * 更新启动文件中已有的环境变量赋值，并记录仍需新增的变量。
 * @param content 已移除旧受管区块的 Shell 文件内容。
 * @param accessToken 需要写入的 API Key。
 * @param baseUrl 需要写入的 API 基础地址。
 * @param lineEnding 当前文件使用的换行符。
 * @returns 更新后的内容和已发现的变量名集合。
 * @remarks 同一变量的重复赋值只保留第一条并更新，防止旧值继续覆盖新值。
 */
function replaceExistingEnvironmentAssignments(content: string, accessToken: string, baseUrl: string, lineEnding: string): { content: string; found: Set<string> } {
  const values: Record<string, string> = { OPENAI_API_KEY: accessToken, OPENAI_BASE_URL: baseUrl };
  const found = new Set<string>();
  const lines = content.split(/\r?\n/);
  const updatedLines: string[] = [];
  for (const line of lines) {
    const match = line.match(/^\s*(?:export\s+)?(OPENAI_API_KEY|OPENAI_BASE_URL)\s*=/);
    if (!match) {
      updatedLines.push(line);
      continue;
    }
    const name = match[1];
    if (found.has(name)) continue;
    found.add(name);
    updatedLines.push(`export ${name}=${shellSingleQuote(values[name])}`);
  }
  const trailingLineEnding = content.endsWith("\n") || content.endsWith("\r") ? lineEnding : "";
  return { content: `${updatedLines.join(lineEnding)}${trailingLineEnding}`, found };
}

/**
 * 读取可选文本文件，不存在时以 null 表示。
 * @param filePath 要读取的文件绝对路径。
 * @returns 文件 UTF-8 内容，或文件不存在时的 null。
 * @throws 文件存在但无法读取时保留原始错误，避免误判为可安全覆盖。
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
 * 通过同目录临时文件原子更新含认证信息的 Shell 启动文件。
 * @param filePath 需要更新的 Shell 启动文件绝对路径。
 * @param content 已合并的完整文件内容。
 * @returns 写入完成后的 Promise。
 * @throws 临时文件创建、同步或替换失败时抛出错误；替换前的原文件保持不变。
 * @remarks 写入完成后会设置 0600，防止同机其他用户读取环境变量中的认证材料。
 */
async function atomicWriteShellProfile(filePath: string, content: string): Promise<void> {
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  } finally {
    await handle?.close();
    await rm(temporaryPath, { force: true });
  }
}

/**
 * 校验要写入 Shell 与系统环境变量的认证材料。
 * @param token 待写入的 API Key。
 * @param baseUrl 待写入的 OpenAI API 基础地址。
 * @returns 去除首尾空白后的安全值。
 * @throws 令牌、地址为空或含有换行时抛出中文错误，避免 Shell 配置注入。
 */
function validatedEnvironmentValues(token: string, baseUrl: string): { token: string; baseUrl: string } {
  if (/\r|\n/.test(token) || /\r|\n/.test(baseUrl)) throw new Error("生图环境变量不能包含换行符。");
  const normalizedToken = token.trim();
  const normalizedBaseUrl = baseUrl.trim();
  if (!normalizedToken || !normalizedBaseUrl) throw new Error("本地 Gateway 认证信息不完整，无法配置生图环境变量。");
  return { token: normalizedToken, baseUrl: normalizedBaseUrl };
}

/**
 * 为当前用户持久化生图所需的 OpenAI 环境变量。
 * @param options 本地 Gateway 令牌、基础地址及可测试的平台与用户目录覆盖项。
 * @returns 环境变量配置成功后的非敏感结果。
 * @throws 当前平台不受支持、令牌为空、Shell 配置保护校验失败或系统环境变量工具执行失败时抛出中文错误。
 * @remarks macOS 同步更新 launchctl、Zsh 与 Bash 启动文件；Windows 使用 setx 写入用户环境并维护本机代理绕过地址；令牌不会写入日志或返回给浏览器。
 */
export async function configureImageEnvironment(options: ImageEnvironmentOptions): Promise<ImageEnvironmentResult> {
  const { token, baseUrl } = validatedEnvironmentValues(options.accessToken, options.baseUrl);
  const platform = options.platform ?? process.platform;
  const executeCommand = options.executeCommand ?? executeFile;

  if (platform === "darwin") {
    const homeDirectory = options.homeDirectory ?? homedir();
    const profiles = await Promise.all(macShellProfilePaths(homeDirectory).map(async (filePath) => ({
      filePath,
      content: mergeMacShellEnvironment(await readOptionalText(filePath), token, baseUrl)
    })));
    for (const profile of profiles) await atomicWriteShellProfile(profile.filePath, profile.content);
    await executeCommand("launchctl", ["setenv", "OPENAI_API_KEY", token]);
    await executeCommand("launchctl", ["setenv", "OPENAI_BASE_URL", baseUrl]);
  } else if (platform === "win32") {
    await executeCommand("setx", ["OPENAI_API_KEY", token]);
    await executeCommand("setx", ["OPENAI_BASE_URL", baseUrl]);
  } else {
    throw new Error("当前系统暂不支持自动配置生图环境变量。");
  }

  process.env.OPENAI_API_KEY = token;
  process.env.OPENAI_BASE_URL = baseUrl;
  return { configured: true, message: "生图环境变量已写入当前用户环境。" };
}

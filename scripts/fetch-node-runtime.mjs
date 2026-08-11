#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const nodeVersion = "22.13.1";
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cacheRoot = path.join(projectRoot, ".cache", "node-runtime");
const outputRoot = path.join(projectRoot, "packaging", "node-runtime");
const targets = {
  "win-x64": { platform: "win", arch: "x64", archive: `node-v${nodeVersion}-win-x64.zip`, binary: "node.exe" },
  "mac-x64": { platform: "mac", arch: "x64", archive: `node-v${nodeVersion}-darwin-x64.tar.gz`, binary: "bin/node" },
  "mac-arm64": { platform: "mac", arch: "arm64", archive: `node-v${nodeVersion}-darwin-arm64.tar.gz`, binary: "bin/node" }
};

/**
 * 执行不经过 shell 的本地解压命令。
 * @param {string} command 解压程序名称。
 * @param {string[]} args 传给程序的参数。
 * @returns {Promise<void>} 命令成功退出后完成。
 * @throws 解压程序不存在或返回非零退出码时抛出错误。
 */
function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: projectRoot, windowsHide: true }, (error, _stdout, stderr) => {
      if (error) reject(new Error(`${command} 解压失败：${stderr.trim() || error.message}`));
      else resolve();
    });
  });
}

/**
 * 等待指定时长后继续执行。
 * @param {number} delayMs 等待时长，单位为毫秒。
 * @returns {Promise<void>} 等待结束后完成。
 * @remarks 仅用于下载失败后的退避重试，不会阻塞 Node.js 事件循环。
 */
function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * 提取下载错误中可用于排查网络问题的底层原因。
 * @param {unknown} error 下载过程中捕获的异常。
 * @returns {string} 可安全输出到命令行的错误摘要。
 * @remarks 仅输出错误代码和消息，不读取或输出环境变量、请求头等潜在敏感信息。
 */
function describeDownloadError(error) {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  if (cause && typeof cause === "object") {
    const details = /** @type {{ code?: unknown, message?: unknown }} */ (cause);
    const code = typeof details.code === "string" ? `${details.code}: ` : "";
    const message = typeof details.message === "string" ? details.message : "";
    if (code || message) return `${error.message}（${code}${message}）`;
  }
  return error.message;
}

/**
 * 下载指定 URL 的二进制内容，并在短暂网络故障时自动重试。
 * @param {string} url 官方 Node.js 下载地址。
 * @param {number} maxAttempts 最大请求次数。
 * @returns {Promise<Buffer>} 下载的二进制内容。
 * @throws 多次请求均失败或 HTTP 状态异常时抛出错误。
 * @remarks 每次请求最多等待一分钟；重试之间使用递增退避，避免一次网络波动直接中断打包。
 */
async function download(url, maxAttempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) break;
      console.warn(`下载 Node.js runtime 失败，第 ${attempt} 次请求将在 ${attempt} 秒后重试：${describeDownloadError(error)}`);
      await wait(attempt * 1_000);
    }
  }
  throw new Error(`下载 Node.js runtime 失败，已尝试 ${maxAttempts} 次：${describeDownloadError(lastError)}`, { cause: lastError });
}

/**
 * 从本地缓存读取并校验 Node.js runtime 压缩包。
 * @param {string} archivePath 缓存压缩包路径。
 * @param {string} expected 官方 SHA-256 摘要。
 * @returns {Promise<Buffer|null>} 缓存有效时返回压缩包内容；不存在或校验失败时返回 null。
 * @remarks 校验失败的缓存会被删除，避免后续打包继续使用损坏文件。
 */
async function readCachedArchive(archivePath, expected) {
  try {
    const archive = await readFile(archivePath);
    verifySha256(archive, expected);
    console.log(`复用已校验的 Node.js runtime 缓存：${path.basename(archivePath)}`);
    return archive;
  } catch (error) {
    if (error && typeof error === "object" && /** @type {{ code?: unknown }} */ (error).code === "ENOENT") return null;
    await rm(archivePath, { force: true });
    console.warn(`Node.js runtime 缓存无效，已重新下载：${path.basename(archivePath)}`);
    return null;
  }
}

/**
 * 校验下载文件的官方 SHA-256 摘要。
 * @param {Buffer} content 下载文件内容。
 * @param {string} expected 官方 SHA-256 摘要。
 * @returns {void} 校验成功后返回。
 * @throws 摘要不匹配时抛出错误，阻止不完整或被篡改的 runtime 进入安装包。
 */
function verifySha256(content, expected) {
  const actual = createHash("sha256").update(content).digest("hex");
  if (actual !== expected) throw new Error(`Node.js runtime SHA-256 校验失败：期望 ${expected}，实际 ${actual}`);
}

/**
 * 从官方校验清单中读取目标压缩包的 SHA-256 摘要。
 * @param {string} manifest 官方 SHASUMS256.txt 文本。
 * @param {string} archive 压缩包文件名。
 * @returns {string} 目标压缩包的十六进制摘要。
 * @throws 清单中不存在目标文件时抛出错误。
 */
function expectedSha256(manifest, archive) {
  const escaped = archive.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = manifest.match(new RegExp(`^([a-f0-9]{64})\\s+${escaped}$`, "mi"));
  if (!match) throw new Error(`官方校验清单中未找到 ${archive}。`);
  return match[1].toLowerCase();
}

/**
 * 获取并准备指定平台的 Node.js runtime。
 * @param {string} targetName 目标名称：win-x64、mac-x64 或 mac-arm64。
 * @returns {Promise<void>} runtime 写入 packaging/node-runtime 后完成。
 * @throws 下载、校验、解压或复制失败时抛出错误。
 */
async function prepare(targetName) {
  const target = targets[targetName];
  if (!target) throw new Error(`未知 runtime 目标：${targetName}`);
  const baseUrl = `https://nodejs.org/dist/v${nodeVersion}`;
  const archivePath = path.join(cacheRoot, target.archive);
  await mkdir(cacheRoot, { recursive: true });
  const manifest = await download(`${baseUrl}/SHASUMS256.txt`);
  const expected = expectedSha256(manifest.toString("utf8"), target.archive);
  let archive = await readCachedArchive(archivePath, expected);
  if (!archive) {
    archive = await download(`${baseUrl}/${target.archive}`);
    verifySha256(archive, expected);
    writeFileSync(archivePath, archive);
  }

  const extractionRoot = path.join(cacheRoot, `${targetName}-extracted`);
  await rm(extractionRoot, { recursive: true, force: true });
  await mkdir(extractionRoot, { recursive: true });
  if (target.archive.endsWith(".zip")) {
    await run("tar", ["-xf", archivePath, "-C", extractionRoot]);
  } else {
    await run("tar", ["-xzf", archivePath, "-C", extractionRoot]);
  }

  const extractedRoot = path.join(extractionRoot, `node-v${nodeVersion}-${target.platform === "win" ? "win" : "darwin"}-${target.arch}`);
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  if (target.platform === "win") {
    await cp(path.join(extractedRoot, target.binary), path.join(outputRoot, target.binary));
  } else {
    await mkdir(path.join(outputRoot, "bin"), { recursive: true });
    await cp(path.join(extractedRoot, target.binary), path.join(outputRoot, target.binary));
    chmodSync(path.join(outputRoot, target.binary), 0o755);
  }
  console.log(`Node.js ${nodeVersion} runtime 已准备：${targetName}`);
}

const targetName = process.argv[2] === "--target" ? process.argv[3] : "";
prepare(targetName).catch((error) => {
  console.error(`Node.js runtime 准备失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

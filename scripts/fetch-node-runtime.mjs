#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
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
 * 下载指定 URL 的二进制内容。
 * @param {string} url 官方 Node.js 下载地址。
 * @returns {Promise<Buffer>} 下载的二进制内容。
 * @throws HTTP 状态异常或网络请求失败时抛出错误。
 */
async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载 Node.js runtime 失败：HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
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
  const archive = await download(`${baseUrl}/${target.archive}`);
  const manifest = await download(`${baseUrl}/SHASUMS256.txt`);
  verifySha256(archive, expectedSha256(manifest.toString("utf8"), target.archive));
  writeFileSync(archivePath, archive);

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

#!/usr/bin/env node

import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = path.join(projectRoot, "dist-runtime");

/**
 * 将一个 Node.js 入口及其生产依赖打包为可随安装包分发的 ESM 文件。
 * @param {string} entryPoint 需要打包的源码入口。
 * @param {string} outputFile 打包后的输出路径。
 * @returns {Promise<void>} 打包完成后结束。
 * @throws esbuild 无法解析依赖或生成文件时抛出错误。
 * @remarks Node 内置模块保持 external，确保 `node:sqlite` 等能力由内置 Node 22 提供。
 */
async function bundleRuntime(entryPoint, outputFile) {
  await build({
    entryPoints: [entryPoint],
    outfile: outputFile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "bundle",
    external: ["node:*"],
    minify: true,
    sourcemap: false,
    legalComments: "none",
    banner: {
      js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);'
    }
  });
}

/**
 * 清理并生成 Electron 安装包需要的最小 Gateway runtime 目录。
 * @returns {Promise<void>} 所有运行时文件准备完成后结束。
 * @throws 构建目录不存在或文件复制失败时抛出错误。
 * @remarks 不复制源码、测试、开发依赖或项目配置文件。
 */
async function main() {
  await rm(runtimeRoot, { recursive: true, force: true });
  await mkdir(path.join(runtimeRoot, "inject"), { recursive: true });
  await bundleRuntime(
    path.join(projectRoot, "src/controller/index.ts"),
    path.join(runtimeRoot, "controller.mjs")
  );
  await bundleRuntime(
    path.join(projectRoot, "scripts/codex-gateway.mjs"),
    path.join(runtimeRoot, "launcher.mjs")
  );
  await cp(path.join(projectRoot, "dist-web"), path.join(runtimeRoot, "dist-web"), { recursive: true });
  await cp(
    path.join(projectRoot, "inject/codex-gateway.user.js"),
    path.join(runtimeRoot, "inject/codex-gateway.user.js")
  );
  console.log(`Gateway runtime 已生成：${runtimeRoot}`);
}

main().catch((error) => {
  console.error(`Gateway runtime 构建失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

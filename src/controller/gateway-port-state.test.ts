import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  gatewayPortStatePath,
  markCodexConfigurationCurrent,
  readGatewayPortState,
  writeGatewayPortState
} from "./gateway-port-state.js";

/**
 * 创建每个测试独享的 Gateway 数据目录。
 * @returns {Promise<string>} 可安全写入和删除的临时目录。
 * @throws 临时目录无法创建时抛出文件系统错误。
 * @remarks 测试不读取用户真实 Gateway 状态或 Codex 配置。
 */
async function temporaryDataDirectory(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "codex-gateway-port-state-"));
}

test("端口状态会持久化并在配置完成后清除迁移标记", async () => {
  const directory = await temporaryDataDirectory();
  try {
    writeGatewayPortState(directory, { controllerPort: 4001, codexConfigurationRequired: true });
    assert.deepEqual(readGatewayPortState(directory), { controllerPort: 4001, codexConfigurationRequired: true });

    markCodexConfigurationCurrent(directory, 4001);
    assert.deepEqual(readGatewayPortState(directory), { controllerPort: 4001, codexConfigurationRequired: false });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("损坏的端口状态不会被当作可用配置", async () => {
  const directory = await temporaryDataDirectory();
  try {
    await writeFile(gatewayPortStatePath(directory), '{"controllerPort": 80, "codexConfigurationRequired": false}\n', "utf8");
    assert.equal(readGatewayPortState(directory), null);
    assert.equal((await readFile(gatewayPortStatePath(directory), "utf8")).includes("80"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

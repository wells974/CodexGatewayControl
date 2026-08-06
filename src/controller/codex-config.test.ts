import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  backupTimestamp,
  configureCodex,
  mergeCodexConfig,
  replaceFileWithRetry,
  resolveCodexHome
} from "./codex-config.js";

/**
 * 创建隔离的临时 Codex 配置目录。
 * @returns 临时目录路径。
 * @remarks 每个测试独占目录，避免写入当前用户真实的 Codex 配置。
 */
async function temporaryCodexHome(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "codex-gateway-control-test-"));
}

/**
 * 读取临时目录中的文本文件。
 * @param directory 临时 Codex 配置目录。
 * @param fileName 要读取的文件名。
 * @returns 文件 UTF-8 文本。
 */
async function readTemporaryFile(directory: string, fileName: string): Promise<string> {
  return readFile(path.join(directory, fileName), "utf8");
}

test("使用用户目录或 CODEX_HOME 解析 macOS 与 Windows 配置路径", () => {
  assert.equal(resolveCodexHome({}, "/Users/ada", path.posix), "/Users/ada/.codex");
  assert.equal(resolveCodexHome({}, "C:\\Users\\Ada", path.win32), "C:\\Users\\Ada\\.codex");
  assert.equal(resolveCodexHome({ CODEX_HOME: "D:\\Codex Home" }, "C:\\Users\\Ada", path.win32), "D:\\Codex Home");
});

test("生成的备份时间戳不包含 Windows 保留字符", () => {
  assert.equal(backupTimestamp(new Date("2026-08-06T07:08:09.123Z")), "20260806T070809123Z");
});

test("Windows 文件占用错误会重试后完成替换", async () => {
  let attempts = 0;
  await replaceFileWithRetry("temporary", "target", "win32", async () => {
    attempts += 1;
    if (attempts < 3) {
      const error = Object.assign(new Error("文件被占用"), { code: "EPERM" });
      throw error;
    }
  }, 0);
  assert.equal(attempts, 3);
});

test("合并配置保留模型、当前 provider 标识和无关设置，并可重复执行", () => {
  const source = [
    'model = "gpt-5.6-terra"',
    'model_provider = "legacy"',
    "",
    "[model_providers.legacy]",
    'name = "Legacy"',
    'base_url = "https://legacy.example/v1"',
    'wire_api = "responses"',
    "requires_openai_auth = true",
    "",
    "[features]",
    "goals = true",
    ""
  ].join("\n");
  const first = mergeCodexConfig(source, "127.0.0.1", 4000);
  const second = mergeCodexConfig(first, "127.0.0.1", 4000);
  assert.match(second, /model = "gpt-5\.6-terra"/);
  assert.match(second, /model_provider = "legacy"/);
  assert.match(second, /\[features\]\ngoals = true/);
  assert.match(second, /base_url = "http:\/\/127\.0\.0\.1:4000\/v1"/);
  assert.equal(second.includes("codex_gateway_control"), false);
});

test("默认 openai provider 只更新 openai_base_url，不创建 model_providers", () => {
  const configured = mergeCodexConfig('model = "gpt-5.6"\n', "127.0.0.1", 4000);
  assert.match(configured, /openai_base_url = "http:\/\/127\.0\.0\.1:4000\/v1"/);
  assert.equal(configured.includes("model_provider ="), false);
  assert.equal(configured.includes("[model_providers."), false);
});

test("一键配置创建备份且不返回或写出接口外的敏感信息", async () => {
  const directory = await temporaryCodexHome();
  try {
    await writeFile(path.join(directory, "config.toml"), 'model = "preserved-model"\n[features]\ngoals = true\n', "utf8");
    await writeFile(path.join(directory, "auth.json"), '{\n  "existing": true\n}\n', "utf8");
    const result = await configureCodex({
      accessToken: "local-gateway-token",
      gatewayHost: "127.0.0.1",
      gatewayPort: 4000,
      codexHome: directory
    });
    const config = await readTemporaryFile(directory, "config.toml");
    const auth = JSON.parse(await readTemporaryFile(directory, "auth.json")) as Record<string, unknown>;
    const names = await readdir(directory);
    assert.equal(result.configured, true);
    assert.equal(result.backupsCreated, 2);
    assert.equal(JSON.stringify(result).includes("local-gateway-token"), false);
    assert.match(config, /model = "preserved-model"/);
    assert.equal(auth.OPENAI_API_KEY, "local-gateway-token");
    assert.equal(auth.auth_mode, "apikey");
    assert.equal(names.filter((name) => name.includes("gateway-backup")).length, 2);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("令牌缺失、损坏配置、损坏认证和 provider 不可用都不会覆盖原文件", async () => {
  const directory = await temporaryCodexHome();
  try {
    const configPath = path.join(directory, "config.toml");
    const authPath = path.join(directory, "auth.json");
    await writeFile(configPath, 'model = "before"\n', "utf8");
    await writeFile(authPath, '{"auth_mode":"api"}\n', "utf8");
    await assert.rejects(
      configureCodex({ accessToken: "", gatewayHost: "127.0.0.1", gatewayPort: 4000, codexHome: directory }),
      /GATEWAY_ACCESS_TOKEN/
    );
    assert.equal(await readFile(configPath, "utf8"), 'model = "before"\n');

    await writeFile(configPath, "[invalid\n", "utf8");
    await assert.rejects(
      configureCodex({ accessToken: "token", gatewayHost: "127.0.0.1", gatewayPort: 4000, codexHome: directory }),
      /config\.toml/
    );
    assert.equal(await readFile(configPath, "utf8"), "[invalid\n");

    await writeFile(configPath, 'model = "before"\n', "utf8");
    await writeFile(authPath, "{invalid\n", "utf8");
    await assert.rejects(
      configureCodex({ accessToken: "token", gatewayHost: "127.0.0.1", gatewayPort: 4000, codexHome: directory }),
      /auth\.json/
    );
    assert.equal(await readFile(authPath, "utf8"), "{invalid\n");

    const missingProvider = 'model_provider = "missing"\n';
    await writeFile(configPath, missingProvider, "utf8");
    await assert.rejects(
      configureCodex({ accessToken: "token", gatewayHost: "127.0.0.1", gatewayPort: 4000, codexHome: directory }),
      /未定义可更新的 provider/
    );
    assert.equal(await readFile(configPath, "utf8"), missingProvider);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("文件系统根目录不能作为 Codex 配置目录", async () => {
  await assert.rejects(
    configureCodex({
      accessToken: "token",
      gatewayHost: "127.0.0.1",
      gatewayPort: 4000,
      codexHome: path.parse(process.cwd()).root
    }),
    /配置目录无效/
  );
});

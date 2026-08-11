import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { configureImageEnvironment, macShellProfilePaths, mergeMacShellEnvironment } from "./image-environment.js";

test("不支持的平台不会写入生图环境变量", async () => {
  await assert.rejects(
    configureImageEnvironment({ accessToken: "token", baseUrl: "http://127.0.0.1:4000/v1", platform: "linux" }),
    /暂不支持/
  );
});

test("缺少本地令牌时拒绝配置生图环境变量", async () => {
  await assert.rejects(
    configureImageEnvironment({ accessToken: "", baseUrl: "http://127.0.0.1:4000/v1", platform: "linux" }),
    /认证信息不完整/
  );
});

test("macOS 路径同时覆盖 Zsh 与 Bash 的常见启动场景", () => {
  assert.deepEqual(macShellProfilePaths("/tmp/cgc-home"), [
    "/tmp/cgc-home/.zprofile",
    "/tmp/cgc-home/.zshrc",
    "/tmp/cgc-home/.bash_profile",
    "/tmp/cgc-home/.bashrc"
  ]);
});

test("合并 Shell 环境区块会保留原有内容并在重复配置时替换旧值", () => {
  const original = "export PATH=/usr/local/bin\nexport EDITOR=vim\n";
  const first = mergeMacShellEnvironment(original, "token-one", "http://127.0.0.1:4000/v1");
  const second = mergeMacShellEnvironment(first, "token-two", "http://127.0.0.1:4999/v1");
  assert.match(second, /export PATH=\/usr\/local\/bin/);
  assert.match(second, /export EDITOR=vim/);
  assert.doesNotMatch(second, /token-one/);
  assert.match(second, /export OPENAI_API_KEY='token-two'/);
  assert.match(second, /export OPENAI_BASE_URL='http:\/\/127\.0\.0\.1:4999\/v1'/);
  assert.equal((second.match(/Codex Gateway Control OpenAI environment >>>/g) ?? []).length, 1);
});

test("已有环境变量会原位更新，缺失变量才会新增受管区块", () => {
  const existing = "export OPENAI_API_KEY='old-key'\nexport PATH=/usr/local/bin\n";
  const result = mergeMacShellEnvironment(existing, "new-key", "http://127.0.0.1:4000/v1");
  assert.equal((result.match(/OPENAI_API_KEY=/g) ?? []).length, 1);
  assert.match(result, /export OPENAI_API_KEY='new-key'/);
  assert.match(result, /Codex Gateway Control OpenAI environment/);
  assert.match(result, /export OPENAI_BASE_URL='http:\/\/127\.0\.0\.1:4000\/v1'/);
  assert.match(result, /export PATH=\/usr\/local\/bin/);
});

test("旧版中文受管标记会被替换为 ASCII 标记且不会重复变量", () => {
  const old = "# >>> Codex Gateway Control OpenAI 环境变量 >>>\nexport OPENAI_API_KEY='old'\nexport OPENAI_BASE_URL='http://old/v1'\n# <<< Codex Gateway Control OpenAI 环境变量 <<<\n";
  const result = mergeMacShellEnvironment(old, "new-key", "http://127.0.0.1:4000/v1");
  assert.doesNotMatch(result, /环境变量/);
  assert.equal((result.match(/OPENAI_API_KEY=/g) ?? []).length, 1);
  assert.equal((result.match(/OPENAI_BASE_URL=/g) ?? []).length, 1);
  assert.match(result, /Codex Gateway Control OpenAI environment/);
});

test("合并 Shell 环境区块会安全转义单引号并保留换行风格", () => {
  const result = mergeMacShellEnvironment("export LANG=zh_CN.UTF-8\r\n", "key'with'quote", "https://gateway.example/v1");
  assert.match(result, /export OPENAI_API_KEY='key'"'"'with'"'"'quote'/);
  assert.ok(result.includes("\r\n"));
  assert.ok(!result.replaceAll("\r\n", "").includes("\n"));
});

test("残缺的 Shell 环境变量区块会拒绝覆盖", () => {
  assert.throws(
    () => mergeMacShellEnvironment("# >>> Codex Gateway Control OpenAI environment >>>\nexport PATH=/bin\n", "token", "http://127.0.0.1:4000/v1"),
    /不完整/
  );
});

test("macOS 配置会原子更新 Zsh 与 Bash 启动文件并调用图形会话设置", async () => {
  const homeDirectory = await mkdtemp(path.join(tmpdir(), "cgc-image-environment-"));
  const commands: Array<{ file: string; arguments_: string[] }> = [];
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalBaseUrl = process.env.OPENAI_BASE_URL;
  try {
    await writeFile(path.join(homeDirectory, ".zshrc"), "export PATH=/usr/local/bin\n", "utf8");
    await configureImageEnvironment({
      accessToken: "token-value",
      baseUrl: "http://127.0.0.1:4000/v1",
      platform: "darwin",
      homeDirectory,
      executeCommand: async (file, arguments_) => { commands.push({ file, arguments_ }); }
    });
    for (const profile of macShellProfilePaths(homeDirectory)) {
      const content = await readFile(profile, "utf8");
      assert.match(content, /export OPENAI_API_KEY='token-value'/);
      assert.match(content, /export OPENAI_BASE_URL='http:\/\/127\.0\.0\.1:4000\/v1'/);
      assert.equal((await stat(profile)).mode & 0o777, 0o600);
    }
    assert.match(await readFile(path.join(homeDirectory, ".zshrc"), "utf8"), /export PATH=\/usr\/local\/bin/);
    assert.deepEqual(commands, [
      { file: "launchctl", arguments_: ["setenv", "OPENAI_API_KEY", "token-value"] },
      { file: "launchctl", arguments_: ["setenv", "OPENAI_BASE_URL", "http://127.0.0.1:4000/v1"] }
    ]);
  } finally {
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
    if (originalBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = originalBaseUrl;
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("含换行的密钥会在写入前被拒绝", async () => {
  await assert.rejects(
    configureImageEnvironment({ accessToken: "token\nexport PATH=/bad", baseUrl: "http://127.0.0.1:4000/v1", platform: "linux" }),
    /不能包含换行符/
  );
});

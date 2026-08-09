import assert from "node:assert/strict";
import test from "node:test";
import { configureImageEnvironment } from "./image-environment.js";

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

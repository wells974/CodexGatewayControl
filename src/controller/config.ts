import "dotenv/config";
import crypto from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensurePrivateDirectory, ensurePrivateFile } from "./local-security.js";

/**
 * 读取环境变量中的访问令牌，或在安装版首次启动时创建并保护本地令牌文件。
 * @param dataDir Gateway 私密数据目录。
 * @returns 可用于本机 Codex 认证的访问令牌。
 * @throws 数据目录或令牌文件无法创建、读取或保护时抛出文件系统错误。
 * @remarks 环境变量优先于持久化令牌，以兼容开发环境；令牌不会返回给 Web 页面或写入日志。
 */
function loadAccessToken(dataDir: string): string {
  const configured = process.env.GATEWAY_ACCESS_TOKEN?.trim();
  if (configured) return configured;

  ensurePrivateDirectory(dataDir);
  const tokenPath = path.join(dataDir, "gateway-access-token");
  if (existsSync(tokenPath)) {
    const stored = readFileSync(tokenPath, "utf8").trim();
    if (stored) {
      ensurePrivateFile(tokenPath);
      return stored;
    }
  }

  const generated = crypto.randomBytes(32).toString("base64url");
  writeFileSync(tokenPath, `${generated}\n`, { encoding: "utf8", mode: 0o600, flag: "w" });
  ensurePrivateFile(tokenPath);
  return generated;
}

const dataDir = path.resolve(process.env.GATEWAY_DATA_DIR ?? ".data");

export const config = {
  host: process.env.GATEWAY_HOST ?? process.env.CONTROLLER_HOST ?? "127.0.0.1",
  port: Number(process.env.GATEWAY_PORT ?? process.env.CONTROLLER_PORT ?? 4000),
  dataDir,
  requestToken: process.env.CONTROLLER_REQUEST_TOKEN ?? crypto.randomBytes(32).toString("base64url"),
  accessToken: loadAccessToken(dataDir),
};

/**
 * 根据本地 Controller 请求令牌生成管理页会话 Cookie 值。
 * @returns 绑定当前 Controller 的不透明会话值。
 * @remarks 返回值只写入 HttpOnly Cookie，不会直接发送给页面脚本。
 */
export function sessionCookieValue(): string {
  return crypto.createHmac("sha256", config.requestToken).update("codex-gateway-controller").digest("base64url");
}

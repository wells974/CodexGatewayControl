import "dotenv/config";
import crypto from "node:crypto";
import path from "node:path";

export const config = {
  host: process.env.GATEWAY_HOST ?? process.env.CONTROLLER_HOST ?? "127.0.0.1",
  port: Number(process.env.GATEWAY_PORT ?? process.env.CONTROLLER_PORT ?? 4000),
  uiTlsPort: Number(process.env.GATEWAY_UI_TLS_PORT ?? 4401),
  dataDir: path.resolve(process.env.GATEWAY_DATA_DIR ?? ".data"),
  requestToken: process.env.CONTROLLER_REQUEST_TOKEN ?? crypto.randomBytes(32).toString("base64url"),
  accessToken: process.env.GATEWAY_ACCESS_TOKEN ?? ""
};

export function sessionCookieValue(): string {
  return crypto.createHmac("sha256", config.requestToken).update("codex-gateway-controller").digest("base64url");
}

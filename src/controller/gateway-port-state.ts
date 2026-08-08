import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensurePrivateDirectory, ensurePrivateFile } from "./local-security.js";

const stateFileName = "gateway-port.json";

export type GatewayPortState = {
  controllerPort: number;
  codexConfigurationRequired: boolean;
};

/**
 * 返回 Gateway 端口状态文件的固定位置。
 * @param dataDir Gateway 私密数据目录。
 * @returns 端口状态文件的绝对路径。
 * @remarks 状态文件不保存令牌或上游凭据，仅保存本机代理端口和配置迁移标记。
 */
export function gatewayPortStatePath(dataDir: string): string {
  return path.join(dataDir, stateFileName);
}

/**
 * 判断值是否可作为 Gateway 的稳定本机端口。
 * @param value 待校验的未知值。
 * @returns 值为 1024 到 65535 的整数时返回 true。
 * @remarks 排除特权端口和无效配置，避免将错误状态带入下次启动。
 */
function isGatewayPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1024 && value <= 65_535;
}

/**
 * 读取已持久化的 Gateway 端口状态。
 * @param dataDir Gateway 私密数据目录。
 * @returns 有效状态；文件不存在、格式错误或不可读时返回 null。
 * @remarks 损坏的状态文件不会阻断已有配置文件的恢复路径，调用方会回退到默认端口并要求用户确认迁移。
 */
export function readGatewayPortState(dataDir: string): GatewayPortState | null {
  const statePath = gatewayPortStatePath(dataDir);
  if (!existsSync(statePath)) return null;
  try {
    const value = JSON.parse(readFileSync(statePath, "utf8")) as Partial<GatewayPortState>;
    if (!isGatewayPort(value.controllerPort) || typeof value.codexConfigurationRequired !== "boolean") return null;
    ensurePrivateFile(statePath);
    return { controllerPort: value.controllerPort, codexConfigurationRequired: value.codexConfigurationRequired };
  } catch {
    return null;
  }
}

/**
 * 原子写入 Gateway 的稳定端口状态。
 * @param dataDir Gateway 私密数据目录。
 * @param state 下次启动需要使用的端口及 Codex 配置状态。
 * @returns 无返回值。
 * @throws 端口无效或状态文件无法写入、替换或保护时抛出错误。
 * @remarks 先写入同目录临时文件再替换，避免应用中断时留下截断的状态内容。
 */
export function writeGatewayPortState(dataDir: string, state: GatewayPortState): void {
  if (!isGatewayPort(state.controllerPort)) throw new Error("本地 Gateway 端口无效，无法保存启动状态。");
  ensurePrivateDirectory(dataDir);
  const statePath = gatewayPortStatePath(dataDir);
  const temporaryPath = `${statePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    ensurePrivateFile(temporaryPath);
    renameSync(temporaryPath, statePath);
    ensurePrivateFile(statePath);
  } catch (error) {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // 临时状态文件不会包含凭据；主错误仍应由调用方处理。
    }
    throw error;
  }
}

/**
 * 标记当前稳定端口已经写入 Codex 的配置文件。
 * @param dataDir Gateway 私密数据目录。
 * @param controllerPort 已成功写入 config.toml 的代理端口。
 * @returns 无返回值。
 * @throws 端口无效或状态文件无法持久化时抛出错误。
 * @remarks 仅在 config.toml 原子更新成功后调用，防止应用启动尚未完成迁移的端口。
 */
export function markCodexConfigurationCurrent(dataDir: string, controllerPort: number): void {
  writeGatewayPortState(dataDir, { controllerPort, codexConfigurationRequired: false });
}

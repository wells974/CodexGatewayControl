import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync } from "node:fs";

/**
 * 获取当前 Windows 用户的 ACL 主体名称。
 * @returns 可传给 `icacls` 的用户主体。
 * @throws 当前进程缺少用户名环境变量时抛出错误。
 * @remarks 不使用 shell 拼接命令，主体作为独立参数传给系统工具。
 */
function windowsPrincipal(): string {
  const username = process.env.USERNAME?.trim();
  if (!username) throw new Error("无法确定当前 Windows 用户，未能保护本地私密目录。");
  const domain = process.env.USERDOMAIN?.trim();
  return domain ? `${domain}\\${username}` : username;
}

/**
 * 使用 Windows ACL 保护本地私密路径。
 * @param target 要保护的文件或目录路径。
 * @param directory target 是否为目录。
 * @returns 无返回值。
 * @throws `icacls` 不存在或 ACL 修改失败时抛出错误，避免继续以不明确权限运行。
 * @remarks 移除继承权限后仅授予当前用户完全控制；系统不会把令牌或密钥写入日志。
 */
function applyWindowsAcl(target: string, directory: boolean): void {
  const permission = directory ? "(OI)(CI)F" : "F";
  execFileSync("icacls", [target, "/inheritance:r", "/grant:r", `${windowsPrincipal()}:${permission}`], { stdio: "ignore" });
}

/**
 * 创建并保护 Gateway 私密目录。
 * @param directory 要创建和保护的目录路径。
 * @returns 无返回值。
 * @throws 文件系统或 Windows ACL 操作失败时抛出错误。
 */
export function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") applyWindowsAcl(directory, true);
  else chmodSync(directory, 0o700);
}

/**
 * 将 Gateway 私密文件限制为当前用户可读写。
 * @param filePath 需要保护的文件路径。
 * @returns 无返回值。
 * @throws 文件权限或 Windows ACL 操作失败时抛出错误。
 */
export function ensurePrivateFile(filePath: string): void {
  if (process.platform === "win32") applyWindowsAcl(filePath, false);
  else chmodSync(filePath, 0o600);
}

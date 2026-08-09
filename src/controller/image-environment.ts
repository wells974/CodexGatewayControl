import { execFile } from "node:child_process";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

export type ImageEnvironmentOptions = {
  accessToken: string;
  baseUrl: string;
  platform?: NodeJS.Platform;
};

export type ImageEnvironmentResult = {
  configured: true;
  message: string;
};

/**
 * 为当前用户持久化生图所需的 OpenAI 环境变量。
 * @param options 本地 Gateway 令牌、基础地址及可测试的平台覆盖项。
 * @returns 环境变量配置成功后的非敏感结果。
 * @throws 当前平台不受支持、令牌为空或系统环境变量工具执行失败时抛出中文错误。
 * @remarks macOS 使用 launchctl 注入图形会话环境，Windows 使用 setx 写入用户环境；令牌不会写入日志或返回给浏览器。
 */
export async function configureImageEnvironment(options: ImageEnvironmentOptions): Promise<ImageEnvironmentResult> {
  const token = options.accessToken.trim();
  const baseUrl = options.baseUrl.trim();
  const platform = options.platform ?? process.platform;
  if (!token || !baseUrl) throw new Error("本地 Gateway 认证信息不完整，无法配置生图环境变量。");

  if (platform === "darwin") {
    await executeFile("launchctl", ["setenv", "OPENAI_API_KEY", token]);
    await executeFile("launchctl", ["setenv", "OPENAI_BASE_URL", baseUrl]);
  } else if (platform === "win32") {
    await executeFile("setx", ["OPENAI_API_KEY", token]);
    await executeFile("setx", ["OPENAI_BASE_URL", baseUrl]);
  } else {
    throw new Error("当前系统暂不支持自动配置生图环境变量。");
  }

  process.env.OPENAI_API_KEY = token;
  process.env.OPENAI_BASE_URL = baseUrl;
  return { configured: true, message: "生图环境变量已写入当前用户环境。" };
}

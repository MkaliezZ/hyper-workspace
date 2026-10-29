import {
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { z } from "zod";
import { digest } from "../core/credentials.js";

export interface NextcloudConfig {
  publicUrl: string;
  transportUrl: string;
  providerKey: string;
  workspaceId: string;
  memberGroup: string;
  bootstrapAdminIds: string[];
}
function baseUrl(value: string, internal = false) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["http:", "https:"].includes(url.protocol)
  )
    throw new Error("Invalid Nextcloud URL");
  if (
    !internal &&
    url.protocol !== "https:" &&
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  )
    throw new Error("Public Nextcloud URL requires HTTPS");
  return url.href.replace(/\/+$/, "");
}
/** Only trusted server configuration chooses the source, membership scope and bootstrap admins. */
export function nextcloudConfig(): NextcloudConfig | undefined {
  const env = process.env;
  if (
    !env.NEXTCLOUD_URL ||
    !env.NEXTCLOUD_WORKSPACE_ID ||
    !env.NEXTCLOUD_MEMBER_GROUP
  )
    return;
  const publicUrl = baseUrl(env.NEXTCLOUD_URL);
  return {
    publicUrl,
    transportUrl: baseUrl(env.NEXTCLOUD_INTERNAL_URL || publicUrl, true),
    providerKey: "nextcloud:" + digest(publicUrl),
    workspaceId: z.uuid().parse(env.NEXTCLOUD_WORKSPACE_ID),
    memberGroup: z.string().min(1).max(255).parse(env.NEXTCLOUD_MEMBER_GROUP),
    bootstrapAdminIds: z
      .array(z.string().min(1).max(255))
      .parse(JSON.parse(env.NEXTCLOUD_BOOTSTRAP_ADMIN_IDS || "[]")),
  };
}
export function requireNextcloud(): NextcloudConfig {
  const config = nextcloudConfig();
  if (!config)
    throw new ServiceUnavailableException(
      "企业登录尚未配置，请联系工作区管理员。",
    );
  return config;
}
export interface SourceCredentials {
  server: string;
  loginName: string;
  appPassword: string;
}
export interface SourceUser {
  uid: string;
  name: string;
  groups: string[];
}
const Credentials = z.object({
  server: z.string(),
  loginName: z
    .string()
    .min(1)
    .max(255)
    .refine((s) => !s.includes(":")),
  appPassword: z.string().min(1).max(4096),
});
/** HTTP boundary only: product permissions and encrypted storage live outside this provider. */
export class NextcloudIdentityProvider {
  constructor(readonly config: NextcloudConfig) {}
  private async request(path: string, init: RequestInit = {}) {
    try {
      return await fetch(this.config.transportUrl + path, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        headers: {
          Accept: "application/json",
          "User-Agent": "Hyper Workspace/0.1",
          ...init.headers,
        },
      });
    } catch {
      throw new ServiceUnavailableException(
        "无法连接企业身份服务，请稍后重试。",
      );
    }
  }
  private async json(response: Response) {
    try {
      return await response.json();
    } catch {
      throw new ServiceUnavailableException("企业身份服务返回了无效响应。");
    }
  }
  async start() {
    const response = await this.request("/index.php/login/v2", {
      method: "POST",
    });
    if (!response.ok)
      throw new ServiceUnavailableException("企业登录暂时不可用。");
    const parsed = z
      .object({
        login: z.string(),
        poll: z.object({
          endpoint: z.string(),
          token: z.string().min(1).max(4096),
        }),
      })
      .safeParse(await this.json(response));
    if (!parsed.success)
      throw new ServiceUnavailableException("企业登录响应格式不受支持。");
    const { login, poll } = parsed.data;
    // Prevent upstream/proxy misconfiguration from sending the browser or poll secret elsewhere.
    const suffix = login.startsWith(this.config.publicUrl + "/")
      ? login.slice(this.config.publicUrl.length)
      : "";
    if (
      !/^\/(?:index\.php\/)?login\/v2\/flow\/[a-zA-Z0-9]+$/.test(suffix) ||
      ![
        this.config.publicUrl + "/index.php/login/v2/poll",
        this.config.publicUrl + "/login/v2/poll",
      ].includes(poll.endpoint)
    )
      throw new ServiceUnavailableException(
        "企业登录地址与配置不符，请联系管理员。",
      );
    return { loginUrl: login, pollToken: poll.token };
  }
  async poll(pollToken: string): Promise<SourceCredentials | null> {
    const response = await this.request("/index.php/login/v2/poll", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: pollToken }),
    });
    if (response.status === 404) return null;
    if (!response.ok)
      throw new ServiceUnavailableException(
        "企业登录查询暂时失败，请稍后重试。",
      );
    const parsed = Credentials.safeParse(await this.json(response));
    if (!parsed.success)
      throw new ServiceUnavailableException("企业登录凭据响应不受支持。");
    this.validateServer(parsed.data.server);
    return parsed.data;
  }
  validateServer(server: string) {
    let normalized: string;
    try {
      normalized = baseUrl(server);
    } catch {
      normalized = "";
    }
    if (normalized !== this.config.publicUrl)
      throw new ForbiddenException("身份来源与工作区配置不匹配。");
  }
  async current(
    credentials: Pick<SourceCredentials, "loginName" | "appPassword">,
  ): Promise<SourceUser> {
    if (!Credentials.shape.loginName.safeParse(credentials.loginName).success)
      throw new UnauthorizedException("企业身份凭据无效，请重新登录。");
    const headers = {
      "OCS-APIRequest": "true",
      Authorization:
        "Basic " +
        Buffer.from(
          credentials.loginName + ":" + credentials.appPassword,
        ).toString("base64"),
    };
    const read = async (path: string) => {
      const response = await this.request(path + "?format=json", { headers });
      if ([401, 403].includes(response.status))
        throw new UnauthorizedException("企业身份凭据已失效，请重新登录。");
      if (!response.ok)
        throw new ServiceUnavailableException("企业身份查询暂时不可用。");
      const body = await this.json(response);
      const code = body?.ocs?.meta?.statuscode;
      if ([401, 403, 997].includes(code))
        throw new UnauthorizedException("企业身份凭据已失效，请重新登录。");
      if (![100, 200].includes(code) || !body?.ocs?.data)
        throw new ServiceUnavailableException("企业身份查询返回无效状态。");
      return body.ocs.data;
    };
    const data = await read("/ocs/v2.php/cloud/user");
    const parsed = z
      .object({
        id: z.string().min(1).max(255),
        displayname: z.string().max(255).optional(),
        enabled: z.boolean().optional(),
      })
      .safeParse(data);
    if (!parsed.success)
      throw new ServiceUnavailableException("企业身份信息格式不受支持。");
    if (parsed.data.enabled === false)
      throw new UnauthorizedException("企业账号已停用。");
    const groupData = await read(
      "/ocs/v2.php/cloud/users/" +
        encodeURIComponent(parsed.data.id) +
        "/groups",
    );
    const groups = z
      .object({ groups: z.array(z.string()).max(10000) })
      .safeParse(groupData);
    if (!groups.success)
      throw new ServiceUnavailableException("企业群组信息格式不受支持。");
    return {
      uid: parsed.data.id,
      name: parsed.data.displayname || parsed.data.id,
      groups: groups.data.groups,
    };
  }
}

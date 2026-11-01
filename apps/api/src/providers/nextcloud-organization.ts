import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { z } from "zod";
import type { NextcloudConfig, SourceCredentials } from "./nextcloud.js";
const Uid = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^\u0000-\u001f\u007f]+$/);
const MAX_BODY = 2 * 1024 * 1024;
type Credentials = Pick<SourceCredentials, "loginName" | "appPassword">;
export interface OrganizationPerson {
  uid: string;
  name: string;
  nameState: "source-verified" | "uid-only";
}
/** Read only. The configured membership group and current employee source permissions bound every result. */
export class NextcloudOrganizationProvider {
  constructor(
    readonly config: NextcloudConfig,
    readonly credentials: Credentials,
  ) {
    if (
      !credentials.loginName ||
      credentials.loginName.includes(":") ||
      /[\r\n]/.test(credentials.loginName)
    )
      throw new UnauthorizedException("来源登录凭据格式无效。");
  }
  private async read(
    path: string,
    query: URLSearchParams = new URLSearchParams(),
  ) {
    query.set("format", "json");
    let response: Response;
    try {
      response = await fetch(this.config.transportUrl + path + "?" + query, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        headers: {
          Accept: "application/json",
          "OCS-APIRequest": "true",
          "User-Agent": "Hyper Workspace/0.1",
          Authorization:
            "Basic " +
            Buffer.from(
              this.credentials.loginName + ":" + this.credentials.appPassword,
            ).toString("base64"),
        },
      });
    } catch {
      throw new ServiceUnavailableException("企业通讯录暂时不可连接。");
    }
    if ([401, 403, 404].includes(response.status)) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 401)
        throw new UnauthorizedException("来源登录已失效，请重新登录。");
      if (response.status === 403)
        throw new ForbiddenException("来源不允许读取此通讯录范围。");
      throw new NotFoundException("来源通讯录范围当前不可读取。");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new ServiceUnavailableException("企业通讯录查询暂时不可用。");
    }
    let body: any;
    try {
      if (Number(response.headers.get("content-length") ?? 0) > MAX_BODY)
        throw new Error("too large");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("missing body");
      let size = 0;
      const parts: Uint8Array[] = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > MAX_BODY) throw new Error("too large");
          parts.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      body = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)),
      );
    } catch {
      await response.body?.cancel().catch(() => {});
      throw new ServiceUnavailableException(
        "企业通讯录返回了无效或超限的响应。",
      );
    }
    const code = Number(body?.ocs?.meta?.statuscode);
    if ([401, 997].includes(code))
      throw new UnauthorizedException("来源登录已失效，请重新登录。");
    if (code === 403)
      throw new ForbiddenException("来源不允许读取此通讯录范围。");
    if ([404, 998].includes(code))
      throw new NotFoundException("来源通讯录范围当前不可读取。");
    if (![100, 200].includes(code) || body?.ocs?.data === undefined)
      throw new ServiceUnavailableException("企业通讯录返回了不受支持的状态。");
    return body.ocs.data;
  }
  async members(): Promise<string[]> {
    const data = await this.read(
      "/ocs/v2.php/cloud/groups/" +
        encodeURIComponent(this.config.memberGroup) +
        "/users",
    );
    const parsed = z.object({ users: z.array(Uid).max(2000) }).safeParse(data);
    if (!parsed.success)
      throw new ServiceUnavailableException(
        "成员目录格式无效或超过 2000 人；未使用截取结果代替完整成员范围。",
      );
    if (new Set(parsed.data.users).size !== parsed.data.users.length)
      throw new ServiceUnavailableException(
        "来源返回重复员工身份，请核对目录。",
      );
    return parsed.data.users.sort((a, b) => a.localeCompare(b));
  }
  private async lookup(
    search: string,
    limit: number,
  ): Promise<{ rows: { uid: string; name: string }[]; partial: boolean }> {
    const data = await this.read(
      "/ocs/v2.php/core/autocomplete/get",
      new URLSearchParams({
        search,
        itemType: "",
        itemId: "",
        "shareTypes[]": "0",
        limit: String(limit),
      }),
    );
    if (!Array.isArray(data) || data.length > 200)
      throw new ServiceUnavailableException(
        "来源联系人搜索响应无效或超过限制。",
      );
    const rows: { uid: string; name: string }[] = [];
    for (const row of data) {
      if (
        row?.source !== "users" ||
        !Uid.safeParse(row.id).success ||
        !Uid.safeParse(row.label).success
      )
        continue;
      const old = rows.find((value) => value.uid === row.id);
      if (old && old.name !== row.label)
        throw new ServiceUnavailableException(
          "来源员工名称不一致，请重新查询。",
        );
      if (!old) rows.push({ uid: row.id, name: row.label });
    }
    return { rows, partial: data.length >= limit };
  }
  /** Autocomplete can legitimately hide names. Do not replace its restrictions with privileged credentials or cached private profiles. */
  async people(uids: string[]): Promise<OrganizationPerson[]> {
    const parsed = z.array(Uid).max(50).parse(uids);
    if (new Set(parsed).size !== parsed.length)
      throw new BadRequestException("本次联系人不能重复。");
    const results: OrganizationPerson[] = [];
    for (let offset = 0; offset < parsed.length; offset += 4) {
      const batch = await Promise.all(
        parsed.slice(offset, offset + 4).map(async (uid) => {
          let values: { uid: string; name: string }[];
          try {
            values = (await this.lookup(uid, 20)).rows;
          } catch (e) {
            if (
              e instanceof ForbiddenException ||
              e instanceof NotFoundException
            )
              values = [];
            else throw e;
          }
          const current = values.find((value) => value.uid === uid);
          return {
            uid,
            name: current?.name ?? uid,
            nameState: current
              ? ("source-verified" as const)
              : ("uid-only" as const),
          };
        }),
      );
      results.push(...batch);
    }
    return results;
  }
  async search(query: string) {
    const value = z.string().trim().min(1).max(200).parse(query);
    return this.lookup(value, 100);
  }
}

import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { Subject } from "@hyper/contracts";
import type { Database } from "../db/database.js";
import { assertMember, Vault } from "./security.js";

export interface ModelConnection {
  id: string;
  provider: string;
  endpoint: string;
  model: string;
  purpose: "chat" | "embedding";
  apiKey?: string;
}

/** Resolves only the current actor's credentials; never place this object in events. */
export class ModelService {
  constructor(private db: Database) {}

  async resolve(
    s: Subject,
    purpose: ModelConnection["purpose"],
    id?: string,
  ): Promise<ModelConnection> {
    await assertMember(this.db, s);
    const row = (
      await this.db.pool.query(
        "SELECT id,provider,endpoint,model,purpose,credential_enc FROM cw_model_profiles WHERE workspace_id=$1 AND (owner_id IS NULL OR owner_id=$2) AND purpose=$3 AND ($4::uuid IS NULL OR id=$4) ORDER BY (owner_id IS NOT NULL) DESC,created_at DESC,id LIMIT 1",
        [s.workspaceId, s.id, purpose, id ?? null],
      )
    ).rows[0];
    if (!row)
      throw new NotFoundException("没有可用的模型配置，或无权使用该连接。");
    const { credential_enc, ...profile } = row;
    return {
      ...profile,
      apiKey: credential_enc ? new Vault().decrypt(credential_enc) : undefined,
    };
  }

  async verify(s: Subject, id: string) {
    await assertMember(this.db, s);
    const row = (
      await this.db.pool.query(
        "SELECT purpose FROM cw_model_profiles WHERE id=$1 AND workspace_id=$2 AND (owner_id IS NULL OR owner_id=$3)",
        [id, s.workspaceId, s.id],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("模型配置不存在或无权使用。");
    const connection = await this.resolve(s, row.purpose, id);
    if (connection.purpose === "embedding")
      await embed(connection, ["connection check"]);
    else await complete(connection, "Reply with OK.", 64);
    // Revocation during a request must not turn into an authorization success.
    await assertMember(this.db, s);
    const updated = await this.db.pool.query(
      'UPDATE cw_model_profiles SET verified_at=clock_timestamp() WHERE id=$1 AND workspace_id=$2 AND (owner_id IS NULL OR owner_id=$3) RETURNING verified_at AS "verifiedAt"',
      [id, s.workspaceId, s.id],
    );
    return {
      id,
      verifiedAt: updated.rows[0]?.verifiedAt,
      evidence: "provider-response",
    };
  }
}

async function request(
  connection: ModelConnection,
  path: string,
  body: unknown,
): Promise<any> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (connection.provider === "anthropic") {
    if (connection.apiKey) headers["x-api-key"] = connection.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (connection.apiKey)
    headers.Authorization = "Bearer " + connection.apiKey;
  let response: Response;
  try {
    response = await fetch(connection.endpoint.replace(/\/+$/, "") + path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new BadRequestException(
      "无法连接模型服务，请检查地址、网络和服务状态。",
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    // Provider error text can echo credentials, prompts, or internal URLs.
    throw new BadRequestException(
      "模型服务返回 HTTP " + response.status + "，请检查模型名称、Key 和额度。",
    );
  }
  try {
    return await response.json();
  } catch {
    throw new BadRequestException("模型服务没有返回有效 JSON。");
  }
}

export async function complete(
  connection: ModelConnection,
  prompt: string,
  maxTokens = 4096,
): Promise<string> {
  if (connection.purpose !== "chat")
    throw new BadRequestException("此连接未配置为对话模型。");
  const anthropic = connection.provider === "anthropic";
  const result = await request(
    connection,
    anthropic ? "/messages" : "/chat/completions",
    {
      model: connection.model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    },
  );
  const text = anthropic
    ? (Array.isArray(result.content) ? result.content : [])
        .filter((block: any) => block.type === "text")
        .map((block: any) => block.text)
        .join("")
    : result.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim())
    throw new BadRequestException("模型服务未返回可用文本。");
  return text;
}

export async function embed(
  connection: ModelConnection,
  inputs: string[],
): Promise<number[][]> {
  if (connection.purpose !== "embedding" || connection.provider === "anthropic")
    throw new BadRequestException("请选择支持 embeddings API 的向量模型连接。");
  const result = await request(connection, "/embeddings", {
    model: connection.model,
    input: inputs,
    encoding_format: "float",
  });
  if (!Array.isArray(result.data) || result.data.length !== inputs.length)
    throw new BadRequestException("向量模型返回的数量不匹配。");
  const ordered = [...result.data].sort((a, b) => a.index - b.index);
  const dimensions = ordered[0]?.embedding?.length;
  if (
    !Number.isInteger(dimensions) ||
    dimensions < 1 ||
    dimensions > 4096 ||
    ordered.some(
      (row, index) =>
        row.index !== index ||
        !Array.isArray(row.embedding) ||
        row.embedding.length !== dimensions ||
        row.embedding.some(
          (x: unknown) => typeof x !== "number" || !Number.isFinite(x),
        ) ||
        !row.embedding.some((x: number) => x !== 0),
    )
  )
    throw new BadRequestException("向量模型返回的索引、维度或数值无效。");
  return ordered.map((row) => row.embedding);
}

import { useEffect, useState } from "react";
import type { WorkspaceView } from "@hyper/contracts";
import { api, mutation } from "../api";

export interface ModelSummary {
  id: string;
  name: string;
  model: string;
  purpose: string;
  provider: string;
  scope: string;
  keyHint: string | null;
  verifiedAt: string | null;
}
export function ModelSettings({
  view,
  busy,
  act,
}: {
  view: WorkspaceView;
  busy: boolean;
  act: (fn: () => Promise<void>) => Promise<boolean>;
}) {
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [name, setName] = useState(""),
    [endpoint, setEndpoint] = useState("");
  const [model, setModel] = useState(""),
    [apiKey, setApiKey] = useState("");
  const [provider, setProvider] = useState("openai-compatible"),
    [purpose, setPurpose] = useState("chat");
  const [scope, setScope] = useState("personal");
  useEffect(() => {
    void act(async () => setModels(await api("/models")));
  }, [view.user.id]);
  async function refresh() {
    setModels(await api("/models"));
  }
  return (
    <div className="work-panel settings-panel">
      <h3>模型连接</h3>
      <p className="muted">
        配置服务地址与 API
        Key。密钥在服务端加密保存；验证连接会发送一条简短测试请求，可能产生少量费用。
      </p>
      {models.map((m) => (
        <div className="model-row" key={m.id}>
          <strong>{m.name}</strong>
          <span>
            {m.model} · {m.purpose === "embedding" ? "向量" : "对话"}
          </span>
          <small>
            {m.keyHint ?? "未设置 Key"} ·{" "}
            {m.verifiedAt ? "已验证连接" : "尚未验证"}
          </small>
          <button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await mutation(`/models/${m.id}/verify`, {});
                await refresh();
              })
            }
          >
            验证连接
          </button>
        </div>
      ))}
      <form
        className="settings-form"
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            await mutation("/models", {
              name,
              provider,
              endpoint,
              model,
              apiKey: apiKey || undefined,
              purpose,
              scope,
            });
            setApiKey("");
            await refresh();
          });
        }}
      >
        <label>
          连接名称
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：团队推理模型"
          />
        </label>
        <label>
          API 类型
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          >
            <option value="openai-compatible">OpenAI 兼容</option>
            <option value="deepseek">DeepSeek Chat 兼容</option>
            <option value="anthropic">Anthropic Messages</option>
          </select>
        </label>
        <label>
          服务地址
          <input
            required
            type="url"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://服务地址/v1"
          />
        </label>
        <label>
          模型名称
          <input
            required
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="服务提供方的模型 ID"
          />
        </label>
        <label>
          API Key
          <input
            type="password"
            autoComplete="new-password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="在服务端加密保存"
          />
        </label>
        <label>
          模型用途
          <select value={purpose} onChange={(e) => setPurpose(e.target.value)}>
            <option value="chat">对话与推理</option>
            <option value="embedding">向量检索</option>
          </select>
        </label>
        <label>
          使用范围
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="personal">仅个人</option>
            {view.user.role === "admin" ? (
              <option value="workspace">工作区</option>
            ) : null}
          </select>
        </label>
        <button className="primary" disabled={busy}>
          保存连接（未验证）
        </button>
      </form>
      <h3 className="settings-section">执行服务</h3>
      {Object.entries(view.engines)
        .filter(([id]) => id !== "fixture")
        .map(([id, engine]) => (
          <div className="model-row" key={id}>
            <strong>
              {id === "dsh" ? "DSH · 默认执行器" : "Hermes · 兼容执行器"}
            </strong>
            <span>
              {engine.configured ? "已配置，真实能力待验证" : "尚未配置"}
            </span>
          </div>
        ))}
    </div>
  );
}

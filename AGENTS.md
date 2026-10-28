# Hyper Workspace 开发规则

必须先读取 docs/handoff-v1/AGENTS.md、docs/handoff-v1/AI-IM基线/README.md、三层定义-v1.0.md、product-baseline.v1.json、技术选型与模块契约-v1.0.md。原交接包中的路径以 docs/handoff-v1/ 为根解析。原快照保持可校验，开发状态另存 docs/IMPLEMENTATION.md。

固定 React + TypeScript、NestJS、PostgreSQL + pgvector + pg-boss、独立 Worker、Docker Compose；DSH 默认执行器，Hermes 必须兼容；Nextcloud 通过 Provider 接入；企业资产、权限、Policy 和回执归产品核心拥有。

最新用户要求：开始实际开发，在 GitHub 新建公开仓库保存；持续更新 README，必要时插入图片；前端主体蓝白黑配色；检查 GitHub Actions 并修复失败。当前用户已授权建库和推送，不为这些已授权动作重复请求确认。

遵守 P01–P08 / C00–C07 / A01–A10 / E01–E10，可追溯实现。Mock、真实引擎、真实模型、业务端到端和上线分别记录。基线变更必须有相应授权与记录，普通实现细节自主推进。

执行接口统一，核心业务不依赖执行器私有状态。安全检查在后端，不以生成文本宣称执行成功；敏感凭据不进入日志、向量或仓库。

不要提交 .env、运行数据、真实企业资料或私钥。README 与实际能力一致，代码/协议变化同步更新文档。

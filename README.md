# Hyper Workspace

[![CI](https://github.com/MkaliezZ/hyper-workspace/actions/workflows/ci.yml/badge.svg)](https://github.com/MkaliezZ/hyper-workspace/actions/workflows/ci.yml)

面向企业内部的 AI 协作 IM：讨论有沉淀，行动有回执，成果能修改，经验能复用。蓝、白、黑配色；拥有自己的业务核心与企业资产服务。

**开发进行中，尚未达到生产可用状态。** 当前提供真实 PostgreSQL 持久化的第一阶段协作链路与明确标记的演示执行；DSH/Hermes 适配仍需真实协议与模型验证，Nextcloud Provider 尚待实现。

## 实际界面

下图为本地运行截图，使用明确标记的演示资料和真实 PostgreSQL 持久化。演示执行不调用真实模型。

![Hyper Workspace 桌面界面](docs/images/workspace-desktop.png)

[查看移动端截图](docs/images/workspace-mobile.png) · [设计参考与核对记录](docs/design/DESIGN.md)

## 技术架构

- React + TypeScript + Vite：聊天、项目上下文、任务、成果和设置。
- NestJS 模块化业务核心 + 独立执行 Worker。
- PostgreSQL + pgvector：业务状态、资产目录、关系和语义索引。
- pg-boss：后台分发；业务动作另做幂等、回执和对账。
- DSH 默认执行器、Hermes 兼容执行器，统一 EngineAdapter。
- Nextcloud 通过身份、通信、文件和日历 Provider 接入。

企业资料与产品状态独立于执行器；引擎切换保持业务接口稳定，不承诺私有检查点热迁移。

## 本地开发

需要 Node.js 24 与可用的 PostgreSQL（安装 pgvector）。Docker Compose 自部署教程正在补齐。

```bash
npm ci
cp .env.example .env
```

在本地 .env 中配置 DATABASE_URL、APP_ORIGIN 与 CREDENTIAL_MASTER_KEY。加密主密钥通过下面的命令生成，不要提交到 Git：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
npm run migrate
```

本机体验演示需显式设置 DEMO_MODE=true，然后运行：

```bash
npm run seed
npm run dev
```

打开 http://127.0.0.1:5173 ，点击“进入演示工作区”。演示登录仅接受本机请求；演示数据与确定性 fixture 执行不代表真实企业数据或模型效果。DSH/Hermes 未配置时会明确报错。

## 检查与验证

```bash
npm run typecheck
npm test
npm run build
# 仅使用隔离测试数据库，数据库名称必须以 _test 结尾
TEST_DATABASE_URL=postgres://用户:密码@127.0.0.1:5432/hyper_test npm run test:integration
npx playwright install chromium
npm run test:e2e
```

本地已通过类型检查、构建、6 项单元测试、8 项数据库集成测试与 3 项浏览器测试（桌面 1504×1045、移动端 390×844）。

GitHub Actions 使用 PostgreSQL/pgvector 服务执行类型、单元、数据库集成、构建和浏览器检查。绿色状态只证明工作流实际覆盖的测试，不代表原始 E01–E10 已全部完成。

## 开发依据与进展

- [Agent 开发规则](AGENTS.md)
- [当前实现与未验证项](docs/IMPLEMENTATION.md)
- [产品三层基线](docs/handoff-v1/AI-IM基线/README.md)
- [技术与跨引擎契约](docs/handoff-v1/AI-IM基线/技术选型与模块契约-v1.0.md)
- [产品命名决定](docs/NAMING.md)

每项变更关联 P/C/A/E 编号；保留原始交接快照，按实际结果更新进度。

## 许可证

自有代码采用 [MIT](LICENSE)。Nextcloud、DSH、Hermes 与其他依赖分别保留自身许可证；本仓库许可证不改变第三方组件的授权要求。

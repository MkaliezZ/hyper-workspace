# Hyper Workspace

[![CI](https://github.com/MkaliezZ/hyper-workspace/actions/workflows/ci.yml/badge.svg)](https://github.com/MkaliezZ/hyper-workspace/actions/workflows/ci.yml)

面向企业内部的 AI 协作 IM：讨论有沉淀，行动有回执，成果能修改，经验能复用。蓝、白、黑配色；拥有自己的业务核心与企业资产服务。

**开发进行中，尚未达到生产可用状态。** 当前提供真实 PostgreSQL 持久化的协作链路、模型配置与 pgvector 检索。DSH/Hermes 两个原生运行时及往返切换已通过本地测试模型链路；Nextcloud 企业身份与 Talk 通信基础已通过固定版本真实服务 CI（使用独立测试账号）。新增来源会话关联项目、权限继承与 AI 只读上下文，联合真实来源/双引擎检查待本次 CI 核验；真实模型质量、AI 通信写入、Files/Calendar 和完整业务验收仍待完成。

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

使用 DSH 时另行运行 `npm ci --prefix runtime/dsh`；Hermes 需要 Python 3.14.6，再运行 `python3 runtime/hermes/install.py`。在设置页保存 chat 模型连接，重启 API/Worker 后发起任务。可显式选择个人/工作区连接；自动选择时优先个人连接。[DSH](runtime/dsh/README.md) · [Hermes 安装及验证边界](runtime/hermes/README.md)。

## 企业账号登录

已实现 Nextcloud Login Flow v2、明确群组准入和产品角色映射。需要单独初始化企业工作区，浏览器在 Nextcloud 页面完成授权。应用密码由后端加密保存，后台执行前重新检查来源权限。[配置、数据范围、撤权和验证边界](docs/NEXTCLOUD-IDENTITY.md)。

## 企业消息

“企业消息”通过当前员工身份读取和回复 Nextcloud Talk 会话；发送具有幂等回执与未知结果核对。群成员和原始消息仍由来源管理。点击“项目空间”可创建受限项目：成果、任务、检索与 AI 上下文均继承来源权限；任务可读取当前获准的最近至多 60 条普通消息，成果保存在项目，暂不自动发布到 Talk。[通信配置与恢复](docs/NEXTCLOUD-TALK.md) · [项目权限、数据范围与回退](docs/PROJECT-SOURCE-SCOPE.md)。

下图使用明确的 UI 协议测试资料，非真实公司消息；真实 Talk 链路由独立 CI 检查。

![企业消息界面](docs/images/talk-desktop.png)

[移动端企业消息界面](docs/images/talk-mobile.png)

关联项目的权限提示如下，使用 UI 协议测试资料。原始消息留在来源，工作记录与成果保存在受限项目。

![来源关联项目](docs/images/source-project-desktop.png)

[移动端来源项目](docs/images/source-project-mobile.png)

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

本地已通过类型检查、构建、9 项单元测试、34 项数据库集成测试、12 项浏览器测试，以及 3 项双执行器原生运行时测试。模型与向量 HTTP 测试使用明确的本地协议测试服务；不代表真实供应商效果。

GitHub Actions 另设固定 Nextcloud 33.0.10/Talk 23.0.12 真实服务 job，已有 5 项身份、通信与撤权测试通过；本次扩充到 6 项，新增真实来源 + 双原生引擎的权限/成果联合用例，结果待核验。主 job 使用 PostgreSQL/pgvector 服务执行类型、单元、数据库集成、两个原生执行器、往返切换、构建和浏览器检查。绿色状态只证明工作流实际覆盖的测试，不代表原始 E01–E10 已全部完成。

## 开发依据与进展

- [Agent 开发规则](AGENTS.md)
- [当前实现与未验证项](docs/IMPLEMENTATION.md)
- [产品三层基线](docs/handoff-v1/AI-IM基线/README.md)
- [技术与跨引擎契约](docs/handoff-v1/AI-IM基线/技术选型与模块契约-v1.0.md)
- [产品命名决定](docs/NAMING.md)
- [模型连接、向量索引与权限边界](docs/MODELS-AND-KNOWLEDGE.md)
- [来源项目与 AI 上下文契约](docs/PROJECT-SOURCE-SCOPE.md)

每项变更关联 P/C/A/E 编号；保留原始交接快照，按实际结果更新进度。

## 许可证

自有代码采用 [MIT](LICENSE)。Nextcloud、DSH、Hermes 与其他依赖分别保留自身许可证；本仓库许可证不改变第三方组件的授权要求。

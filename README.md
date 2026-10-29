# Hyper Workspace

[![CI](https://github.com/MkaliezZ/hyper-workspace/actions/workflows/ci.yml/badge.svg)](https://github.com/MkaliezZ/hyper-workspace/actions/workflows/ci.yml)

面向企业内部的 AI 协作 IM：讨论有沉淀，行动有回执，成果能修改，经验能复用。蓝、白、黑配色；拥有自己的业务核心与企业资产服务。

**开发进行中，尚未达到生产可用状态。** 当前提供真实 PostgreSQL 持久化的协作链路、模型配置与 pgvector 检索。DSH/Hermes 两个原生运行时及往返切换已通过本地测试模型链路；Nextcloud 企业身份、Talk 通信、来源关联项目、AI 个人回复草稿、Files 个人文本导入与个人 AI 解读已通过固定版本真实服务 CI（使用独立测试账号、本地模型协议服务）。真实模型质量、AI 自主通信投递、Files 扩展、Calendar 和完整业务验收仍待完成。

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

需要 Node.js 24 与可用的 PostgreSQL（安装 pgvector）。容器运行包见下方自部署章节。

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

## Docker Compose 自部署

新增构建后的网页/API、独立 Worker、PostgreSQL/pgvector 与一次性初始化服务；镜像包含锁定的 DSH/Hermes。Nextcloud 作为独立来源接入。配置生成器以 0600 创建新密钥文件并拒绝覆盖，容器持久化卷独立，默认只向主机 loopback 开放应用端口。

API/Worker 的数据库运行账号与管理员分离，管理员凭据仅用于数据库与初始化；[旧配置与旧数据卷升级说明](docs/DEPLOYMENT-DATABASE.md)。受限账号的业务、队列、容器权限与双执行器恢复已通过 CI，原有数据和加密主密钥保留。

```bash
node scripts/deploy-init.mjs
# 编辑 .env.compose 中的组织来源与 APP_ORIGIN
HYPER_REVISION=$(git rev-parse HEAD) docker compose --env-file .env.compose up -d --build
```

[完整配置、备份、迁移与回退说明](docs/DEPLOYMENT.md)。Linux amd64 容器构建、启动、双执行器、停启持久化与中断恢复用例已在 CI 通过；真实公司环境与生产验收仍待完成。

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

新增“AI 起草回复”：选择模型生成个人草稿，检查、编辑后放入当前会话发送框，发送仍使用真实来源回执。草稿仅本人可见，不自动广播；已通过固定真实来源与双原生执行器的联合 CI。[完整契约与恢复边界](docs/AI-REPLY-DRAFTS.md)。

下图使用明确的 UI 协议测试资料，非公司消息或真实模型效果。

![AI 回复草稿](docs/images/reply-draft-desktop.png)

[移动端回复草稿](docs/images/reply-draft-mobile.png)

## 企业文件与个人资料

新增 Nextcloud Files/WebDAV 浏览与显式导入，在“知识库 → 企业文件”选择短文本/Markdown，副本仅本人可见，可建立语义索引。读取、检索和索引重新检查来源；源更新、删除或撤权后停止使用旧正文和向量。真实来源分享、更新、刷新与撤权联合用例已通过 CI。PDF/Office、长文分块、文件到共享项目成果的权限传播和 Calendar 仍待完成。[配置、数据契约与回退](docs/NEXTCLOUD-FILES.md)。

下图使用明确 UI 协议测试资料，非真实公司文件。

![企业文件导入](docs/images/files-desktop.png)

[移动端文件预览](docs/images/files-mobile.png)

新增个人“AI 阅读此文件”：选择 DSH/Hermes 与 chat 模型，基于所选当前版本生成个人解读，可人工修改并保留版本；源变更/撤权清理相关解读。该流程保持个人范围，完整共享发布与多文件 RAG 仍待实现。[范围、运行清理与迁移](docs/FILE-AI-READING.md)。

下图为 UI 协议测试资料，非真实公司资料或模型质量证据。

![个人 AI 文件阅读与修订](docs/images/file-reading-desktop.png)

[移动端个人解读](docs/images/file-reading-mobile.png)


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

本地已通过类型检查、构建、16 项单元/Provider/部署配置测试、52 项数据库集成测试；既有 18 项浏览器和 3 项双执行器原生运行时测试已通过。模型与向量 HTTP 测试使用明确的本地协议测试服务；不代表真实供应商效果。

部署首轮 [CI](https://github.com/MkaliezZ/hyper-workspace/actions/runs/40903087059) 在固定 Hermes 源码下载时遇到 HTTP 429，第二轮复用归档遇到构建 secret 大小限制。修复为有界重试、公开源码缓存/摘要复核与独立构建上下文后，提交 `5a0cb37` 的 [容器 job](https://github.com/MkaliezZ/hyper-workspace/actions/runs/40906030218) 2 项用例通过；完整证据和首轮失败记录见部署文档。

数据库权限修复提交 `42facee` 的 [完整 CI](https://github.com/MkaliezZ/hyper-workspace/actions/runs/40913709891) 三个 job 均成功，共 103 项测试：16 单元/Provider/部署配置、3 Python 下载回归、52 数据库、18 UI、3 原生执行器、8 真实 Nextcloud/Talk/Files、3 容器部署与权限/恢复。另含类型、构建、两个 npm 审计和冻结包校验。模型仍为协议测试服务；未代表真实模型质量或原始 E01–E10 全部完成。

此前容器基础提交 `5a0cb37` 的 [CI](https://github.com/MkaliezZ/hyper-workspace/actions/runs/40906030218) 三个 job 成功，共 98 项测试；后续数据库权限变化和首轮清理失败的记录见上述部署权限文档。

个人文件阅读实现提交 `38de927` 的 [完整 CI](https://github.com/MkaliezZ/hyper-workspace/actions/runs/40869859532) 两个 job 成功，共 90 项测试（12 单元/Provider、49 数据库、18 浏览器、3 原生执行器、8 真实来源），另含类型、构建、两个 npm 依赖审计和冻结包校验。来源用例覆盖 DSH/Hermes 的私有文件解读、修订、源更新与撤权传播；模型仍为协议测试服务。后续提交以各自 Actions 为准。

## 开发依据与进展

- [Agent 开发规则](AGENTS.md)
- [当前实现与未验证项](docs/IMPLEMENTATION.md)
- [产品三层基线](docs/handoff-v1/AI-IM基线/README.md)
- [技术与跨引擎契约](docs/handoff-v1/AI-IM基线/技术选型与模块契约-v1.0.md)
- [产品命名决定](docs/NAMING.md)
- [模型连接、向量索引与权限边界](docs/MODELS-AND-KNOWLEDGE.md)
- [来源项目与 AI 上下文契约](docs/PROJECT-SOURCE-SCOPE.md)
- [AI 个人草稿与人工检查后发送](docs/AI-REPLY-DRAFTS.md)

每项变更关联 P/C/A/E 编号；保留原始交接快照，按实际结果更新进度。

## 许可证

自有代码采用 [MIT](LICENSE)。Nextcloud、DSH、Hermes 与其他依赖分别保留自身许可证；本仓库许可证不改变第三方组件的授权要求。

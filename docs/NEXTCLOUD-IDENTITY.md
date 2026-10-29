# Nextcloud 企业身份 Provider

对应 P04/P07/P08、C00/C02/C05/C07、A01/A10、E04/E09 的身份与撤权子集。原 E01–E10 的完整双执行器验收状态不因此改变。此模块不改变默认 DSH、兼容 Hermes 或企业资产归产品核心持有的基线。

## 范围与版本

实现 Login Flow v2、当前用户与自身群组查询、产品身份映射、按设备保存凭据、产品会话与执行前再鉴权。Talk 通信基础模块另见 [NEXTCLOUD-TALK.md](NEXTCLOUD-TALK.md)；Files/WebDAV、Calendar/CalDAV 尚未接入。没有导入真实公司账号或资料。

真实服务 CI 固定官方镜像 `nextcloud:33.0.10-apache@sha256:5ded1127972ea84c29792215f0621c71929ed315cc47be946b489c7a1c1ad305`；摘要于 2026-10-29 通过 Docker Registry v2 核验。当前机器没有 Docker/PHP，真实服务测试由 GitHub Actions 的 `nextcloud-identity` job 执行；已在 [run 40797427984](https://github.com/MkaliezZ/hyper-workspace/actions/runs/40797427984)（提交 abf6a0c）通过 3 项真实服务测试。该 job 中 Nextcloud 使用独立 SQLite 测试库，产品仍使用独立 PostgreSQL/pgvector 测试库。此配置不作为生产部署方案。

协议依据为固定版本源码：[Login Flow v2 Controller](https://github.com/nextcloud/server/blob/v33.0.10/core/Controller/ClientFlowLoginV2Controller.php)、[当前用户和群组查询](https://github.com/nextcloud/server/blob/v33.0.10/apps/provisioning_api/lib/Controller/UsersController.php)。Nextcloud `stable` 文档会随版本变化；本次核验时文档标题为 35，因此没有将其标题当作已验证运行版本。Talk 版本必须另外核验兼容范围，不能直接取 GitHub latest。

## 配置与初始化

先按 README 完成依赖安装、`.env` 和 `npm run migrate`。生产凭据与真实群组只能由有权管理员配置，本仓库示例不代表已获准接入任何公司来源。

```dotenv
# 浏览器使用的规范地址，支持 /nextcloud 子路径；除本机回环外必须 HTTPS
NEXTCLOUD_URL=https://cloud.example.invalid
# 可选：受信管理员配置的内网传输地址；Nextcloud 返回的 public URL 仍须匹配
NEXTCLOUD_INTERNAL_URL=
# 新 UUID，不能复用演示工作区
NEXTCLOUD_WORKSPACE_ID=10000000-0000-4000-8000-000000000001
NEXTCLOUD_MEMBER_GROUP=明确授权的群组ID
# 精确 UID 的 JSON 数组，仅在首次建立产品身份时使用
NEXTCLOUD_BOOTSTRAP_ADMIN_IDS=["明确授权的初始管理员UID"]
WORKSPACE_NAME=工作区名称
DEMO_MODE=false
```

```bash
npm run workspace:init
npm run dev
```

初始化会创建一个空的“团队讨论”项目和产品会话容器，不创建员工、公司事实或聊天资料；重复执行不会覆盖已有角色/项目。当前没有完整管理界面，管理员 ID 与群组准入由受控服务配置维护。API/Worker 使用相同配置与 CREDENTIAL_MASTER_KEY，修改后重新启动。主密钥必须备份并受限保存。

点击“使用企业账号登录”，在单独的 Nextcloud 页面完成登录和授权。产品页面不接收账号密码或应用密码。弹窗被阻止时，可使用页面中的“打开企业登录页面”链接。网络失败可重试查询，过期/取消后重新发起。

[移动端登录等待界面](images/login-mobile.png)为实际页面截图，使用明确的 UI 协议 fixture，不表示连接了公司来源。

## 来源绑定与权限

| 绑定字段                    | 本模块的明确范围                                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| connector / object_selector | 管理员配置的单个 Nextcloud 来源；仅当前授权员工自身身份与自身群组                                                                |
| field_allowlist             | canonical UID、displayname、自身群组 ID；不导入 email、quota、完整通讯录                                                         |
| time_scope                  | 每次登录与业务鉴权时查询当前状态；不采集历史身份资料                                                                             |
| credential_ref              | 每次登录单独的 cw_identity_credentials.id，应用密码 AES-256-GCM 加密；不进入模型上下文、运行事件、向量或前端                     |
| access_policy_ref           | NEXTCLOUD_MEMBER_GROUP 准入 ∩ cw_members 当前产品授权；初始管理 UID 由服务配置指定                                               |
| sync_policy                 | 来源 UID/URL 标识与产品 UUID 映射；登录更新显示名；查询成功记录 verified_at                                                      |
| revocation_policy           | 身份凭据失效禁用对应设备；群组缺失（包括新设备登录时首次发现）撤销产品成员和该工作区全部会话；服务故障阻止本次操作且保留授权记录 |
| deletion_policy             | 不同步完整目录；撤权保留业务对象和历史主体关联；过期流程在下一次发起登录时清理；员工彻底删除与合规留存管理后续补齐               |

`provider_key` 由规范来源 URL 派生；登录名可能是别名，实际身份使用 OCS 返回的 UID。相同显示名不会合并。已有产品成员被移除后，重新登录或恢复源群组不会自动恢复产品权限。Nextcloud 的 admin 群组不会自动授予产品 admin；初始配置也不会在后续登录时覆盖产品角色。

每次登录创建独立应用密码记录和产品会话；一台设备失效不会改用另一台设备的凭据。来源 URL 改变后，原凭据被拒绝使用，避免转发到新地址；域名迁移需要明确迁移流程，当前不自动改绑。

## 行为、失败与恢复

- `POST /api/auth/nextcloud/start`：返回 flowId、已验证来源的 loginUrl、expiresAt。poll token 只加密留在后端。工作区须先初始化。当前全局最多 100 个待完成流程，同一浏览器最多 5 个，完成/取消后释放名额；仍需后续并发容量验证。
- `POST /api/auth/nextcloud/poll`：只接受 flowId，验证 Origin 和 HttpOnly 的浏览器绑定 Cookie；pending 每 2 秒最多查询一次。完成后设置 HttpOnly/SameSite=Strict 的 12 小时产品会话，生产环境启用 Secure。前端 JSON 只含 pending/complete。
- `POST /api/auth/nextcloud/cancel`：取消当前浏览器拥有的流程；已生成的产品会话会同时失效，不注销其他设备/不相关流程。流程有效 10 分钟；取消与成功查询通过数据库锁串行化。
- 一次性源凭据收到后先加密提交，再查询身份；来源暂时故障可继续原流程。数据库提交之前进程崩溃或响应丢失，仍可能丢失一次性上游响应，此时过期后重新发起；没有声称消除这个跨系统窗口。
- 来源响应、轮询地址和 server 地址必须匹配受信配置；HTTP 不跟随重定向；上游错误正文不返回产品日志/错误。
- API、模型解析、Worker 开始、每次业务动作前及最终发布前会重新查询来源与产品权限。Run 固定发起设备的 credential ref，不能用客户端参数或另一台设备替代。撤权发生在已提交动作之后时不承诺回滚；按已有回执进入失败/待对账路径。
- 来源暂时不可达返回 503，不将故障写成永久撤权；重试需要来源恢复。当前实时查询没有缓存，不代表已通过大规模性能/可用性验证。源权限查询与产品 SQL 不具备跨系统原子性；已发送给执行器的上下文也不能撤回。
- 注销与取消禁用本地设备记录并清除加密凭据。当前不自动删除 Nextcloud 上已签发的应用密码；用户可在 Nextcloud 安全设置中撤销。自动清理与离线重试后续补齐。

## 迁移与验证

`005_nextcloud_identity.sql` 增加独立来源身份、设备凭据、登录流程，并为 Session/Run 增加服务端引用。原 `cw_users.nextcloud_id` 保留但不用于新来源绑定；既有演示资料不改绑。

回退应优先保留支持此身份契约的修复版本。不能把含有效企业会话/Run 的数据库直接回退到忽略来源凭据的旧应用：需先停止 API/Worker、撤销源身份会话、处理排队和运行中的任务，再由管理员按回执核对后恢复。保留新增表用于历史与恢复，不自动删除企业数据。正式升级/回退演练仍待 Compose 交付。

```bash
# 本地协议测试 + 真实 PostgreSQL
TEST_DATABASE_URL=postgres://用户:密码@127.0.0.1:5432/hyper_test npm run test:integration
# 真实 Nextcloud 测试依赖 Docker、隔离数据库、synthetic 测试账号；见 CI 的完整配置
bash scripts/ci/nextcloud-setup.sh
npm run test:nextcloud
```

新增 9 项身份数据库测试覆盖角色/UID、多设备隔离、浏览器绑定、流程重放/取消/过期、暂时故障重试、源群组与产品撤权、来源改绑拒绝、推理中撤权后停止写入。新增 2 项界面测试只使用明确的协议 fixture。真实服务 CI 另测 Login Flow v2 浏览器授权、持久化讨论、设备应用密码撤销、群组撤销及 Origin/Cookie 约束。真实公司 SSO/MFA、代理配置、目录映射和全量业务验收仍未验证。

首次 run 40796637776 因仅按 link 角色寻找来源授权入口而超时；测试已改为兼容 link/button，并增加不输出凭据的页面诊断。复跑通过。两个执行器与业务主 CI 同时通过；这些证据不等于真实公司环境、真实模型或全量 IM 已验收。

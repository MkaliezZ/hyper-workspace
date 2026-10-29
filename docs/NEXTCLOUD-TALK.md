# 企业通信 Provider / Nextcloud Talk

本增量对应 P03/P04/P07/P08，C00/C05/C07，A01/A03/A10，E04/E09/E10 的通信子集。产品仍在开发；这不是完整 IM 或完整双执行器验收。

## 已实现的边界

- 使用当前员工、当前设备的已验证 Nextcloud 应用密码访问 Talk，产品 admin 不获得源会话的额外权限。
- 自有“企业消息”页面提供会话列表、按页读取消息、发送纯文本、消息结果核对、只读状态、按会话保留当前页面内的草稿；可退出演示/注销后切换企业账号。
- 会话与消息从源端实时读取；不把私有 Talk 消息复制进当前工作区共享项目或向量库。产品只持久化发送意图、参数哈希、源对象 ID 和回执。
- 发送前保存幂等意图；实际发送后再读取来源确认。同一员工使用相同幂等键不会再次投递，不同参数使用相同键被拒绝。
- 结果不明保留 `recovery_required`，不自动重发。页面刷新后从后端恢复待核对回执，处理后才能在同一会话发起新消息；不同员工独立处理。

当前尚未实现：在产品内创建/管理群成员、联系人目录、附件、消息编辑/删除/反应、完整实时通知/已读同步、音视频。单聊和群聊的成员在 Nextcloud 中管理。Talk 与项目/成果的关联及其来源权限继承、DSH/Hermes 的通信工具入口仍待实现；当前不能声称企业消息已经可由 AI 全面驱动。现有项目 AI 任务继续使用产品项目讨论，点击“发起任务”会返回项目空间。

## 版本与安装

固定 Nextcloud 33.0.10，Talk 23.0.12；Talk 的 appinfo 声明仅支持 Nextcloud 33，应用商店的范围为 `>=33.0.0 <34.0.0`。没有直接使用只支持 Nextcloud 35 的 Talk 25。

- [官方发行包](https://github.com/nextcloud-releases/spreed/releases/tag/v23.0.12)
- [固定版本兼容声明](https://github.com/nextcloud/spreed/blob/v23.0.12/appinfo/info.xml)
- [固定版本消息 API](https://github.com/nextcloud/spreed/blob/v23.0.12/docs/chat.md)
- [会话 API](https://github.com/nextcloud/spreed/blob/v23.0.12/docs/conversation.md) / [参与者 API](https://github.com/nextcloud/spreed/blob/v23.0.12/docs/participant.md)

发行包 SHA-256：`a907070cb8c0eb69a0ef808f62ea6eea822365c97a1c0e6f4a86aa748eda6c79`。版本、大小与地址固定在 `runtime/nextcloud/talk.lock.json`。准备脚本检查归档摘要、大小、appinfo 版本与服务器主版本范围，不提交第三方运行文件。上游组件保留自身许可证，产品 MIT 不替换它。

先完成 [企业身份配置](NEXTCLOUD-IDENTITY.md)，在受控的 Nextcloud 上安装兼容 Talk，再设置：

```dotenv
NEXTCLOUD_TALK_ENABLED=true
```

```bash
npm run migrate
npm run dev
```

使用企业账号登录后进入“企业消息”。原 `.env.example` 默认关闭开关。这里不创建公司会话，不向真实联系人发送测试消息，不自动导入企业历史。真实服务 CI 仅创建独立 synthetic 账号、单聊和群聊；本机无 Docker/PHP，不能将本机协议测试写成真实服务通过。

## 来源绑定与资产范围

| 字段                        | 当前范围                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| connector / object_selector | 管理员配置的单个 Nextcloud；当前源员工已经加入的会话；用户选定会话每页最多 100 条消息                                                                  |
| field_allowlist             | 源 token/消息 ID、会话名称/只读状态、作者 ID/名称、文本、时间、消息类型、referenceId、编辑/过期时间；富对象仅提取名称作纯文本展示，不读取其 URL 或文件 |
| time_scope                  | 当前访问页；可手动向前分页；可见页面每 5 秒更新，隐藏页面暂停轮询                                                                                      |
| credential_ref              | 当前 Session 的设备凭据引用；加密密码只在后端解密，不进入消息、事件、模型上下文、向量或前端                                                            |
| access_policy_ref           | 当前产品成员资格 ∩ 当前源群组准入 ∩ 当前会话参与者/源 API 权限；只读会话在产品中禁止发送                                                               |
| sync_policy                 | 读取源端当前页并替换页面内容，不累计永久聊天镜像；不自动设置源端已读标记、清理通知或更新在线状态                                                       |
| revocation_policy           | 每次会话/消息/回执操作重新查询来源权限；源检查拒绝后页面清空对应消息，已提交的发送不声称回滚                                                           |
| deletion_policy             | 源删除消息显示删除状态，已过期消息不返回；API 禁止缓存。发送审计元数据保留，保留期限/管理员清理界面后续补齐，不自动删除业务历史                        |

读取与发送均经 `CommunicationService` 和 `CommunicationProvider`，不依赖 DSH/Hermes 私有状态。`cw_communication_sends` 保存 workspace、actor、设备引用、provider_key、源会话、幂等键、参数哈希、referenceId、状态、源消息 ID、源内容哈希、核对/确认时间；不保存消息正文。回执只对原产品员工开放，返回前仍检查源会话权限。同一员工可用另一台有效设备读取/核对自己的回执，但不会自动换用它重试旧发送。

源消息仍以 Nextcloud 为权威。当前没有将 source token 当作全工作区共享授权；后续项目关联必须先为任务、成果、检索与 Run 上下文补齐来源权限继承。

## API 与失败恢复

| API                                              | 行为                                                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| GET `/api/talk/rooms`                            | 只列出当前源员工加入的会话                                                                             |
| GET `/api/talk/rooms/:token/messages?before=...` | 当前或更早的一页，最多 100 条；来源查询设置 noStatusUpdate、setReadMarker=0、markNotificationsAsRead=0 |
| POST `/api/talk/rooms/:token/messages`           | 严格输入 content + UUID idempotencyKey；不接收 actor/credential；返回产品发送回执                      |
| GET `/api/talk/rooms/:token/sends`               | 当前员工该会话未处理的 sending/recovery_required 回执                                                  |
| GET `/api/talk/sends/:id`                        | 重新鉴权后读取回执；45 秒未更新的 sending 转为待核对，不重发                                           |
| POST `/api/talk/sends/:id/reconcile`             | 只读核对：有源消息 ID 时按 ID 查，无 ID 时在最近 100 条中按 referenceId + 作者查；不调用发送接口       |
| POST `/api/talk/sends/:id/acknowledge`           | 人已查看来源后允许继续新发送；保留原 recovery_required 结果和独立 acknowledged_at，不改写为成功/未发送 |

发送在数据库保存意图后只投递一次，成功响应还需回读同一源消息及其版本/内容哈希。已经收到发送确认之后的回读失败仍是待核对，不能记成“无副作用失败”。确定的源 4xx 拒绝才记 `failed`；传输中断、5xx、无效响应或提交后进程中断按未知结果处理。

每个员工/会话串行保存新意图，存在未处理回执时拒绝新的发送，原键重试仍可读取原结果。普通成功发送不要求额外确认。页面保留当前内存草稿和原重试键；刷新后的未知发送从后端回执恢复。

在最近 100 条中没有找到不能证明未发送，也不触发自动重发。消息已经编辑/删除、超过查询窗口、来源失效时可能仍无法完成核对；用户需查看源端后判断是否继续。手动继续不是回滚或未发送证明。源权限和产品 SQL 没有跨系统原子性，不能消除在途请求/已提交数据的全部窗口。

## 迁移、回退与验证

迁移 `006_communication_sends.sql` 只增加发送回执表，不改写既有项目消息，不迁移源聊天。模块回退先关闭 `NEXTCLOUD_TALK_ENABLED`、等待/核对在途发送，保留表用于审计。不要通过删除未知意图来触发重投；正式部署回退仍需后续 Compose 演练。

本地已通过新增 7 项真实 PostgreSQL + HTTP 协议服务测试，以及 2 项前端协议测试。覆盖来源成员/只读权限、私有会话直读拒绝、幂等、已写入后丢响应、回读失败、有限范围核对、人工继续与重新加载。UI 截图使用明确测试资料，非真实公司数据。完整本地测试当前为 9 单元、30 数据库、9 浏览器；两个原生引擎由主 CI 回归。

新增真实 Talk CI 用例验证群聊和单聊：员工登录、读取源消息、产品发出并回读、并发幂等键、不伪造作者、移除参与者后拒绝旧页面/接口、源消息不进入产品共享项目表。提交 811fbf0 的 [CI run 40818944365](https://github.com/MkaliezZ/hyper-workspace/actions/runs/40818944365) 已通过两个 job，真实服务共 5 项浏览器测试（3 身份 + 2 Talk）。真实公司环境、真实模型、完整 E01–E10 和生产部署仍未验收。

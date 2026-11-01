# 会话、成员与通知管理

人工/AI 链路与本地验证已接通，新增真实来源/容器整批 CI 待提交核验，公司验收未完成。映射 P02/P03/P04/P07/P08、C00/C03/C05、A01/A03/A06/A10、E02/E04/E06/E07/E09/E10 子集；不代表完整场景通过。固定 Nextcloud Talk 23.0.12 的公开 API；普通员工当前设备凭据，产品管理员不获得来源群管理员权力。

人工与 `manage_communication` / `communication.manage` 共用 `RoomManagementService`。AI 仅收到操作类型，提出一个空参数工具，不能重选人员、会话、设置、已读位置或授予权限；不发送群名、员工目录或消息正文，不发布模型生成文字或共享项目消息。配置模型 Key 沿用服务端模型连接和用量/预算检查。

## 输入和结果

- 查询当前会话未读数、提及、收藏、通知等级、已读位置、来源角色及成员；来源未返回的字段明确为未知，不把缺失当作零。读取消息继续明确关闭自动已读、自动清通知和状态更新。
- 人工或双执行器入口：创建单聊/最多 20 个明确 UID 的私群；当前群名、邀请/移除成员、授予/撤回群管理员；个人通知等级/收藏/标记所选消息已读/未读；退出和删除私群。
- 当前成员组内的确切 UID 才能邀请，同名不合并；成员移除/管理员更改同时固定 UID 与 attendeeId，防止离群重入后旧确认作用于新成员实例。不能借产品部门或产品管理员角色取得来源权力。
- 群管理只接受普通私群，当前来源群主/管理员权限；删除还要求来源明确允许、无通话且无分组讨论。字段不明或出现不支持的成员类型时拒绝对应管理。不能删除联邦/共享对象/未知类型会话。
- 群成员会决定已关联及以后关联项目的来源访问范围；邀请确认展示当前关联项目影响，不能声称“邀请不影响项目权限”。撤回不会删除员工已经下载的数据。
- 标已读必须选择当前可见、未过期消息的正整数 ID；不传空值让来源猜最新位置。当前已达该位置时不再发送旧标记。来源 API 无跨客户端原子 CAS，不承诺并发客户端下单调已读。

## 持久化与恢复

迁移 036–038：产品保存明确确认的 plan、来源绑定、主体/设备、请求键、Run 引用和分步派发证据；不保存完整来源成员列表、群消息或供应商响应正文。自己的最近 20 个回执仅返回操作、步骤、来源 ACK、回读计数和状态；会话 ID 仅在当前仍可访问时返回，历史 Run 结果及事件同样重新过滤，原始审计事实保留。退出/删除后的安全个人回执可读；组织/登录撤销后禁止读取。

来源写入前提交步骤 `dispatching`；网络调用在数据库事务外；随后保存 ACK 并回读。结果明确分为 succeeded、failed、recovery_required。相同请求键必须是完全相同的确认参数，只返回原回执，不重发来源写入。并发队列和人工入口按员工/来源/目标串行校验；已有排队、派发或未人工确认的未知操作会阻止同范围新写入。

建群包括创建和每次邀请，按实际步骤计入 AI maxActions。部分邀请失败保留已创建群和已邀请成员，停止后续步骤，不假装原子回滚。手工等待响应期间轮询自己的持久回执并保留停止入口；停止只收紧本人操作，不依赖来源网络恢复。取消保留当前已派发步骤的后续 ACK/实际效果，停止所有后续步骤。Worker 中断不自动重放外部动作。

来源建群没有通用请求幂等/关联 token；丢失创建 ACK 且没有确切来源 ID 时，保持未知，禁止按同名猜群或再建一个。只读对账只核验已获得 ACK 的确切对象，不以“当前状态刚好相同”伪造丢失 ACK。人工核对确认只解除新操作阻塞，原未知状态不消失，也不重新执行旧步骤。

独立通信 Run 的 conversation_id 为空，使用工作区/个人/任务规则。若明确目标会话已关联项目，则同时遵守该实际项目的当前规则；创建后的群在执行中新增关联，后续步骤也接受更严格项目规则，不继承无关界面项目内容。个人结果和运行资料清理独立于引擎私有状态。

## 接口

- GET `/api/talk/management?roomId=...`：当前员工来源、能力和会话/成员元数据。
- GET/POST `/api/talk/management/commands`：本人最近回执或人工执行 `{plan,idempotencyKey}`。
- GET `/api/talk/management/commands/:id`；POST 相同路径后加 `/reconcile`、`/stop`、`/acknowledge`（后者要求 `{confirmed:true}`）。
- POST `/api/talk/management/runs`：`{plan,idempotencyKey,engine,modelProfileId?,taskRules?}`；普通 `/api/runs` 不接受该 workflow；查询/取消沿用本人 Run 入口。

## 验证和上线边界

4 项来源 HTTP 协议测试、21 项通信数据库/Worker 场景和完整 213 数据库场景通过；36 单元/配置、类型/构建、冻结包、完整 64 Chromium UI、6 原生场景通过。最后的历史 ID 清理修正后，完整 213 数据库及新增双原生通信场景再次通过。新增真实来源场景已列入 CI，用独立 org-reader 来源员工创建/管理合成群，DSH/Hermes 运行并回读；容器场景将验证编译服务导入、持久未知分步证据在 API/Worker/DB 重启后保留，不宣称在容器 fixture 中执行过真实通信写入。本机无 Docker，不能代替真实服务 CI 或公司验收。

首次 AI 测试发现 task_rules 空值与数据库来源分区未扩展，修正默认值并新增迁移 038；没有放宽旧文件/项目约束。首轮新增 UI 2 过/1 失败，定位为通知下拉框的 accessible name 混入“当前设置”说明，修正后原 3 项重跑通过；补充手工停止与延迟失权场景后的 5 项也通过。审计新增用例证明特殊成员/分组讨论管理、过期确认下的安全失败回执、历史来源 ID 清理存在缺口，修复后相应原用例和完整数据库通过。首次失败日志和 UI trace 保留在忽略的本机 .runtime，不删失败证据、不提高重试掩盖。

2026-11-01 按用户授权使用现有 DeepSeek Flash 连接，未复制 Key 到测试库、文件或仓库；仅做两个有界真实供应商 Run，来源是临时合成 loopback HTTP fixture：

- DSH 查询：`2464e57d-a7b2-43c1-8aaa-7a388b895fa9`，runtime/succeeded，1 次 HTTP 200/completed，输入 2438 / 输出 77 tokens。
- Hermes 收藏：`e07f78fe-7fb7-4c71-8d70-6631affe177c`，runtime/succeeded，1 次 HTTP 200/completed，输入 3133 / 输出 162 tokens；合成来源恰有 1 次收藏写入并回读。

两次均经正常模型配置/权限/预算入口，未修改价格、预算或 Policy；调用前核对了 [供应商官方价格](https://api-docs.deepseek.com/quick_start/pricing/)。产品记录 cost_status=unpriced，没有供应商账单核验、免费调用或金额硬封顶结论。合成来源已移除、临时员工来源凭据已禁用并清空，业务审计保留；原模型 Key 未改动。私有报告在 .runtime/private-model-checks/communication-real/report.json，目录 0700、报告/日志 0600。此为真实模型加协议来源的小样例，不是真实 Nextcloud 或公司数据验收。

来源协议核对：[固定 Talk Conversation API](https://github.com/nextcloud/spreed/blob/v23.0.12/docs/conversation.md)、[Participant API](https://github.com/nextcloud/spreed/blob/v23.0.12/docs/participant.md)、[RoomFormatter](https://github.com/nextcloud/spreed/blob/v23.0.12/lib/Service/RoomFormatter.php) 及 [BreakoutRoom 常量](https://github.com/nextcloud/spreed/blob/v23.0.12/lib/Model/BreakoutRoom.php)；源码返回 breakoutRoomMode 整数 0–3，缺失保持未知。

运行 `npm run migrate` 前备份产品数据库；首次应用后不得编辑已应用迁移。回退应用时停止 Worker，保留 036–038 表和证据，不删除已派发回执；已有新型 Run 无法被旧 Worker 安全处理，应保持停止并人工对账。没有清空来源对象的自动回退。

手机通知仍需公司实际设备/客户端验收；通知等级设置成功不等于手机已响铃。公司规模、生产身份、业务资料、真实模型理解质量及完整 E01–E10 仍未验收。

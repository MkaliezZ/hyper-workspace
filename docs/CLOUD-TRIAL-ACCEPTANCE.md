# 云端真实来源联合检查

日期：2026-11-03。环境为用户选定的阿里杭州独立试用机，仅使用受控合成账号和资料；公司正式部署采用 [内网 IP](DEPLOYMENT-INTRANET.md)。本文记录实际成功和失败，不表示整个首版或公司验收已通过。

## 当前已验证

- 应用镜像 `9be68e5` 已构建并核对 VCS 标签；API、Worker、PostgreSQL/pgvector、固定版本 Nextcloud/Talk 和 CPU 向量服务均实际启动。来源与产品分库分角色，数据库和向量服务不发布公网端口。
- Nextcloud Login Flow v2 已实际完成管理员和普通员工授权，产品回读的工作区/角色正确、`demo=false`；个人 chat 连接不对另一员工可见。实际供应商为获准的个人 DeepSeek 连接，Key 不进入本文。
- PDF、DOCX、XLSX、PPTX 四份合成文件已通过真实 WebDAV 上传、产品导入与云端解析；内容标记和格式回读通过，另一员工读取导入对象均为 404。后续联合检查再次回读原版本和权限，无重复上传。
- 固定公开 CPU 权重独立推理、512 维、相关中文排序、鉴权、400 字符边界和 8×400 批处理已验证。独立服务峰值约 379 MiB；产品中的真实语义检索已命中原件；双引擎私人解读均保存并回读，另一员工仍不可读。

## 实际业务与失败

| Run | 引擎/工作流 | 实际结果 |
| --- | --- | --- |
| `5bec4d3f-ee91-4c2f-97ab-d86672364d16` | DSH / 讨论转纪要 | succeeded；真实来源引用、纪要和两项待办回执通过，两项日期分别为 2026-11-04 / 2026-11-05 |
| `34b11b17-8376-43f4-8607-89a788812b14` | DSH / 第一项员工分配 | succeeded；明确的来源 UID 对应真实产品员工 ID，分配后版本 2、状态 open、负责人回读一致 |
| `0012a26f-3e96-4a7b-8d77-66e5cf8bcee6` | DSH / 第二项员工分配 | failed；错误显示 Runtime connection closed。核对该 Run 的动作记录为空，第二项仍为版本 1、未分配；没有盲目重放 |
| `efaa5188-2cd8-4786-8702-1697da6a7b4b` | DSH / 检查当前状态后明确续做第二项分配 | succeeded；一条 task.assign 动作 completed，模型 HTTP 200 / completed / reported，回读负责人、open 和版本 2 通过 |
| `a42a16b7-1b45-4ac5-83f1-4e94d5f8e7bb` | Hermes / 同一成果续改 | failed；达到 180 秒限制，动作记录为空，模型请求 completed / reported（输入 4,164、输出 996），未冒充零费用 |
| `5268ee7a-71f6-43b3-a471-b93de19cbd5e` | Hermes / 核对旧版本后续改 | succeeded；在 API 阶段关闭已验证的浏览器页面后，原成果版本 1 → 2，仍经完整当前来源与权限检查 |
| `2cbccc10-c3bb-4e68-b0c9-c7de68673565` | DSH / 项目周报 | succeeded；项目周报成果真实保存并回读 |
| `8b861815-bf45-4a17-a475-e3614ef5294d` | DSH / 静默跟进 | succeeded；无后续变化时 notify=false |

第三个 Run 的模型请求记录为 HTTP 200、transport unknown / usage unknown，不能据此断言供应商未计费或把它改成零费用。该 Run 未完成分配也不影响前两次已完成的真实对象。后续续跑必须保留失败编号，读取当前任务版本和已发生动作后再提交新的明确请求。

关闭来源空闲连接后，明确续做的分配使用真实 DeepSeek：本次请求输入 2,843、输出 109 token，用量完整；供应商响应约 1.9 秒，整个 Run 从创建到终态约 118 秒，包含排队、来源校验与业务回执，不能将模型耗时当作整体耗时。该次续做成功后继续按当前状态完成另一引擎与其余业务，下表及后续批次记录最终结果。

该失败不是容器 OOM：Worker 的 cgroup OOM/kill 为 0、未重启，观察内存峰值 236,294,144 字节。现有 RPC 在宿主中止时关闭连接，会把本来有意义的宿主原因遮成管道关闭；新增回归已复现该诊断缺陷，修正保留受控宿主中止原因，并区分来源暂时不可用与已变化的权限/规则。修正后的云端诊断复验见文末；不能从诊断修正推断底层故障已消失。

后续已完成 Hermes 纪要/员工分配、两向同成果 v1→v2、双引擎周报/静默跟进及私人文档检索/解读；这些是本环境真实供应商结果。既有 [真实业务](REAL-BUSINESS-ACCEPTANCE.md) 和 [方法质量](REAL-METHODS-ACCEPTANCE.md) 人类反馈保留其原有范围。

## 页面加载证据边界

最初两次授权在填写凭据前因冷资源下载/并发阻塞失败，未产生来源业务写入或模型调用。Apache 处理槽从 3 调至 8，为浏览器六条资源连接、设备查询和健康检查留出位置，内存上限仍为 640 MiB。该配置的限速冷登录已进入真实来源 CI。

后续 WAN 冷加载超时也保留。为继续业务核对，本轮使用三份与同一固定服务器字节摘要一致的公开 JavaScript 静态缓存；只缓存 core-common / core-main / files_sharing-main，不缓存 HTML、令牌、身份响应或任何业务 API。所有授权、权限和业务请求均走真实服务。该方式证明业务链路，不证明远程冷页面加载性能。临时入口仍为 SSH 隧道，未开放公网 HTTP。

## 云端产品库恢复

已用现有主密钥创建并离线校验 289,166 字节的一致归档，备份编号 `859ffbee-5d14-4f20-afb8-d23fbb2738bb`，SHA-256 `c2c70ad5e7a9c8934ed581c4394c20dc4434e5821ffde410b06a673d853f17f4`。实际恢复到新建隔离库，状态 `verified_isolated`，恢复编号 `9afb58c2-8d3f-4cc9-a115-ec8326d04c78`，7 条活动凭据密文检查通过，旧队列不存在，未启动 API/Worker、未调用外部业务系统、未切换原库。

该快照时三个 Run 均已终止，隔离报告中的 activeRuns / recoveryRuns 为 0；不据此声称本次验证了云端在途 Run 的恢复。Nextcloud 原件/数据库需要配套一致备份，该产品库归档本身不替代来源备份或公司灾备切流；后续来源配套备份与隔离恢复已完成，见 [完整记录](SOURCE-BACKUP-RESTORE.md)。归档、签名与私有配置留在管理员受限目录，不提交公库。

后续明确等待一个新 Run 开始，再在原环境继续运行时取得第二份有效快照：备份 `ed7ac516-afb8-4430-9cb7-872202892912`，305,102 字节，SHA-256 `b87f855371e2bcc7268379f7dd565fea42a85934b6217ddf2f36425f680817ac`。隔离恢复 `48e9610f-5488-4227-a49e-a1067ff15dd7` 为 verified_isolated、15 条活动密文检查通过；原为 running 的 Hermes / assign_task `38fa0fb7-1e0c-490d-ba0e-64fc91671ce4` 在恢复库实际回读为 recovery_required，recoveryRuns=1、activeRuns=0，旧队列和登录均清理。未启动恢复库服务、未调用外部业务、未切换原库、未重放分配。一次较早的捕获未赶上活动窗口，recoveryRuns=0，保留为无在途恢复记录，不算该项通过证据。

## 最新独立 CI

执行详情实现 `f77e7b7` 的 [CI 41631467691](https://github.com/MkaliezZ/hyper-workspace/actions/runs/41631467691) 三个 job 全部成功：65 单元、9 Python、8 解析、253 数据库、9 原生、76 UI、18 真实来源、7 容器及 4 IP TLS/代理，共 449 项。完成日志逐份核对，UI 无重试，来源 19.2 分钟。CI 使用合成资料及协议模型，真实供应商另查本记录。新同名项目展示回归的后续提交 CI 单独记录。

## 来源连接耗尽修正

诊断修正 `77a8bcb` 已作为增量应用镜像部署：沿用已验证的 `9be68e5` 原生运行时层，核对基础层和编译后的 processor / source map 摘要，五个服务健康；全量同源构建另外记录。再次明确续跑的 `19d03d6b-e4cb-4a91-a57f-90a7be0cac8d` 返回了正确的“企业来源暂时不可用”原因，模型请求和业务动作均为 0，目标仍未分配。

在 API 和 Worker 中各做了 40 次双路只读范围检查，全部通过。随后对同一来源保持 24 条空闲 HTTP 连接：第 25 条读取在 10,009 ms 超时，未请求模型、未写业务对象。这复现了小型 Apache prefork 池被空闲连接占用的机制；[Apache 官方性能说明](https://httpd.apache.org/docs/2.4/misc/perf-tuning.html)描述了这种行为。

来源只作 loopback/容器网络 HTTP 后端，因此设置 `KeepAlive Off`，员工的 HTTPS 连接由前置代理维护。对同一服务器用同样 24 客户端复验，读取 HTTP 200，耗时 804 ms；Apache 语法检查通过并已 graceful reload。没有扩大内存上限、放松权限校验、增加模型重试或重放未知写入。该结果验证了此连接耗尽机制的修正，随后真实业务联合链路已按下述完整回执续验。新增真实来源回归让空闲连接场景下的新读取须在 3 秒内完成。

## 全量构建与运行镜像

首次云端 `9be68e5` 全量构建成功。后续 `77a8bcb` 全量构建在 Hermes 原生 PM 的 uv 依赖下载阶段超出 1800 秒并失败，不能记为已完成；不是业务 Run 的超时，也未修改其 180 秒执行限制。当前实际运行的 `77a8bcb-app` 是上述已核验运行时基础层加编译后的单个应用模块增量，层链和文件摘要已核对；该提交的完整 Docker 构建另外已在 CI 通过。未改变原生依赖锁、伪造安装回执或放松完整性检查。

## 续跑与诊断边界

一次后续只读检查遇到客户端 socket hangup，在新业务 Run 创建之前停止。诊断曾带出合成测试会话字段，该会话已明确撤销一条，私人报告已脱敏。续跑工具只为 GET 的 ECONNRESET 启用一次传输重试；所有写入仍为零自动重试，错误输出不记录请求头、Cookie 或授权 URL。当前按已完成对象版本续跑，不重放前两次已完成写入。

## 最终业务与方法联合检查

只读账本快照时间 2026-11-03 18:18 UTC：共 25 个业务 Run，22 succeeded、3 failed，没有 queued/running。成功的第一批 14 Run 为两引擎各自的纪要、两次员工 ID 分配、对方成果续改、周报、静默检查和私人文档解读；后续 8 Run 完成两向方法提炼/复用/撤回及重要变化合并提醒。全量编号如下，前述失败保留原状，不把另一个成功 Run 覆盖到失败记录。

| Run | 引擎 | 工作流 | 状态 |
| --- | --- | --- | --- |
| `5bec4d3f-ee91-4c2f-97ab-d86672364d16` | dsh | discussion_to_minutes | succeeded |
| `34b11b17-8376-43f4-8607-89a788812b14` | dsh | assign_task | succeeded |
| `0012a26f-3e96-4a7b-8d77-66e5cf8bcee6` | dsh | assign_task | failed |
| `19d03d6b-e4cb-4a91-a57f-90a7be0cac8d` | dsh | assign_task | failed |
| `efaa5188-2cd8-4786-8702-1697da6a7b4b` | dsh | assign_task | succeeded |
| `a42a16b7-1b45-4ac5-83f1-4e94d5f8e7bb` | hermes | revise_artifact | failed |
| `5268ee7a-71f6-43b3-a471-b93de19cbd5e` | hermes | revise_artifact | succeeded |
| `2cbccc10-c3bb-4e68-b0c9-c7de68673565` | dsh | project_report | succeeded |
| `8b861815-bf45-4a17-a475-e3614ef5294d` | dsh | follow_up | succeeded |
| `9980f8aa-c412-4307-bd8e-8bfcf87d2cb6` | hermes | discussion_to_minutes | succeeded |
| `b319eae8-f88a-4900-8c6b-318bf5b189a6` | hermes | assign_task | succeeded |
| `38fa0fb7-1e0c-490d-ba0e-64fc91671ce4` | hermes | assign_task | succeeded |
| `27760077-d001-4207-88dd-ad171fa15268` | dsh | revise_artifact | succeeded |
| `ead5f270-e5f0-483e-8fdd-855999d3baab` | hermes | project_report | succeeded |
| `0f57feb7-253e-4b48-8be7-4cabd0d51b23` | hermes | follow_up | succeeded |
| `b4337586-d003-4a0f-80a9-e4dabea7da9b` | dsh | read_file | succeeded |
| `e01e830f-eeff-4c54-90c9-cb1e398dfe77` | hermes | read_file | succeeded |
| `9cf31ffd-8630-4835-b218-7f8e309d198e` | dsh | manage_method | succeeded |
| `7eb53167-9f9b-4596-a8f4-cdaf479ac46a` | hermes | project_report | succeeded |
| `b9174af2-e4ff-4450-a45a-1fb46da64696` | dsh | manage_method | succeeded |
| `50d6adb1-00b1-4a19-8e46-675040b2badc` | dsh | follow_up | succeeded |
| `b15a64ed-f43f-4976-b85f-9a3bc34f8455` | hermes | manage_method | succeeded |
| `59d096c4-accc-40c6-b3c2-c3bb45a3f374` | dsh | project_report | succeeded |
| `68ad7019-55f0-4e5f-b50a-ebf0903b7586` | hermes | manage_method | succeeded |
| `b883814e-6ee2-4ca7-ba4f-9b32e0f0aa3f` | hermes | follow_up | succeeded |

方法候选基于同一成果明确版本 2；维护人显式确认验证依据后，只在原项目发布为 v1/revision3。绑定真实来源的方法向整个工作区扩张被拒绝（403），不以管理员角色绕过来源范围。由相反引擎精确引用方法版本制作新周报，实际使用记录与 Run 对应。操作者将合成待办从 open/v2 改为 done/v3，并在真实 Talk 加入核对标记；周报使用新状态与标记，审批仍未获得、尚未上线，旧方法例子没有代替当前事实。试用操作者的完成标记不代表真实员工工作签收。

| 方法引擎 | 方法 ID | 复用成果 ID | 撤回后状态/修订 | 旧引用执行 | 合并提醒 |
| --- | --- | --- | --- | --- | --- |
| DSH | `f4e6177a-3286-4613-881c-047bc819be02` | `3bc3b048-f9a1-4e23-9570-2dc8f1f83ef4` | withdrawn / 4 | 409，模型前拒绝 | 两项状态变化，一条消息 `90a9bf38-9597-486e-bdf2-b21820af5f2c` |
| Hermes | `83e4ef8e-52db-41ec-b331-0a3e52960eeb` | `1e0012f7-0d97-49a3-9959-71abc4a266d3` | withdrawn / 4 | 409，模型前拒绝 | 两项状态变化，一条消息 `c3a231c0-359c-4a0a-a4de-874dc946f888` |

两条方法在撤回后从有效方法检索中消失，另一员工读取为 404；历史回执保留。另一员工读取管理员活动 Run 以及借用管理员个人模型连接均为 404，没有通过模型验证来暴露凭据。本轮没有为另一员工复制个人 API Key。多主体并发、运行目录和确认参数的进一步保护由真实原生 SDK 的受控协议回归覆盖，不冒称两把真实付费 Key 的并发实测。

首轮方法脚本漏传撤回 reason，HTTP 400 在创建新 Run 前拒绝；先读取已发布方法、已完成任务和复用记录，再补理由续做，未重复发布、改任务或发原消息。另一次周报脚本只接受 project.report，实际 artifact.create 也是合法保存回执；读取已有成果完成核对，未重做成功的 8 Run。脚本错误不改写为产品失败或首轮全通过。

私人 Markdown 从真实 Files 上传、导入与 pgvector 语义检索命中；DSH/Hermes 解读均保留“北侧总阀门”、`HW-CLOUD-042`、值班人员姓名未知以及合成试用/非公司制度的说明。另一员工导入及读取拒绝。该题证明实际链路和此输入，不替代完整语义质量；固定八题评估见 [SEMANTIC-QUALITY.md](SEMANTIC-QUALITY.md)。

## 实际请求及费用口径

账本共 28 条请求：25 条 deepseek-flash、3 条本机 CPU embedding；27 条 completed/reported，1 条 transport/usage unknown。已报告合计输入 82,124、输出 15,480 token，含两类模型及连接验证，不等于完整供应商账单；未知一条没有填零。没有配置价格版本的请求为 unpriced，不能由此断言免费或总费用为零。管理员个人模型 Key 未进入报告或源码。

## 最终交付边界

E08 三项材料的人类反馈已齐：原 v2 纪要的清晰度，以及执行详情日志按需展开、失败说明可操作；用户回答均为满足。此前方法候选/复用质量反馈仅覆盖原报告材料，不扩大到本轮所有输出或公司采用。

来源配套完整备份/隔离恢复已完成，见 [SOURCE-BACKUP-RESTORE.md](SOURCE-BACKUP-RESTORE.md)。公司局域网 Linux 机器/IP 仍“待准备”，内部 CA 信任、该机器的多员工负载、原数据切流和正式组织签收尚未执行。临时云端只作私有技术验收；以上不改变固定首版范围，也不承诺执行器私有检查点热迁移。


临时候选环境于 2026-11-04 更新为 f4859cd-app：保留已核验原生层，实际容器中 122 个应用文件摘要和 UID10001 通过；API/Worker 健康，数据库/向量/Nextcloud 容器 ID 未变化。更新前后活动 Run 均为0，无模型调用或业务写入。该次代码完整 CI 尚在检查来源套件，不能提前称三项全绿。只读 UI 复验随后发现重新登录无法找回历史执行，已在新一批补齐本人历史入口和043索引；此时云端尚未部署该新入口，不把失败复验算通过。

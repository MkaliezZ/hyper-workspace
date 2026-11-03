# 数据库备份与隔离恢复检查

映射 P04/P07/P08、C05/C07、A01/A04/A06/A08/A10、E09/E10 的运行恢复子集。技术与三层定义不变。工具仅供受控部署管理员使用，不开放模型自选数据库、路径或 SQL 的入口。

`scripts/workspace-backup.mjs` 提供创建、离线校验和新建隔离库恢复检查。它保存产品数据库中的资产、版本、关系、模型/身份密文、费用记录和执行回执；恢复检查保留这些对象的 ID 与历史，并隔离未完成工作。工具不覆盖现有库，不启动 API/Worker，不自动切换生产连接。

## 覆盖范围

| 对象                                          | 处理                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------ |
| 产品业务、原始文本副本、提取内容、向量与索引  | PostgreSQL 17 custom archive 保存；恢复时由 PostgreSQL 重建              |
| 模型、设备凭据                                | 原密文保存；创建前、恢复后逐批验证当前主密钥能解密活动凭据，明文不输出   |
| Run、动作、成果和反馈历史、费用预留与未知费用 | 保留；不把未知请求改成免费或失败                                         |
| queued/running Run                            | 恢复库转 `recovery_required`，清理租约，追加有恢复 ID/备份 ID 的产品事件 |
| 活跃定时跟进                                  | 恢复库暂停并递增版本，不补跑旧周期                                       |
| 在途消息/附件发送、通信步骤、准备中上传       | 保留意图和已有回执，转待核对；不重复向来源发送                           |
| 登录会话、尚未完成的登录流程                  | 在恢复库清除，使用前重新登录                                             |
| `hyper_jobs`                                  | 排除；任务队列由产品状态重新建立，旧队列任务不回放                       |
| Nextcloud 原件、来源服务器及其全量历史        | 仍由来源系统备份；本工具只保留产品引用和已导入副本                       |
| 运行角色、操作系统、执行器目录、部署秘密文件  | 分别由部署流程管理；数据库归档不携带全局角色密码或主密钥                 |

归档为压缩格式，HMAC 用于完整性校验，不提供整份企业数据的加密。归档需按公司要求加密存储，并与主密钥的受限备份分开保存。目录 0700、文件 0600；禁止写入仓库公开路径，允许被忽略的 `.runtime` / `.data`。`.dump` 也加入 Git 忽略。

## Compose 用法

在仓库根目录执行，沿用**现有** `.env.compose` 的主密钥和实际项目名称。父备份目录需已存在且由管理员控制；下列目录和报告文件必须尚不存在。

```bash
# 使用固定数据库容器内的 PG17 客户端，主机不需另装 pg_dump。
node --env-file=.env.compose scripts/workspace-backup.mjs create \
  --compose-project hyper-workspace --env-file .env.compose \
  --directory /private-backups/hyper-20261101

# 离线校验签名与全部归档字节，不连接数据库。
node --env-file=.env.compose scripts/workspace-backup.mjs verify \
  --directory /private-backups/hyper-20261101

# 在指定 PG17 实例中新建随机 hyper_restore_* 库；现有 hyper 库不覆盖。
node --env-file=.env.compose scripts/workspace-backup.mjs restore-check \
  --compose-project hyper-workspace --env-file .env.compose \
  --directory /private-backups/hyper-20261101 \
  --report /private-backups/hyper-20261101.restore.json
```

使用其他 Compose 文件时，逐一增加 `--file compose.yaml --file deploy/your-overlay.yaml`。配置文件必须是普通私有文件，不能为符号链接。Docker 子进程仅继承所需的 Docker/系统环境，部署参数从指定私有文件读取，不打印完整 Compose 配置。

备份使用数据库一致快照；建议在维护窗口停止新的 API/Worker 写入，并暂停主密钥、结构或扩展变更。结构/扩展在备份前后不一致时不生成成功清单；创建时源凭据检查不能替代后续恢复检查。仅支持与本代码版本完整迁移集匹配的专用产品库（当前到 042），拒绝混入其他应用表、无效约束/索引及不匹配的 PG 客户端主版本。

## 已有本机 PostgreSQL

在私有环境文件中提供 `BACKUP_DATABASE_URL` 和原 `CREDENTIAL_MASTER_KEY`，使用 PG17 客户端目录。连接 URL 不放入命令参数、报告或聊天。

```bash
node --env-file=/private-config/hyper-backup.env scripts/workspace-backup.mjs create \
  --url-env BACKUP_DATABASE_URL --bin-dir /path/to/postgresql17/bin \
  --directory /private-backups/hyper-20261101

node --env-file=/private-config/hyper-backup.env scripts/workspace-backup.mjs restore-check \
  --url-env BACKUP_DATABASE_URL --bin-dir /path/to/postgresql17/bin \
  --directory /private-backups/hyper-20261101 \
  --report /private-backups/hyper-20261101.restore.json
```

只允许明确的单库名称。连接支持 `sslmode/sslrootcert/sslcert/sslkey`；保留环境中的相应 TLS 设置，URL 显式值优先。未知连接选项拒绝处理。PG 连接秘密只传入 PG 客户端所需环境，主密钥留在备份工具进程；不转发无关业务 Key。

## 校验、失败和恢复

创建成功后目录包含 `workspace.dump` 与 `manifest.json`。清单记录归档 SHA-256/长度、扩展/迁移、客户端版本、工具源码 SHA-256 和活动凭据检查数量；通过从原主密钥派生的 HKDF-SHA256 签名密钥计算 HMAC。清单不包含原主密钥、API Key 或源凭据明文；它不是员工签名或供应商账单证明。

恢复先验证清单和归档，再创建私有临时副本并复核字节。恢复实际使用该副本，原归档随后被改动也不能替换已核验输入。临时副本在正常结束和可处理失败时清理；强制终止后的残留需在受控环境检查。原归档不改写。

只有完成核验后才新建随机隔离库。`pg_restore --single-transaction --exit-on-error --no-owner --no-privileges` 不使用 `--clean` 或 `--create`，不删除旧库。恢复后检查扩展/迁移、约束、索引及凭据，再原子隔离活动工作。报告记录 `verified_isolated` 或 `failed_isolated`、恢复库名、备份引用和检查结果，并带签名。数据库操作诊断不回显；错误提供工具、退出码和诊断长度供管理员在受控环境核查。

失败时不覆盖原库、不自动删除已创建的隔离库、不启动服务。先检查新报告和该隔离库；报告路径已存在会在数据库操作前拒绝，不能用覆盖报告来重试。签名/主密钥错误、归档损坏及公开权限等情况在恢复数据库命令前拒绝。

`verified_isolated` 表示此备份已成功还原并完成隔离检查。正式接管仍需在新的恢复实例上按对应代码/扩展版本重建受限运行角色，核对来源连接与当前权限、未知费用和外部动作，再受控切换产品连接。工具未自动提升隔离库为生产库；公司灾备、备份保留/异地存储和切流演练仍需验收。恢复后的新任务可选择 DSH 或 Hermes；恢复出的活动任务先核对已有动作，再在明确边界重启。

## 验证证据

本地真实 PG17/pgvector 的 3 项集成用例通过：归档/新库恢复、稳定文档 ID/版本/向量与模型/设备密文、在途 Run/定时/各类发送意图隔离、原库不变；错误主密钥、损坏归档、混用其他应用表和路径覆盖均拒绝。另有 7 项进程/文件协议单元用例，覆盖原路径被替换、权限/符号链接、私有报告、参数/诊断和环境边界。协议用例不代替实际 PostgreSQL 测试。

主实现完整本地 230 数据库、单元/类型/构建回归通过，后续签名/临时副本与路径保护的 7 单元/3 真 PG 用例亦通过。提交 `9c062efa7a9cc25e5de9b104b68de299759955bd` 的 [CI 41321121462](https://github.com/MkaliezZ/hyper-workspace/actions/runs/41321121462) 三项全部成功，共 383 项：46 单元、3 下载器、8 解析、230 数据库、7 原生、70 UI、14 真实来源、5 容器；另含类型/构建、双 npm 审计与冻结包。新增实际 Compose 备份/新库恢复验证通过，使用隔离合成数据库与固定 PG17 容器；本机仍无 Docker。原冻结包未修改，没有真实企业数据或本模块模型调用，不表示公司灾备切流通过。

首轮失败保留：本机 PG 客户端尚引用改名前的编译路径，修复被忽略的本机客户端链接后继续；PG 工具对 `--version` 的参数位置要求与 `psql` 不同，现保留版本参数首位，原断言继续执行。修复后实际数据库和文件/进程验证通过。

依据：[PG17 pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html)、[pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html)、[SQL dump 与全局角色边界](https://www.postgresql.org/docs/17/backup-dump.html)。仅恢复可信来源归档；PostgreSQL 恢复会执行归档中的 SQL。

## 企业金额账本恢复（041）

新版本要求完整迁移集包含 `041_organization_budgets.sql`。独立企业计价版本、工作区/项目控制、原请求关联、估算/管理员声明及未结算预留随原库归档，不使用个人单价重算。恢复库中未结束且未由有权人员声明的模型请求和企业费用标记为待核对；保留金额、价格版本和原始用量，不计为免费、不退款，也不重发供应商请求。启用的预算据此暂停后续准入。已明确声明的金额与原估算同时保留，恢复不会替管理员编造账单。

旧迁移集的归档须使用与该归档匹配的代码/工具先做隔离恢复，再按升级说明迁移；不把新版工具强套到旧结构。开发机在应用 041 前，使用保留的 040 代码快照生成并校验了独立受限备份；未覆盖原库或重置主密钥。扩展的本地真 PG 用例已验证未知预留、已声明金额/原估算与源库不变，以及恢复后拒绝新准入；真实 Compose 场景按本代码提交的 CI 单独核对。

企业账本恢复增量已由实现 `a0a5c52` 的 [CI 41353513303](https://github.com/MkaliezZ/hyper-workspace/actions/runs/41353513303) 核实：245 数据库回归和 6 项容器均成功，包含实际 Compose PG17 备份/随机新库恢复，未结束模型请求与企业费用标为待核对，预留不抹零，原库保持原值。该证据不代表公司切流或恢复时效验收。

## 本机向量连接容量（042）

迁移 042 为模型连接保存单次输入容量；备份/恢复要求匹配包含此迁移的完整结构，恢复后按相同容量重建派生索引。应用迁移前已用 041 工具创建并离线校验独立受限备份；旧归档仍须使用对应旧代码先隔离恢复，不跳过结构匹配。本机模型权重可按固定锁重新下载，常驻服务访问凭据须另外受限备份；不属于 PostgreSQL 归档自动包含的本机文件。详见 [LOCAL-EMBEDDING.md](LOCAL-EMBEDDING.md)。

### 当前开发库的实际恢复检查

2026-11-02 使用当前 042 工具，为本机现用开发库创建一致归档并离线校验：7,373,423 字节，备份编号 `1d18afe3-61df-4603-8d73-90c4240137c5`。随后实际恢复到一个新建隔离 PostgreSQL 库，报告为 `verified_isolated`，58 条活动加密凭据检查通过，旧队列不存在，API/Worker 未启动、外部业务系统未调用、未切换原库。原库包含演示/合成验收资料及已有模型配置，不是公司生产数据。

恢复编号 `66872978-475e-4923-abcc-3f06f50a8acb`；归档 SHA-256 为 `98960fbb08458f9c13b91c9f04db8d1c2cf4db4b93cc5361f09df1a6f588fd18`。归档、带签名报告及配置留在受限本机目录，未提交公库。该检查补充当前数据和密文可恢复的实证；公司灾备切流与来源服务器备份仍独立验收。

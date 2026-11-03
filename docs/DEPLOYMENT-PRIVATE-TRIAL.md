# 带独立来源与本地向量服务的私有试用

映射 P02/P04/P07、C00/C02/C05/C07、A01/A03/A04/A10 与 E02/E04/E09/E10 的部署子集。产品三层定义、默认 DSH、必需 Hermes 和资产所有权均不变。

默认 [Compose 部署](DEPLOYMENT.md) 接入管理员已有的 Nextcloud。以下可选文件用于一台独立 Linux 主机上的新试用环境：

| 文件 | 作用 |
| --- | --- |
| `deploy/compose.source.yaml` | 新建来源数据库与独立 Nextcloud，数据保存在 `nextcloud_data` 卷 |
| `deploy/compose.local-ai.yaml` | 固定开源中文向量模型的 CPU 服务，供产品保存 embedding 连接使用 |
| `deploy/compose.small.yaml` | 限制各容器 CPU/内存、Apache 进程数，将单个 Worker 的 Run 并发降为 1 |

来源与产品共享 PostgreSQL 进程，但使用不同数据库和登录角色。来源角色不能连接产品库，产品运行角色不能连接来源库。来源初始化只有部署管理员可运行，API/Worker 不取得数据库管理员、来源数据库或来源管理员密码。Nextcloud 的员工、群、应用仍经 `occ` 或公开 API 管理；产品不写来源表。

这些配置不会自动接入公司资料，不创建正式员工，也不把测试账号当公司身份。2 GB 主机仅作为待测的受限试用候选；各容器内存上限之和可超过物理内存，必须实际观察峰值、交换与请求延迟后决定容量。`WORKER_RUN_CONCURRENCY` 为每个 Worker 的 1–8 并发，默认仍为 2；多 Worker 的总并发需另行控制。

## 准备配置与公开模型

先在专用目录按部署文档生成新的私有 `.env.compose`，不要覆盖旧安装配置或重新生成旧主密钥。追加以下设置，密码使用分别生成的 64 位随机十六进制值，保存在权限 0600 的文件中，不在命令行或聊天传递：

```dotenv
HYPER_NEXTCLOUD_DB_PASSWORD=<独立随机值>
HYPER_NEXTCLOUD_ADMIN_USER=<明确的来源管理员 UID>
HYPER_NEXTCLOUD_ADMIN_PASSWORD=<另一个独立随机值>
HYPER_NEXTCLOUD_PORT=8090
HYPER_PORT=8180
APP_ORIGIN=http://localhost:5187
DEMO_MODE=false
NEXTCLOUD_URL=http://127.0.0.1:8090
NEXTCLOUD_INTERNAL_URL=http://nextcloud
NEXTCLOUD_MEMBER_GROUP=hyper-workspace-members
NEXTCLOUD_BOOTSTRAP_ADMIN_IDS=["<同一个来源管理员 UID>"]
NEXTCLOUD_TALK_ENABLED=true
NEXTCLOUD_FILES_ENABLED=true
```

保留 `deploy-init` 生成的独立工作区 UUID，设置实际 `WORKSPACE_NAME`。HTTP 地址仅用于 SSH 隧道试用；对组织开放时改用经过验证的 HTTPS 地址和来源信任域，不直接开放这些 HTTP 端口。

在有 Node 24 的准备机上，按 [本地向量文档](LOCAL-EMBEDDING.md)下载并复核固定模型，再准备严格白名单上下文：

```sh
node runtime/evaluations/prepare-container.mjs
node runtime/evaluations/prepare-container.mjs --execute
```

第一条仅离线预检，第二条复核固定六个文件并创建 `.runtime/embedding-build-source`，重跑只接受本工具拥有且摘要一致的上下文。仅将这个公开权重目录作为 `embedding_model` 构建输入；不要把包含私人配置的 `.runtime` 整体用作上下文。向量服务镜像使用独立 npm 锁，CPU 推理不下载 CUDA；权重锁见 `embedding-model.lock.json`。启动禁止远程模型下载。

在 Linux 部署机创建服务配置文件，内容是 `version: 1`、随机 `serviceId` UUID、`port: 3116`、随机 64 位十六进制 `credential`；由 UID/GID 10001 拥有，权限 0600，父目录受限。可用仓库的 `createLocalEmbeddingConfig` 生成，再由管理员调整所有者。添加配置文件路径和公开模型上下文路径到私有环境文件：

```dotenv
HYPER_EMBEDDING_CONFIG_FILE=/absolute/private/embedding.json
HYPER_EMBEDDING_MODEL_CONTEXT=/absolute/public-model-context
```

Docker Compose 文件型 secret 在 Linux 以绑定文件提供；必须核对实际所有者/权限。服务拒绝非本人、符号链接或其他用户可读的配置。它只在容器网络监听 3116，未发布主机端口；需要独立 256-bit Bearer 凭据。API/Worker 不直接挂载该文件，连接仍通过产品模型配置及凭据服务保存。

## 启动与来源配置

以下命令均在仓库根目录运行；只核验配置，不打印展开后的秘密：

```sh
docker compose --env-file .env.compose -f compose.yaml \
  -f deploy/compose.source.yaml -f deploy/compose.local-ai.yaml \
  -f deploy/compose.small.yaml config --quiet

docker compose --env-file .env.compose -f compose.yaml \
  -f deploy/compose.source.yaml -f deploy/compose.local-ai.yaml \
  -f deploy/compose.small.yaml build api embedding

docker compose --env-file .env.compose -f compose.yaml \
  -f deploy/compose.source.yaml -f deploy/compose.local-ai.yaml \
  -f deploy/compose.small.yaml up -d --no-build --wait --wait-timeout 600
```

启动依赖为数据库 → 产品初始化 → 来源数据库初始化 → Nextcloud → API/Worker；向量服务也须健康。来源数据库工具 `node scripts/deploy-nextcloud.mjs` 默认不连接数据库，只有 `--execute` 才在专用 Compose 管理环境初始化；同一凭据可重跑，不静默修改旧密码，遇到其他角色/库或异常权限则拒绝。

服务健康后，用管理员在该专用 Nextcloud 上经 `occ` 创建上述成员组、加入来源管理员及明确标记的试用员工。Talk 采用 `runtime/nextcloud/talk.lock.json` 的 23.0.12 发行包；`python3 runtime/nextcloud/install-talk.py` 复核大小/摘要，随后复制已核验 `spreed` 到来源容器 `custom_apps`，调整为 `www-data` 所有并执行 `occ app:enable spreed`，回读 `installed_version`。现有实例先检查原应用与兼容性，不能覆盖未知安装。来源管理员不自动等于所有产品管理员，首位管理员仍须匹配配置并通过真实 Nextcloud Login Flow。

在本机使用已有 SSH 连接建立回环隧道：

```sh
ssh -N -L 127.0.0.1:5187:127.0.0.1:8180 \
  -L 127.0.0.1:8090:127.0.0.1:8090 <已有 SSH 别名>
```

打开 `http://localhost:5187`，完成来源授权。设置中保存 chat 连接，并保存 embedding 连接：endpoint `http://embedding:3116/v1`、模型 `local-bge-small-zh-v1.5-q8`、维度 512、单条输入容量 400、密钥为独立服务凭据。先验证，再使用明确范围的试用资料检索；长文由产品完整分块。供应商 Key 仅保存在本人获准连接中，不能随镜像发布或未经授权改成公司共享。

## 备份、停止与恢复

产品库沿用 [签名备份与隔离恢复](BACKUP-RESTORE.md)，工具参数须包含本次使用的所有 Compose 文件与原私有配置。来源库及 `nextcloud_data` 原件还需单独一致备份，并遵循 Nextcloud 维护/恢复流程；产品备份不包含来源数据库或文件卷。模型公开权重可按锁重建，服务凭据、来源凭据和产品主密钥须分别受限备份。

停止时使用相同文件组合的 `stop`，保留卷和私有配置；禁止 `down --volumes` 清理企业数据。首次初始化失败先核对原库/角色标记、私有凭据和安装状态，再重跑；不要通过改密码、换主密钥、删卷或重放未知外部动作恢复。已有数据升级先备份、核对迁移和运行中任务；取消来源叠加配置不能让仍依赖它的产品获得健康结论。

## 当前证据

2026-11-03：实现 `8803f0f` 的 [CI 41557078464](https://github.com/MkaliezZ/hyper-workspace/actions/runs/41557078464) 三项全部成功，共 432 项：63 单元、3 下载器、8 解析、252 数据库、9 原生、74 UI、16 真实来源和 7 容器。新增用例实际验证来源/产品双向隔离、重复初始化及拒绝改密；使用合成账号和协议模型。冻结包保持原样。

独立闲置 Linux 试用机已部署并启动真实 CPU 向量容器，回读 512 维、归一化、中文相关资料排序、鉴权和 401 字符拒绝通过；8 条各 400 字符的批处理通过。内核记录该次容器内存峰值 397,680,640 字节（约 379 MiB），未 OOM、未重启；因此小内存配置将向量服务上限从 384 调至 512 MiB 留出余量。该结论是独立服务技术检查，不替代产品 pgvector 检索质量或整机容量验收。数据库和向量服务均未发布公网端口。

阿里杭州的完整镜像已构建，API、Worker、来源、产品库和向量服务均健康启动。首轮授权冷加载因原 3 个 Apache 处理槽被慢速资源下载占满而失败，设备授权查询超时；未进入凭据填写，未产生来源业务写入或模型调用。小内存配置将处理槽上限调至 8，保留 640 MiB 内存限制，为浏览器六条资源连接、查询及健康检查留出并发槽；CI 真实来源套件也使用该配置并新增限速冷登录回归，修正仍待复验。真实来源员工授权、双执行器与真实来源/模型联合验收、整机资源峰值、HTTPS 和公司试用签收分别记录；不以基础镜像拉取或容器健康替代应用交付。

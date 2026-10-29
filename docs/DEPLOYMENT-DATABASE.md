# 部署数据库运行账号

映射 P04/P07、C05/C07、A01/A08/A10、E09/E10 的部署与权限子集。三层定义、执行器、数据所有权和技术栈不变。员工、项目与来源权限仍由同一业务服务校验。

| 账号/服务 | 权限 | 凭据 |
| --- | --- | --- |
| `hyper` / PostgreSQL 与一次性 `initialize` | 专用产品库管理员；建扩展、业务迁移、设置运行角色与授权 | 原有 `DB_PASSWORD` |
| `hyper_runtime` / API、Worker | 产品 `public.cw_*` 表的 SELECT/INSERT/UPDATE/DELETE；业务序列 USAGE；迁移记录仅 SELECT；拥有独立 `hyper_jobs` schema 内队列对象 | 独立 `DB_RUNTIME_PASSWORD`，仅以 DATABASE_URL 传入 |
| 原生 DSH/Hermes 子进程 | 本次模型连接和任务输入；不继承上述数据库连接或管理员凭据 | 沿用逐 Run 环境白名单 |

运行角色没有 superuser、CREATEDB、CREATEROLE、REPLICATION、BYPASSRLS 或角色成员关系，不拥有数据库或业务表；不能 CREATE/ALTER/DROP 业务结构、TRUNCATE 表、篡改迁移记录、创建临时表、读取服务器文件或提升角色权限。业务 DML 的工作区/员工范围由产品后端约束；本轮没有新增数据库 RLS，也不把共享运行角色称为逐员工 SQL 隔离。

pg-boss 需要在 `hyper_jobs` 内建表、分区、函数和维护队列，运行角色保留这部分结构权限。初始化预建 schema，Compose 设置 `QUEUE_SCHEMA_PRECREATED=true`，运行进程不申请数据库 CREATE 权限。开发模式默认自行创建队列 schema；既有本地 `.env` 无需替换。

API/Worker 的环境没有 `DB_PASSWORD` 或独立 `DB_RUNTIME_PASSWORD` 变量；其 `DATABASE_URL` 含运行密码，仍须按秘密保护。凭据加密主密钥供产品受控解密，不传入原生引擎。不要输出完整 Compose 配置、容器环境或连接 URL。

## 初始化与旧卷

`deploy-bootstrap.mjs` 先以管理员连接检查专用产品库和现有角色，再运行产品迁移、重新授权，最后使用受限连接初始化工作区或显式演示资料。仅密码设置语句临时关闭本连接的 statement/error 参数日志，随后恢复原日志设置，程序错误不回显 SQL、连接 URL、密码或原驱动错误；外部审计扩展与主机日志策略仍需另行验收。

只对专用 Hyper Workspace 数据库使用此配置。发现 `public` 中非 `cw_*` 且不属于扩展的表/视图时，在迁移前拒绝；不要连接公司其他应用的数据库。

既有角色若有更高权限、额外成员关系、其他数据库依赖、业务对象或其他系统对象所有权，则拒绝初始化并保留原状态。正常重复初始化允许该角色自己的默认授权记录，以及确实隶属队列表的 TOAST 对象；不会放行业务表所有权。

首次升级旧卷时，仅将管理员拥有的 `hyper_jobs` 表、分区、序列、枚举及函数所有权交给运行角色，保留队列数据和 ID；产品表、成果、会话、加密凭据的所有权和内容不重建。未知队列对象所有者会停止初始化，不做全库 `REASSIGN OWNED`。

业务表权限按当前 `cw_*` 表重算，`cw_migrations` 保持只读；新迁移后须经过同一初始化。业务序列只授予 USAGE。队列函数的 PUBLIC 调用权被撤回，运行角色将来新建函数的默认 PUBLIC 执行权也被撤回。

新部署照常运行 `node scripts/deploy-init.mjs`，生成三个独立 64-hex 秘密，文件 0600、拒绝覆盖。旧 `.env.compose` 若缺少运行密码，保留管理员密码、加密主密钥和工作区 ID，先生成另一个受限文件：

```bash
node scripts/deploy-init.mjs --add-runtime-key .env.compose .env.compose.next
# 使用完整的新配置解析服务；停止接收新任务并核对正在执行的 Run。
docker compose --env-file .env.compose.next stop api worker
# 备份到工作区之外的受控目录。
docker compose --env-file .env.compose.next exec -T db pg_dump -U hyper -Fc hyper > /path/to/private-backup/hyper-before-role-split.dump
# 保留旧配置；两个文件的原权限都是 0600。
mv .env.compose .env.compose.previous
mv .env.compose.next .env.compose
HYPER_REVISION=$(git rev-parse HEAD) docker compose --env-file .env.compose up -d --build
```

升级工具逐字保留原配置，不输出秘密；目标已存在、原配置关键项重复/无效、或已配置运行密码时拒绝重写。原文件不自动替换。缺少运行密码时 Compose 明确失败，不使用管理员账号启动 API/Worker。对已有卷修改 `POSTGRES_PASSWORD` 环境不能代替数据库实际改密；本工具不会轮换既有密码或主密钥。

## 失败、回退与证据

停止服务继续保留原数据卷。初始化使用事务和锁；角色/所有权检查失败时回滚本次授权事务，业务迁移失败时停止启动。已经成功执行的前置角色准备和业务迁移分别保留，修复后重新初始化，不假装跨进程全量回滚。

不要通过恢复旧 Compose 的管理员运行连接或扩大 GRANT 绕过失败。保留当前角色与凭据配置，优先向前修复。备份恢复到新实例仍需重建角色、核对所有权/密钥/迁移；本轮未完成完整备份恢复演练或自动密钥轮换。

本地受限业务/向量/队列、旧队列接管与重复初始化、拒绝额外权限/成员关系等 3 项数据库用例通过。首轮为 1 通过/2 失败，定位到默认授权记录与队列表 TOAST 所有权被误判；只对这两类合法依赖增加限定检查后通过。新配置生成/升级等 4 项部署配置保护测试通过。容器内凭据/权限、双执行器修订和中断恢复等待本轮 CI；没有公司数据或真实供应商模型。

依据：[PostgreSQL 17 GRANT](https://www.postgresql.org/docs/17/sql-grant.html)、[默认权限作用域](https://www.postgresql.org/docs/17/sql-alterdefaultprivileges.html)。行为以固定 PostgreSQL/pg-boss 组合的实际测试为准。

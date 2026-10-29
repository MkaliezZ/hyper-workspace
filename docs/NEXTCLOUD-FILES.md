# Files / WebDAV 与个人知识副本

对应 P02/P04/P07/P08、C02/C07、A01/A04/A06/A10，E02/E04/E07/E09/E10 的子集。保持既定三层和技术路线：来源文件是权威内容，产品拥有选择范围、个人副本、版本关系与可重建索引。执行器记忆不是文件目录或权限来源。

## 使用与当前范围

先完成 [企业身份配置](NEXTCLOUD-IDENTITY.md)，设置 `NEXTCLOUD_FILES_ENABLED=true`，运行迁移并重新启动 API/Worker/Web。默认关闭，不会自动遍历或导入企业目录。

“知识库 → 企业文件”提供来源文件夹浏览、路径定位、显式选择导入、个人文本预览、刷新来源及建立语义索引。首批支持 `.txt/.md/.markdown`、对应文本 MIME、有效 UTF-8、最多 64 KiB 且 18000 字符的短文本；二进制控制内容、无效编码、超限和不支持的类型明确拒绝，不生成伪解析结果。目录每次只读取一层，最多 500 个子项、512 KiB XML；大目录可输入已知子文件夹路径。每个员工最多保留 50 个导入记录。

副本仅本人可见，即使源文件也分享给同事，也不会自动生成产品共享资料。不会自动把个人文件放入项目 AI 上下文、成果或待办。当前 AI 入口是通过所选 embedding 连接建立索引与语义检索；文件到聊天/成果的获准工具、派生成果权限传播仍待后续实现。该阶段不代表全部文件操作已经可由 DSH/Hermes 驱动。

PDF/Office 受控解析、长文分块、OCR、多媒体、附件、文件上传/编辑/删除、全局爬取和 Calendar 仍未完成。这个 Provider 当前只读来源；测试上传和分享仅用于隔离的合成 CI 来源，不是产品写入接口。

## 来源绑定与生命周期

| 字段              | 实现                                                                                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| connector         | 固定配置的 Nextcloud 33.0.10，通过独立 StorageProvider/WebDAV 接口访问                                                                                           |
| object_selector   | 当前设备对应员工的 `/remote.php/dav/files/<canonical UID>/`；用户选择路径、fileid 与 ETag，不接受外部 URL 或公开分享令牌                                         |
| field_allowlist   | 路径、源 fileid、ETag、大小、MIME、文件/目录类型；只对所选支持文件读取正文；授权探测只请求一个字节                                                               |
| time_scope        | 导入为该次精确源版本的副本；刷新是显式操作，列表/检索不自动下载新全文                                                                                            |
| credential_ref    | 当前会话的服务端设备凭据；源 UID 来自已验证身份，密码不进入文件、资产、向量、日志或前端                                                                          |
| access_policy_ref | 产品成员/来源群组准入 ∩ 当前来源实例与设备 ∩ 本人产品副本 ∩ 当前文件实际读取权限                                                                                 |
| sync_policy       | 元数据和实际下载权限重新核验；当前源 ETag、fileid、大小、MIME必须匹配副本，导入读取前后再次核对                                                                  |
| provenance        | asset_id 稳定；cw_source_files 记录 Provider、fileid、路径、ETag、文本摘要、解析版本与时间；cw_assets.source_version 结合 ETag、文件名、规范化文本摘要与解析版本 |
| revocation_policy | 每次文本读取、关键词、索引发送前/写回前、语义召回均核验来源；源端确定拒绝后清空正文和向量，不能由旧缓存授权                                                      |
| deletion_policy   | 删除/撤权/路径被新对象替换时停用副本并清空正文/索引，保留个人来源记录；正式保留期限、清理界面和全部依赖删除传播尚待实现                                          |

元数据可见不等于可下载：核验还会使用带 `If-Match` 的内容读取探测，覆盖“只保留元数据权限但禁止下载”。源读取失败时不将敏感文件名/正文当作仍可用资料返回。网络/5xx/限流只阻止本次读取，不将暂时故障当作永久删除；恢复后仍须重新证明权限与版本。

源版本变化后，旧正文和向量立即失效，需要用户刷新；同一 fileid 刷新保留 asset_id，重复导入相同版本不废弃已有索引。文件名也参与副本版本，改名期间仍在返回的旧向量不能覆盖新资料。路径被不同 fileid 占用时拒绝把新文件套到旧资产，需重新选择；改名/移动暂无自动按 ID 寻址。撤权后再恢复源分享也不会自动下载正文，需重新刷新。

文件副本的所有权和来源约束叠加于资产原有权限，即使误把其 visibility 改为 workspace，也不能向其他员工返回或索引。索引在发给模型前检查当前来源；embedding 调用中撤权会跳过写回并清除失效副本。已经发出的模型输入不能撤回，来源与 PostgreSQL 之间也没有跨系统原子性；此实现不声称消除所有在途窗口。

页面可见时每 8 秒只读核验已导入记录，不反复调用向量模型；失权/版本变化后清理文本预览与知识检索片段。旧的文件夹/预览异步响应不能覆盖新的范围或恢复已失效文本。原文件、模型提供方保留及组织级 DLP 等策略仍需公司环境验证。

## 传输与格式边界

固定 `fast-xml-parser 5.11.2`（MIT，包锁保存完整性），仅在 API 中使用。按命名空间解析 DAV 与 ownCloud 属性；拒绝 DTD/实体声明、超深 XML、重复路径、跨目录、其他账号/域名的 href、路径穿越及重定向。URL 只由受信配置、已验证 UID 和逐段编码路径构造，不使用来源返回的链接发请求。

GET 要求当前 ETag、完整字节数及 UTF-8 校验。来源错误正文不返回产品日志/错误，也不跟随重定向发送凭据。已知来源元数据和当前短文本限制不等于生产容器、文件病毒扫描、规模压测或全部 WebDAV 实现兼容性已验收。

依据：[Nextcloud 33 WebDAV 文档](https://github.com/nextcloud/documentation/blob/stable33/developer_manual/client_apis/WebDAV/basic.rst)、[33.0.10 FilesPlugin 属性定义](https://github.com/nextcloud/server/blob/v33.0.10/apps/dav/lib/Connector/Sabre/FilesPlugin.php)、[XML Parser 5.11.2](https://www.npmjs.com/package/fast-xml-parser/v/5.11.2)、[上游实体展开修复记录](https://github.com/NaturalIntelligence/fast-xml-parser/security/advisories/GHSA-8r6m-32jq-jx6q)。文档分支只用于说明，实际兼容性以锁定服务器与 CI 为准；额外禁止 DTD 不替代版本修复。

同轮依赖检查修复了已有依赖的已知问题：API/contracts 同步固定 Zod 4.6.7，根 overrides 固定 Multer 2.5.0、esbuild 0.28.1，开发脚本固定 concurrently 9.2.5（shell-quote 1.12.0）。保留 Nest 11 主版本；只更新这些目标及其必要锁定条目。npm 11.11.0 对仅经 workspace 引用的 Nest 依赖未稳定应用 override，根 devDependencies 同时固定同一 `@nestjs/platform-express 11.2.8` 作为安装锚点；升级 Nest 时须同步 API 与根版本，不能只手改锁文件。已核对安装树实际使用 Multer 2.5.0 并显示 overridden。

全新 `npm ci` 已验证，2026-10-29 使用 `npm audit --registry=https://registry.npmjs.org` 对本仓库根 npm 锁文件全量审计，结果为 0 项已知漏洞。这是当时公告库的查询结果，不包含独立 DSH/Hermes 环境和 Nextcloud 镜像，也不代表完整安全验收。默认镜像 registry 的审计曾返回不支持，未计为通过。

对应公告：[Zod](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)、[Multer](https://github.com/advisories/GHSA-q7qp-rjg7-q26m)、[shell-quote 命令转义](https://github.com/advisories/GHSA-w7jw-789q-3m8p)、[shell-quote 解析](https://github.com/advisories/GHSA-395f-4hp3-45gv)、[esbuild 开发服务器](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr)。

## API、迁移与回退

- POST `/api/files/list`：`{path: string[]}`，仅一层元数据。
- POST `/api/files/import`：`{path, expectedId, expectedEtag}`，原对象或版本变化返回冲突。
- GET `/api/files/imports`：本人记录与实时状态，不直接返回正文；不可验证时使用通用文件名。
- GET `/api/files/imports/:id`：重新核验后返回本人该版本文本。
- POST `/api/files/imports/:id/refresh`：空对象输入，保持原源身份，读取当前获准版本。
- 原关键词/向量 API 增加文件来源门禁，不扩大工作区或项目权限；没有任何匿名文件或个人 Key 入模旁路。

迁移 `009_source_files.sql` 新增来源关系表和约束，原 cw_assets 记录私有文本，数据不写 Nextcloud 表。先迁移再共同升级 API/Web/Worker。

**存在文件副本后不能回退到忽略来源门禁的旧版检索/索引代码。** 仅关闭 Files 开关不能保护不认识绑定表的旧代码。优先兼容前向修复；必须回退时先停止 API/Worker/登录，隔离这些资产及索引、失效会话，核验旧读取/索引路径都不可返回后再开放。不要删除来源关系把资产降成普通资料，保留与回退尚未生产演练。

## 验证记录

新增 3 项 Provider 测试覆盖命名空间、编码路径、精确版本、DTD/href/路径攻击、实际读取权限和文本限制；新增 5 项 PostgreSQL/HTTP 集成用例覆盖私有范围、稳定 ID、索引保留、改名期间的在途向量、源更新/替换、下载权限撤回、故障时不授予缓存访问、embedding 期间撤权和中途文件变化。新增 2 项 UI 协议测试覆盖显式选择、单独建索引、移动端、预览与检索片段失效。

真实来源 job 新增 Files 分享用例：固定 Nextcloud，合成员工创建只读分享，浏览器显式导入、真实 WebDAV 读取、pgvector 检索、来源更新后旧内容/向量失效、刷新保留 ID、撤销分享后拒绝 API 并清理页面。模型仍是本地 embedding 协议服务。实现提交 `10742f3c2e1b4ef9dc6b7419f85d76bf96edebd5` 的 [run 40863698233](https://github.com/MkaliezZ/hyper-workspace/actions/runs/40863698233) 两个 job 全通过：74 项主测试、8 项真实来源测试。本机没有 Docker/PHP，真实服务证据来自该 CI；HTTP/UI fixture 单独记录。

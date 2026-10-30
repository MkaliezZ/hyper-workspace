# 模型连接与企业知识索引

对应 P02/P04/P05/P07，C02/C04/C07，A04/A08/A10，E04/E05/E07/E09。实现状态以 IMPLEMENTATION.md 和当前提交的测试为准。

## 模型连接

设置页面支持个人/工作区连接、endpoint、模型名、API Key 与 chat/embedding 用途。工作区连接由数据库中当前管理员配置；客户端传入 admin 不产生权限。模型配置为追加创建，现有配置不会被一次失败验证覆盖。

服务端使用 AES-256-GCM 加密 Key。ModelService 解析连接时重新检查成员关系、工作区、个人可见范围和用途。未指定连接时，先用该员工最新的个人配置，再用工作区最新配置；不会使用其他员工的 Key。

“验证连接”调用一次实际 endpoint。对话请求上限 64 个输出 token，向量请求使用短测试文本。成功只证明该次 HTTP 协议响应可用，不代表执行器工具能力、质量、费用或业务验收通过。服务端拒绝重定向，并隐藏上游错误正文，避免正文回显 Key。自部署者只应配置获准的模型服务地址。

当前 HTTP 客户端支持 OpenAI 兼容 Chat Completions/embeddings、DeepSeek Chat 和 Anthropic Messages。Anthropic 不提供本实现要求的 embeddings 接口。两个执行器均使用本次 Run 固定的模型配置；共同验证覆盖 Chat Completions 兼容协议。Hermes 的 Anthropic extra 尚未接入，界面禁用不兼容连接，服务端在创建 Run 前拒绝，不静默切换 Key。首次安装和真实供应商能力仍需分别验证。

## 知识索引

- 文字匹配无需模型，直接查询当前可访问资料。
- 按含义查找需要配置 embedding 连接并显式建立索引。
- text-v1 每个短资产一个向量，上限两万字符；超长资料明确拒绝，后续需分块接入。
- PostgreSQL 保存来源内容和版本，pgvector 保存派生向量。索引记录模型配置 ID、模型名、维度、源版本、索引版本与建立时间。
- 检索只比较同一模型配置/维度/索引版本，且索引源版本必须等于当前源版本。不同向量空间不会混排。
- 私有、撤权、删除或失效资料不返回。索引期间内容更新时跳过旧快照；成员撤权后不得提交新索引。
- 产品成果修订与资料副本更新在同一事务中完成，同时清除旧向量。人工修改与 AI 修改均执行此失效规则。

当前仅索引产品数据库已有的授权文本资产；关联 Talk 来源的项目还叠加实时来源读取权限，在 embedding 发送前及写回/召回时检查。原聊天不自动索引，派生成果随项目权限限制。[来源范围和失效限制](PROJECT-SOURCE-SCOPE.md)。该项目来源模块不自动导入原聊天；文件增量及其验证范围见下文。不能据此声称所有企业数据已导入或完整源删除传播已实现。

Files 增量已增加用户显式选择的个人短文本副本，在关键词/向量读取与索引发送/写回前核验源 fileid、ETag 和实际下载权限。私有范围不能因 workspace 标记而扩大，旧正文/向量随源变更或确定拒绝失效；临时来源故障不使用缓存授权。[文件契约与当前验证状态](NEXTCLOUD-FILES.md)。PDF/Office 已有受控解析（见文档接入契约）；长文分块、完整跨来源依赖与项目成果的权限传播仍待补齐；不会自动把文件送入 DSH/Hermes 项目上下文。

## API

所有路由使用已认证主体，不接受请求声明员工身份。

| 路由                         | 请求                          | 结果                                  |
| ---------------------------- | ----------------------------- | ------------------------------------- |
| POST /api/models/:id/verify  | 空对象                        | 验证时间和 provider-response 证据标记 |
| POST /api/knowledge/index    | assetIds，modelProfileId 可选 | 已索引/因变化跳过的 ID                |
| POST /api/knowledge/semantic | query，modelProfileId 可选    | 有权限的源对象和当前版本              |
| GET /api/knowledge?q=…       | 关键词                        | 有权限的文字命中                      |

## 迁移与回退

003_asset_index.sql 增加可空索引元数据，并使产品成果副本与当前版本一致；不删除原始成果历史。升级前按实际部署流程备份数据库。应用可先回退到上一提交，新增列保留；不要为回退页面而删除业务数据。确需撤销该迁移时，先关闭索引功能，再移除这次新增的索引元数据列与 cw_assets_source 索引；源内容和成果版本应保留。

## 核验边界

真实 PostgreSQL/pgvector + 本地确定性 HTTP 服务验证了隔离、向量读写、版本失效和删除过滤。该 HTTP 服务是协议测试用例，不是真实 embedding 模型；真实供应商质量、召回率、中文分块和并发容量均未验收。

协议参考：[DeepSeek Chat](https://api-docs.deepseek.com/api/create-chat-completion/)、[Anthropic Messages](https://docs.anthropic.com/en/api/messages)。API 类型和具体模型能力仍须用实际服务验证。

个人文件的 `read_file` 使用固定的 chat 连接与所选单文件原文，经 DSH/Hermes 生成本人可修订解读；它无需 embedding，也不执行跨文件 RAG。输出暂不加入通用索引，源版本/权限失效会清理其全部版本。见 [FILE-AI-READING.md](FILE-AI-READING.md)。

## 实际请求用量

两原生执行器现经每 Run 独立的产品网关调用供应商，真实 Key 留在后端；验证连接和 embedding 也记录实际 HTTP 用量。私人页面与 AI 回读使用同一主体范围，缺失统计不补零；人工价格版本、按连接金额预留和员工金额声明已通过同一服务接入；组织/项目跨连接总预算和自动账单对账仍缺，见 [价格与预算](MODEL-SPENDING.md)。见 [模型用量](MODEL-USAGE.md)。

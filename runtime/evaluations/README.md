# 可选的中文语义检索验收工具

映射 P02/P04/P07、C02/C07、A04/A06/A10、E02/E04/E07/E09 子集。用于复查本机真实 embedding + 产品 pgvector；独立于首版核心依赖与生产 Compose。默认验收模式不更改员工配置；用户授权后的独立常驻模式见 [本机服务部署](../../docs/LOCAL-EMBEDDING.md)。

模型为 [BAAI/bge-small-zh-v1.5](https://huggingface.co/BAAI/bge-small-zh-v1.5) 的 [Xenova ONNX 转换](https://huggingface.co/Xenova/bge-small-zh-v1.5)，512 维、q8、CLS pooling 和归一化；原模型卡标记 MIT。权重不提交仓库；本目录锁定转换提交 `75c43b069aac4d136ba6bc1122f995fedcfd2781`、六份文件的精确大小与 SHA-256，总计 24,560,715 字节。首次下载与每次启动都校验，运行时关闭远程模型回退。

## 准备和执行

独立 Linux 容器服务通过 `Dockerfile`、`container-service.mjs --serve` 与公开权重白名单上下文构建，使用独立私有配置和内部网络监听，详见[私有试用部署](../../docs/DEPLOYMENT-PRIVATE-TRIAL.md)。本机常驻验证与 Linux 容器验证分开记录。

从仓库根目录运行，需要 Node 24，已验证平台是本机 macOS Intel；Linux/其他平台的真实推理质量不从依赖支持列表推导为已验收。

```bash
npm ci --prefix runtime/evaluations --ignore-scripts --registry=https://registry.npmjs.org
npm audit --prefix runtime/evaluations --audit-level=high --registry=https://registry.npmjs.org
node runtime/evaluations/download-embedding.mjs
node runtime/evaluations/download-embedding.mjs --execute
node runtime/evaluations/embedding-server.mjs --execute
```

下载器和服务不带参数均仅预检，不联网或启动模型；明确 `--execute` 才下载或启动。服务只监听 loopback 的动态端口，地址/模型名保存在受限 `.runtime/embedding-eval/server.json`。请求使用固定的合成验收凭据，不连接供应商、个人 Key 或企业原件。

准备单独的空测试数据库，在受限本地配置中设置下列值，再运行产品侧验收：

```bash
# 下列均为占位值；不要把生产数据库填入。
export TEST_DATABASE_URL='postgres://LOCAL_USER:LOCAL_TEST_PASSWORD@127.0.0.1:5432/hyper_semantic_quality_test'
export EMBEDDING_EVAL_ENDPOINT='http://127.0.0.1:SERVER_PORT/v1'
export EMBEDDING_EVAL_MODEL='local-bge-small-zh-v1.5-q8'
node --import tsx scripts/semantic-quality-check.ts
node --import tsx scripts/semantic-quality-check.ts --execute
```

产品检查脚本只接受 loopback、`_test` 数据库及明确的本地模型地址；不清库，只建立新的合成工作区、两种身份/项目、模型连接与资料。结束后关闭合成来源并禁用、清空临时凭据；真实业务数据库和员工设置不参与。报告留在 0700/0600 的忽略目录中。

## 边界和结果

语料在 `tests/fixtures/semantic-quality-corpus.json` 中预先固定：8 个办公主题及同义问法，门槛为 Top1 至少 75%、Recall@3 为 100%。还检查私人/失权资料、旧向量、新版本重建和删除过滤。使用产品的 ModelProvider、KnowledgeService 与 PostgreSQL 查询，不以直接算向量分数替代产品链路。

本地服务显式拒绝超过 400 字符或 512 tokens 的输入，不静默截断；文档与查询均不加 BGE 查询指令前缀，按产品当前通用 embedding 接口验收。检查脚本给连接配置 400 字符容量；八道固定短题评分后，单独检查一份 2574 字符长文的完整分块与末尾引用，不改变原题库分母。不能据此声称任意长文/企业问题、RAG 回答、生产吞吐或完整 C02 已验收。[逐项分数、失权和限制](../../docs/SEMANTIC-QUALITY.md)。

`@huggingface/transformers` 固定 3.8.1；独立依赖固定 `onnxruntime-node` 1.23.2、`sharp` 0.35.5、`adm-zip` 0.6.1，兼顾本机 Intel 绑定和已发现依赖公告。关闭时等待队列/模型释放并自然结束 Node，实测退出为 0。官方 registry 审计通过，根应用 lockfile/依赖不变。CI 对此可选 lockfile 单独审计；模型推理实测来自本机，CI 默认不下载权重。

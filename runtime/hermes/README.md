# Hyper Workspace Hermes runtime

需要 Python **3.14.6**。从仓库根运行：

```bash
python3 runtime/hermes/install.py
```

安装器按 [lock.json](lock.json) 下载不可变提交，校验源码压缩包 SHA-256，通过上游官方 `pm.build_environment` 按 `uv.lock` 创建独立环境。下载、源码、PM 工具和 Python 环境均位于 Git 忽略的 `.runtime`；不安装上游的 `all` extra，也不改写上游内核。

源码归档使用 `.runtime/hermes-source.tar.gz` 缓存；每次使用仍验证固定摘要，摘要错误直接失败。网络 429/短暂故障最多尝试 6 次，遵守不超过 60 秒的数字 `Retry-After`；更长冷却期直接停止，等待后续重试，不替换提交或校验值。CI 仅缓存这份公开源码，Docker 构建经只读独立构建上下文复用；不缓存运行目录、凭据或模型输入。下载器回归：`python3 -m unittest discover -s runtime/hermes -p test_download.py`。

安装后重启 API/Worker，产品会自动发现安装回执。每个 Run 独立生成 HERMES_HOME，使用本次模型连接的 endpoint、model 和凭据环境变量引用。配置文件不写 Key；企业资产和成果仍由产品数据库拥有。

本版本的共同模型协议为 **OpenAI Chat Completions 兼容 API**，包括按该协议配置的 DeepSeek 连接。Hermes 的 Anthropic extra 尚未接入；前后端会阻止不兼容的连接进入执行队列，不会自动改用其他人的 Key。

原生 shell、文件、目录等工具关闭；模型输出业务提案，由产品校验、执行并产生回执。原生长期记忆、规则目录读取、入门流程、模型标题生成和懒安装关闭。单次输出上限 4096 token，原生执行预算 120 秒；这不等于已实现总费用配额或生产容器沙箱。

## 核验

```bash
# 同时安装 DSH，再执行两个引擎和往返切换检查
npm ci --prefix runtime/dsh
TEST_DATABASE_URL=postgres://用户:密码@127.0.0.1:5432/hyper_test npm run test:runtime
```

测试运行两个真正的引擎和 PostgreSQL，但模型端是本地确定性协议服务。覆盖同一工作区两名员工并发（包含普通成员）、每次执行的模型/Key/目录、原生工具关闭、输出上限、实际成果回执，以及 DSH → Hermes → DSH 后成果 ID、源引用与版本连续。它不证明真实模型质量或原始 E01–E10 全部通过。

新 Run 从产品上下文启动；进行中的 Run 继续归原引擎，不迁移私有检查点。源代码和上游依赖锁应保持不变；升级须更新锁定清单并重新验证这组契约。

依赖保留各自许可。Hermes 源码采用 [MIT](THIRD_PARTY_HERMES_LICENSE.txt)。参考：[固定提交的程序接口说明](https://github.com/NousResearch/hermes-agent/blob/780d5a3313d7e1f64c0a0f3ec6b644d50f156e90/website/docs/developer-guide/programmatic-integration.md)。

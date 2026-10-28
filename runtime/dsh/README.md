# Hyper Workspace DSH runtime

单独安装运行时，避免把执行器的依赖装入 Web 构建。需要 Node 24。

```bash
npm ci --prefix runtime/dsh
```

产品后端发现该目录的已安装运行时后，自动启用 DSH。启动 API 与 Worker 前运行数据库迁移。每个 Run 固定模型配置 ID，由 Worker 在当前授权下读取该连接，并把本次凭据放入该进程的环境；不修改共享配置，也不把 Key 写入 profile、会话或产品事件。

launch.mjs 固定检查 DSH 0.2.1-rc.2，使用 sdk-minimal 和同版本 pi-ai 模型适配。OpenAI Chat 兼容路由已通过本地模型协议测试；Anthropic Messages 路由已配置映射，原生链路尚待验收。每次生成独立 profile，关闭原生 shell、文件和目录工具；实际业务动作由产品校验并保存回执。profile 中只保存 endpoint、模型名和凭据环境变量名称。

这是初期工具范围控制，不等于完整生产容器沙箱。容器隔离、预算、长上下文、交互确认和真实模型质量仍待完成。无 Key 的本地服务在此 DSH 路由中可能需要按照服务约定配置占位 Key；不要把连接验证成功直接视为执行器能力验收。

从仓库根运行真实运行时测试：

```bash
TEST_DATABASE_URL=postgres://用户:密码@127.0.0.1:5432/hyper_test npm run test:runtime:dsh
```

该测试运行真正的 DSH，并使用本地确定性模型协议服务；验证两个员工的模型连接、运行目录、成果回执和秘密未落盘。它不评价真实大模型质量，也不代替原始 E01–E10。

依赖分别保留自己的许可。配置组合参照 MIT 授权的 DeepSeek Harness sdk-minimal；附带其 [MIT 许可](THIRD_PARTY_DSH_LICENSE.txt)。官方项目：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。

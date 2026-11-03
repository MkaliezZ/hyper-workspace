# 公司内网 IP 部署

2026-11-03 用户明确：正式部署在公司内部，通过 IP 访问，不以购买域名或开放公网为前提。阿里杭州仅为临时技术验收环境，保持 SSH 隧道访问；本文件不表示已在公司局域网安装或签收。沿用现有架构、模型和权限边界。

用户已进一步选择公司局域网 Linux 服务器，目标机和固定内网 IP 目前“待准备”。软件包与安装教程先交付，实际安装在该机器就绪后执行；不自行改为云端正式运行。

## 地址与证书

由公司 IT 为服务器保留一个固定内网 IPv4（以下 `192.168.10.50` 仅为示例）。员工入口为 `https://192.168.10.50`，企业身份与原文件入口为 `https://192.168.10.50:8443`，不依赖外部 DNS。产品和来源的 HTTP 后端仍只绑定 loopback，数据库与向量端口仍只在容器网络内。

公司 CA 签发的服务器证书必须包含 `subjectAltName=IP:192.168.10.50`；员工设备由 IT 分发并信任 CA 根证书。只分发公开根证书，服务器私钥留在服务器，公司 CA 私钥由 IT 保管。若公司尚无 CA，可由 IT 建立内部 CA；不要求公开证书机构，也不以浏览器跳过警告或关闭 TLS 校验代替部署。

在公司目标机创建受限私钥和 CSR，交由 IT 签发。先将示例 IP 改为保留地址，检查目标目录没有已有密钥，避免覆盖：

```sh
sudo install -d -m 700 /etc/hyper-workspace/tls
sudo sh -c 'umask 077; test ! -e /etc/hyper-workspace/tls/server.key && test ! -e /etc/hyper-workspace/tls/server.csr && openssl req -new -newkey rsa:3072 -noenc -keyout /etc/hyper-workspace/tls/server.key -out /etc/hyper-workspace/tls/server.csr -subj "/CN=Hyper Workspace" -addext "subjectAltName=IP:192.168.10.50"'
```

IT 签发时须保留 IP SAN 和服务器用途，返回证书链到 `/etc/hyper-workspace/tls/server-chain.pem`；根证书独立保存为 `/etc/hyper-workspace/tls/company-root.pem`。私钥权限保持 `0600`，不提交 Git、不发到聊天或镜像。

## 配置与启动

先依照 [私有试用部署](DEPLOYMENT-PRIVATE-TRIAL.md) 准备固定版本镜像、独立凭据、工作区、来源库及员工；使用公司部署的全新私有配置，不复制公开示例密码。将以下非秘密配置写入该配置文件：

```dotenv
HYPER_LAN_IP=192.168.10.50
HYPER_HTTP_PORT=8180
APP_ORIGIN=https://192.168.10.50
HYPER_NEXTCLOUD_PORT=8090
NEXTCLOUD_URL=https://192.168.10.50:8443
NEXTCLOUD_INTERNAL_URL=http://nextcloud
DEMO_MODE=false
```

在原文件组合后再加 `-f deploy/compose.intranet.yaml`，先 `config --quiet`，再按原部署命令启动。`HYPER_LAN_IP` 必须是保留的地址，不是阿里杭州公网 IP。该叠加文件调整来源的信任域、规范主机及 HTTPS scheme；产品与来源的公开地址必须相互一致。容器内部仍走受限网络中的来源 HTTP，无须关闭证书校验或给容器挂载 CA 私钥。

[NGINX 模板](../deploy/nginx.intranet.conf.example) 安装于公司目标机的 Nginx `http` 上下文中；替换两处监听 IP 与证书位置，后端端口与配置保持一致。先检查已有站点和端口，保留原配置，再运行 `sudo nginx -t`；检查成功后 reload。模板仅监听指定的内网 IP，保留 Origin、事件流、原始响应和未知写入语义，不对写请求做上游重试。按公司网段开放 443/8443；没有开放阿里云公网入口的必要。

## 交付检查

1. 由员工设备在正常 TLS 校验下访问两个 HTTPS IP 地址，证书链、IP SAN 和有效期均通过；不使用 `curl -k`。
2. 可用 `curl --cacert /etc/hyper-workspace/tls/company-root.pem https://192.168.10.50/api/health` 和来源的 `:8443/status.php` 检查；来源必须返回已安装、非维护状态。
3. 实际完成企业 Login Flow、工作区身份回读和退出；检查会话为 HttpOnly / SameSite / Secure。
4. 冷登录、多员工权限、文档导入/读取/分享、双执行器、语义检索、事件流与取消/未知结果核对，均在同一入口复验。健康检查或 Nginx 语法通过不能替代这些业务证据。
5. 按 [备份恢复](BACKUP-RESTORE.md) 验证产品库，并按[来源配套备份与隔离恢复记录](SOURCE-BACKUP-RESTORE.md)核对来源库、完整文件卷和私有配置。公司业务资料不从云端合成验收数据推断。

公网 IP 改为公司 IP 会改变来源身份绑定。云端当前只装合成试用数据，公司首次安装可建立独立工作区；如需迁移已有正式数据，必须另行验证身份/来源绑定、备份和回退，不能只改 URL 后宣称原会话可无缝复用。公司 IP、CA 信任、网络及迁移证据仍需在实际公司环境核对。

配置依据：[NGINX HTTPS](https://nginx.org/en/docs/http/configuring_https_servers.html)、[代理与重试/缓冲](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)、[OpenSSL CSR 与扩展](https://docs.openssl.org/3.0/man1/openssl-req/)。本版本提供可检查的配置模板；公司环境的 TLS 与业务验证尚未执行。

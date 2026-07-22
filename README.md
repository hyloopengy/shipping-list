# 发货清单

导入聚水潭拣货单后，按批次录入大包号、款色尺码、数量和可选的长宽高重，并按本批次库存进行软提醒。

## 主要功能

- 上传 `.xlsx` 自动生成日期流水批次号
- 当前批次保留最近 3 条；输入批次号并点击“查询”可搜索最多 100 条历史批次
- 多关键词搜索款色尺码，例如 `001 xl`
- 一个大包可混装多个 SKU，同款大包可批量生成连续大包号
- 长、宽、高、重量允许留空；已保存记录显示“长/宽/高未填”和“体重未填”
- 超过本批次库存时提醒，但允许人工二次确认后强制保存
- 导出大包明细和 SKU 库存汇总
- Mac 与服务器统一使用 Docker + PostgreSQL；旧 SQLite 数据可迁移

## Mac 本地运行

启动 Docker Desktop 后双击 `start-mac.command`。首次运行自动建立本机 PostgreSQL 和随机密钥，浏览器访问：

```text
http://127.0.0.1:8080
```

容器会在后台持续运行，关闭启动终端不会停止服务。

## Docker + PostgreSQL 部署

服务器需要安装 Docker、Docker Compose 和 Git。

```bash
git clone <仓库地址> shipping-list
cd shipping-list
cp .env.example .env
```

在 `.env` 中设置随机数据库密码、Flask 密钥、服务器公网 IP/域名和允许访问的公网 IP/CIDR。

启动：

```bash
docker compose up -d --build
docker compose ps
```

架构：Caddy 对外开放 80/443；应用端口只绑定服务器回环地址；PostgreSQL 只在 Docker 内部网络通信。Caddy 为域名或支持的公网 IP 自动申请 HTTPS 证书，并只允许 `.env` 中配置的来源网段访问。

## 备份与更新

PostgreSQL 和上传文件分别保存在 Docker 命名卷中。手动备份：

```bash
./backup-postgres.sh
```

建议用系统定时任务每天执行，脚本默认保留 14 天。更新代码：

```bash
git pull --ff-only
docker compose up -d --build
```

停止服务但保留数据：

```bash
docker compose down
```

不要执行 `docker compose down -v`，它会删除 PostgreSQL 和上传文件数据卷。

## 安全设计

- 所有 SQL 用户输入均使用参数绑定，不拼接用户值
- PostgreSQL 不映射宿主机端口
- 公网入口启用 HTTPS、来源 IP 白名单、CSRF 校验和安全响应头
- `.env`、数据库、上传文件、备份和 Excel 文件均不进入 Git
- 公网服务器只开放 SSH、HTTP 和 HTTPS
- 当前不设登录账号；变更办公网络后需同步更新 `ALLOWED_CIDRS`

## 测试

```bash
.venv/bin/python -m unittest discover -s tests -v
docker compose config
```

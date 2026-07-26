# 发货清单

导入聚水潭拣货单后，按批次录入大包号、款色尺码、数量和可选的长宽高重，并按本批次库存进行软提醒。

完整架构、安全、数据、测试与上线流程见 [技术方案.md](./技术方案.md)。

## 主要功能

- 上传 `.xlsx` 自动生成日期流水批次号
- 当前批次保留最近 3 条；输入批次号并点击“查询”可搜索最多 100 条历史批次
- 多关键词搜索款色尺码，例如 `001 xl`
- 每个批次可建立多个“配比1、配比2……”；配比与普通款色尺码在同一个下拉框中选择，悬停可查看明细
- 一个大包可混装普通 SKU 和多个配比；配比数量按“中包数量”录入，库存自动展开到实际 SKU 件数
- 自动循环配比可把所选剩余库存均衡生成到连续的新大包，保存前先预览且保证数量守恒
- 款色尺码按款号、颜色、服装尺码和商品编码稳定排序，方便一线查找
- 一个大包可混装多个 SKU，同款大包可批量生成连续大包号
- 长、宽、高、重量允许留空；已保存记录显示“长/宽/高未填”和“体重未填”
- 超过本批次库存时提醒，但允许人工二次确认后强制保存
- Excel 每个大包只占一行，明细在单元格内分行；使用配比时自动增加中包字段
- 长宽高填写完整后自动计算体积，网页和 Excel 均显示体积
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

在 `.env` 中设置随机数据库密码、Flask 密钥、服务器公网 IP/域名、网页用户名和网页密码哈希。生成网页密码哈希：

```bash
docker run --rm caddy:2.10-alpine caddy hash-password --plaintext '你的网页密码'
```

将输出结果用单引号包住写入 `BASIC_AUTH_HASH`，服务器只保存哈希，不保存网页明文密码。用户名建议固定为 `shipping`，密码使用便于业务人员记忆但不属于常见口令的组合；浏览器选择“保存密码”后可长期记住。

启动：

```bash
docker compose up -d --build
docker compose ps
```

架构：Caddy 对外开放 80/443；应用端口只绑定服务器回环地址；PostgreSQL 只在 Docker 内部网络通信。Caddy 为域名或支持的公网 IP 自动申请 HTTPS 证书，并在所有页面、静态文件和 API 进入应用前统一验证网页用户名和密码。

## 备份与更新

PostgreSQL 和上传文件分别保存在 Docker 命名卷中。手动备份：

```bash
./backup-postgres.sh

备份默认保留7天。登录网页后可通过“数据备份”下载最近7份到本地。
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
- 公网入口启用 HTTPS、全站密码验证、CSRF 校验和安全响应头
- `.env`、数据库、上传文件、备份和 Excel 文件均不进入 Git
- 公网只开放 HTTP 80 和 HTTPS 443；PostgreSQL 5432、应用 8080 均不对公网开放
- SSH 22 仅允许管理员固定来源访问，不向全网开放
- 网页可从任意网络访问，但必须输入统一用户名和密码

## 测试

```bash
.venv/bin/python -m unittest discover -s tests -v
npm run test:frontend
docker compose config
```

# Skill Hub

企业内网 Skill 上传、导入、审核、发布与分享中心。第一版支持网页上传 zip、GitHub repo 导入、管理员审核发布、同步到企业 GitHub Skill 仓库，并可用 Docker Compose 部署。

GitHub 仓库：

```text
https://github.com/garytan023/skillhub
```

## 快速安装

推荐直接从 GitHub clone 后用 Docker Compose 启动：

```bash
git clone https://github.com/garytan023/skillhub.git
cd skillhub
cp .env.example .env
docker compose up --build
```

打开：

```text
http://127.0.0.1:4777
```

默认管理员账号：

```text
admin@example.com / admin123456
```

生产或团队内部使用前，请先修改 `.env`：

```env
SESSION_SECRET=replace-with-a-long-random-string
ADMIN_EMAIL=your-admin@example.com
ADMIN_PASSWORD=replace-with-a-strong-password
PUBLIC_BASE_URL=https://your-skillhub-domain.example.com
```

升级到最新版：

```bash
git pull
docker compose up --build -d
```

## 功能

- 内置账号登录：`admin` / `member` 两种角色。
- 团队上传：上传包含 `SKILL.md` 的 zip 包。
- GitHub 导入：通过 GitHub App 从私有或公开 repo 指定 path/ref 导入。
- 自动扫描：解析 `SKILL.md` frontmatter、可选 `skill.manifest.json`、文件清单、内容 hash、权限和风险等级。
- 审核发布：成员提交审核，管理员批准、驳回、发布、下架。
- GitHub 同步：发布时写入配置好的企业 Skill repo：`skills/{skill_slug}/`。
- 分享安装：详情页提供下载链接和安装命令：`skillhub install {slug}@{version}`。
- Docker 部署：`skillhub-app + postgres + volumes`。

## 本地开发运行

需要本地已有 PostgreSQL，并设置 `DATABASE_URL`：

```bash
cp .env.example .env
npm install
DATABASE_URL=postgres://skillhub:skillhub@127.0.0.1:5432/skillhub npm start
```

打开：

```text
http://127.0.0.1:4777
```

默认管理员来自环境变量：

- `ADMIN_EMAIL=admin@example.com`
- `ADMIN_PASSWORD=admin123456`

## Docker 部署说明

```bash
cp .env.example .env
docker compose up --build
```

服务地址：

```text
http://127.0.0.1:4777
```

Compose 会启动：

- `skillhub-app`
- `postgres`
- `skillhub_postgres_data`
- `skillhub_packages`

首次启动时 app 会自动建表并创建管理员账号。

## GitHub App 配置

GitHub 导入和发布同步使用 GitHub App，不使用个人 PAT。

`.env` 中配置：

```env
GITHUB_APP_ID=
GITHUB_INSTALLATION_ID=
GITHUB_APP_PRIVATE_KEY=
GITHUB_APP_PRIVATE_KEY_PATH=
PUBLISH_REPO=owner/enterprise-skills
PUBLISH_BRANCH=main
```

说明：

- `GITHUB_APP_PRIVATE_KEY` 支持把换行写成 `\n`。
- 也可以用 `GITHUB_APP_PRIVATE_KEY_PATH` 指向容器内私钥文件。
- `PUBLISH_REPO` 是唯一允许发布写入的企业 Skill 仓库。
- GitHub 未配置时，zip 上传和审核仍可用，GitHub 导入/发布同步会显示未配置。

GitHub App 需要的最小权限：

- Contents: Read，用于导入来源 repo。
- Contents: Read and write，用于发布到 `PUBLISH_REPO`。

## 使用流程

1. 管理员登录。
2. 在用户管理中创建团队成员。
3. 成员上传 zip 或从 GitHub repo 导入 Skill。
4. 系统生成草稿和扫描报告。
5. 成员提交审核。
6. 管理员批准或驳回。
7. 管理员发布，同步到 `PUBLISH_REPO/skills/{slug}/`。
8. 用户在 Skill 详情页下载 zip 或复制安装命令。

## API

- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/me`
- `GET /api/users`
- `POST /api/users`
- `POST /api/skills/uploads`
- `POST /api/skills/imports/github`
- `GET /api/skills`
- `GET /api/skills/:id`
- `GET /api/skills/:id/versions`
- `POST /api/skill-versions/:id/submit-review`
- `POST /api/skill-versions/:id/approve`
- `POST /api/skill-versions/:id/reject`
- `POST /api/skill-versions/:id/publish`
- `POST /api/skill-versions/:id/sync-github`
- `POST /api/skill-versions/:id/archive`
- `GET /api/skill-versions/:id/download`

## 架构说明

更多实现边界见 [docs/skillhub-architecture.md](docs/skillhub-architecture.md)。

## 安全边界

- 审核前只读取文件，不执行脚本。
- zip 上传拒绝路径穿越、软链接、超大文件和超多文件。
- 发布同步只写入 `PUBLISH_REPO`，不会写回任意来源 repo。
- 登录使用 httpOnly cookie，密码使用 PBKDF2 hash。
- SQL 全部使用参数化查询。

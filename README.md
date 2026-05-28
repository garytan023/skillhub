# WPPMEDIA MD SkillHub

企业内网 Skill 上传、导入、审核、发布与分享中心。第一版支持网页上传 zip、GitHub 链接导入、管理员审核发布、Agent 在线拉取安装、同步到企业 GitHub Skill 仓库，并可用 Docker Compose 部署。

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

## 直接贴入 Docker / Portainer

如果你是在 Portainer、1Panel、CasaOS、群晖 Container Manager 这类界面里直接粘贴 compose，不要使用 `npm ci`。请使用仓库里的独立 compose：

[docker-compose.standalone.yml](docker-compose.standalone.yml)

这个版本会在容器启动时自动从 GitHub 下载源码，并使用 `npm install --omit=dev` 安装依赖，所以不需要宿主机提前 clone 仓库。

直接粘贴版：

```yaml
services:
  skillhub-app:
    image: node:22-alpine
    working_dir: /app
    command:
      - sh
      - -c
      - |
        set -eu
        apk add --no-cache curl tar
        rm -rf /tmp/skillhub /tmp/skillhub.tar.gz
        mkdir -p /tmp/skillhub /app
        curl -fsSL -o /tmp/skillhub.tar.gz https://github.com/garytan023/skillhub/archive/refs/heads/main.tar.gz
        tar -xzf /tmp/skillhub.tar.gz --strip-components=1 -C /tmp/skillhub
        cp -a /tmp/skillhub/. /app/
        npm install --omit=dev
        node server.js
    ports:
      - "4777:4777"
    environment:
      HOST: 0.0.0.0
      PORT: 4777
      NODE_ENV: production
      DATA_DIR: /data
      PACKAGE_DIR: /data/packages
      DATABASE_URL: postgres://skillhub:skillhub@postgres:5432/skillhub
      PUBLIC_BASE_URL: http://127.0.0.1:4777
      SESSION_SECRET: change-me-long-random-string
      ADMIN_EMAIL: admin@example.com
      ADMIN_PASSWORD: admin123456
      MAX_UPLOAD_MB: 25
      PUBLISH_BRANCH: main
      GITHUB_APP_ID: ""
      GITHUB_INSTALLATION_ID: ""
      GITHUB_APP_PRIVATE_KEY: ""
      GITHUB_APP_PRIVATE_KEY_PATH: ""
      PUBLISH_REPO: ""
    volumes:
      - skillhub_app:/app
      - skillhub_packages:/data/packages
    depends_on:
      postgres:
        condition: service_healthy
    restart: unless-stopped

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: skillhub
      POSTGRES_USER: skillhub
      POSTGRES_PASSWORD: skillhub
    volumes:
      - skillhub_postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U skillhub -d skillhub"]
      interval: 5s
      timeout: 3s
      retries: 10
    restart: unless-stopped

volumes:
  skillhub_app:
  skillhub_postgres_data:
  skillhub_packages:
```

如果是服务器部署，把这三项改掉：

```yaml
PUBLIC_BASE_URL: http://你的服务器IP或域名:4777
SESSION_SECRET: 一串长随机字符串
ADMIN_PASSWORD: 强密码
```

## 功能

- 内置账号登录：`admin` / `member` 两种角色。
- 团队上传：上传包含 `SKILL.md` 的 zip 包。
- GitHub 导入：粘贴 GitHub repo、tree 文件夹或 blob/SKILL.md 链接即可导入。
- 平台标签：支持小红书、京东、抖音、ISV、Agent 基础提升等标签和 Team 归属展示。
- 自动扫描：解析 `SKILL.md` frontmatter、可选 `skill.manifest.json`、文件清单、内容 hash、权限和风险等级。
- 审核发布：成员提交审核，管理员批准、驳回、发布、下架。
- 在线拉取：发布上线后生成公开只读下载接口和 Agent 安装命令。
- GitHub 同步：配置 GitHub App 后，可写入企业 Skill repo：`skills/{skill_slug}/`。
- 分享安装：详情页提供下载链接和安装命令：`curl -fsSL .../install.sh | sh`。
- Docker 部署：`skillhub-app + postgres + volumes`。

## Agent 直接拉取安装

管理员批准并点击“发布上线”后，详情页会显示真实可用的安装命令：

```bash
curl -fsSL http://你的服务器IP或域名:4777/api/public/skills/find-skills/v0.1.0/install.sh | sh
```

默认安装到：

```text
~/.agents/skills/{skill_slug}
```

需要安装到其他 Agent Skill 目录时：

```bash
SKILL_DIR=/path/to/agent-skills curl -fsSL http://你的服务器IP或域名:4777/api/public/skills/find-skills/v0.1.0/install.sh | sh
```

如果你在 Docker 面板里把外部端口映射成了 `11212`，请把 `PUBLIC_BASE_URL` 改成真实访问地址，例如：

```yaml
PUBLIC_BASE_URL: http://s.ztso.xyz:11212
```

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
- GitHub 未配置时，zip 上传、审核、发布上线和 Agent 在线拉取仍可用；GitHub 导入/同步会显示未配置。

GitHub App 需要的最小权限：

- Contents: Read，用于导入来源 repo。
- Contents: Read and write，用于发布到 `PUBLISH_REPO`。

## 使用流程

1. 管理员登录。
2. 在用户管理中创建团队成员。
3. 成员上传 zip，或粘贴 GitHub 链接导入 Skill。
4. 系统生成草稿和扫描报告。
5. 成员提交审核。
6. 管理员批准或驳回。
7. 管理员发布上线，系统生成公开只读下载链接和 Agent 安装命令。
8. 如已配置 GitHub App，可同步到 `PUBLISH_REPO/skills/{slug}/`。
9. 用户在 Skill 详情页下载 zip 或复制安装命令。

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
- `GET /api/public/skill-versions/:id/download`
- `GET /api/public/skill-versions/:id/install.sh`
- `GET /api/public/skills/:slug/:version/download`
- `GET /api/public/skills/:slug/:version/install.sh`

## 架构说明

更多实现边界见 [docs/skillhub-architecture.md](docs/skillhub-architecture.md)。

## 安全边界

- 审核前只读取文件，不执行脚本。
- zip 上传拒绝路径穿越、软链接、超大文件和超多文件。
- 发布同步只写入 `PUBLISH_REPO`，不会写回任意来源 repo。
- 登录使用 httpOnly cookie，密码使用 PBKDF2 hash。
- SQL 全部使用参数化查询。

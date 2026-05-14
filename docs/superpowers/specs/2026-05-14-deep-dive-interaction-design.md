# Deep Dive 交互功能设计

**日期：** 2026-05-14  
**状态：** 已批准

## 背景

`news_digest.py` 每日通过 GitHub Actions 抓取 GitHub 项目、Changelog 和博客更新，用 Gemini 分析后推送到 Discord 频道。用户希望在收到日报后，能对感兴趣的项目或博客文章一键获取深度分析，结果以 Discord 私信形式发回。

## 目标

- 日报末尾附带下拉菜单，列出所有分析过的项目和博客
- 用户选择后，自动私信发送深度分析
- 无需常驻服务器，基于 Cloudflare Workers 实现

## 架构

```
GitHub Actions（每日两次）
  └─ news_digest.py
       ├─ 发日报 embeds 到 Discord 频道（Bot API）
       └─ 发 selector 消息（下拉菜单，列出所有项目）

用户在 Discord 选择项目
  └─ Discord POST → Cloudflare Worker
       ├─ 验证签名
       ├─ 立即返回 deferred ephemeral（"分析中..."）
       └─ waitUntil:
            ├─ 抓 GitHub API / 博客全文
            ├─ 调 Gemini 生成分析
            ├─ 创建 Discord DM 频道
            └─ 发私信 + 编辑 deferred 为 "已发送私信"
```

## 组件

### 1. Discord Bot Application

- 在 Discord Developer Portal 创建
- 用于替换当前 Incoming Webhook 发消息（Bot API 支持消息组件）
- 需要权限：`Send Messages`、`Read Message History`；Intent：`Direct Messages`
- Interaction Endpoint URL 指向 Cloudflare Worker

### 2. Cloudflare Worker（新建）

**文件结构：**
```
worker/
  src/index.js
  wrangler.toml
  package.json
```

**环境变量（Cloudflare 后台配置）：**

| 变量 | 说明 |
|------|------|
| `DISCORD_PUBLIC_KEY` | 签名验证，Discord 开发者后台获取 |
| `DISCORD_BOT_TOKEN` | 发私信 |
| `GEMINI_API_KEY` | AI 深度分析 |

**处理逻辑：**
1. 验证 Discord ed25519 签名，失败返回 401
2. PING（type=1）→ PONG
3. 组件交互（type=3）：
   - 立即返回 deferred ephemeral（type=5）
   - `ctx.waitUntil()` 异步处理：
     - 解析 `custom_id`（`github:owner/repo` 或 `blog:url`）
     - GitHub 项目：调 GitHub API 获取 repo info、README、issues、PRs、commits
     - 博客文章：fetch 全文内容
     - 调 Gemini 生成分析
     - 创建 DM 频道，发送私信
     - 编辑 deferred 消息为「✉️ 已发送私信」

### 3. `news_digest.py` 改动

**发消息方式：**
- 从 `DISCORD_WEBHOOK_URL` 改为 Bot API：`POST /channels/{channel_id}/messages`
- 新增环境变量：`DISCORD_BOT_TOKEN`、`DISCORD_CHANNEL_ID`

**新增 selector 消息：**
- 日报所有 embed 发完后，追加一条消息
- 包含 Discord Select Menu 组件
- 每个选项的 `value` 即 `custom_id`：
  - GitHub 项目：`github:owner/repo`
  - 博客文章：`blog:https://...`
- 选项标签格式：`[GitHub] owner/repo` 或 `[Blog] 文章标题（截断到45字）`

**GitHub Actions Secrets 新增：**

| Secret | 说明 |
|--------|------|
| `DISCORD_BOT_TOKEN` | Bot token |
| `DISCORD_CHANNEL_ID` | 目标频道 ID |

## Discord 消息结构

```
[embed] 📌 技术动态 2026-05-14 09:00
[embed] 📁 分组1 - 字段: 项目A, 项目B
[embed] 📰 博客更新 - 字段: 文章A, 文章B
[embed] 📋 Changelog
[message+component] 🔍 对哪个感兴趣？选择后将私信深度分析
                    [Select Menu ▼]
```

## 私信内容格式

**GitHub 项目：**
```
🔍 owner/repo 深度分析

📌 项目定位
[问题域、目标用户，2-3句]

🏗 核心架构
[技术方案和关键组件，3-5句]

📊 近期活跃度
⭐ Stars: xxx
🐛 Open Issues: xx
🔀 近期 PR: #xxx title · #xxx title
📝 近期 Commit: feat: ... · fix: ...

🔗 https://github.com/owner/repo
```

**博客文章：**
```
📰 文章标题 深度解读

🎯 核心观点
[主要论点，2-3句]

💡 关键技术点
• 要点一
• 要点二
• 要点三

🔑 值得关注的原因
[对 AI Agent/Harness 生态的意义，1-2句]

🔗 https://...
```

## 变更文件清单

| 文件 | 类型 | 说明 |
|------|------|------|
| `news_digest.py` | 修改 | 改用 Bot API，追加 selector 消息 |
| `worker/src/index.js` | 新建 | Cloudflare Worker 主逻辑 |
| `worker/wrangler.toml` | 新建 | Worker 配置 |
| `worker/package.json` | 新建 | 依赖（仅 `discord-interactions` 验签库）|
| `.github/workflows/digest.yml` | 修改 | 新增两个 Secret 引用 |

## 不在范围内

- 支持多用户同时触发（当前场景为个人使用）
- 历史深度分析记录存储
- 速率限制（Gemini / GitHub API）

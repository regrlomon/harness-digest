import os
import base64
import requests
import feedparser
from bs4 import BeautifulSoup
from datetime import datetime, timedelta, timezone
import google.generativeai as genai

# ── 配置区 ──────────────────────────────────────────────
SEARCH_KEYWORDS = ["harness", "agent workflow", "llm agent skill"]

TRACKED_REPOS = [
    "harness/harness",
    "harness/gitness",
    "harness/drone",
]

SCRAPE_BLOGS = [
    {"name": "Anthropic News",        "base": "https://www.anthropic.com", "pattern": "/news/"},
    {"name": "Anthropic Engineering",  "base": "https://www.anthropic.com", "pattern": "/engineering/"},
    {"name": "Claude Blog",            "base": "https://claude.com",        "pattern": "/blog/"},
]
# ────────────────────────────────────────────────────────


def scrape_blog(blog):
    list_url = blog["base"] + blog["pattern"].rstrip("/")
    resp = requests.get(list_url, timeout=15)
    if resp.status_code != 200:
        return []
    soup = BeautifulSoup(resp.text, "html.parser")
    posts = []
    seen = set()
    for a in soup.select(f"a[href*='{blog['pattern']}']"):
        title = a.get_text(strip=True)
        href = a.get("href", "")
        if not title or len(title) < 10:
            continue
        url = href if href.startswith("http") else f"{blog['base']}{href}"
        if url in seen or url == list_url:
            continue
        seen.add(url)
        posts.append({"source": blog["name"], "title": title, "url": url, "summary": ""})
    return posts[:5]


def fetch_blogs():
    posts = []
    for blog in SCRAPE_BLOGS:
        posts += scrape_blog(blog)
    return posts


def fetch_readme(repo_full_name):
    resp = requests.get(
        f"https://api.github.com/repos/{repo_full_name}/readme",
        headers={"Accept": "application/vnd.github.v3+json"},
    )
    if resp.status_code != 200:
        return ""
    content = base64.b64decode(resp.json().get("content", "")).decode("utf-8", errors="ignore")
    return content[:1500]


def search_new_repos():
    since = (datetime.now(timezone.utc) - timedelta(hours=13)).strftime("%Y-%m-%dT%H:%M:%SZ")
    headers = {"Accept": "application/vnd.github.v3+json"}
    results = []
    for kw in SEARCH_KEYWORDS:
        resp = requests.get(
            "https://api.github.com/search/repositories",
            headers=headers,
            params={"q": f"{kw} created:>{since}", "sort": "stars", "order": "desc", "per_page": 10},
        )
        if resp.status_code == 200:
            for item in resp.json().get("items", []):
                readme = fetch_readme(item["full_name"])
                results.append({
                    "name": item["full_name"],
                    "description": item.get("description") or "",
                    "stars": item["stargazers_count"],
                    "url": item["html_url"],
                    "readme": readme,
                })
    return results


def fetch_changelogs():
    since = datetime.now(timezone.utc) - timedelta(hours=13)
    releases = []
    for repo in TRACKED_REPOS:
        feed = feedparser.parse(f"https://github.com/{repo}/releases.atom")
        for entry in feed.entries[:5]:
            if not getattr(entry, "published_parsed", None):
                continue
            published = datetime(*entry.published_parsed[:6], tzinfo=timezone.utc)
            if published >= since:
                releases.append({
                    "repo": repo,
                    "title": entry.title,
                    "url": entry.link,
                    "body": entry.get("summary", "")[:1500],
                })
    return releases


def fetch_blogs():
    posts = []
    for blog in SCRAPE_BLOGS:
        posts += scrape_blog(blog)
    return posts


def ai_summarize(new_repos, releases, blog_posts):
    genai.configure(api_key=os.environ["GEMINI_API_KEY"])
    model = genai.GenerativeModel("gemini-2.5-flash")
    prompt = f"""你是一个关注 AI Agent、CI/CD 和 Harness 生态的技术信息筛选助手。

过去 12 小时动态如下，请按以下要求处理：

1. 过滤掉学习笔记、无 star、fork、个人练习等无价值内容
2. 将保留内容按技术方向分组（如：Harness 生态、Agent 工作流与 Skill 实践、AI 框架更新、行业博客解读等），组数不超过 5 个
3. 每个分组格式：

### 分组名称
> 这个分组的技术方向说明（1-2句）

- **项目/文章名**：解决什么问题，核心技术方案，值得关注的原因

4. Changelog 单独一组，注明 breaking change / 新功能 / 性能改进
5. 博客文章重点提炼核心观点和对实践的指导意义
6. 用中文输出

## GitHub 新项目（{len(new_repos)} 个）
{new_repos or '无'}

## Changelog（{len(releases)} 条）
{releases or '无'}

## 博客更新（{len(blog_posts)} 篇）
{blog_posts or '无'}

如无有价值内容，直接回复：本周期无重要动态。
"""
    return model.generate_content(prompt).text


def send_discord(content):
    for chunk in [content[i:i + 1900] for i in range(0, len(content), 1900)]:
        requests.post(os.environ["DISCORD_WEBHOOK_URL"], json={"content": chunk})


def main():
    new_repos = search_new_repos()
    releases = fetch_changelogs()
    blog_posts = fetch_blogs()

    summary = ai_summarize(new_repos, releases, blog_posts)
    now = datetime.now().strftime("%Y-%m-%d %H:%M")

    send_discord(f"**[技术动态] {now}**\n\n{summary}")
    print("Done.")


if __name__ == "__main__":
    main()

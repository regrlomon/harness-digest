import os
import base64
import requests
import feedparser
from datetime import datetime, timedelta, timezone
import google.generativeai as genai

# ── 配置区 ──────────────────────────────────────────────
SEARCH_KEYWORDS = ["harness"]

TRACKED_REPOS = [
    "harness/harness",
    "harness/gitness",
    "harness/drone",
    "harness/ff-golang-server-sdk",
]
# ────────────────────────────────────────────────────────


def fetch_readme(repo_full_name):
    """抓取仓库 README 前 1500 字符"""
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


def ai_summarize(new_repos, releases):
    genai.configure(api_key=os.environ["GEMINI_API_KEY"])
    model = genai.GenerativeModel("gemini-2.5-flash")
    prompt = f"""你是 Harness 生态的技术信息筛选助手。

过去 12 小时 GitHub 动态如下，请按以下要求处理：

1. 过滤掉学习笔记、无 star、fork、个人练习等无价值仓库
2. 将保留的项目按技术方向分组（如：CI/CD工具、AI代理框架、测试工具、基础设施等），组数不超过5个
3. 每个分组输出格式如下：

### 分组名称
> 这个分组的技术方向说明（1-2句，解释为什么这些项目被归为一类）

- **项目名**：解决什么问题，技术方案是什么，对 Harness 生态有何意义

4. Changelog 单独一个分组，每条注明 breaking change / 新功能 / 性能改进
5. 用中文输出

## 新项目（{len(new_repos)} 个）
{new_repos or '无'}

## Changelog（{len(releases)} 条）
{releases or '无'}

如无有价值内容，直接回复：本周期无重要动态。
"""
    return model.generate_content(prompt).text


def send_discord(content):
    for chunk in [content[i:i + 1900] for i in range(0, len(content), 1900)]:
        requests.post(os.environ["DISCORD_WEBHOOK_URL"], json={"content": chunk})


def main():
    new_repos = search_new_repos()
    releases = fetch_changelogs()

    summary = ai_summarize(new_repos, releases)
    now = datetime.now().strftime("%Y-%m-%d %H:%M")

    send_discord(f"**[Harness 动态] {now}**\n\n{summary}")
    print("Done.")


if __name__ == "__main__":
    main()

import os
import json
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
    {"name": "Anthropic News",       "base": "https://www.anthropic.com", "pattern": "/news/"},
    {"name": "Anthropic Engineering", "base": "https://www.anthropic.com", "pattern": "/engineering/"},
    {"name": "Claude Blog",           "base": "https://claude.com",        "pattern": "/blog/"},
]

GROUP_COLORS = [0x5865F2, 0x57F287, 0xFEE75C, 0xEB459E, 0xED4245]
CHANGELOG_EMOJI = {"breaking_change": "🔴", "feature": "🟢", "improvement": "🔵"}
# ────────────────────────────────────────────────────────


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
                results.append({
                    "name": item["full_name"],
                    "description": item.get("description") or "",
                    "stars": item["stargazers_count"],
                    "url": item["html_url"],
                    "readme": fetch_readme(item["full_name"]),
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


def build_selector_options(data):
    options = []
    for group in data.get("groups", []):
        for item in group.get("items", []):
            url = item.get("url", "")
            if not url:
                continue
            if not url.startswith("https://github.com/"):
                continue
            repo = url.replace("https://github.com/", "")[:93]
            opt = {
                "label": f"[GitHub] {item['name']}"[:100],
                "value": f"github:{repo}",
            }
            if summary := item.get("summary", "")[:100]:
                opt["description"] = summary
            options.append(opt)
    for item in data.get("blog_group", {}).get("items", []):
        url = item.get("url", "")
        if not url:
            continue
        opt = {
            "label": f"[Blog] {item['name']}"[:100],
            "value": f"blog:{url[:95]}",
        }
        if summary := item.get("summary", "")[:100]:
            opt["description"] = summary
        options.append(opt)
    return options[:25]


def ai_analyze(new_repos, releases, blog_posts):
    genai.configure(api_key=os.environ["GEMINI_API_KEY"])
    model = genai.GenerativeModel(
        "gemini-2.5-flash",
        generation_config={"response_mime_type": "application/json"},
    )
    prompt = f"""你是一个关注 AI Agent、CI/CD 和 Harness 生态的技术信息筛选助手。

分析以下过去 12 小时的 GitHub 和博客动态，以 JSON 格式输出结果。

要求：
1. 过滤掉学习笔记、无 star、fork、个人练习等无价值内容
2. 将保留内容按技术方向分组，组数不超过 5 个
3. 每个 summary 不超过 80 字，用中文

输出 JSON 结构：
{{
  "has_content": true,
  "groups": [
    {{
      "name": "分组名称",
      "description": "分组说明，1-2句",
      "items": [
        {{
          "name": "项目或文章名",
          "url": "https://github.com/owner/repo",
          "summary": "解决什么问题，核心方案，值得关注的原因"
        }}
      ]
    }}
  ],
  "blog_group": {{
    "items": [
      {{
        "name": "文章标题",
        "url": "文章链接",
        "source": "来源名称",
        "summary": "文章核心内容，不超过60字"
      }}
    ]
  }},
  "changelogs": [
    {{
      "repo": "仓库名",
      "title": "版本号",
      "type": "breaking_change 或 feature 或 improvement",
      "summary": "更新内容简述"
    }}
  ]
}}

注意：博客更新必须全部放入 blog_group，不得混入 groups。
没有有价值内容时返回：{{"has_content": false, "groups": [], "blog_group": {{"items": []}}, "changelogs": []}}

注意：groups 中每个 item 的 url 必须与 GitHub 新项目原始数据中的 url 完全一致，不得修改或省略。

## GitHub 新项目
{json.dumps(new_repos, ensure_ascii=False)}

## Changelog
{json.dumps(releases, ensure_ascii=False)}

## 博客更新
{json.dumps(blog_posts, ensure_ascii=False)}
"""
    response = model.generate_content(prompt)
    return json.loads(response.text)


def build_embeds(data, title):
    embeds = [{"title": title, "color": 0x5865F2}]

    for i, group in enumerate(data.get("groups", [])):
        fields = [
            {"name": item["name"], "value": item["summary"], "inline": False}
            for item in group.get("items", [])
        ]
        embeds.append({
            "title": f"📁 {group['name']}",
            "description": group.get("description", ""),
            "color": GROUP_COLORS[i % len(GROUP_COLORS)],
            "fields": fields,
        })

    blog_items = data.get("blog_group", {}).get("items", [])
    if blog_items:
        fields = [
            {"name": f"[{item.get('source', '')}] {item['name']}", "value": f"{item.get('summary', '')}\n{item.get('url', '')}", "inline": False}
            for item in blog_items
        ]
        embeds.append({"title": "📰 博客更新", "color": 0xEB459E, "fields": fields})

    changelogs = data.get("changelogs", [])
    if changelogs:
        fields = [
            {
                "name": f"{CHANGELOG_EMOJI.get(cl.get('type', ''), '⚪')} {cl['repo']} {cl['title']}",
                "value": cl["summary"],
                "inline": False,
            }
            for cl in changelogs
        ]
        embeds.append({"title": "📋 Changelog", "color": 0xED4245, "fields": fields})

    return embeds


def send_discord(embeds):
    # Discord 单次最多 10 个 embed
    for i in range(0, len(embeds), 10):
        requests.post(
            os.environ["DISCORD_WEBHOOK_URL"],
            json={"embeds": embeds[i:i + 10]},
        )


def main():
    new_repos = search_new_repos()
    releases = fetch_changelogs()
    blog_posts = fetch_blogs()

    data = ai_analyze(new_repos, releases, blog_posts)
    if not data.get("has_content"):
        print("No content.")
        return

    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    embeds = build_embeds(data, f"技术动态 {now}")
    send_discord(embeds)
    print("Done.")


if __name__ == "__main__":
    main()

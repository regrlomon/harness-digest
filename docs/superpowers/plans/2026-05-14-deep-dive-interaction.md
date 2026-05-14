# Deep Dive Interaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-item "deep dive" select menu to the daily Discord digest — users pick a project or blog post, and a Cloudflare Worker fetches detailed data, calls Gemini, and sends a private Discord DM with the analysis.

**Architecture:** The Python digest script switches from an Incoming Webhook to Discord Bot API, adding a Select Menu component at the end of each daily report. A Cloudflare Worker hosts the Discord interaction endpoint: it responds within 3 seconds with a deferred acknowledgement, then asynchronously fetches GitHub API or blog content, calls Gemini 2.5 Flash, and sends the result as a Discord DM to the requesting user.

**Tech Stack:** Python 3.12, pytest · Cloudflare Workers (JS ES modules), Vitest · Discord Bot API v10 · GitHub REST API v3 · Gemini 2.5 Flash REST API · `discord-interactions` npm package (ed25519 verification)

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `news_digest.py` | Modify | Add URL to AI output, `build_selector_options`, switch to Bot API |
| `.github/workflows/digest.yml` | Modify | Replace webhook secret with bot token + channel ID |
| `tests/test_selector.py` | Create | Unit tests for `build_selector_options` |
| `worker/package.json` | Create | Worker deps and scripts |
| `worker/wrangler.toml` | Create | Worker name, entry point |
| `worker/src/index.js` | Create | Entry: signature verification, routing, deferred response, `waitUntil` |
| `worker/src/verify.js` | Create | Discord ed25519 signature verification wrapper |
| `worker/src/analyze.js` | Create | GitHub API fetch, blog scrape, Gemini call |
| `worker/src/discord.js` | Create | Discord API helpers: `createDMChannel`, `sendMessage`, `editInteractionResponse` |
| `worker/test/verify.test.js` | Create | Unit tests for `verifyDiscordRequest` |
| `worker/test/analyze.test.js` | Create | Unit tests for `fetchGithubData`, `fetchBlogContent`, `analyzeWithGemini` |

---

### Task 1: Add URL field to AI output schema

**Files:**
- Modify: `news_digest.py`

- [ ] **Step 1: Update groups.items schema in the prompt**

In `ai_analyze`, change the `groups.items` schema block from:
```python
      "items": [
        {{
          "name": "项目或文章名",
          "summary": "解决什么问题，核心方案，值得关注的原因"
        }}
      ]
```
to:
```python
      "items": [
        {{
          "name": "项目或文章名",
          "url": "https://github.com/owner/repo",
          "summary": "解决什么问题，核心方案，值得关注的原因"
        }}
      ]
```

- [ ] **Step 2: Add URL preservation instruction to the prompt**

After the `"没有有价值内容时返回"` line, add:
```python

注意：groups 中每个 item 的 url 必须与 GitHub 新项目原始数据中的 url 完全一致，不得修改或省略。
```

- [ ] **Step 3: Commit**

```bash
git add news_digest.py
git commit -m "feat: add url field to ai_analyze groups output"
```

---

### Task 2: Add build_selector_options with tests

**Files:**
- Modify: `news_digest.py`
- Create: `tests/test_selector.py`

- [ ] **Step 1: Write the failing test**

Create `tests/test_selector.py`:
```python
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from news_digest import build_selector_options

def test_github_options():
    data = {
        "groups": [{"items": [
            {"name": "harness/harness", "url": "https://github.com/harness/harness", "summary": "CI/CD platform"},
            {"name": "harness/gitness", "url": "https://github.com/harness/gitness", "summary": "Git hosting"},
        ]}],
        "blog_group": {"items": []},
    }
    opts = build_selector_options(data)
    assert len(opts) == 2
    assert opts[0]["value"] == "github:harness/harness"
    assert opts[0]["label"] == "[GitHub] harness/harness"
    assert len(opts[0]["label"]) <= 100
    assert len(opts[0]["value"]) <= 100

def test_blog_options():
    data = {
        "groups": [],
        "blog_group": {"items": [
            {"name": "Claude 3.7 Sonnet", "url": "https://www.anthropic.com/news/claude-3-7-sonnet", "summary": "New model", "source": "Anthropic"},
        ]},
    }
    opts = build_selector_options(data)
    assert len(opts) == 1
    assert opts[0]["value"].startswith("blog:")
    assert len(opts[0]["value"]) <= 100

def test_max_25_options():
    items = [{"name": f"owner/repo{i}", "url": f"https://github.com/owner/repo{i}", "summary": "s"} for i in range(30)]
    data = {"groups": [{"items": items}], "blog_group": {"items": []}}
    opts = build_selector_options(data)
    assert len(opts) == 25

def test_skips_items_without_url():
    data = {
        "groups": [{"items": [{"name": "no-url", "summary": "x"}]}],
        "blog_group": {"items": []},
    }
    opts = build_selector_options(data)
    assert len(opts) == 0
```

- [ ] **Step 2: Run test to verify it fails**

```bash
python -m pytest tests/test_selector.py -v
```
Expected: `ImportError: cannot import name 'build_selector_options'`

- [ ] **Step 3: Implement build_selector_options in news_digest.py**

Add after the `fetch_blogs()` function:
```python
def build_selector_options(data):
    options = []
    for group in data.get("groups", []):
        for item in group.get("items", []):
            url = item.get("url", "")
            if not url:
                continue
            repo = url.replace("https://github.com/", "")
            options.append({
                "label": f"[GitHub] {item['name']}"[:100],
                "value": f"github:{repo}"[:100],
                "description": item.get("summary", "")[:100],
            })
    for item in data.get("blog_group", {}).get("items", []):
        url = item.get("url", "")
        if not url:
            continue
        options.append({
            "label": f"[Blog] {item['name']}"[:100],
            "value": f"blog:{url}"[:100],
            "description": item.get("summary", "")[:100],
        })
    return options[:25]
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
python -m pytest tests/test_selector.py -v
```
Expected: 4 tests PASSED

- [ ] **Step 5: Commit**

```bash
git add news_digest.py tests/test_selector.py
git commit -m "feat: add build_selector_options for discord select menu"
```

---

### Task 3: Switch send_discord to Bot API + append selector message

**Files:**
- Modify: `news_digest.py`

- [ ] **Step 1: Replace send_discord function**

Replace the existing `send_discord(embeds)` function with:
```python
def send_discord(embeds, selector_options=None):
    headers = {
        "Authorization": f"Bot {os.environ['DISCORD_BOT_TOKEN']}",
        "Content-Type": "application/json",
    }
    channel_id = os.environ["DISCORD_CHANNEL_ID"]
    base_url = f"https://discord.com/api/v10/channels/{channel_id}/messages"

    for i in range(0, len(embeds), 10):
        requests.post(base_url, headers=headers, json={"embeds": embeds[i:i + 10]})

    if selector_options:
        requests.post(base_url, headers=headers, json={
            "content": "🔍 对哪个感兴趣？选择后将私信深度分析",
            "components": [{
                "type": 1,
                "components": [{
                    "type": 3,
                    "custom_id": "deep_dive_selector",
                    "placeholder": "选择一个项目或文章...",
                    "options": selector_options,
                }],
            }],
        })
```

- [ ] **Step 2: Update main() to pass selector options**

Replace the `send_discord(embeds)` call in `main()` with:
```python
    selector_options = build_selector_options(data)
    send_discord(embeds, selector_options)
```

- [ ] **Step 3: Verify selector payload is built correctly**

```bash
python -c "
from news_digest import build_selector_options, build_embeds
import json
data = {
    'has_content': True,
    'groups': [{'name': 'test', 'description': '', 'items': [
        {'name': 'harness/harness', 'url': 'https://github.com/harness/harness', 'summary': 'CI/CD'}
    ]}],
    'blog_group': {'items': [
        {'name': 'Claude blog post', 'url': 'https://www.anthropic.com/news/test', 'summary': 'AI update', 'source': 'Anthropic'}
    ]},
    'changelogs': []
}
opts = build_selector_options(data)
print(json.dumps(opts, ensure_ascii=False, indent=2))
"
```
Expected: 2 options printed, values start with `github:` and `blog:`

- [ ] **Step 4: Commit**

```bash
git add news_digest.py
git commit -m "feat: switch to discord bot api and add selector message"
```

---

### Task 4: Update GitHub Actions workflow

**Files:**
- Modify: `.github/workflows/digest.yml`

- [ ] **Step 1: Replace webhook secret with bot token and channel ID**

Replace:
```yaml
        env:
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
          DISCORD_WEBHOOK_URL: ${{ secrets.DISCORD_WEBHOOK_URL }}
```
with:
```yaml
        env:
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
          DISCORD_BOT_TOKEN: ${{ secrets.DISCORD_BOT_TOKEN }}
          DISCORD_CHANNEL_ID: ${{ secrets.DISCORD_CHANNEL_ID }}
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/digest.yml
git commit -m "ci: replace discord webhook with bot token and channel id"
```

---

### Task 5: Create Cloudflare Worker scaffold

**Files:**
- Create: `worker/package.json`
- Create: `worker/wrangler.toml`

- [ ] **Step 1: Create worker/package.json**

```json
{
  "name": "harness-digest-worker",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run"
  },
  "dependencies": {
    "discord-interactions": "^3.4.0"
  },
  "devDependencies": {
    "wrangler": "^3.0.0",
    "vitest": "^1.0.0"
  }
}
```

- [ ] **Step 2: Create worker/wrangler.toml**

```toml
name = "harness-digest-worker"
main = "src/index.js"
compatibility_date = "2024-01-01"

# Secrets are set via: wrangler secret put <KEY>
# Required secrets: DISCORD_PUBLIC_KEY, DISCORD_BOT_TOKEN, GEMINI_API_KEY
# Optional: GITHUB_TOKEN (raises GitHub API rate limit from 60 to 5000 req/hr)
```

- [ ] **Step 3: Install dependencies**

```bash
cd worker && npm install
```
Expected: `node_modules/` created, `package-lock.json` generated, no errors

- [ ] **Step 4: Commit**

```bash
cd ..
git add worker/package.json worker/wrangler.toml worker/package-lock.json
git commit -m "chore: add cloudflare worker scaffold"
```

---

### Task 6: Implement Discord signature verification

**Files:**
- Create: `worker/src/verify.js`
- Create: `worker/test/verify.test.js`

- [ ] **Step 1: Write the failing test**

Create `worker/test/verify.test.js`:
```js
import { describe, it, expect, vi } from 'vitest';

vi.mock('discord-interactions', () => ({
  verifyKey: vi.fn(),
}));

import { verifyKey } from 'discord-interactions';
import { verifyDiscordRequest } from '../src/verify.js';

describe('verifyDiscordRequest', () => {
  it('returns true when verifyKey returns true', async () => {
    verifyKey.mockResolvedValue(true);
    const result = await verifyDiscordRequest('body', 'sig', 'ts', 'pubkey');
    expect(result).toBe(true);
    expect(verifyKey).toHaveBeenCalledWith('body', 'sig', 'ts', 'pubkey');
  });

  it('returns false when verifyKey returns false', async () => {
    verifyKey.mockResolvedValue(false);
    const result = await verifyDiscordRequest('body', 'sig', 'ts', 'pubkey');
    expect(result).toBe(false);
  });

  it('returns false when verifyKey throws', async () => {
    verifyKey.mockRejectedValue(new Error('bad key'));
    const result = await verifyDiscordRequest('body', 'sig', 'ts', 'pubkey');
    expect(result).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd worker && npm test
```
Expected: `Cannot find module '../src/verify.js'`

- [ ] **Step 3: Implement verify.js**

Create `worker/src/verify.js`:
```js
import { verifyKey } from 'discord-interactions';

export async function verifyDiscordRequest(body, signature, timestamp, publicKey) {
  try {
    return await verifyKey(body, signature, timestamp, publicKey);
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd worker && npm test
```
Expected: 3 tests PASSED

- [ ] **Step 5: Commit**

```bash
cd ..
git add worker/src/verify.js worker/test/verify.test.js
git commit -m "feat: add discord signature verification"
```

---

### Task 7: Implement Discord API helpers

**Files:**
- Create: `worker/src/discord.js`

- [ ] **Step 1: Create worker/src/discord.js**

```js
const DISCORD_API = 'https://discord.com/api/v10';

export async function createDMChannel(userId, botToken) {
  const res = await fetch(`${DISCORD_API}/users/@me/channels`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ recipient_id: userId }),
  });
  const data = await res.json();
  return data.id;
}

export async function sendMessage(channelId, content, botToken) {
  await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content }),
  });
}

export async function editInteractionResponse(applicationId, interactionToken, content, botToken) {
  await fetch(
    `${DISCORD_API}/webhooks/${applicationId}/${interactionToken}/messages/@original`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content }),
    }
  );
}
```

- [ ] **Step 2: Run existing tests to confirm nothing broke**

```bash
cd worker && npm test
```
Expected: 3 tests PASSED (same as before)

- [ ] **Step 3: Commit**

```bash
cd ..
git add worker/src/discord.js
git commit -m "feat: add discord api helpers (dm channel, send message, edit response)"
```

---

### Task 8: Implement GitHub fetcher and blog scraper

**Files:**
- Create: `worker/src/analyze.js`
- Create: `worker/test/analyze.test.js`

- [ ] **Step 1: Write failing tests**

Create `worker/test/analyze.test.js`:
```js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchGithubData, fetchBlogContent, analyzeWithGemini } from '../src/analyze.js';

describe('fetchGithubData', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));

  it('fetches repo, readme, issues, prs, commits in parallel', async () => {
    const mockRepo = { full_name: 'harness/harness', description: 'CI/CD', stargazers_count: 1000, language: 'Go', open_issues_count: 50 };
    fetch
      .mockResolvedValueOnce({ ok: true, json: async () => mockRepo })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ content: btoa('# Harness\nA platform') }) })
      .mockResolvedValueOnce({ ok: true, json: async () => [{ number: 1, title: 'Bug fix' }] })
      .mockResolvedValueOnce({ ok: true, json: async () => [{ number: 2, title: 'New feature' }] })
      .mockResolvedValueOnce({ ok: true, json: async () => [{ commit: { message: 'feat: add pipeline' } }] });

    const result = await fetchGithubData('harness/harness');
    expect(result.repo.full_name).toBe('harness/harness');
    expect(result.readme).toContain('Harness');
    expect(result.issues).toHaveLength(1);
    expect(result.prs).toHaveLength(1);
    expect(result.commits).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it('returns empty arrays when sub-requests fail', async () => {
    fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ full_name: 'x', stargazers_count: 0, open_issues_count: 0 }) })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: false });

    const result = await fetchGithubData('x/y');
    expect(result.readme).toBe('');
    expect(result.issues).toEqual([]);
    expect(result.prs).toEqual([]);
    expect(result.commits).toEqual([]);
  });
});

describe('fetchBlogContent', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));

  it('strips html tags and script blocks', async () => {
    const html = '<html><body><script>js()</script><style>css{}</style><p>Hello world</p></body></html>';
    fetch.mockResolvedValueOnce({ ok: true, text: async () => html });
    const result = await fetchBlogContent('https://example.com/blog');
    expect(result).toContain('Hello world');
    expect(result).not.toContain('<p>');
    expect(result).not.toContain('js()');
    expect(result).not.toContain('css{}');
  });

  it('returns empty string on fetch failure', async () => {
    fetch.mockResolvedValueOnce({ ok: false });
    const result = await fetchBlogContent('https://example.com');
    expect(result).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd worker && npm test
```
Expected: `Cannot find module '../src/analyze.js'`

- [ ] **Step 3: Implement fetchGithubData and fetchBlogContent in analyze.js**

Create `worker/src/analyze.js`:
```js
export async function fetchGithubData(repoFullName, githubToken) {
  const headers = { 'User-Agent': 'harness-digest-bot' };
  if (githubToken) headers['Authorization'] = `token ${githubToken}`;

  const [repoRes, readmeRes, issuesRes, prsRes, commitsRes] = await Promise.all([
    fetch(`https://api.github.com/repos/${repoFullName}`, { headers }),
    fetch(`https://api.github.com/repos/${repoFullName}/readme`, { headers }),
    fetch(`https://api.github.com/repos/${repoFullName}/issues?state=open&per_page=5&sort=updated`, { headers }),
    fetch(`https://api.github.com/repos/${repoFullName}/pulls?state=open&per_page=5&sort=updated`, { headers }),
    fetch(`https://api.github.com/repos/${repoFullName}/commits?per_page=5`, { headers }),
  ]);

  const repo = await repoRes.json();
  let readme = '';
  if (readmeRes.ok) {
    const readmeData = await readmeRes.json();
    readme = atob(readmeData.content.replace(/\n/g, '')).slice(0, 2000);
  }

  return {
    repo,
    readme,
    issues: issuesRes.ok ? await issuesRes.json() : [],
    prs: prsRes.ok ? await prsRes.json() : [],
    commits: commitsRes.ok ? await commitsRes.json() : [],
  };
}

export async function fetchBlogContent(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) return '';
  const html = await res.text();
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 5000);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd worker && npm test
```
Expected: all previous tests + new fetchGithubData/fetchBlogContent tests PASSED

- [ ] **Step 5: Commit**

```bash
cd ..
git add worker/src/analyze.js worker/test/analyze.test.js
git commit -m "feat: add github data fetcher and blog scraper"
```

---

### Task 9: Implement Gemini analyzer

**Files:**
- Modify: `worker/src/analyze.js`
- Modify: `worker/test/analyze.test.js`

- [ ] **Step 1: Add failing tests for analyzeWithGemini**

Append to `worker/test/analyze.test.js`:
```js
describe('analyzeWithGemini', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));

  it('calls gemini api and returns text for github type', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '🔍 deep analysis result' }] } }],
      }),
    });

    const data = {
      repo: { full_name: 'harness/harness', description: 'CI/CD', stargazers_count: 1000, language: 'Go', open_issues_count: 50 },
      readme: '# Harness',
      issues: [{ number: 1, title: 'Bug' }],
      prs: [{ number: 2, title: 'Feature' }],
      commits: [{ commit: { message: 'feat: add thing' } }],
    };

    const result = await analyzeWithGemini('github', data, 'fake-key');
    expect(result).toBe('🔍 deep analysis result');
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('gemini-2.5-flash'),
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('returns fallback message when candidates is empty', async () => {
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ candidates: [] }) });
    const data = {
      repo: { full_name: 'x', description: '', stargazers_count: 0, language: '', open_issues_count: 0 },
      readme: '', issues: [], prs: [], commits: [],
    };
    const result = await analyzeWithGemini('github', data, 'key');
    expect(result).toBe('分析失败，请稍后重试。');
  });

  it('calls gemini for blog type with url in prompt', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: '📰 blog analysis' }] } }] }),
    });

    const result = await analyzeWithGemini('blog', { content: 'Article text here', url: 'https://anthropic.com/blog/test' }, 'key');
    expect(result).toBe('📰 blog analysis');

    const callBody = JSON.parse(fetch.mock.calls[0][1].body);
    expect(callBody.contents[0].parts[0].text).toContain('https://anthropic.com/blog/test');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd worker && npm test
```
Expected: `analyzeWithGemini is not a function` (it's not exported yet)

- [ ] **Step 3: Implement analyzeWithGemini in analyze.js**

Append to `worker/src/analyze.js`:
```js
export async function analyzeWithGemini(type, data, apiKey) {
  let prompt;

  if (type === 'github') {
    const { repo, readme, issues, prs, commits } = data;
    prompt = `分析以下 GitHub 项目，用中文生成深度报告，严格按照下方格式输出，不要添加其他内容。

🔍 **${repo.full_name}** 深度分析

📌 **项目定位**
[分析问题域和目标用户，2-3句]

🏗 **核心架构**
[分析技术方案和关键组件，3-5句]

📊 **近期活跃度**
⭐ Stars: ${repo.stargazers_count}
🐛 Open Issues: ${repo.open_issues_count}
🔀 近期 PR: ${prs.slice(0, 3).map(p => `#${p.number} ${p.title}`).join(' · ') || '无'}
📝 近期 Commit: ${commits.slice(0, 3).map(c => c.commit.message.split('\n')[0]).join(' · ') || '无'}

🔗 https://github.com/${repo.full_name}

---以下是原始数据，请基于此分析---
描述: ${repo.description || '无'}
语言: ${repo.language || '未知'}
README（节选）:
${readme}
近期 Issues: ${issues.slice(0, 5).map(i => `#${i.number} ${i.title}`).join(', ') || '无'}`;
  } else {
    prompt = `分析以下博客文章，用中文生成深度解读，严格按照下方格式输出，不要添加其他内容。

📰 **深度解读**

🎯 **核心观点**
[主要论点，2-3句]

💡 **关键技术点**
• [要点一]
• [要点二]
• [要点三]

🔑 **值得关注的原因**
[对 AI Agent/Harness 生态的意义，1-2句]

🔗 ${data.url}

---以下是文章内容，请基于此分析---
${data.content}`;
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    }
  );
  const json = await res.json();
  return json.candidates?.[0]?.content?.parts?.[0]?.text ?? '分析失败，请稍后重试。';
}
```

- [ ] **Step 4: Run all tests to verify they pass**

```bash
cd worker && npm test
```
Expected: all tests PASSED (verify + fetchGithubData + fetchBlogContent + analyzeWithGemini)

- [ ] **Step 5: Commit**

```bash
cd ..
git add worker/src/analyze.js worker/test/analyze.test.js
git commit -m "feat: add gemini analyzer for github and blog deep dives"
```

---

### Task 10: Implement Worker entry point

**Files:**
- Create: `worker/src/index.js`

- [ ] **Step 1: Create worker/src/index.js**

```js
import { verifyDiscordRequest } from './verify.js';
import { fetchGithubData, fetchBlogContent, analyzeWithGemini } from './analyze.js';
import { createDMChannel, sendMessage, editInteractionResponse } from './discord.js';

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const signature = request.headers.get('X-Signature-Ed25519');
    const timestamp = request.headers.get('X-Signature-Timestamp');
    const body = await request.text();

    const isValid = await verifyDiscordRequest(body, signature, timestamp, env.DISCORD_PUBLIC_KEY);
    if (!isValid) {
      return new Response('Invalid signature', { status: 401 });
    }

    const interaction = JSON.parse(body);

    if (interaction.type === 1) {
      return Response.json({ type: 1 });
    }

    if (interaction.type === 3) {
      const value = interaction.data.values[0];
      const userId = interaction.member?.user?.id ?? interaction.user?.id;
      const applicationId = interaction.application_id;
      const interactionToken = interaction.token;

      ctx.waitUntil(handleDeepDive(value, userId, applicationId, interactionToken, env));

      return Response.json({ type: 5, data: { flags: 64 } });
    }

    return new Response('Unknown interaction type', { status: 400 });
  },
};

async function handleDeepDive(value, userId, applicationId, interactionToken, env) {
  try {
    let analysis;

    if (value.startsWith('github:')) {
      const repo = value.slice(7);
      const data = await fetchGithubData(repo, env.GITHUB_TOKEN);
      analysis = await analyzeWithGemini('github', data, env.GEMINI_API_KEY);
    } else if (value.startsWith('blog:')) {
      const url = value.slice(5);
      const content = await fetchBlogContent(url);
      analysis = await analyzeWithGemini('blog', { content, url }, env.GEMINI_API_KEY);
    } else {
      analysis = '无法识别的项目类型。';
    }

    const dmChannelId = await createDMChannel(userId, env.DISCORD_BOT_TOKEN);
    await sendMessage(dmChannelId, analysis, env.DISCORD_BOT_TOKEN);
    await editInteractionResponse(applicationId, interactionToken, '✉️ 已发送私信，请查收！', env.DISCORD_BOT_TOKEN);
  } catch {
    await editInteractionResponse(
      applicationId, interactionToken, '❌ 分析失败，请稍后重试。', env.DISCORD_BOT_TOKEN
    ).catch(() => {});
  }
}
```

- [ ] **Step 2: Run all tests one final time**

```bash
cd worker && npm test
```
Expected: all tests PASSED

- [ ] **Step 3: Do a dry-run bundle to check for import errors**

```bash
cd worker && npx wrangler deploy --dry-run --outdir dist
```
Expected: `Total Upload: xx KiB` with no errors

- [ ] **Step 4: Commit**

```bash
cd ..
git add worker/src/index.js
git commit -m "feat: implement worker entry point with deep dive handler"
```

---

### Task 11: Deploy Worker and configure Discord Bot

> Manual configuration task. No code changes.

- [ ] **Step 1: Create Discord Application and Bot**

1. Go to `https://discord.com/developers/applications`
2. Click "New Application" → name it `Harness Digest Bot` → Create
3. Go to "Bot" tab → click "Add Bot" → confirm
4. Under "Privileged Gateway Intents" → enable **Message Content Intent**
5. Click "Reset Token" → copy the token → this is `DISCORD_BOT_TOKEN`
6. Go to "General Information" tab → copy **Public Key** → this is `DISCORD_PUBLIC_KEY`

- [ ] **Step 2: Invite bot to your Discord server**

1. Go to "OAuth2" → "URL Generator"
2. Scopes: check `bot`
3. Bot Permissions: check `Send Messages` and `Read Message History`
4. Copy the generated URL → open in browser → select your server → Authorize

- [ ] **Step 3: Get your Discord Channel ID**

1. Discord → Settings → Advanced → enable **Developer Mode**
2. Right-click the target digest channel → "Copy Channel ID" → this is `DISCORD_CHANNEL_ID`

- [ ] **Step 4: Set Cloudflare Worker secrets**

```bash
cd worker
npx wrangler secret put DISCORD_PUBLIC_KEY
# paste the public key when prompted

npx wrangler secret put DISCORD_BOT_TOKEN
# paste the bot token when prompted

npx wrangler secret put GEMINI_API_KEY
# paste the Gemini API key when prompted
```
Each command prompts for the value. Press Enter after pasting. Expected: `✨ Success! Uploaded secret <KEY>`

- [ ] **Step 5: Deploy the Worker**

```bash
cd worker && npm run deploy
```
Expected output includes: `https://harness-digest-worker.<your-subdomain>.workers.dev`

Copy that URL.

- [ ] **Step 6: Register interaction endpoint in Discord**

1. Discord Developer Portal → your application → "General Information"
2. Paste the Worker URL into **"Interactions Endpoint URL"**
3. Click "Save Changes"

Expected: Discord sends a PING to verify the endpoint → green checkmark appears. If it shows an error, confirm `DISCORD_PUBLIC_KEY` matches exactly what's in the Developer Portal.

- [ ] **Step 7: Add GitHub Actions secrets**

In GitHub repo → Settings → Secrets and variables → Actions:
- Add secret `DISCORD_BOT_TOKEN` → paste bot token
- Add secret `DISCORD_CHANNEL_ID` → paste channel ID

(The old `DISCORD_WEBHOOK_URL` secret can be deleted — it's no longer referenced)

- [ ] **Step 8: End-to-end test**

Trigger a manual workflow run:
```bash
gh workflow run digest.yml
```

Wait ~2 minutes, then check Discord:
1. Daily digest embeds appear in the channel ✅
2. A "🔍 对哪个感兴趣？" message with a dropdown appears ✅
3. Select any item → ephemeral message shows "分析中..." ✅
4. Within ~20 seconds → Discord DM arrives with deep dive analysis ✅

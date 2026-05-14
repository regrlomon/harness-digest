# Button Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add follow-up buttons to deep-dive DMs so users can ask for more specific analysis (architecture, trends, issues, comparison for GitHub; technical details or application scenarios for blog articles).

**Architecture:** After the existing deep-dive DM is sent, append an action-row with buttons. Each button click triggers a new Discord Interaction (type 3, component_type 2) received by the Worker. GitHub button custom_ids encode the repo name directly; blog button custom_ids encode a short URL hash, with the full URL stored in Cloudflare KV (TTL 2h). The Worker reads the KV entry, re-fetches data, calls Gemini with an action-specific prompt, and sends a follow-up DM.

**Tech Stack:** Cloudflare Workers (JS), Cloudflare KV, Discord Interactions API, Gemini 2.5 Flash, Vitest

---

## File Map

| File | Change | Responsibility |
|------|--------|---------------|
| `worker/wrangler.toml` | Modify | Add KV namespace binding `CONTEXT_KV` |
| `worker/src/discord.js` | Modify | `sendMessage` accepts optional `components`; add `buildFollowupButtons` |
| `worker/src/analyze.js` | Modify | Add `analyzeFollowup(type, action, data, apiKey)` |
| `worker/src/index.js` | Modify | Route `component_type 2` (button) to `handleFollowup`; update `handleDeepDive` to save KV + send buttons |
| `worker/test/discord.test.js` | Create | Tests for `sendMessage` with components and `buildFollowupButtons` |
| `worker/test/analyze.test.js` | Modify | Add tests for `analyzeFollowup` |

---

## Task 1: Add KV Binding

**Files:**
- Modify: `worker/wrangler.toml`

- [ ] **Step 1: Add KV binding**

Replace the contents of `worker/wrangler.toml` with:

```toml
name = "harness-digest-worker"
main = "src/index.js"
compatibility_date = "2024-01-01"

[[kv_namespaces]]
binding = "CONTEXT_KV"
id = "REPLACE_WITH_YOUR_KV_NAMESPACE_ID"

# Secrets are set via: wrangler secret put <KEY>
# Required secrets: DISCORD_PUBLIC_KEY, DISCORD_BOT_TOKEN, GEMINI_API_KEY
# Optional: GITHUB_TOKEN (raises GitHub API rate limit from 60 to 5000 req/hr)
```

> Note: Create the KV namespace first with `wrangler kv:namespace create CONTEXT_KV`, then paste the returned `id` into the config.

- [ ] **Step 2: Commit**

```bash
git add worker/wrangler.toml
git commit -m "feat: add KV namespace binding for followup context"
```

---

## Task 2: Update discord.js — sendMessage + buildFollowupButtons

**Files:**
- Modify: `worker/src/discord.js`
- Create: `worker/test/discord.test.js`

- [ ] **Step 1: Write the failing tests**

Create `worker/test/discord.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendMessage, buildFollowupButtons } from '../src/discord.js';

describe('sendMessage', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true })));

  it('sends message without components when none provided', async () => {
    await sendMessage('chan123', 'hello', 'token');
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.content).toBe('hello');
    expect(body.components).toBeUndefined();
  });

  it('sends message with components when provided', async () => {
    const components = [{ type: 1, components: [{ type: 2, label: 'Test', custom_id: 'fu:gh:repo:arch', style: 2 }] }];
    await sendMessage('chan123', 'hello', 'token', components);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.components).toEqual(components);
  });
});

describe('buildFollowupButtons', () => {
  it('returns one action row with 4 github buttons', () => {
    const rows = buildFollowupButtons('github', 'harness/harness');
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe(1);
    expect(rows[0].components).toHaveLength(4);
    const ids = rows[0].components.map(b => b.custom_id);
    expect(ids).toContain('fu:gh:harness/harness:arch');
    expect(ids).toContain('fu:gh:harness/harness:trend');
    expect(ids).toContain('fu:gh:harness/harness:issues');
    expect(ids).toContain('fu:gh:harness/harness:compare');
  });

  it('returns one action row with 2 blog buttons', () => {
    const rows = buildFollowupButtons('blog', 'abc12345');
    expect(rows).toHaveLength(1);
    expect(rows[0].components).toHaveLength(2);
    const ids = rows[0].components.map(b => b.custom_id);
    expect(ids).toContain('fu:blog:abc12345:detail');
    expect(ids).toContain('fu:blog:abc12345:apply');
  });

  it('all buttons have type 2 and style 2', () => {
    const rows = buildFollowupButtons('github', 'x/y');
    for (const btn of rows[0].components) {
      expect(btn.type).toBe(2);
      expect(btn.style).toBe(2);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd worker && npx vitest run test/discord.test.js
```

Expected: FAIL — `sendMessage` does not accept components; `buildFollowupButtons` is not defined.

- [ ] **Step 3: Implement in discord.js**

Replace the full contents of `worker/src/discord.js`:

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
  if (!res.ok) throw new Error(`Discord DM channel error: ${res.status} ${JSON.stringify(data)}`);
  return data.id;
}

export async function sendMessage(channelId, content, botToken, components = []) {
  const body = { content };
  if (components.length > 0) body.components = components;
  await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
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

export function buildFollowupButtons(type, identifier) {
  if (type === 'github') {
    return [{
      type: 1,
      components: [
        { type: 2, style: 2, label: '📖 架构深挖',  custom_id: `fu:gh:${identifier}:arch` },
        { type: 2, style: 2, label: '📈 发展趋势',  custom_id: `fu:gh:${identifier}:trend` },
        { type: 2, style: 2, label: '🐛 Issue 分析', custom_id: `fu:gh:${identifier}:issues` },
        { type: 2, style: 2, label: '🔮 竞品对比',  custom_id: `fu:gh:${identifier}:compare` },
      ],
    }];
  }
  return [{
    type: 1,
    components: [
      { type: 2, style: 2, label: '🔍 技术细节', custom_id: `fu:blog:${identifier}:detail` },
      { type: 2, style: 2, label: '💼 应用场景', custom_id: `fu:blog:${identifier}:apply` },
    ],
  }];
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd worker && npx vitest run test/discord.test.js
```

Expected: PASS — all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add worker/src/discord.js worker/test/discord.test.js
git commit -m "feat: add button components support and buildFollowupButtons helper"
```

---

## Task 3: Add analyzeFollowup to analyze.js

**Files:**
- Modify: `worker/src/analyze.js`
- Modify: `worker/test/analyze.test.js`

- [ ] **Step 1: Write the failing tests**

Append to the bottom of `worker/test/analyze.test.js`:

```js
import { analyzeFollowup } from '../src/analyze.js';

describe('analyzeFollowup', () => {
  const mockGithubData = {
    repo: { full_name: 'harness/harness', description: 'CI/CD', stargazers_count: 1000, language: 'Go', open_issues_count: 50 },
    readme: '# Harness',
    issues: [{ number: 1, title: 'Bug' }],
    prs: [{ number: 2, title: 'Feature' }],
    commits: [{ commit: { message: 'feat: add thing' } }],
  };

  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));

  it.each(['arch', 'trend', 'issues', 'compare'])('calls gemini for github action: %s', async (action) => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: `result:${action}` }] } }] }),
    });
    const result = await analyzeFollowup('github', action, mockGithubData, 'key');
    expect(result).toBe(`result:${action}`);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('gemini-2.5-flash'),
      expect.objectContaining({ method: 'POST' })
    );
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.contents[0].parts[0].text).toContain('harness/harness');
  });

  it.each(['detail', 'apply'])('calls gemini for blog action: %s', async (action) => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: `blog:${action}` }] } }] }),
    });
    const result = await analyzeFollowup('blog', action, { content: 'article text', url: 'https://example.com/post' }, 'key');
    expect(result).toBe(`blog:${action}`);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.contents[0].parts[0].text).toContain('https://example.com/post');
  });

  it('returns fallback on empty candidates', async () => {
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ candidates: [] }) });
    const result = await analyzeFollowup('github', 'arch', mockGithubData, 'key');
    expect(result).toBe('分析失败，请稍后重试。');
  });
});
```

Also update the import line at the top of `worker/test/analyze.test.js`:

```js
import { fetchGithubData, fetchBlogContent, analyzeWithGemini, analyzeFollowup } from '../src/analyze.js';
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd worker && npx vitest run test/analyze.test.js
```

Expected: FAIL — `analyzeFollowup` is not exported from `analyze.js`.

- [ ] **Step 3: Add analyzeFollowup to analyze.js**

Append to the bottom of `worker/src/analyze.js`:

```js
export async function analyzeFollowup(type, action, data, apiKey) {
  const directives = {
    github: {
      arch:    '深入分析该项目的技术架构，包括系统设计模式、核心模块依赖关系、关键技术选型原因和扩展性设计，用中文输出。',
      trend:   '分析该项目的发展趋势，基于近期 PR、commit 和 open issues，评估活跃度并预测未来方向，用中文输出。',
      issues:  '详细分析当前 open issues，按类型（bug/feature/discussion）分类，列出最值得关注的问题，评估社区健康度，用中文输出。',
      compare: '对比该项目与同类竞品（如 GitHub Actions、Jenkins、GitLab CI、Tekton），分析定位差异、核心优势和适用场景，用中文输出。',
    },
    blog: {
      detail: '深入解析文章中的技术实现细节、算法或架构设计，列出具体的技术要点和难点，用中文输出。',
      apply:  '分析文章内容的实际应用价值，列出具体落地场景，重点说明对 AI Agent 和 Harness 生态的影响，用中文输出。',
    },
  };

  const directive = directives[type]?.[action] ?? '对以下内容做深度分析，用中文输出。';

  let rawData;
  if (type === 'github') {
    const { repo, readme, issues, prs, commits } = data;
    rawData = `项目: ${repo.full_name}
描述: ${repo.description || '无'}
语言: ${repo.language || '未知'}
Stars: ${repo.stargazers_count} | Open Issues: ${repo.open_issues_count}
README（节选）: ${readme}
近期 PR: ${prs.slice(0, 5).map(p => `#${p.number} ${p.title}`).join(' | ') || '无'}
近期 Commit: ${commits.slice(0, 5).map(c => c.commit.message.split('\n')[0]).join(' | ') || '无'}
近期 Issues: ${issues.slice(0, 5).map(i => `#${i.number} ${i.title}`).join(' | ') || '无'}`;
  } else {
    rawData = `文章 URL: ${data.url}\n内容: ${data.content}`;
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: `${directive}\n\n---原始数据---\n${rawData}` }] }] }),
    }
  );
  const json = await res.json();
  return json.candidates?.[0]?.content?.parts?.[0]?.text ?? '分析失败，请稍后重试。';
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd worker && npx vitest run test/analyze.test.js
```

Expected: PASS — all tests green (existing + new analyzeFollowup tests).

- [ ] **Step 5: Commit**

```bash
git add worker/src/analyze.js worker/test/analyze.test.js
git commit -m "feat: add analyzeFollowup with action-specific prompts"
```

---

## Task 4: Update index.js — button routing + KV + buttons in DM

**Files:**
- Modify: `worker/src/index.js`

- [ ] **Step 1: Replace index.js with the full updated version**

```js
import { verifyDiscordRequest } from './verify.js';
import { fetchGithubData, fetchBlogContent, analyzeWithGemini, analyzeFollowup } from './analyze.js';
import { createDMChannel, sendMessage, editInteractionResponse, buildFollowupButtons } from './discord.js';

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
      const userId = interaction.member?.user?.id ?? interaction.user?.id;
      const applicationId = interaction.application_id;
      const interactionToken = interaction.token;

      if (interaction.data.component_type === 3) {
        // Select menu — deep dive
        const value = interaction.data.values[0];
        ctx.waitUntil(handleDeepDive(value, userId, applicationId, interactionToken, env));
      } else if (interaction.data.component_type === 2) {
        // Button — follow-up
        const customId = interaction.data.custom_id;
        ctx.waitUntil(handleFollowup(customId, userId, applicationId, interactionToken, env));
      }

      return Response.json({ type: 5, data: { flags: 64 } });
    }

    return new Response('Unknown interaction type', { status: 400 });
  },
};

function hashUrl(url) {
  let h = 5381;
  for (let i = 0; i < url.length; i++) h = ((h << 5) + h + url.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36).slice(0, 8);
}

async function handleDeepDive(value, userId, applicationId, interactionToken, env) {
  try {
    let analysis, components;

    if (value.startsWith('github:')) {
      const repo = value.slice(7);
      const data = await fetchGithubData(repo, env.GITHUB_TOKEN);
      analysis = await analyzeWithGemini('github', data, env.GEMINI_API_KEY);
      components = buildFollowupButtons('github', repo);
    } else if (value.startsWith('blog:')) {
      const url = value.slice(5);
      const urlHash = hashUrl(url);
      await env.CONTEXT_KV.put(`blog:${urlHash}`, url, { expirationTtl: 7200 });
      const content = await fetchBlogContent(url);
      analysis = await analyzeWithGemini('blog', { content, url }, env.GEMINI_API_KEY);
      components = buildFollowupButtons('blog', urlHash);
    } else {
      analysis = '无法识别的项目类型。';
      components = [];
    }

    const dmChannelId = await createDMChannel(userId, env.DISCORD_BOT_TOKEN);
    await sendMessage(dmChannelId, analysis, env.DISCORD_BOT_TOKEN, components);
    await editInteractionResponse(applicationId, interactionToken, '✉️ 已发送私信，请查收！', env.DISCORD_BOT_TOKEN);
  } catch {
    await editInteractionResponse(
      applicationId, interactionToken, '❌ 分析失败，请稍后重试。', env.DISCORD_BOT_TOKEN
    ).catch(() => {});
  }
}

async function handleFollowup(customId, userId, applicationId, interactionToken, env) {
  try {
    // customId format: fu:{type}:{identifier}:{action}
    // Examples: fu:gh:harness/harness:arch  |  fu:blog:abc12345:detail
    const parts = customId.split(':');
    const type = parts[1];
    const action = parts[parts.length - 1];
    const identifier = parts.slice(2, -1).join(':');

    let analysis;

    if (type === 'gh') {
      const data = await fetchGithubData(identifier, env.GITHUB_TOKEN);
      analysis = await analyzeFollowup('github', action, data, env.GEMINI_API_KEY);
    } else if (type === 'blog') {
      const url = await env.CONTEXT_KV.get(`blog:${identifier}`);
      if (!url) {
        analysis = '❌ 会话已过期（2小时），请重新从日报中选择项目。';
      } else {
        const content = await fetchBlogContent(url);
        analysis = await analyzeFollowup('blog', action, { content, url }, env.GEMINI_API_KEY);
      }
    } else {
      analysis = '无法识别的操作类型。';
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

- [ ] **Step 2: Run all tests**

```bash
cd worker && npx vitest run
```

Expected: PASS — all existing + new tests green.

- [ ] **Step 3: Commit**

```bash
git add worker/src/index.js
git commit -m "feat: route button interactions to handleFollowup with KV context"
```

---

## Deployment Checklist

After all tasks pass:

1. Create KV namespace (if not already):
   ```bash
   cd worker && npx wrangler kv:namespace create CONTEXT_KV
   ```
   Copy the `id` output into `wrangler.toml`.

2. Deploy:
   ```bash
   cd worker && npx wrangler deploy
   ```

3. Verify in Discord: select a repo from the daily digest → DM arrives with 4 buttons → click one → follow-up DM arrives.

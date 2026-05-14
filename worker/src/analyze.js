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

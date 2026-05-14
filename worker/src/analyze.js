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

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

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

  it('omits components when empty array passed explicitly', async () => {
    await sendMessage('chan123', 'hello', 'token', []);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.components).toBeUndefined();
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

  it('throws for unknown type', () => {
    expect(() => buildFollowupButtons('unknown', 'x')).toThrow('Unknown button type: unknown');
  });
});

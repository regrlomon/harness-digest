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

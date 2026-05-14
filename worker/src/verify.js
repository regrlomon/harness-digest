import { verifyKey } from 'discord-interactions';

export async function verifyDiscordRequest(body, signature, timestamp, publicKey) {
  try {
    return await verifyKey(body, signature, timestamp, publicKey);
  } catch {
    return false;
  }
}

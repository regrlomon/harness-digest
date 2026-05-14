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

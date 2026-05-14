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
  if (type === 'blog') {
    return [{
      type: 1,
      components: [
        { type: 2, style: 2, label: '🔍 技术细节', custom_id: `fu:blog:${identifier}:detail` },
        { type: 2, style: 2, label: '💼 应用场景', custom_id: `fu:blog:${identifier}:apply` },
      ],
    }];
  }
  throw new Error(`Unknown button type: ${type}`);
}

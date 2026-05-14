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
        const value = interaction.data.values[0];
        ctx.waitUntil(handleDeepDive(value, userId, applicationId, interactionToken, env));
      } else if (interaction.data.component_type === 2) {
        const customId = interaction.data.custom_id;
        ctx.waitUntil(handleFollowup(customId, userId, applicationId, interactionToken, env));
      } else {
        console.warn('Unhandled component_type:', interaction.data.component_type);
      }

      return Response.json({ type: 5, data: { flags: 64 } });
    }

    return new Response('Unknown interaction type', { status: 400 });
  },
};

async function hashUrl(url) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
  return Array.from(new Uint8Array(buf)).slice(0, 6).map(b => b.toString(16).padStart(2, '0')).join('');
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
      const urlHash = await hashUrl(url);
      const [content] = await Promise.all([
        fetchBlogContent(url),
        env.CONTEXT_KV.put(`blog:${urlHash}`, url, { expirationTtl: 7200 }),
      ]);
      analysis = await analyzeWithGemini('blog', { content, url }, env.GEMINI_API_KEY);
      components = buildFollowupButtons('blog', urlHash);
    } else {
      analysis = '无法识别的项目类型。';
      components = [];
    }

    const dmChannelId = await createDMChannel(userId, env.DISCORD_BOT_TOKEN);
    await sendMessage(dmChannelId, analysis, env.DISCORD_BOT_TOKEN, components);
    await editInteractionResponse(applicationId, interactionToken, '✉️ 已发送私信，请查收！', env.DISCORD_BOT_TOKEN);
  } catch (e) {
    console.error('handleDeepDive failed:', e);
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
        if (!content) {
          analysis = '❌ 无法获取文章内容，请稍后重试。';
        } else {
          analysis = await analyzeFollowup('blog', action, { content, url }, env.GEMINI_API_KEY);
        }
      }
    } else {
      analysis = '无法识别的操作类型。';
    }

    const dmChannelId = await createDMChannel(userId, env.DISCORD_BOT_TOKEN);
    await sendMessage(dmChannelId, analysis, env.DISCORD_BOT_TOKEN);
    await editInteractionResponse(applicationId, interactionToken, '✉️ 已发送私信，请查收！', env.DISCORD_BOT_TOKEN);
  } catch (e) {
    console.error('handleFollowup failed:', e);
    await editInteractionResponse(
      applicationId, interactionToken, '❌ 分析失败，请稍后重试。', env.DISCORD_BOT_TOKEN
    ).catch(() => {});
  }
}

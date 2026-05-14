import { verifyDiscordRequest } from './verify.js';
import { fetchGithubData, fetchBlogContent, analyzeWithGemini } from './analyze.js';
import { createDMChannel, sendMessage, editInteractionResponse } from './discord.js';

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
      const value = interaction.data.values[0];
      const userId = interaction.member?.user?.id ?? interaction.user?.id;
      const applicationId = interaction.application_id;
      const interactionToken = interaction.token;

      ctx.waitUntil(handleDeepDive(value, userId, applicationId, interactionToken, env));

      return Response.json({ type: 5, data: { flags: 64 } });
    }

    return new Response('Unknown interaction type', { status: 400 });
  },
};

async function handleDeepDive(value, userId, applicationId, interactionToken, env) {
  try {
    let analysis;

    if (value.startsWith('github:')) {
      const repo = value.slice(7);
      const data = await fetchGithubData(repo, env.GITHUB_TOKEN);
      analysis = await analyzeWithGemini('github', data, env.GEMINI_API_KEY);
    } else if (value.startsWith('blog:')) {
      const url = value.slice(5);
      const content = await fetchBlogContent(url);
      analysis = await analyzeWithGemini('blog', { content, url }, env.GEMINI_API_KEY);
    } else {
      analysis = '无法识别的项目类型。';
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

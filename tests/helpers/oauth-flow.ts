import { createWorkerTestContext } from './worker';

export async function registerClient(ctx: ReturnType<typeof createWorkerTestContext>, redirectUri = 'https://chatgpt.com/connector/oauth/test-callback') {
  const response = await ctx.callWorker('/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      client_name: 'Test Client',
      token_endpoint_auth_method: 'none',
    }),
  });
  const json = await response.json() as Record<string, unknown>;
  return { response, json, redirectUri };
}

export function extractHiddenInput(html: string, name: string): string {
  const pattern = new RegExp(`<input[^>]+name="${name}"[^>]+value="([^"]*)"`, 'i');
  const match = html.match(pattern);
  if (!match) {
    throw new Error(`Hidden input ${name} not found`);
  }
  return match[1] ?? '';
}

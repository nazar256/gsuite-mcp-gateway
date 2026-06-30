export {};

const baseUrl = process.env.BASE_URL ?? 'http://localhost:8787';

interface CheckResult {
  name: string;
  ok: boolean;
  details: string;
}

async function fetchText(path: string): Promise<{ response: Response; text: string }> {
  const response = await fetch(new URL(path, baseUrl));
  const text = await response.text();
  return { response, text };
}

async function fetchJson(path: string): Promise<{ response: Response; json: any }> {
  const response = await fetch(new URL(path, baseUrl));
  const json = await response.json().catch(() => undefined);
  return { response, json };
}

async function main(): Promise<void> {
  const checks: CheckResult[] = [];

  const root = await fetchText('/');
  checks.push({
    name: 'GET /',
    ok: root.response.ok && root.text.includes('self-hosted Cloudflare Worker MCP gateway for Google Calendar, Gmail, and Google Drive'),
    details: `status=${root.response.status}`,
  });

  const health = await fetchJson('/health');
  checks.push({
    name: 'GET /health',
    ok: health.response.ok && health.json?.ok === true,
    details: `status=${health.response.status} ok=${String(health.json?.ok ?? '')}`,
  });

  const resource = await fetchJson('/.well-known/oauth-protected-resource');
  checks.push({
    name: 'Protected resource metadata',
    ok: resource.response.ok
      && resource.json?.resource === `${baseUrl}/mcp`
      && Array.isArray(resource.json?.authorization_servers),
    details: `status=${resource.response.status} resource=${String(resource.json?.resource ?? '')}`,
  });

  const authz = await fetchJson('/.well-known/oauth-authorization-server');
  checks.push({
    name: 'Authorization server metadata',
    ok: authz.response.ok
      && authz.json?.issuer === baseUrl
      && authz.json?.token_endpoint === `${baseUrl}/token`,
    details: `status=${authz.response.status} issuer=${String(authz.json?.issuer ?? '')}`,
  });

  const mcp = await fetch(new URL('/mcp', baseUrl));
  const wwwAuthenticate = mcp.headers.get('www-authenticate') ?? '';
  checks.push({
    name: 'Unauthenticated MCP challenge',
    ok: mcp.status === 401 && wwwAuthenticate.includes('resource_metadata='),
    details: `status=${mcp.status} www-authenticate=${wwwAuthenticate}`,
  });

  const failed = checks.filter((check) => !check.ok);
  for (const check of checks) {
    console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.details}`);
  }

  if (failed.length > 0) {
    process.exitCode = 1;
    return;
  }

  console.log(`\nLocal smoke verification passed against ${baseUrl}`);
  console.log('Next manual steps: complete OAuth in MCP Inspector or ChatGPT, then run Calendar/Gmail live tool tests.');
}

await main();

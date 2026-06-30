export {};

const baseUrl = process.env.BASE_URL;

if (!baseUrl) {
  console.error('BASE_URL is required, e.g. BASE_URL=https://your-worker.workers.dev npm run smoke:remote');
  process.exit(1);
}

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
    name: 'Landing page',
    ok: root.response.ok && root.text.includes('self-hosted Cloudflare Worker MCP gateway for Google Calendar, Gmail, and Google Drive'),
    details: `status=${root.response.status}`,
  });

  const resource = await fetchJson('/.well-known/oauth-protected-resource');
  checks.push({
    name: 'Protected resource metadata',
    ok: resource.response.ok
      && resource.json?.resource === `${baseUrl}/mcp`
      && Array.isArray(resource.json?.authorization_servers)
      && resource.json.authorization_servers.includes(baseUrl),
    details: `status=${resource.response.status} resource=${String(resource.json?.resource ?? '')}`,
  });

  const authz = await fetchJson('/.well-known/oauth-authorization-server');
  checks.push({
    name: 'Authorization server metadata',
    ok: authz.response.ok
      && authz.json?.issuer === baseUrl
      && authz.json?.authorization_endpoint === `${baseUrl}/authorize`
      && authz.json?.token_endpoint === `${baseUrl}/token`
      && authz.json?.registration_endpoint === `${baseUrl}/register`,
    details: `status=${authz.response.status} issuer=${String(authz.json?.issuer ?? '')}`,
  });

  const mcp = await fetch(new URL('/mcp', baseUrl));
  const wwwAuthenticate = mcp.headers.get('www-authenticate') ?? '';
  checks.push({
    name: 'Unauthenticated MCP challenge',
    ok: mcp.status === 401 && wwwAuthenticate.includes(`${baseUrl}/.well-known/oauth-protected-resource`),
    details: `status=${mcp.status} www-authenticate=${wwwAuthenticate}`,
  });

  const registerResponse = await fetch(new URL('/register', baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: ['https://chatgpt.com/connector/oauth/test-callback'],
      client_name: 'Smoke Test Client',
      token_endpoint_auth_method: 'none',
    }),
  });
  const registerJson = await registerResponse.json().catch(() => undefined) as Record<string, unknown> | undefined;
  checks.push({
    name: 'Dynamic client registration',
    ok: registerResponse.status === 201
      && typeof registerJson?.client_id === 'string'
      && Array.isArray(registerJson?.redirect_uris),
    details: `status=${registerResponse.status} client_id=${String(registerJson?.client_id ?? '')}`,
  });

  const failed = checks.filter((check) => !check.ok);
  for (const check of checks) {
    console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.details}`);
  }

  if (failed.length > 0) {
    process.exitCode = 1;
    return;
  }

  console.log(`\nRemote smoke verification passed against ${baseUrl}`);
  console.log('Next manual steps: complete OAuth in MCP Inspector or ChatGPT, then run authenticated Calendar/Gmail tool tests.');
}

await main();

import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config';
import { createTestEnv } from './helpers/env';

describe('config validation', () => {
  it('allows localhost http urls in development', () => {
    const config = parseConfig(createTestEnv());
    expect(config.issuer).toBe('http://localhost:8787');
    expect(config.mcpResource).toBe('http://localhost:8787/mcp');
  });

  it('rejects localhost http urls in production', () => {
    expect(() => parseConfig(createTestEnv({
      APP_ENV: 'production',
    }))).toThrow('must use HTTPS');
  });

  it('rejects mismatched resource and audience', () => {
    expect(() => parseConfig(createTestEnv({
      MCP_AUDIENCE: 'http://localhost:8787/not-mcp',
    }))).toThrow('MCP_RESOURCE and MCP_AUDIENCE must match');
  });
});

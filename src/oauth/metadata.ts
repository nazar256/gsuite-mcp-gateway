import type { AppConfig } from '../config';

export function getProtectedResourceMetadata(config: AppConfig): Record<string, unknown> {
  return {
    resource: config.mcpResource,
    authorization_servers: [config.issuer],
    scopes_supported: [...config.supportedScopes],
    bearer_methods_supported: ['header'],
    resource_name: 'Google Workspace MCP Gateway',
  };
}

export function getAuthorizationServerMetadata(config: AppConfig): Record<string, unknown> {
  return {
    issuer: config.issuer,
    authorization_endpoint: `${config.issuer}/authorize`,
    token_endpoint: `${config.issuer}/token`,
    registration_endpoint: `${config.issuer}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: [...config.supportedScopes],
    resource_parameter_supported: true,
  };
}

export function buildWwwAuthenticate(
  config: AppConfig,
  scope: string = config.supportedScopes.join(' '),
  error = 'invalid_token',
  description = 'A valid bearer token is required',
): string {
  return `Bearer resource_metadata="${config.issuer}/.well-known/oauth-protected-resource", error="${error}", error_description="${description}", scope="${scope}"`;
}

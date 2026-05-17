import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppConfig } from '../config';
import { createGoogleCalendarClient } from '../google/calendar';
import { createGoogleDriveClient } from '../google/drive';
import { createGoogleGmailClient } from '../google/gmail';
import { registerCalendarTools } from './tools/calendar';
import { registerDriveTools } from './tools/drive';
import { registerGmailTools } from './tools/gmail';

export function createGatewayMcpServer(config: AppConfig, params: {
  googleAccessToken: string;
  grantedScope: string;
}): McpServer {
  const server = new McpServer(
    {
      name: 'gsuite-mcp-gateway',
      version: '0.1.0',
    },
    {
      capabilities: { tools: {} },
    },
  );

  const calendarClient = createGoogleCalendarClient(params.googleAccessToken, config.fetchImpl);
  const driveClient = createGoogleDriveClient(params.googleAccessToken, config.fetchImpl);
  const gmailClient = createGoogleGmailClient(params.googleAccessToken, config.fetchImpl);

  registerCalendarTools(server, config, calendarClient, params.grantedScope);
  registerDriveTools(server, config, driveClient, params.grantedScope);
  registerGmailTools(server, config, gmailClient, params.grantedScope);

  return server;
}

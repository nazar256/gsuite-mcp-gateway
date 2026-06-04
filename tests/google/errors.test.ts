import { describe, expect, it } from 'vitest';
import { expectGoogleJson } from '../../src/google/errors';

describe('google error mapping', () => {
  it('does not misclassify generic 403 responses as insufficient_scope', async () => {
    const response = new Response(JSON.stringify({
      error: {
        code: 403,
        message: 'The user does not have sufficient permissions for this file',
        status: 'PERMISSION_DENIED',
        errors: [{ reason: 'forbidden' }],
      },
    }), {
      status: 403,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });

    await expect(expectGoogleJson(response)).rejects.toMatchObject({
      status: 403,
      code: 'google_api_error',
      message: 'Google API request failed',
    });
  });

  it('still maps explicit scope failures to insufficient_scope', async () => {
    const response = new Response(JSON.stringify({
      error: {
        code: 403,
        message: 'Request had insufficient authentication scopes.',
        status: 'PERMISSION_DENIED',
        errors: [{ reason: 'insufficientPermissions' }],
      },
    }), {
      status: 403,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });

    await expect(expectGoogleJson(response)).rejects.toMatchObject({
      status: 403,
      code: 'insufficient_scope',
      message: 'Google rejected this request because the granted permissions are insufficient',
    });
  });
});

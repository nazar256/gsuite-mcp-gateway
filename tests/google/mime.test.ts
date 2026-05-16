import { describe, expect, it } from 'vitest';
import { buildMimeMessage, encodeMimeMessage } from '../../src/google/mime';

describe('gmail mime helpers', () => {
  it('builds a plain text message', () => {
    const mime = buildMimeMessage({
      to: ['me@example.com'],
      subject: 'Hello',
      textBody: 'World',
    });
    expect(mime).toContain('To: me@example.com');
    expect(mime).toContain('Subject: Hello');
  });

  it('encodes base64url', () => {
    const encoded = encodeMimeMessage('hello');
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
  });

  it('rejects CRLF in subject headers', () => {
    expect(() => buildMimeMessage({
      to: ['me@example.com'],
      subject: 'Hello\r\nBcc:evil@example.com',
      textBody: 'World',
    })).toThrow(/CR or LF/);
  });
});

import type { ContactChallengeResponse, InstanceResponse } from '@subify/shared';
import { solveChallenge } from '@subify/shared/proof';
import { describe, expect, it } from 'vitest';
import { createHarness } from '#harness';
import type { Mail } from '../../src/platform';
import type { Harness } from '../harness/types';

const ON = { messagesTo: 'operator@example.org', messagesFrom: 'contact@example.org', operatorName: 'Alex', operatorContact: 'operator@example.org' };

async function formHarness(config: Record<string, unknown> = {}, fail = false) {
  const sent: Mail[] = [];
  const harness = await createHarness({
    config: { ...ON, ...config },
    mailer: async (mail) => {
      if (fail) {
        throw new Error('SMTP down');
      }

      sent.push(mail);
    },
  });

  return { harness, sent };
}

/** A robot check solved the way the app solves it. */
async function proof(harness: Harness): Promise<string> {
  const challenge = (await (await harness.request('/api/contact')).json()) as ContactChallengeResponse;

  return (await solveChallenge(challenge))!;
}

const message = { name: 'Sam', email: 'sam@example.net', text: 'Hello, a question about the server.' };

describe('the contact form', () => {
  // A self-hoster who sets nothing must not get mail, nor have the app offer a form that fails.
  it('is off without an address and a way to send', async () => {
    const harness = await createHarness({ config: { messagesTo: 'operator@example.org' } });
    const instance = (await (await harness.request('/api/instance')).json()) as InstanceResponse;

    expect((await harness.request('/api/contact')).status).toBe(404);
    expect((await harness.post('/api/contact', { ...message, proof: 'x' })).status).toBe(404);
    expect(instance.messages).toBe(false);
  });

  // The operator's address must never reach the app once the form can reach them instead.
  it('hides the operator’s address while the form is on', async () => {
    const { harness } = await formHarness();
    const instance = (await (await harness.request('/api/instance')).json()) as InstanceResponse;

    expect(instance).toEqual({ v: 3, name: 'Subify test', operator: { name: 'Alex', contact: null }, messages: true });
    expect(JSON.stringify(instance)).not.toContain('operator@example.org');
  });

  // What reaches the operator is plain text that can't hide words, fake a link's direction, or be clicked.
  it('sends one plain-text message, cleaned, that answers go back to the sender', async () => {
    const { harness, sent } = await formHarness();
    const text = 'Look at https://evil.example/login and www.bad.example\u200B now.\r\n\r\n\r\n\r\nFile: \u202Egnp.exe\u0007 end\tok';

    const response = await harness.post('/api/contact', { name: 'Sam\u200D\nEvil.com', email: 'sam@example.net', text, proof: await proof(harness) });

    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'operator@example.org', from: 'contact@example.org', replyTo: 'sam@example.net' });
    expect(sent[0]!.text).toBe(
      [
        'Sam Evil[.]com <sam@example[.]net> wrote, through the contact form of Subify test:',
        '',
        'Look at hxxps://evil[.]example/login and www[.]bad[.]example now.',
        '',
        'File: gnp[.]exe end ok',
        '',
        '—',
        'Links in this message are disabled (hxxps://, [.]). Replying answers the address they gave, which nobody checked.',
      ].join('\n'),
    );
  });

  // A robot that solved one check must not send with it again, nor use one that expired or that it made itself.
  it('takes each robot check once, before it expires, and only the server’s own', async () => {
    const { harness, sent } = await formHarness();
    const solved = await proof(harness);
    const forged = JSON.parse(atob(await proof(harness))) as { signature: string };
    const late = await proof(harness);

    expect((await harness.post('/api/contact', { ...message, proof: solved })).status).toBe(200);
    expect((await harness.post('/api/contact', { ...message, proof: solved })).status).toBe(400);
    expect((await harness.post('/api/contact', { ...message, proof: btoa(JSON.stringify({ ...forged, signature: '0'.repeat(64) })) })).status).toBe(400);
    harness.setNow(harness.platform.clock.now() + 31 * 60_000);
    expect((await harness.post('/api/contact', { ...message, proof: late })).status).toBe(400);
    expect(sent).toHaveLength(1);
  });

  // The hidden field catches robots without telling them: they get the same answer as people.
  it('answers sent but sends nothing when the hidden field is filled in', async () => {
    const { harness, sent } = await formHarness();

    const response = await harness.post('/api/contact', { ...message, website: 'https://spam.example', proof: 'not even solved' });

    expect(response.status).toBe(200);
    expect(sent).toHaveLength(0);
  });

  // A flood must stop at the hour's ceiling, for everyone, and say when to try again.
  it('refuses past the messages allowed per hour', async () => {
    const { harness, sent } = await formHarness({ messagesPerHour: 2 });

    for (let index = 0; index < 2; index += 1) {
      expect((await harness.post('/api/contact', { ...message, proof: await proof(harness) })).status).toBe(200);
    }

    const refused = await harness.post('/api/contact', { ...message, proof: await proof(harness) });

    expect(refused.status).toBe(503);
    expect(Number(refused.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(sent).toHaveLength(2);
  });

  // A mail server that fails must not pass for a message sent.
  it('says so when the message can’t be sent', async () => {
    const { harness } = await formHarness({}, true);

    expect((await harness.post('/api/contact', { ...message, proof: await proof(harness) })).status).toBe(502);
  });
});

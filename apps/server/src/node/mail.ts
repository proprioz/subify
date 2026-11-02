import { createTransport } from 'nodemailer';
import type { Mailer } from '../platform';

/**
 * Sends the contact form's messages through the SMTP server SMTP_URL names, for example
 * `smtps://user:password@mail.example.org:465`: the admin's own mail account. Plain text only.
 */
export function smtpMailer(url: string): Mailer {
  const transport = createTransport(url);

  return async ({ to, from, replyTo, subject, text }) => {
    await transport.sendMail({ to, from, replyTo, subject, text, disableUrlAccess: true, disableFileAccess: true });
  };
}

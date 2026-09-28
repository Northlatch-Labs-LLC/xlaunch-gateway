// Outbound mail for account surfaces. The gateway owns the account, so the
// gateway owns the mail that carries account actions to the person — today the
// hosted-harness access link, tomorrow anything else an account holder needs
// without a terminal.
//
// Mail is configured entirely through the environment and is OPTIONAL: with no
// SMTP_HOST the gateway behaves exactly as before (nothing sends, surfaces
// answer `sent: false`, and the account page remains the way in). That keeps a
// deployment honest — a half-configured mailer that silently swallows welcome
// mail looks the same as no mailer at all, so the sender says which it was.

import nodemailer from 'nodemailer';

export interface MailConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string | undefined;
  pass: string | undefined;
  from: string;
}

/**
 * Read the SMTP configuration from the environment.
 * @returns the configuration, or null when no SMTP host is set.
 */
export function mailConfig(): MailConfig | null {
  const host = process.env.SMTP_HOST;
  if (!host) return null;
  const port = Number(process.env.SMTP_PORT ?? '587');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SMTP_PORT is set but is not a valid port');
  }
  const from = process.env.SMTP_FROM;
  if (!from) throw new Error('SMTP_HOST is set but SMTP_FROM is missing');
  return {
    host,
    port,
    secure: process.env.SMTP_SECURE === '1' || port === 465,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from,
  };
}

/** The outcome of one send attempt. A refusal is an answer, not an error. */
export type MailResult =
  | { sent: true }
  | { sent: false; reason: 'unconfigured' | 'failed' };

/**
 * Send the hosted-harness access mail: one line of welcome, one button, and
 * the plain link as the fallback every mail client can open.
 * @param to - the account's address.
 * @param accessUrl - the absolute harness access URL with its token.
 * @returns whether the mail went out, and why not when it did not.
 */
export async function sendHarnessAccessMail(to: string, accessUrl: string): Promise<MailResult> {
  const config = mailConfig();
  if (config === null) return { sent: false, reason: 'unconfigured' };
  try {
    const transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: config.user === undefined ? undefined : { user: config.user, pass: config.pass },
    });
    await transport.sendMail({
      from: config.from,
      to,
      subject: 'Your Xlaunch harness is ready',
      text: [
        'Welcome to Xlaunch.',
        '',
        'Your hosted harness is ready — it opens in your browser and needs nothing installed:',
        accessUrl,
        '',
        'The link works for 24 hours. After that, open harness access again from your',
        'account at https://xlaunch.work — it is one click, under "Your harness".',
        '',
        '— Xlaunch',
      ].join('\n'),
      html: [
        '<p>Welcome to <strong>Xlaunch</strong>.</p>',
        '<p>Your hosted harness is ready — it opens in your browser and needs nothing installed.</p>',
        `<p><a href="${accessUrl}" style="display:inline-block;padding:10px 18px;border-radius:6px;background:#0a0f0c;color:#45c580;text-decoration:none;font-weight:600">Open your harness</a></p>`,
        `<p style="font-size:12px;color:#666">Or paste this link: ${accessUrl}<br>The link works for 24 hours; after that, reopen harness access from your account at https://xlaunch.work.</p>`,
      ].join('\n'),
    });
    return { sent: true };
  } catch (error) {
    // A mail failure must not fail the surface that triggered it: the account
    // page remains the way in either way. The reason goes to the logs only.
    console.log(JSON.stringify({
      at: new Date().toISOString(),
      event: 'mail_send_failed',
      to: to.replace(/^(..).*(@.*)$/, '$1***$2'),
      error: error instanceof Error ? error.message : String(error),
    }));
    return { sent: false, reason: 'failed' };
  }
}

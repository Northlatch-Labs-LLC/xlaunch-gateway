// Outbound mail for account surfaces. The gateway owns the account, so the
// gateway owns the mail that carries account actions to the person — today the
// hosted-harness access link, tomorrow anything else an account holder needs
// without a terminal.
//
// Two transports, chosen by the environment: a Resend API key (the provider's
// own HTTP API, the first-class path) or a generic SMTP host. Mail is
// configured entirely through the environment and is OPTIONAL: with neither
// configured the gateway behaves exactly as before (nothing sends, surfaces
// answer `sent: false`, and the account page remains the way in). That keeps a
// deployment honest — a half-configured mailer that silently swallows welcome
// mail looks the same as no mailer at all, so the sender says which it was.

import nodemailer from 'nodemailer';

export type MailConfig =
  | { driver: 'resend'; apiKey: string; from: string }
  | {
      driver: 'smtp';
      host: string;
      port: number;
      secure: boolean;
      user: string | undefined;
      pass: string | undefined;
      from: string;
    };

/** The shared sender identity every transport requires. */
function senderFromEnvironment(): string {
  const from = process.env.SMTP_FROM;
  if (!from) {
    throw new Error('a mail transport is configured but SMTP_FROM is missing');
  }
  return from;
}

/**
 * Read the mail configuration from the environment. A Resend API key wins
 * when both transports are configured, because it is the provider's own path.
 * @returns the configuration, or null when nothing is configured.
 */
export function mailConfig(): MailConfig | null {
  const apiKey = process.env.RESEND_API_KEY;
  if (apiKey) return { driver: 'resend', apiKey, from: senderFromEnvironment() };
  const host = process.env.SMTP_HOST;
  if (!host) return null;
  const port = Number(process.env.SMTP_PORT ?? '587');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SMTP_PORT is set but is not a valid port');
  }
  return {
    driver: 'smtp',
    host,
    port,
    secure: process.env.SMTP_SECURE === '1' || port === 465,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: senderFromEnvironment(),
  };
}

/** The welcome mail's content, shared by both transports. The button is the
 *  bulletproof table pattern: mail clients that strip styled inline anchors
 *  still render the link, and nothing in the markup depends on the client
 *  keeping an element's CSS to keep its href. */
function welcomeMail(accessUrl: string): { subject: string; text: string; html: string } {
  return {
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
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0"><tr><td bgcolor="#0a0f0c" style="border-radius:6px"><a href="${accessUrl}" target="_blank" style="display:inline-block;padding:10px 18px;font-family:-apple-system,'Segoe UI',sans-serif;font-size:14px;font-weight:600;color:#45c580;text-decoration:none;border-radius:6px">Open your harness</a></td></tr></table>`,
      `<p style="font-size:12px;color:#666">Or paste this link: ${accessUrl}<br>The link works for 24 hours; after that, reopen harness access from your account at https://xlaunch.work.</p>`,
    ].join('\n'),
  };
}

/**
 * Send through Resend's HTTP API.
 * @param config - the resend transport configuration.
 * @param to - the account's address.
 * @param accessUrl - the absolute harness access URL with its token.
 */
async function sendWithResend(config: Extract<MailConfig, { driver: 'resend' }>, to: string, accessUrl: string): Promise<void> {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ from: config.from, to, ...welcomeMail(accessUrl) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`resend answered ${String(response.status)}: ${body.slice(0, 200)}`);
  }
}

/**
 * Send through a generic SMTP host.
 * @param config - the SMTP transport configuration.
 * @param to - the account's address.
 * @param accessUrl - the absolute harness access URL with its token.
 */
async function sendWithSmtp(config: Extract<MailConfig, { driver: 'smtp' }>, to: string, accessUrl: string): Promise<void> {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user === undefined ? undefined : { user: config.user, pass: config.pass },
  });
  await transport.sendMail({ from: config.from, to, ...welcomeMail(accessUrl) });
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
    if (config.driver === 'resend') await sendWithResend(config, to, accessUrl);
    else await sendWithSmtp(config, to, accessUrl);
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

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

/** Any mail this service sends; the transports take it as-is. */
export interface MailContent {
  subject: string;
  text: string;
  html: string;
}

/** The bulletproof table button: mail clients that strip styled inline anchors
 *  still render the link, and nothing in the markup depends on the client
 *  keeping an element's CSS to keep its href. */
function button(url: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0"><tr><td bgcolor="#0a0f0c" style="border-radius:6px"><a href="${url}" target="_blank" style="display:inline-block;padding:10px 18px;font-family:-apple-system,'Segoe UI',sans-serif;font-size:14px;font-weight:600;color:#45c580;text-decoration:none;border-radius:6px">${label}</a></td></tr></table>`;
}

/** A plain fallback line under a button, for clients that render neither. */
function pasteLine(url: string, note: string): string {
  return `<p style="font-size:12px;color:#666">Or paste this link: ${url}<br>${note}</p>`;
}

/** The harness access mail's content, shared by both transports. */
function harnessMail(accessUrl: string): MailContent {
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
      button(accessUrl, 'Open your harness'),
      pasteLine(accessUrl, 'The link works for 24 hours; after that, reopen harness access from your account at https://xlaunch.work.'),
    ].join('\n'),
  };
}

/** The sign-up mail. The verification link is the action it asks for — wallets
 *  and API keys wait on a verified address — and the harness link rides along
 *  so the welcome that used to carry it loses nothing. */
function signupMail(verifyUrl: string, accessUrl: string | null): MailContent {
  const text = [
    'Welcome to Xlaunch.',
    '',
    'Verify your email address to unlock API keys and wallets:',
    verifyUrl,
    '',
    'The link works for 24 hours. You can ask for a new one from your account.',
    '',
    '— Xlaunch',
  ];
  const html = [
    '<p>Welcome to <strong>Xlaunch</strong>.</p>',
    '<p>Verify your email address to unlock API keys and wallets.</p>',
    button(verifyUrl, 'Verify your email'),
    pasteLine(verifyUrl, 'The link works for 24 hours; you can ask for a new one from your account.'),
  ];
  if (accessUrl !== null) {
    text.push('', 'Your hosted harness is ready — it opens in your browser and needs nothing installed:', accessUrl);
    html.push('<p>Your hosted harness is also ready — it opens in your browser and needs nothing installed.</p>',
      button(accessUrl, 'Open your harness'),
      pasteLine(accessUrl, 'This link works for 24 hours; after that, reopen harness access from your account.'));
  }
  return { subject: 'Verify your email — welcome to Xlaunch', text: text.join('\n'), html: html.join('\n') };
}

/** The resend mail for an account still waiting on a verified address. */
function verificationMail(verifyUrl: string): MailContent {
  return {
    subject: 'Verify your email',
    text: [
      'Verify your email address to unlock API keys and wallets:',
      verifyUrl,
      '',
      'The link works for 24 hours. You can ask for a new one from your account.',
      '',
      '— Xlaunch',
    ].join('\n'),
    html: [
      '<p>Verify your email address to unlock API keys and wallets.</p>',
      button(verifyUrl, 'Verify your email'),
      pasteLine(verifyUrl, 'The link works for 24 hours; you can ask for a new one from your account.'),
    ].join('\n'),
  };
}

/** The password-reset mail. One button, one fallback line, nothing else: a
 *  person reading it wants to know the link is real and where it goes. */
function resetMail(resetUrl: string): MailContent {
  return {
    subject: 'Reset your Xlaunch password',
    text: [
      'Someone asked to reset the password on this Xlaunch account.',
      'If that was you, open the link below within 60 minutes:',
      resetUrl,
      '',
      'If it was not you, ignore this mail — the link expires on its own and',
      'the password stays as it is.',
      '',
      '— Xlaunch',
    ].join('\n'),
    html: [
      '<p>Someone asked to reset the password on this <strong>Xlaunch</strong> account.</p>',
      '<p>If that was you, open the link below within 60 minutes.</p>',
      button(resetUrl, 'Reset your password'),
      pasteLine(resetUrl, 'If this was not you, ignore this mail — the link expires on its own and the password stays as it is.'),
    ].join('\n'),
  };
}

/**
 * Send through Resend's HTTP API.
 * @param config - the resend transport configuration.
 * @param to - the account's address.
 * @param accessUrl - the absolute harness access URL with its token.
 */
async function sendWithResend(config: Extract<MailConfig, { driver: 'resend' }>, to: string, content: MailContent): Promise<void> {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ from: config.from, to, ...content }),
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
 * @param content - the mail to send.
 */
async function sendWithSmtp(config: Extract<MailConfig, { driver: 'smtp' }>, to: string, content: MailContent): Promise<void> {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user === undefined ? undefined : { user: config.user, pass: config.pass },
  });
  await transport.sendMail({ from: config.from, to, ...content });
}

/** The outcome of one send attempt. A refusal is an answer, not an error. */
export type MailResult =
  | { sent: true }
  | { sent: false; reason: 'unconfigured' | 'failed' };

/**
 * Deliver one mail through whichever transport is configured. A mail failure
 * must not fail the surface that triggered it — the account page remains the
 * way in either way. The reason goes to the logs only.
 * @param to - the account's address.
 * @param content - the mail to send.
 * @returns whether the mail went out, and why not when it did not.
 */
async function deliver(to: string, content: MailContent): Promise<MailResult> {
  const config = mailConfig();
  if (config === null) return { sent: false, reason: 'unconfigured' };
  try {
    if (config.driver === 'resend') await sendWithResend(config, to, content);
    else await sendWithSmtp(config, to, content);
    return { sent: true };
  } catch (error) {
    console.log(JSON.stringify({
      at: new Date().toISOString(),
      event: 'mail_send_failed',
      to: to.replace(/^(..).*(@.*)$/, '$1***$2'),
      error: error instanceof Error ? error.message : String(error),
    }));
    return { sent: false, reason: 'failed' };
  }
}

/** The hosted-harness access mail. */
export function sendHarnessAccessMail(to: string, accessUrl: string): Promise<MailResult> {
  return deliver(to, harnessMail(accessUrl));
}

/** The sign-up mail: verify the address, with the harness link along for the ride. */
export function sendSignupMail(to: string, verifyUrl: string, accessUrl: string | null): Promise<MailResult> {
  return deliver(to, signupMail(verifyUrl, accessUrl));
}

/** A re-sent verification link. */
export function sendVerificationMail(to: string, verifyUrl: string): Promise<MailResult> {
  return deliver(to, verificationMail(verifyUrl));
}

/** A password-reset link. */
export function sendPasswordResetMail(to: string, resetUrl: string): Promise<MailResult> {
  return deliver(to, resetMail(resetUrl));
}

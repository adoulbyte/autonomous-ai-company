import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

export interface OutgoingMail {
  from: string; to: string; subject: string; text: string; html?: string;
  inReplyTo?: string | null; references?: string[];
  attachments?: { filename: string; content: string | Buffer; contentType?: string; cid?: string }[];
  /** List-Unsubscribe header (mailto), required by Gmail/Yahoo for bulk senders and a strong deliverability signal. */
  listUnsubscribe?: string;
}
export interface IncomingMail {
  uid: number; messageId: string | null; inReplyTo: string | null; references: string[];
  from: string | null; fromName: string | null; to: string | null; subject: string; text: string; date: Date | null;
}
export interface MailTransport {
  address: string;
  send(m: OutgoingMail): Promise<{ messageId: string }>;
  fetchSince(lastUid: number, max: number): Promise<IncomingMail[]>;
}

/** Gmail (or any SMTP/IMAP) mailbox using an app password stored as a GitHub secret. */
export function gmailTransport(env: NodeJS.ProcessEnv = process.env): MailTransport | null {
  const user = env.GMAIL_ADDRESS?.trim(); const pass = env.GMAIL_APP_PASSWORD?.replace(/\s+/g, '');
  if (!user || !pass) return null;
  const smtp = nodemailer.createTransport({ host: env.MAIL_SMTP_HOST ?? 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass } });
  return {
    address: user,
    async send(m) {
      const info = await smtp.sendMail({
        from: m.from, to: m.to, subject: m.subject, text: m.text, html: m.html,
        inReplyTo: m.inReplyTo ?? undefined, references: m.references?.length ? m.references : undefined,
        attachments: m.attachments,
        list: m.listUnsubscribe ? { unsubscribe: m.listUnsubscribe } : undefined,
      });
      return { messageId: info.messageId };
    },
    async fetchSince(lastUid, max) {
      const client = new ImapFlow({ host: env.MAIL_IMAP_HOST ?? 'imap.gmail.com', port: 993, secure: true, auth: { user, pass }, logger: false });
      await client.connect();
      const out: IncomingMail[] = [];
      try {
        const lock = await client.getMailboxLock('INBOX');
        try {
          for await (const msg of client.fetch(`${lastUid + 1}:*`, { uid: true, source: true }, { uid: true })) {
            if (msg.uid <= lastUid || !msg.source) continue;
            const p = await simpleParser(msg.source);
            const from = p.from?.value?.[0];
            const refs = Array.isArray(p.references) ? p.references : p.references ? [p.references] : [];
            out.push({ uid: msg.uid, messageId: p.messageId ?? null, inReplyTo: p.inReplyTo ?? null, references: refs,
              from: from?.address?.toLowerCase() ?? null, fromName: from?.name ?? null, to: Array.isArray(p.to) ? null : p.to?.text ?? null,
              subject: p.subject ?? '(no subject)', text: (p.text ?? '').slice(0, 20000), date: p.date ?? null });
            if (out.length >= max) break;
          }
        } finally { lock.release(); }
      } finally { await client.logout().catch(() => {}); }
      return out;
    },
  };
}

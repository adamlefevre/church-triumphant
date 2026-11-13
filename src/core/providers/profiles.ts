import type { ProviderKind } from '../../shared/types'

export interface ServerConfig {
  host: string
  port: number
  /** true = TLS from the start; false = STARTTLS. */
  secure: boolean
}

export interface Profile {
  imap: ServerConfig
  smtp: ServerConfig
  auth: 'password' | 'oauth'
  /** The server files sent mail itself; otherwise we append a copy to Sent. */
  serverSavesSent: boolean
  /** Use Gmail extensions (X-GM-THRID) and treat All Mail as the archive. */
  gmail: boolean
  /** Accept a self-signed certificate. Only ever true for a server on this computer. */
  allowSelfSigned: boolean
}

export interface ProfileOverrides {
  imapHost?: string
  imapPort?: number
  smtpHost?: string
  smtpPort?: number
}

export function profileFor(kind: ProviderKind, o: ProfileOverrides = {}): Profile {
  switch (kind) {
    case 'gmail':
      return {
        imap: { host: 'imap.gmail.com', port: 993, secure: true },
        smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
        auth: 'oauth',
        serverSavesSent: true,
        gmail: true,
        allowSelfSigned: false,
      }
    case 'outlook':
      return {
        imap: { host: 'outlook.office365.com', port: 993, secure: true },
        smtp: { host: 'smtp.office365.com', port: 587, secure: false },
        auth: 'oauth',
        serverSavesSent: true,
        gmail: false,
        allowSelfSigned: false,
      }
    case 'icloud':
      return {
        imap: { host: 'imap.mail.me.com', port: 993, secure: true },
        smtp: { host: 'smtp.mail.me.com', port: 587, secure: false },
        auth: 'password',
        serverSavesSent: true,
        gmail: false,
        allowSelfSigned: false,
      }
    case 'proton': {
      // Proton Mail Bridge runs on this computer and uses STARTTLS with its own certificate.
      const imapHost = o.imapHost ?? '127.0.0.1'
      const smtpHost = o.smtpHost ?? '127.0.0.1'
      return {
        imap: { host: imapHost, port: o.imapPort ?? 1143, secure: false },
        smtp: { host: smtpHost, port: o.smtpPort ?? 1025, secure: false },
        auth: 'password',
        serverSavesSent: true,
        gmail: false,
        allowSelfSigned: isLocalHost(imapHost) && isLocalHost(smtpHost),
      }
    }
    case 'imap':
      if (!o.imapHost || !o.smtpHost) throw new Error('Enter the IMAP and SMTP servers')
      return {
        imap: { host: o.imapHost, port: o.imapPort ?? 993, secure: (o.imapPort ?? 993) === 993 },
        smtp: { host: o.smtpHost, port: o.smtpPort ?? 465, secure: (o.smtpPort ?? 465) === 465 },
        auth: 'password',
        serverSavesSent: false,
        gmail: false,
        allowSelfSigned: false,
      }
    case 'demo':
      throw new Error('Demo accounts have no server')
  }
}

export function isLocalHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

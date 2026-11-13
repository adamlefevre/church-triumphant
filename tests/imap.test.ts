import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// @ts-expect-error no types
import hoodiecrow from 'hoodiecrow-imap'
import { ImapProvider, messageIds, parseHeaders, roleOf } from '../src/core/providers/imap'
import type { Profile } from '../src/core/providers/profiles'

const PORT = 41430
const raw = (id: string, subject: string, extra = '') =>
  `From: Ann Lee <ann@example.test>\r\nTo: me@example.test\r\nSubject: ${subject}\r\nMessage-ID: ${id}\r\nDate: Thu, 12 Nov 2026 10:00:00 +0000\r\n${extra}Content-Type: text/plain\r\n\r\nHello ${subject}\r\n`

let server: any
beforeAll(async () => {
  server = hoodiecrow({
    plugins: ['ID', 'UIDPLUS', 'SPECIAL-USE', 'MOVE', 'IDLE', 'ENABLE', 'CONDSTORE', 'LITERALPLUS'],
    storage: {
      INBOX: {
        messages: [
          { raw: raw('<a@x>', 'First'), flags: [], internaldate: '12-Nov-2026 10:00:00 +0000' },
          { raw: raw('<b@x>', 'Second', 'In-Reply-To: <a@x>\r\nReferences: <a@x>\r\nList-Id: <news.example>\r\n'), flags: ['\\Seen'], internaldate: '12-Nov-2026 11:00:00 +0000' },
        ],
      },
      '': {
        separator: '/',
        folders: {
          Archive: { 'special-use': '\\Archive', messages: [] },
          Sent: { 'special-use': '\\Sent', messages: [] },
          Trash: { 'special-use': '\\Trash', messages: [] },
        },
      },
    },
  })
  await new Promise<void>((r) => server.listen(PORT, r))
})
afterAll(() => server?.close())

const profile: Profile = {
  imap: { host: '127.0.0.1', port: PORT, secure: false },
  smtp: { host: '127.0.0.1', port: 1, secure: false },
  auth: 'password',
  serverSavesSent: true,
  gmail: false,
  allowSelfSigned: true,
}

describe('ImapProvider against a real IMAP server', () => {
  it('lists folders, fetches, flags and moves messages', async () => {
    const p = new ImapProvider(profile, { user: 'testuser', password: 'testpass' })
    try {
      const folders = await p.listFolders()
      expect(Object.fromEntries(folders.map((f) => [f.path, f.role]))).toMatchObject({ INBOX: 'inbox', Archive: 'archive', Sent: 'sent', Trash: 'trash' })

      const snap = await p.fetchFolder('INBOX', { uidvalidity: null, uidnext: null }, { since: Date.UTC(2026, 0, 1), withBodies: true })
      expect(snap.reset).toBe(true)
      expect(snap.added.map((m) => m.subject)).toEqual(['First', 'Second'])
      const second = snap.added[1]
      expect(second).toMatchObject({ messageId: '<b@x>', inReplyTo: '<a@x>', references: ['<a@x>'], seen: true, isList: true })
      expect(second.body?.text.trim()).toBe('Hello Second')

      const again = await p.fetchFolder('INBOX', { uidvalidity: snap.uidvalidity, uidnext: snap.uidnext }, { since: Date.UTC(2026, 0, 1), withBodies: false })
      expect(again.added).toHaveLength(0)
      expect(again.present).toHaveLength(2)

      await p.setFlags('INBOX', [snap.added[0].uid], { seen: true, flagged: true })
      await p.move('INBOX', [snap.added[0].uid], 'Archive')
      const archive = await p.fetchFolder('Archive', { uidvalidity: null, uidnext: null }, { since: 0, withBodies: false })
      expect(archive.added.map((m) => [m.subject, m.seen, m.flagged])).toEqual([['First', true, true]])
      const body = await p.fetchBody('Archive', archive.added[0].uid)
      expect(body.text.trim()).toBe('Hello First')
    } finally {
      await p.close()
    }
  })

  it('rejects a wrong password', async () => {
    const p = new ImapProvider(profile, { user: 'testuser', password: 'nope' })
    await expect(p.listFolders()).rejects.toThrow()
    await p.close()
  })
})

describe('header helpers', () => {
  it('parses folded headers and message ids', () => {
    const h = parseHeaders(Buffer.from('References: <a@x>\r\n <b@x>\r\nList-Id: x\r\n'))
    expect(messageIds(h.get('references'))).toEqual(['<a@x>', '<b@x>'])
    expect(h.has('list-id')).toBe(true)
  })

  it('maps folders to roles, including Gmail All Mail', () => {
    expect(roleOf('[Gmail]/All Mail', '\\All', true)).toBe('archive')
    expect(roleOf('All Mail', '\\All', false)).toBe('other')
    expect(roleOf('Deleted Items', undefined, false)).toBe('trash')
    expect(roleOf('Sent Messages', undefined, false)).toBe('sent')
  })
})

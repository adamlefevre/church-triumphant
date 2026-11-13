import { describe, expect, it } from 'vitest'
import { ann, bob, DAY, harness, inboxView, MIN, T0 } from './helpers'

describe('sync and threading', () => {
  it('syncs new mail and groups replies into one thread, even out of order', async () => {
    const h = await harness()
    const first = h.box.deliver('INBOX', { from: ann, subject: 'Budget', text: 'Draft attached', date: T0 - 3 * MIN })
    // The reply to a reply arrives before the message it answers.
    h.box.deliver('INBOX', { from: ann, subject: 'Re: Budget', text: 'third', date: T0 - MIN, messageId: '<c@x>', inReplyTo: '<b@x>', references: [first.messageId, '<b@x>'] })
    h.box.deliver('INBOX', { from: bob, subject: 'Lunch?', text: 'Noon?', date: T0 - 2 * MIN })
    await h.sync()
    h.box.deliver('Sent', { from: { name: 'me', address: 'me@example.test' }, subject: 'Re: Budget', text: 'second', date: T0 - 2 * MIN, messageId: '<b@x>', inReplyTo: first.messageId, references: [first.messageId] })
    await h.sync()

    const threads = h.core.threadsList(inboxView)
    expect(threads.map((t) => t.subject)).toEqual(['Budget', 'Lunch?'])
    expect(threads[0].messageCount).toBe(3)
    expect(threads[0].participants).toEqual(['Ann', 'Me'])
    expect(threads[0].unreadCount).toBe(2)
  })

  it('merges two threads when a later message links them', async () => {
    const h = await harness()
    h.box.deliver('INBOX', { from: ann, subject: 'A', messageId: '<a@x>' })
    h.box.deliver('INBOX', { from: bob, subject: 'Re: A', messageId: '<c@x>', inReplyTo: '<b@x>', references: ['<b@x>'] })
    await h.sync()
    expect(h.core.threadsList(inboxView)).toHaveLength(2)
    h.box.deliver('INBOX', { from: ann, subject: 'Re: A', messageId: '<b@x>', inReplyTo: '<a@x>', references: ['<a@x>'] })
    await h.sync()
    const threads = h.core.threadsList(inboxView)
    expect(threads).toHaveLength(1)
    expect(threads[0].messageCount).toBe(3)
  })

  it('uses the provider thread id when there is one', async () => {
    const h = await harness()
    h.box.deliver('INBOX', { from: ann, subject: 'One', nativeThreadId: '77' })
    h.box.deliver('INBOX', { from: bob, subject: 'Unrelated subject', nativeThreadId: '77' })
    await h.sync()
    expect(h.core.threadsList(inboxView)).toHaveLength(1)
  })

  it('picks up flag changes and deletions made elsewhere', async () => {
    const h = await harness()
    const a = h.box.deliver('INBOX', { from: ann, subject: 'A' })
    const b = h.box.deliver('INBOX', { from: bob, subject: 'B' })
    await h.sync()
    h.box.folder('INBOX').messages.find((m) => m.uid === a.uid)!.seen = true
    h.box.remove('INBOX', b.uid)
    await h.sync()
    const threads = h.core.threadsList(inboxView)
    expect(threads.map((t) => [t.subject, t.unreadCount])).toEqual([['A', 0]])
    expect(h.core.threadsList({ kind: 'search', query: 'B' })).toHaveLength(0)
  })

  it('survives the server renumbering a folder', async () => {
    const h = await harness()
    h.box.deliver('INBOX', { from: ann, subject: 'A', text: 'alpha' })
    h.box.deliver('INBOX', { from: bob, subject: 'B', text: 'beta' })
    await h.sync()
    h.box.folder('INBOX').messages.reverse()
    h.box.resetUidValidity('INBOX')
    await h.sync()
    const threads = h.core.threadsList(inboxView)
    expect(threads.map((t) => t.subject).sort()).toEqual(['A', 'B'])
    const a = await h.core.threadsGet(threads.find((t) => t.subject === 'A')!.id)
    expect(a!.messages[0].text).toBe('alpha')
  })

  it('syncs on its own when the server reports new mail', async () => {
    const h = await harness()
    await h.sync()
    h.box.deliver('INBOX', { from: ann, subject: 'Pushed' })
    await h.core.idle()
    expect(h.core.threadsList(inboxView).map((t) => t.subject)).toEqual(['Pushed'])
  })

  it('downloads a body on demand for folders synced as headers only', async () => {
    const h = await harness()
    h.box.deliver('Archive', { from: ann, subject: 'Old', text: 'the full body' })
    await h.sync()
    const [t] = h.core.threadsList({ kind: 'folder', name: 'archive' })
    expect(t.snippet).toBe('')
    const detail = await h.core.threadsGet(t.id)
    expect(detail!.messages[0].text).toBe('the full body')
    expect(h.core.threadsList({ kind: 'search', query: 'full body' })).toHaveLength(1)
  })

  it('keeps several accounts apart', async () => {
    const h = await harness(['me@example.test', 'work@example.test'])
    h.boxes.get('me@example.test')!.deliver('INBOX', { from: ann, subject: 'Personal', messageId: '<same@x>' })
    h.boxes.get('work@example.test')!.deliver('INBOX', { from: ann, subject: 'Work', messageId: '<same@x>' })
    await h.sync()
    expect(h.core.threadsList(inboxView)).toHaveLength(2)
    expect(h.core.threadsList({ kind: 'split', splitId: `acct:${h.accounts[1].id}` }).map((t) => t.subject)).toEqual(['Work'])
  })
})

describe('actions', () => {
  it('archives instantly, sends it to the server after the undo window', async () => {
    const h = await harness()
    h.box.deliver('INBOX', { from: ann, subject: 'A' })
    await h.sync()
    const [t] = h.core.threadsList(inboxView)
    const token = h.core.threadsAction([t.id], 'archive')
    expect(token).toBeTruthy()
    expect(h.core.threadsList(inboxView)).toHaveLength(0)
    expect(h.box.folder('INBOX').messages).toHaveLength(1)

    await h.sync() // a sync during the undo window must not bring it back
    expect(h.core.threadsList(inboxView)).toHaveLength(0)

    await h.advance(11_000)
    expect(h.box.folder('INBOX').messages).toHaveLength(0)
    expect(h.box.folder('Archive').messages).toHaveLength(1)
    expect(h.core.threadsList({ kind: 'folder', name: 'archive' }).map((x) => x.subject)).toEqual(['A'])
    await h.sync()
    expect(h.core.threadsList({ kind: 'folder', name: 'archive' })).toHaveLength(1)
  })

  it('undo restores the thread and nothing reaches the server', async () => {
    const h = await harness()
    h.box.deliver('INBOX', { from: ann, subject: 'A' })
    await h.sync()
    const [t] = h.core.threadsList(inboxView)
    const token = h.core.threadsAction([t.id], 'trash')!
    expect(h.core.threadsList(inboxView)).toHaveLength(0)
    expect(h.core.undo(token)).toBe(true)
    expect(h.core.threadsList(inboxView)).toHaveLength(1)
    await h.advance(60_000)
    expect(h.box.folder('INBOX').messages).toHaveLength(1)
    expect(h.provider.calls).not.toContain('move')
  })

  it('trash removes the thread everywhere', async () => {
    const h = await harness()
    h.box.deliver('INBOX', { from: ann, subject: 'A', text: 'findme' })
    await h.sync()
    const [t] = h.core.threadsList(inboxView)
    h.core.threadsAction([t.id], 'trash')
    expect(h.core.threadsList({ kind: 'search', query: 'findme' })).toHaveLength(0)
    await h.advance(11_000)
    expect(h.box.folder('Trash').messages).toHaveLength(1)
    await h.sync()
    expect(h.core.threadsList({ kind: 'folder', name: 'archive' })).toHaveLength(0)
  })

  it('replays actions made offline once the connection returns', async () => {
    const h = await harness()
    h.box.deliver('INBOX', { from: ann, subject: 'A' })
    await h.sync()
    const [t] = h.core.threadsList(inboxView)
    h.provider.offline = true
    h.core.threadsAction([t.id], 'archive')
    h.core.threadsAction([t.id], 'read')
    await h.advance(11_000)
    await h.advance(10 * MIN)
    expect(h.box.folder('INBOX').messages).toHaveLength(1)
    expect(h.core.threadsList(inboxView)).toHaveLength(0)
    h.provider.offline = false
    await h.advance(10 * MIN)
    await h.advance(10 * MIN)
    expect(h.box.folder('INBOX').messages).toHaveLength(0)
    expect(h.box.folder('Archive').messages[0].seen).toBe(true)
  })

  it('rolls back and reports when the server keeps rejecting an action', async () => {
    const h = await harness()
    h.box.deliver('INBOX', { from: ann, subject: 'A' })
    await h.sync()
    const [t] = h.core.threadsList(inboxView)
    h.core.threadsAction([t.id], 'archive')
    for (let i = 0; i < 3; i++) {
      h.provider.failWith = new Error('Mailbox is read-only')
      await h.advance(6 * MIN)
    }
    expect(h.core.threadsList(inboxView)).toHaveLength(1)
    expect(h.toasts.at(-1)?.message).toContain('Mailbox is read-only')
  })

  it('marks read, unread and starred on the server', async () => {
    const h = await harness()
    h.box.deliver('INBOX', { from: ann, subject: 'A' })
    await h.sync()
    const [t] = h.core.threadsList(inboxView)
    expect(h.core.threadsAction([t.id], 'read')).toBeNull()
    h.core.threadsAction([t.id], 'star')
    expect(h.core.threadsList(inboxView)[0]).toMatchObject({ unreadCount: 0, starred: true })
    await h.advance(1000)
    expect(h.box.folder('INBOX').messages[0]).toMatchObject({ seen: true, flagged: true })
    h.core.threadsAction([t.id], 'unread')
    h.core.threadsAction([t.id], 'unstar')
    await h.advance(1000)
    expect(h.box.folder('INBOX').messages[0]).toMatchObject({ seen: false, flagged: false })
    expect(h.core.threadsList({ kind: 'folder', name: 'starred' })).toHaveLength(0)
  })
})

describe('snooze and reminders', () => {
  it('hides a snoozed thread and returns it to the top when due', async () => {
    const h = await harness()
    h.box.deliver('INBOX', { from: ann, subject: 'Old', date: T0 - DAY })
    h.box.deliver('INBOX', { from: bob, subject: 'New', date: T0 - MIN })
    await h.sync()
    const old = h.core.threadsList(inboxView).find((t) => t.subject === 'Old')!
    const token = h.core.threadsSnooze([old.id], T0 + 60 * MIN)
    expect(h.core.threadsList(inboxView).map((t) => t.subject)).toEqual(['New'])
    expect(h.core.threadsList({ kind: 'folder', name: 'snoozed' })).toHaveLength(1)
    await h.advance(30 * MIN)
    expect(h.core.threadsList(inboxView)).toHaveLength(1)
    await h.advance(31 * MIN)
    const inbox = h.core.threadsList(inboxView)
    expect(inbox.map((t) => t.subject)).toEqual(['Old', 'New'])
    expect(inbox[0].reminded).toBe(1)

    h.core.threadsSnooze([old.id], T0 + 5 * DAY)
    h.core.undo(token)
    expect(h.core.threadsList(inboxView)).toHaveLength(2)
  })

  it('wakes a thread whose snooze expired while the app was closed', async () => {
    const h = await harness()
    h.box.deliver('INBOX', { from: ann, subject: 'A' })
    await h.sync()
    h.core.threadsSnooze([h.core.threadsList(inboxView)[0].id], T0 + MIN)
    await h.advance(3 * DAY)
    expect(h.core.threadsList(inboxView)).toHaveLength(1)
  })

  it('reminds about a sent message only when nobody replied', async () => {
    const h = await harness()
    await h.sync()
    const draft = { accountId: h.account.id, to: [ann], cc: [], bcc: [], subject: 'Proposal', html: '<p>hi</p>', text: 'hi' }
    h.core.composeSend({ ...draft, remindAt: T0 + 2 * DAY })
    h.core.composeSend({ ...draft, subject: 'Other', to: [bob], remindAt: T0 + 2 * DAY })
    await h.advance(11_000)
    expect(h.core.threadsList({ kind: 'folder', name: 'sent' })).toHaveLength(2)
    expect(h.core.threadsList({ kind: 'folder', name: 'reminders' })).toHaveLength(0) // not linked until due
    const sentToBob = h.box.folder('Sent').messages.find((m) => m.subject === 'Other')!
    h.clock.now += DAY
    h.box.deliver('INBOX', { from: bob, subject: 'Re: Other', inReplyTo: sentToBob.messageId, references: [sentToBob.messageId], date: h.clock.now })
    await h.sync()
    h.core.threadsAction([h.core.threadsList(inboxView)[0].id], 'archive')
    await h.advance(DAY + MIN)
    const inbox = h.core.threadsList(inboxView)
    expect(inbox.map((t) => [t.subject, t.reminded])).toEqual([['Proposal', 2]])
    // Archiving the reminder clears it.
    h.core.threadsAction([inbox[0].id], 'archive')
    expect(h.core.threadsList(inboxView)).toHaveLength(0)
  })
})

describe('outbox', () => {
  const draft = (accountId: number) => ({ accountId, to: [ann], cc: [], bcc: [], subject: 'Hi', html: '<p>hello</p>', text: 'hello' })

  it('holds a message for the undo window, then sends it', async () => {
    const h = await harness()
    await h.sync()
    const item = h.core.composeSend(draft(h.account.id))
    expect(item.sendAt).toBe(T0 + 10_000)
    await h.advance(9000)
    expect(h.provider.sent).toHaveLength(0)
    await h.advance(2000)
    expect(h.provider.sent).toHaveLength(1)
    expect(h.provider.sent[0].from.address).toBe('me@example.test')
    expect(h.core.outboxList()).toHaveLength(0)
    expect(h.core.threadsList({ kind: 'folder', name: 'sent' }).map((t) => t.subject)).toEqual(['Hi'])
  })

  it('undo send cancels and hands the draft back', async () => {
    const h = await harness()
    await h.sync()
    const item = h.core.composeSend(draft(h.account.id))
    const cancelled = h.core.outboxCancel(item.id)
    expect(cancelled!.draft.subject).toBe('Hi')
    await h.advance(MIN)
    expect(h.provider.sent).toHaveLength(0)
  })

  it('sends a scheduled message at its time, or on the next launch if that time passed', async () => {
    const h = await harness()
    await h.sync()
    h.core.composeSend(draft(h.account.id), T0 + DAY)
    await h.advance(DAY - MIN)
    expect(h.provider.sent).toHaveLength(0)
    expect(h.core.outboxList()).toHaveLength(1)
    await h.advance(3 * DAY) // app was closed across the scheduled time
    expect(h.provider.sent).toHaveLength(1)
  })

  it('retries while offline and reports a rejected message', async () => {
    const h = await harness()
    await h.sync()
    h.provider.offline = true
    h.core.composeSend(draft(h.account.id))
    await h.advance(11_000)
    expect(h.core.outboxList()[0].state).toBe('pending')
    h.provider.offline = false
    await h.advance(10 * MIN)
    expect(h.provider.sent).toHaveLength(1)

    h.provider.failWith = new Error('Recipient address rejected')
    const item = h.core.composeSend(draft(h.account.id))
    await h.advance(11_000)
    expect(h.core.outboxList()[0]).toMatchObject({ state: 'failed', error: 'Recipient address rejected' })
    h.core.outboxRetry(item.id)
    await h.advance(1000)
    expect(h.provider.sent).toHaveLength(2)
  })

  it('refuses a message with no recipients', async () => {
    const h = await harness()
    expect(() => h.core.composeSend({ ...draft(h.account.id), to: [] })).toThrow(/recipient/)
  })
})

describe('splits and search', () => {
  it('sorts the inbox into splits, and custom splits pull mail out of the built-in ones', async () => {
    const h = await harness()
    h.box.deliver('INBOX', { from: ann, subject: 'Person' })
    h.box.deliver('INBOX', { from: { name: 'Weekly', address: 'news@letters.test' }, subject: 'Issue 12', isList: true })
    h.box.deliver('INBOX', { from: bob, subject: 'Invite', hasInvite: true })
    h.box.deliver('INBOX', { from: { name: 'GitHub', address: 'noreply@github.test' }, subject: 'PR merged', isAutomated: true })
    await h.sync()
    const subjects = (splitId: string) => h.core.threadsList({ kind: 'split', splitId }).map((t) => t.subject)
    expect(subjects('important')).toEqual(['Person'])
    expect(subjects('news')).toEqual(['Issue 12'])
    expect(subjects('calendar')).toEqual(['Invite'])
    expect(subjects('other')).toEqual(['PR merged'])

    h.core.splitsSave({ name: 'GitHub', rule: { fromContains: ['github.test'] } })
    const splits = h.core.splitsList()
    const custom = splits.find((s) => s.kind === 'custom')!
    expect(subjects(custom.id)).toEqual(['PR merged'])
    expect(subjects('other')).toEqual([])
    expect(splits.find((s) => s.id === 'important')).toMatchObject({ count: 1, unread: 1 })
    h.core.splitsDelete(custom.id)
    expect(subjects('other')).toEqual(['PR merged'])
  })

  it('searches text, senders and filters', async () => {
    const h = await harness()
    h.box.deliver('INBOX', { from: ann, subject: 'Quarterly budget', text: 'Numbers for the offsite in Lisbon' })
    h.box.deliver('INBOX', { from: bob, subject: 'Lunch', text: 'budget sandwich place', seen: true })
    await h.sync()
    const find = (query: string) => h.core.threadsList({ kind: 'search', query }).map((t) => t.subject).sort()
    expect(find('lisb')).toEqual(['Quarterly budget'])
    expect(find('budget')).toEqual(['Lunch', 'Quarterly budget'])
    expect(find('budget from:bob')).toEqual(['Lunch'])
    expect(find('budget is:unread')).toEqual(['Quarterly budget'])
    expect(find('subject:lunch')).toEqual(['Lunch'])
    expect(find('"don\'t" (crash')).toEqual([])
  })
})

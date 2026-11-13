import type { Account } from '../shared/types'
import type { Core } from './core'
import type { FakeMailbox, FakeMessageInput } from './providers/fake'

type Seed = Omit<FakeMessageInput, 'date'> & { ago: number; folder?: string }

const H = 3_600_000
const D = 24 * H

const people = {
  maya: { name: 'Maya Chen', address: 'maya@northwind.example' },
  omar: { name: 'Omar Haddad', address: 'omar@northwind.example' },
  lena: { name: 'Lena Fischer', address: 'lena.fischer@example.org' },
  dad: { name: 'Dad', address: 'dad@family.example' },
  sam: { name: 'Sam Ortiz', address: 'sam@studio.example' },
}

/** Seeds two demo accounts with realistic mail so the app can be tried without signing in. */
export async function seedDemo(core: Core, mailbox: (accountId: number) => FakeMailbox): Promise<Account[]> {
  const personal = await core.addAccountRecord('demo', 'you@personal.example', 'Personal')
  const work = await core.addAccountRecord('demo', 'you@northwind.example', 'Work')
  const me = (a: Account) => ({ name: 'You', address: a.email })
  const now = Date.now()
  const put = (box: FakeMailbox, seeds: Seed[]) => {
    const ids: string[] = []
    for (const { ago, folder, ...m } of seeds) ids.push(box.deliver(folder ?? 'INBOX', { ...m, date: now - ago }).messageId)
    return ids
  }

  const w = mailbox(work.id)
  const [kickoff] = put(w, [
    { from: people.maya, to: [me(work)], subject: 'Q1 planning kickoff', ago: 26 * H, seen: true, text: 'Hi team,\n\nLet\'s kick off Q1 planning on Thursday. Please bring your top three priorities and any open risks.\n\nMaya' },
  ])
  put(w, [
    { from: me(work), to: [people.maya], subject: 'Re: Q1 planning kickoff', ago: 25 * H, folder: 'Sent', seen: true, inReplyTo: kickoff, references: [kickoff], text: 'Sounds good. I\'ll bring the migration timeline.' },
    { from: people.omar, to: [me(work)], cc: [people.maya], subject: 'Re: Q1 planning kickoff', ago: 3 * H, inReplyTo: kickoff, references: [kickoff], text: 'Can we move it to 2pm? I have a customer call at 11.\n\nOmar', html: '<p>Can we move it to <b>2pm</b>? I have a customer call at 11.</p><p>Omar</p>' },
    { from: people.omar, to: [me(work)], subject: 'Contract redlines for Fabrikam', ago: 45 * 60_000, hasAttachments: true, text: 'Attached are legal\'s redlines. The indemnity clause is the only real sticking point. Could you review by Friday?' },
    { from: { name: 'Calendar', address: 'calendar@northwind.example' }, to: [me(work)], subject: 'Invitation: Design review, Tue 10:00', ago: 5 * H, hasInvite: true, isAutomated: true, text: 'Maya Chen invited you to Design review.\nTuesday 10:00 to 11:00, Room 4B.' },
    { from: { name: 'CI', address: 'noreply@ci.northwind.example' }, to: [me(work)], subject: 'Build #4821 failed on main', ago: 2 * H, isAutomated: true, text: 'Job "integration" failed after 6m 12s. 2 tests failed in billing/.' },
    { from: { name: 'Lena Fischer', address: 'lena.fischer@example.org' }, to: [me(work)], subject: 'Intro: Lena <> you re analytics hire', ago: 30 * H, seen: true, text: 'Great to meet you. Happy to share how we structured our analytics team. Free next week?' },
  ])

  const p = mailbox(personal.id)
  put(p, [
    { from: people.dad, to: [me(personal)], subject: 'Photos from the lake', ago: 20 * 60_000, text: 'Here are the photos from the weekend. The sunset one came out great!\n\nLove, Dad' },
    { from: { name: 'The Morning Brief', address: 'hello@brief.example' }, to: [me(personal)], subject: 'Your Thursday brief: markets, science, and a crossword', ago: 6 * H, isList: true, text: 'Good morning. Here is what you need to know today...' },
    { from: { name: 'Trail Running Weekly', address: 'news@trailweekly.example' }, to: [me(personal)], subject: 'Issue 112: Winter shoes tested', ago: 2 * D, isList: true, seen: true, text: 'We tested twelve winter trail shoes so you do not have to.' },
    { from: people.sam, to: [me(personal)], subject: 'Saturday climbing?', ago: 9 * H, text: 'Gym opens at 9. Want to meet there? I can drive.' },
    { from: { name: 'Bank Alerts', address: 'alerts@bank.example' }, to: [me(personal)], subject: 'Your statement is ready', ago: 3 * D, isAutomated: true, seen: true, text: 'Your November statement is now available online.' },
    { from: me(personal), to: [{ name: 'Landlord', address: 'office@apartments.example' }], subject: 'Leaky faucet in unit 4', ago: 4 * D, folder: 'Sent', seen: true, text: 'Hi, the kitchen faucet has been dripping since Monday. Could someone take a look this week?' },
    { from: { name: 'Airline', address: 'trips@airline.example' }, to: [me(personal)], subject: 'Your trip to Lisbon is confirmed', ago: 8 * D, folder: 'Archive', seen: true, isAutomated: true, text: 'Confirmation ABC123. Departs Mar 3, 08:40.' },
  ])
  return [personal, work]
}

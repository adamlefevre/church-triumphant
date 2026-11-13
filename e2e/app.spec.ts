import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let app: ElectronApplication
let page: Page
let dataDir: string
const shots = process.env.SHOTS_DIR

async function launch() {
  app = await electron.launch({
    args: [join(__dirname, '../out/main/index.js'), '--no-sandbox'],
    env: { ...process.env, MAIL_DATA_DIR: dataDir, MAIL_DEMO: '1', ELECTRON_RENDERER_URL: '' },
  })
  page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 800 })
  await expect(page.getByTestId('thread-row').first()).toBeVisible({ timeout: 20000 })
}

const shot = async (name: string) => {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) })
}
const rows = () => page.getByTestId('thread-row')
const selected = () => page.locator('[data-testid="thread-row"][aria-selected="true"]')

test.beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'ct-e2e-'))
  await launch()
})
test.afterAll(async () => {
  await app?.close()
  rmSync(dataDir, { recursive: true, force: true })
})

test('unified inbox, navigation and reading', async () => {
  await expect(page.getByRole('tab', { name: /Important/ })).toBeVisible()
  await expect(rows().first()).toContainText('Photos from the lake')
  await shot('1-inbox')
  await page.keyboard.press('j')
  await expect(selected()).toContainText('Contract redlines')
  await page.keyboard.press('j')
  await page.keyboard.press('k')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('thread-view')).toContainText('Contract redlines')
  // Bodies render in a sandboxed frame with scripts disabled.
  await expect(page.frameLocator('iframe[title="Message"]').locator('body')).toContainText('indemnity clause')
  await expect(page.locator('iframe[title="Message"]')).toHaveAttribute('sandbox', /^(?!.*allow-scripts).*$/)
  await shot('2-thread')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('thread-list')).toBeVisible()
})

test('threads group replies across sent and received mail', async () => {
  await page.getByRole('button', { name: 'All inbox' }).click()
  const kickoff = rows().filter({ hasText: 'Q1 planning kickoff' })
  await expect(kickoff).toHaveCount(1)
  await kickoff.dblclick()
  await expect(page.getByTestId('message')).toHaveCount(3)
  await page.keyboard.press('Escape')
  await page.keyboard.press('g')
  await page.keyboard.press('i')
})

test('mark done, then undo', async () => {
  const subject = await selected().innerText()
  const count = await rows().count()
  await page.keyboard.press('e')
  await expect(rows()).toHaveCount(count - 1)
  await expect(page.getByTestId('notice').filter({ hasText: 'Archived' })).toBeVisible()
  await page.keyboard.press('z')
  await expect(rows()).toHaveCount(count)
  await expect(rows().first()).toContainText(subject.split('\n')[0])
})

test('split inbox tabs', async () => {
  await page.keyboard.press('Tab')
  await expect(page.getByRole('tab', { name: /Calendar/ })).toHaveAttribute('aria-selected', 'true')
  await expect(rows().first()).toContainText('Design review')
  await page.keyboard.press('Tab')
  await expect(page.getByRole('tab', { name: /Newsletters/ })).toHaveAttribute('aria-selected', 'true')
  await expect(rows()).toHaveCount(2)
  await shot('3-newsletters')
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Shift+Tab')
})

test('search across accounts', async () => {
  await page.keyboard.press('/')
  await page.keyboard.type('climbing')
  await page.keyboard.press('Enter')
  await expect(rows()).toHaveCount(1)
  await expect(rows().first()).toContainText('Saturday climbing?')
  await shot('4-search')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('tab', { name: /Important/ })).toBeVisible()
})

test('snooze hides a conversation until later', async () => {
  const subject = 'Saturday climbing?'
  await rows().filter({ hasText: subject }).click()
  await page.keyboard.press('h')
  await expect(page.getByTestId('time-picker')).toBeVisible()
  await shot('5-snooze')
  await page.keyboard.press('3') // tomorrow
  await expect(rows().filter({ hasText: subject })).toHaveCount(0)
  await page.keyboard.press('g')
  await page.keyboard.press('h')
  await expect(rows().filter({ hasText: subject })).toHaveCount(1)
  await page.keyboard.press('g')
  await page.keyboard.press('i')
})

test('compose, undo send, then send', async () => {
  await page.keyboard.press('c')
  await expect(page.getByTestId('composer')).toBeVisible()
  await page.getByLabel('To').fill('Friend <friend@example.org>')
  await page.getByLabel('Subject').fill('Hello from the client')
  await page.locator('.ProseMirror').click()
  await page.keyboard.type('Testing undo send.')
  await shot('6-compose')
  await page.keyboard.press('Control+Enter')
  await expect(page.getByTestId('composer')).toHaveCount(0)
  await expect(page.getByTestId('notice').filter({ hasText: 'Sending' })).toBeVisible()
  await page.keyboard.press('z')
  await expect(page.getByTestId('composer')).toBeVisible()
  await expect(page.getByLabel('Subject')).toHaveValue('Hello from the client')
  await expect(page.locator('.ProseMirror')).toContainText('Testing undo send.')
  await page.getByTestId('send').click()
  await page.getByRole('button', { name: 'Sent' }).click()
  await expect(rows().filter({ hasText: 'Hello from the client' })).toHaveCount(1, { timeout: 20000 })
})

test('reply keeps the conversation together', async () => {
  await page.keyboard.press('g')
  await page.keyboard.press('i')
  await rows().filter({ hasText: 'Photos from the lake' }).click()
  await page.keyboard.press('r')
  await expect(page.getByLabel('To')).toHaveValue('Dad <dad@family.example>')
  await expect(page.getByLabel('Subject')).toHaveValue('Re: Photos from the lake')
  await page.keyboard.type('They look great!')
  await page.keyboard.press('Control+Enter')
  await page.getByRole('button', { name: 'Sent' }).click()
  const t = rows().filter({ hasText: 'Photos from the lake' })
  await expect(t).toHaveCount(1, { timeout: 20000 })
  await expect(t).toContainText('2')
})

test('command palette', async () => {
  await page.keyboard.press('Control+k')
  await expect(page.getByTestId('palette')).toBeVisible()
  await page.keyboard.type('starred')
  await shot('7-palette')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Starred' })).toHaveClass(/bg-raised/)
})

test('state survives a restart', async () => {
  await page.keyboard.press('g')
  await page.keyboard.press('h')
  const snoozed = await rows().count()
  expect(snoozed).toBe(1)
  await app.close()
  await launch()
  await page.getByRole('button', { name: 'Snoozed' }).click()
  await expect(rows()).toHaveCount(1)
  await page.getByRole('button', { name: 'Settings and accounts' }).click()
  await expect(page.getByTestId('settings')).toContainText('you@northwind.example')
  await shot('8-settings')
})

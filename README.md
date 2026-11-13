# Church Triumphant

A fast, keyboard-first desktop email client for several Gmail accounts plus Outlook,
iCloud and Proton Mail, in one unified inbox.

- **Unified inbox** across every account, with **split inbox** tabs (Important, Calendar,
  Newsletters, Other, one per account, plus your own rules)
- **Keyboard first**: `j`/`k`, `e` done, `h` snooze, `r` reply, `/` search, `Ctrl/⌘+K` command palette, `?` for all shortcuts
- **Snooze**, **remind me if no reply**, **send later**, and **undo** for send, archive and trash
- **Instant local search** across all accounts (`from:`, `to:`, `subject:`, `is:unread`, `has:attachment`)
- Works **offline**: actions apply instantly and sync when you reconnect
- Private: mail stays on your computer, credentials in the OS keychain, remote images blocked by default

## Get started

```sh
pnpm install
pnpm dev
```

Then Settings → Accounts. Try **demo mail** first, or follow [docs/setup.md](docs/setup.md)
to connect real accounts (Gmail and Outlook need a one-time app registration; iCloud uses an
app-specific password; Proton Mail uses Proton Mail Bridge).

## Development

```sh
pnpm test        # unit and IMAP integration tests
pnpm e2e         # drives the built app with Playwright (needs a display; use xvfb-run on Linux)
pnpm typecheck
pnpm package     # installer in release/
```

See [CLAUDE.md](CLAUDE.md) for how the code is organised.

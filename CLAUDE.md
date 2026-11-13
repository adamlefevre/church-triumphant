# Church Triumphant

Electron desktop email client. TypeScript, React, Tailwind v4, pnpm.

## Layout

- `src/shared/types.ts`: types and the `Api` contract between UI and core.
- `src/core/`: the mail engine. No Electron imports, so it runs under plain Node in tests.
  - `db.ts`: `node:sqlite` wrapper and migrations (append new migrations; never edit old ones).
  - `store.ts`: all persistent state: ingest, threading, thread summaries, splits, search (FTS5).
  - `core.ts`: implements `Api`. Sync scheduling, per-account job queue, optimistic actions with
    undo and offline replay, snooze, reminders, outbox. `tick()` runs due work each second.
  - `provider.ts`: the `MailProvider` interface every account type implements.
  - `providers/imap.ts`: IMAP (imapflow) + SMTP (nodemailer) provider for all real accounts.
  - `providers/profiles.ts`: per-service servers and quirks (Gmail, Outlook, iCloud, Proton Bridge).
  - `providers/fake.ts`: in-memory mail server for tests and demo mode.
  - `oauth.ts`: desktop OAuth (PKCE + loopback) and token refresh.
- `src/main/`: Electron main process; hosts the core and exposes it over one IPC channel.
- `src/preload/`: the `window.mail` bridge.
- `src/renderer/`: React UI. `state.ts` (zustand) holds UI state; `App.tsx` has the keymap.

## Conventions

- The core is the only writer to the database. The UI calls `api.*` and re-reads on `changed`.
- User actions apply locally first, then queue in `actions`; `archive`/`trash` wait for the undo window.
- Mail HTML is sanitized (DOMPurify) and shown in a sandboxed iframe without scripts.

## Commands

- `pnpm test` (vitest: core + IMAP integration against hoodiecrow-imap)
- `pnpm e2e` (Playwright on the built app, demo data; on Linux run under `xvfb-run -a`)
- `pnpm typecheck`, `pnpm build`

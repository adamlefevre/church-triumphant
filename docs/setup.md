# Setting up your accounts

Church Triumphant is a desktop app. Your mail is stored in a local database on your
computer, and passwords and tokens are encrypted with your operating system's keychain.
Nothing passes through a third-party server.

Gmail and Outlook use OAuth, so you register a small "app" with Google and Microsoft once.
That registration belongs to you, which is why no one else (including the authors) can
read your mail. iCloud and Proton Mail use passwords and need no registration.

## Run the app

```sh
pnpm install
pnpm dev          # development, with hot reload
pnpm package      # build an installer into release/
```

To try it without any accounts: Settings → Accounts → **Try demo mail**.

## Gmail (one registration covers all your Gmail accounts)

1. Go to https://console.cloud.google.com and create a project (any name).
2. **APIs & Services → Library**: enable the **Gmail API**.
3. **APIs & Services → OAuth consent screen** (now called "Google Auth Platform"):
   - User type **External**. App name: anything. Add your own email as support and developer contact.
   - **Data access / Scopes**: add `https://mail.google.com/`.
   - **Audience / Test users**: add every Gmail address you'll connect.
   - **Publish the app** ("In production"). It will say unverified; that is fine for personal
     use, you'll just click through a warning when signing in. If you leave it in "Testing",
     Google expires your sign-in every 7 days.
4. **Credentials → Create credentials → OAuth client ID**, application type **Desktop app**.
5. Copy the **Client ID** and **Client secret** into the app: Settings → Sign-in apps → Google.
   (Google calls it a secret, but for desktop apps it is not confidential.)
6. Settings → Accounts → **Gmail**. Your browser opens; sign in, allow access, and come back.
   Repeat for each Gmail account.

## Outlook / Microsoft 365

1. Go to https://entra.microsoft.com → **App registrations → New registration**.
   - Supported account types: **Accounts in any organizational directory and personal Microsoft accounts**.
   - Redirect URI: platform **Public client/native (mobile & desktop)**, value `http://localhost`.
2. In the app's **Authentication** page, set **Allow public client flows** to **Yes**.
3. **API permissions → Add a permission → APIs my organization uses →** search
   **Office 365 Exchange Online** → Delegated → `IMAP.AccessAsUser.All` and `SMTP.Send`.
   Also add Microsoft Graph delegated `offline_access`, `openid`, `email`, `profile`.
4. Copy the **Application (client) ID** into Settings → Sign-in apps → Microsoft.
5. Settings → Accounts → **Outlook**.

Work or school accounts: your organization must allow IMAP and authenticated SMTP for your
mailbox. If sign-in works but sync fails with an authentication error, ask your admin.

## iCloud Mail

1. Go to https://account.apple.com → **Sign-In and Security → App-Specific Passwords**, create one.
2. Settings → Accounts → **iCloud**: your iCloud email address and that app-specific password.

## Proton Mail

Proton has no public API; desktop clients connect through **Proton Mail Bridge**, which needs a
paid Proton plan.

1. Install and sign in to Proton Mail Bridge, and leave it running.
2. In Bridge, open your address's **mailbox details** and copy the **username** and **password**
   it shows (this is not your Proton password).
3. Settings → Accounts → **Proton Mail**: that username as the email address and the Bridge password.
   If you changed Bridge's ports, enter them; the defaults are IMAP 1143 and SMTP 1025.

Bridge uses a self-signed certificate. The app accepts it only when Bridge is on this computer
(127.0.0.1 / localhost).

## Checklist after connecting

- [ ] Each account shows in the sidebar without a red `!`.
- [ ] New mail sent to each account appears within a few seconds.
- [ ] Press `e` on a message: after the undo window it moves to Archive (All Mail for Gmail) in
      the provider's own web mail.
- [ ] Send a message from each account: it arrives, and it appears in Sent.
- [ ] Read and starred states match the provider's web mail.

## What to know

- Snooze, reminders and send later are stored on this computer. They fire while the app is
  running and catch up the next time you open it; they don't sync to your phone.
- The app keeps the last 90 days of Inbox, Sent and Archive by default (Settings → Preferences).
- Remote images are blocked unless you turn them on, so senders can't tell when you open mail.

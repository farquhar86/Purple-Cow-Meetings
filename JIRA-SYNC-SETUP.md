# Jira ticket sync — setup

Put a Jira ticket number in a task and the app keeps an eye on it:

- **Task:** `Ship the modem swap flow PCHT-1234`
- The task shows a live chip — `PCHT-1234 · In Progress` — that links straight to the ticket.
- When the ticket reaches **Done / Resolved / Closed**, the app ticks the task off by itself.

It works on **tasks under a quarterly priority** and on **meeting to-dos**. Ticket numbers
in any Jira project on `purplecowinternet.atlassian.net` are recognised; anything that
merely looks like one (`Q1-2026`) is ignored.

It never un-ticks. If someone un-ticks a task the sync completed, the sync leaves that task
alone from then on — the person has the last word.

---

## Why there's a server piece

The site is a plain web page. Jira won't answer a web page directly, and an API token
sitting in `index.html` would be readable by anyone. So the lookup goes through a Supabase
Edge Function — `jira-status` — which holds the token server-side and only answers people
who are logged into the app. Same shape as `manage-users`.

Nothing breaks if this isn't set up: no chips appear, no tasks tick themselves, everything
else in the app works exactly as before.

---

## One-time setup

### 1. Get a Jira API token

**There's already one on hand.** The PCHT queue dashboard uses a Jira token kept in AWS
Secrets Manager, dev-sandbox account (`528757786015`), `ca-central-1`:

```
aws secretsmanager get-secret-value --profile dev-sandbox --region ca-central-1 \
  --secret-id pcht-queue-dashboard/jira --query SecretString --output text
```

It holds `{"email": "...", "token": "..."}` — those two values go straight into
`JIRA_EMAIL` and `JIRA_API_TOKEN` below. It's been verified against PCHT, PCSYNC and DEV
for this sync.

**Worth knowing before you reuse it:** that token belongs to a *personal* account
(rei.colina@), not a service account. Two consequences — the sync reads Jira as that
person, and it dies the day that account is disabled or the token is rotated, taking the
queue dashboard with it. Fine to start with; worth moving to a service account before many
people depend on it.

To make a fresh one instead:

1. Go to <https://id.atlassian.com/manage-profile/security/api-tokens> signed in as the
   account the sync should read as — a service/admin account ages better than a personal one.
2. **Create API token**, name it `purple-cow-meetings`, copy the value.
   You can't view it again later — if it's lost, make a new one.

The sync only ever *reads* Jira. The token still grants that account's full access, so
treat it like a password. Don't paste it into the repo or the app — only into Supabase's
secrets.

### 2. Add the secrets in Supabase

Supabase ▸ Project Settings ▸ Edge Functions ▸ **Secrets**:

| Name | Value |
|---|---|
| `JIRA_BASE_URL` | `https://purplecowinternet.atlassian.net` |
| `JIRA_EMAIL` | the email of the account the token belongs to |
| `JIRA_API_TOKEN` | the token from step 1 |

(`SUPABASE_URL` and `SUPABASE_ANON_KEY` are already set for the project.)

### 3. Deploy the function

1. Supabase ▸ Edge Functions ▸ **Create function**, name it exactly `jira-status`.
2. Paste in the whole of `jira-status-function.ts` from this repo. **Deploy.**
3. **Check the "Last deployed" timestamp actually changed** — it has silently failed to
   redeploy before (see the handoff notes).
4. Edge Functions ▸ `jira-status` ▸ Settings ▸ turn **Verify JWT OFF**. The function checks
   the caller's login itself, the same way `manage-users` does.

### 4. Try it

In the app: Priorities ▸ **↻ Sync Jira**. You should get one of:

- *"Ticked 2 tasks off — the Jira tickets are done"*
- *"Checked Jira — nothing new to tick off"*
- *"No Jira ticket numbers found on these tasks"*

Chips appear on any task that names a real ticket.

---

## When it runs

- When someone opens the app (once they're logged in).
- When they open the Priorities screen or a meeting.
- When they press **↻ Sync Jira**.

Between automatic runs there's a five-minute floor, so moving around the app doesn't hammer
Jira. The button ignores that and checks immediately. There is no scheduled/cron job —
somebody has to have the app open.

---

## If something looks wrong

| What you see | Almost always |
|---|---|
| *"Jira isn't set up yet"* | One of the three secrets is missing or misspelled. |
| *"Not authorized — please log in again"* | Session token went stale. Log out and back in. |
| *"Is the jira-status function deployed?"* | The function isn't there, or Verify JWT is ON. |
| No chip on a task that does name a ticket | Jira doesn't recognise the key, or the token's account can't see that project. Open the ticket URL as that account to check. |
| A task ticked itself and shouldn't have | Un-tick it — the sync will respect that and leave it alone from then on. |
| Chips are stale | Press ↻ Sync Jira; automatic runs are capped at one per five minutes. |

Deeper: Supabase ▸ Edge Functions ▸ `jira-status` ▸ **Logs**, and the browser console
(the app logs `Jira sync` warnings there and otherwise stays quiet).

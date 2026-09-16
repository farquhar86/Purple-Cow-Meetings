# Purple Cow Planning App — Project Handoff / Reference

A single reference for the internal planning app ("Not Metronome") — an in-house,
Ninety.io / EOS-style operating system for Purple Cow Internet. Use this to brief a
new conversation or as the knowledge-base entry for the project.

---

## 1. What it is

A web app where the leadership/departments run the company: quarterly **Priorities
(Rocks)**, weekly **Metrics (Scorecard)**, **Meetings** (daily standup + weekly L10)
with shared agendas, an **Issues** board, a **Core Values / Vision** page, and a
**Team** admin panel with real logins and roles. Built as one self-contained HTML
file backed by Supabase.

Tagline baked into the product: **Herd Life.**

---

## 2. Architecture at a glance

```
Browser (any teammate)  ─►  index.html on GitHub Pages (the whole app: HTML+CSS+JS)
                                   │
                                   ├─►  Supabase Postgres  (shared data, JSONB tables + RLS)
                                   ├─►  Supabase Auth       (email/password logins, invites)
                                   ├─►  Supabase Edge Function "manage-users" (invite/list/roles)
                                   ├─►  Supabase Edge Function "jira-status" ─► Jira Cloud (ticket statuses)
                                   └─►  Supabase Storage    ("meeting-uploads" bucket, note images)

Supabase Auth  ─►  Custom SMTP  ─►  Resend  ─►  sends invite / reset emails from @purplecowinternet.com
```

- **No build step.** The app is one file; edit and deploy.
- **Concurrency principle (important):** anything multiple people edit at once is stored
  as **one row per item** so people never overwrite each other. This pattern is used for
  priorities, metric weekly values, and every meeting entry (notes, to-dos, issues, comments).

---

## 3. Hosting & deployment

- **Repo:** `farquhar86/Purple-Cow-Meetings` (GitHub), branch `main`, GitHub Pages.
- **Live URL:** `https://farquhar86.github.io/Purple-Cow-Meetings/`
- **Deploy:** commit + push `index.html` in GitHub Desktop → GitHub Pages rebuilds in ~1 min → hard-refresh (Cmd+Shift+R).
- **Working file:** `herd-100k-worksheet.html` is the source; it's copied to `index.html` (the file GitHub serves). They're identical — edit and push `index.html`.

### Files in the project folder (Desktop/Purple-Cow-Meetings)
| File | Purpose |
|---|---|
| `index.html` | The whole app (what GitHub Pages serves). |
| `herd-100k-worksheet.html` | Same content, working copy. |
| `manage-users-function.ts` | Supabase Edge Function code (paste into Supabase to deploy). |
| `jira-status-function.ts` | Supabase Edge Function that looks up Jira ticket statuses (see `JIRA-SYNC-SETUP.md`). |
| `supabase-setup.sql` | Original quarters tables (`meetings`, `entries`). |
| `supabase-lockdown.sql` | RLS policies for those tables. |
| `supabase-metrics.sql` | Metrics tables (`metrics` + `metric_values`). |
| `supabase-meetings.sql` | Meetings tables (`mtgs` + `mtg_items`). |
| `supabase-storage.sql` | Public `meeting-uploads` bucket + policies (note images). |
| `invite-email.html` | Branded invite email template (paste into Supabase). |
| `metric-*.txt` | Real Salesforce history pulled for backfilling metrics. |

**Any SQL file must be run once in Supabase → SQL Editor for that feature to share data.**
Symptom of a missing table: data only shows in your own browser (saves to localStorage,
warns in console "relation ... does not exist").

---

## 4. Supabase project

- **Project:** `purple-cow-meetings` — ref `pabuedfwiinvlhvmrslm` (`https://pabuedfwiinvlhvmrslm.supabase.co`).
- **Config block in the HTML (safe to expose — these are the public keys):**
  - `SUPABASE_URL = 'https://pabuedfwiinvlhvmrslm.supabase.co'`
  - `SUPABASE_ANON_KEY = 'sb_publishable_...'` (publishable/anon key — safe in the client)
- **Never in the site:** the service-role key and the Resend API key. They live only in
  the Edge Function / Supabase settings, server-side.

### Tables (all JSONB-blob style with Row Level Security)
| Table | Holds | Notes |
|---|---|---|
| `meetings` | Quarters (name/theme/goal) | anon can read; authenticated write |
| `entries` | Priorities, SWOT, start/stop/keep | one row per entry (concurrency-safe); anon can insert (intake form) |
| `metrics` | Metric definitions | one row per metric |
| `metric_values` | Weekly numbers | **one row per (metric, week)** — key `"<metricId>|<week>"` |
| `mtgs` | Meeting definitions + the Vision page (`id = 'app-vision'`) | authenticated only |
| `mtg_items` | Every meeting entry (notes, to-dos, issues, comments, text blocks) | one row per item |
| Storage bucket `meeting-uploads` | Note images (public) | |

RLS model: intake form is public-insert; everything else requires a logged-in user.

---

## 5. Auth, roles & email

### Roles (stored in each user's `app_metadata.role`)
- **superadmin** — brad only. Everything Admin can do **plus sees every meeting** company-wide.
- **admin** — full planning + **can manage people** (invite/remove/change roles). Sees only their own meetings.
- **leadership** — full planning, own meetings only, **cannot** manage people.
- **team** — restricted: sees only priorities/metrics they own or have a task on, only meetings they're invited to, can't create priorities/metrics or manage people.
- Code: `canManageUsers()` = admin + superadmin; `isSuperAdmin()` gates the "all meetings" view.

### Edge Function `manage-users`
- Actions: `list`, `create` (invite), `setrole`, `syncavatars` (Slack photos), `delete`.
- Env vars it needs: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and optional `SLACK_BOT_TOKEN` (scopes `users:read`, `users:read.email`) for auto-pulling Slack profile photos.
- **Setting: "Verify JWT" must be OFF** for the function (it verifies the caller itself).
- Deploy by pasting `manage-users-function.ts` into Supabase → Edge Functions → manage-users → Code → Deploy. **Confirm the "Last deployed" timestamp changes** — several times it silently didn't redeploy.

### Edge Function `jira-status`
- Answers `{action:'status', keys:[…]}` with each ticket's status, status **category** and URL.
- Env vars: `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` (plus the project's `SUPABASE_URL` / `SUPABASE_ANON_KEY`).
- **"Verify JWT" must be OFF** — it verifies the caller itself, like `manage-users`.
- Filters requested keys against the real project list first, because one bad key makes a whole JQL search fail; falls back to per-issue lookups if the bulk search errors anyway.
- Deploy the same way: paste `jira-status-function.ts` into a function named `jira-status`. Full setup in `JIRA-SYNC-SETUP.md`.

### Auth configuration (Supabase → Authentication)
- **URL Configuration:** Site URL and Redirect URLs = `https://farquhar86.github.io/Purple-Cow-Meetings/` (with `/**` on the redirect). Wrong/missing values here break invites and password resets.
- **Email OTP Expiration:** set to `86400` (24h max) so invite links last a day.
- **Rate Limits → sending emails:** raised to ~100/hr.

### Email sending (Resend, via custom SMTP)
- Domain `purplecowinternet.com` **verified in Resend** (DKIM + SPF/MX added in **AWS Route 53** — DNS is hosted there; nameservers are `awsdns`). Records live on a `send` subdomain so they don't touch Google Workspace email.
- **Supabase → Authentication → Emails → SMTP:** host `smtp.resend.com`, port `465` (or `587`), username `resend`, password = a Resend API key, sender `@purplecowinternet.com`.
- **Email templates** (Authentication → Email Templates): branded **Invite** and **Reset Password** HTML (see `invite-email.html`). Keep `{{ .ConfirmationURL }}` intact.

---

## 6. Feature list (what's built)

**Left sidebar shell** (mobile = hamburger drawer): Home, Core Values, Metrics, Priorities, To-Dos, Issues, Meetings, + Add teammates, account menu. Lands on Home after login.

- **Core Values / Vision** — editable page (strategy, purpose, 3 core values, 1HAG/3HAG/BHAG goals). Stored in DB (`app-vision`). Can be dropped into meetings as a section.
- **Metrics (Scorecard)** — cards focused on *this week* vs goal (green/yellow/red), last week + trend arrow, owner photo; grouped by owner (toggle). Click a card → full history + trend graph, editable weekly history. Per-metric **quarterly targets** with step %, direction (higher/lower better), "total ÷ 13 = weekly pace" vs "level" goals. **Salesforce report picker** + paste-a-report-link; **backfill** box to paste history. **🏢 Company metric** flag → shows on meeting scorecards.
- **Priorities** — the original quarterly dashboard (Rocks), pipeline stages, Gantt, roadmap, load; off-track/behind color flags.
- **Meetings** — list (attendee-filtered; superadmin sees all with toggle). Create: title, type (one-time / daily / weekly / biweekly / monthly), **day-of-week picker for daily**, date, time, timezone, length, attendees (photo cards). In a meeting: date ◀▶ nav, motivational quote on weekly meetings, drag-reorder sections, per-section ↻ refresh, live auto-sync every 10s. Section types: **text**, **Core Values/Vision**, **notes** (Good News — multiline, Shift+Enter, paste/attach images), **priorities today**, **priorities yesterday** (done/not-done carry-over), **issues** (Notion/Trello board), **metrics snapshot** (company metrics only), **quarterly priorities (Rocks)** with expandable Gantt (today line + past-due). Entries grouped by person, alphabetical; editable by their owner; **confetti** when a task is checked off.
- **Jira ticket sync** — put a ticket number in a task (`Ship the swap flow PCHT-1234`) and it grows a
  live chip linking to the ticket; when the ticket hits Done/Resolved/Closed the task ticks itself off.
  Works on quarterly-priority tasks and meeting to-dos. Runs on page load, when opening Priorities or a
  meeting, and on the **↻ Sync Jira** button (five-minute floor between automatic runs). Never un-ticks —
  un-ticking by hand tells it to leave that task alone. Reads Jira through the `jira-status` Edge Function
  so the API token stays off the site. Setup: `JIRA-SYNC-SETUP.md`.
- **Issues board** — Not started / In progress / Has update / Done columns, drag cards. Card detail = rich-text notes (bold/H2/lists/tables, paste tables), created-by + last-edited, comments. **Highlight text → right-click or ✅ To-Do button → assign as a weekly to-do** for a person; a "To-Dos from this issue" list shows below the notes; the resulting to-do carries a "🔗 from issue" chip back.
- **Team panel** — invite by email + role, change roles, remove, login status (Active/Pending), Slack profile photos (auto on invite + "Sync photos from Slack").
- **Auth** — real email/password login, "Forgot password?" flow, invite-to-set-password flow.
- **Favicon** = purple "NM" logo. Mobile-responsive throughout.

---

## 7. Hard-won gotchas / lessons (read before debugging)

1. **"Data only shows in my browser" = a Supabase table wasn't created.** Run the matching `supabase-*.sql`. Each new data feature needs its SQL run once.
2. **Concurrency = per-item rows.** Storing a whole collection in one row let people overwrite each other. Everything multi-user is now one row per item.
3. **Invite email `{}` / status-500 error was a broken email *template*,** not SMTP. Supabase's Go `html/template` rejected the branded invite HTML ("ends in a non-text context"). Fix: use a clean, balanced template (see `invite-email.html`); if in doubt, clear the template to Supabase's default. Resend/SMTP were fine the whole time (password resets delivered).
4. **Redeploys of the Edge Function silently didn't take** several times — always verify the "Last deployed" timestamp updated.
5. **"Verify JWT" must be OFF** on the function.
6. **"invalid JWT / unrecognized kid ES256"** when managing users = the session token went stale after JWT signing keys rotated → **log out and back in.**
7. **Redirect URLs / Site URL** in Supabase Auth must match the live app URL or invites fail.
8. **Can't re-view a Resend API key** after creation — make a new one if lost.
9. **SPF:** Resend's records sit on a `send` subdomain, so they don't conflict with the existing Google Workspace SPF on the root domain.
10. **Metric targets:** a quarterly target is graded weekly at target ÷ 13 (for "total" metrics); "level" metrics (e.g., Active Members) are measured against the full number each week, not divided.

---

## 8. Security notes

- Publishable/anon Supabase key in the client is fine by design (RLS protects data).
- The **service-role key** and **Resend API key** must never be in the site or the repo — only in Supabase settings / the Edge Function env.
- A Resend API key was pasted into chat during setup; **rotate it** (delete in Resend, create a fresh one, update Supabase SMTP) when convenient.

---

## 9. Open / possible next steps

- **Automated Salesforce + AWS Connect metric sync** (a scheduled Supabase Edge Function holding the SF/AWS credentials that writes weekly `metric_values`). Currently metrics are entered manually or backfilled from pasted exports. This is the biggest remaining build.
- Optional: a personal to-do list per person spanning all meetings (today, to-dos live per-meeting).
- Optional: extend image paste into issue-board cards; more email templates on-brand.

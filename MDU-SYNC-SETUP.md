# Weekly MDU metric auto-sync — setup

This makes the **MDU Access Agreements Signed** metric update itself every Monday
evening from the Salesforce report *"Units Signed This Quarter"* (report id
`00OOO000005fnt72AA`). The current grand total is the **Sum of Residential Unit
Count** (≈ 1,161 today), which is written into that week's value.

The work happens in a Supabase **Edge Function** (`sync-mdu-metric`) triggered by
Supabase **cron**, because that runs inside Supabase where it can reach both
Salesforce and the database.

Two files do the work:
- `sync-mdu-metric-function.ts` — the function code
- `supabase-mdu-cron.sql` — the weekly schedule

---

## 0. One-time: make the metric a "level to reach"

The Salesforce report already gives the **cumulative** units signed this quarter,
so the metric should just display that number against the goal. In the app open the
**MDU Access Agreements Signed** metric → **Edit metric & targets** → set
*"What kind of quarterly goal is this?"* to **"A level to reach"**, target **1,500**.
(That shows "1,161 / 1,500" and climbs each week — no weekly math needed.)

---

## 1. Create a Salesforce Connected App (gives the function permission to read the report)

Salesforce → **Setup** → search **App Manager** → **New Connected App**.
- Name: `Purple Cow Metric Sync`
- Enable **OAuth Settings**.
- Callback URL: `https://login.salesforce.com/services/oauth2/callback` (not used, but required).
- OAuth Scopes: add **Manage user data via APIs (api)** and **Perform requests at any time (refresh_token, offline_access)**.
- **Enable "Allow OAuth Username-Password Flows"** (this function uses the username/password grant for simplicity). In newer orgs this toggle is under Setup → **OAuth and OpenID Connect Settings**.
- Save. Open the app → **Manage Consumer Details** to copy the **Consumer Key** and **Consumer Secret**.

You'll also need the **security token** for the integration user (Setup → *personal
settings* → **Reset My Security Token**; it's emailed to that user). The function's
`SF_PASSWORD` = that user's password **immediately followed by** the security token,
no space.

> Use a dedicated integration user if you can, with read access to the report/folder.

## 2. Deploy the Edge Function

Supabase → **Edge Functions** → **Create a function** named exactly `sync-mdu-metric`
→ paste the contents of `sync-mdu-metric-function.ts` → **Deploy**.

Then in that function's **Settings**, turn **Verify JWT = OFF** (the cron job calls it
without a user login; it's protected by the shared secret below).

## 3. Add the secrets

Supabase → **Project Settings → Edge Functions → Secrets** (or Functions ▸ Secrets),
add:

| Name | Value |
|---|---|
| `SYNC_SECRET` | `pcmdu_19297495e4223f89aef0d120d7a2a778d35d` |
| `SF_LOGIN_URL` | `https://login.salesforce.com` |
| `SF_CLIENT_ID` | *(Connected App Consumer Key)* |
| `SF_CLIENT_SECRET` | *(Connected App Consumer Secret)* |
| `SF_USERNAME` | *(integration user's Salesforce username)* |
| `SF_PASSWORD` | *(their password + security token, concatenated)* |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are already available to functions —
you don't add those. **Never** put the service-role key or these SF secrets in the
website or the repo; they live only here.

## 4. Schedule it

Run `supabase-mdu-cron.sql` once in the **SQL Editor**. It enables the scheduler and
sets the job for **Monday 23:00 UTC (~8 PM Atlantic)**. Change the time in the cron
expression if you'd like it earlier/later.

## 5. Test it now

Trigger a run immediately (fills in this week without waiting for Monday):

```bash
curl -X POST https://pabuedfwiinvlhvmrslm.functions.supabase.co/sync-mdu-metric \
  -H "x-sync-secret: pcmdu_19297495e4223f89aef0d120d7a2a778d35d"
```

A success response looks like:
`{"ok":true,"results":[{"metric":"MDU Access Agreements Signed","week":"2026-08-...","value":1161}]}`

Then open the app → **Metrics** → the MDU card should show this week's number.
Check `select * from cron.job_run_details order by start_time desc limit 5;` to see
scheduled runs.

---

### Adding more report→metric syncs later
Edit the `JOBS` array at the top of `sync-mdu-metric-function.ts` — add
`{ reportId, metricName, aggregateIndex }` rows and redeploy. `aggregateIndex: 0`
is the report's first summary column (for this report, Sum of Residential Unit Count).

### Security notes
- The service-role key and all Salesforce secrets stay server-side in Supabase only.
- The function is guarded by `SYNC_SECRET`; rotate it by changing the secret in both
  Supabase and `supabase-mdu-cron.sql` (then re-run the SQL).

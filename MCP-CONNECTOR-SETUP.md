# Claude connector — setup

Connects Claude to Round Up so you can ask things like:

- "What's off track in Q4?"
- "What tasks does Operations owe other departments' priorities?"
- "Which metrics don't have a number yet this week?"
- "What are my open to-dos?"
- "Tick off the venue task on the training priority." (stage 2)
- "Put 22.2 in Breakage % for last week." (stage 2)
- "Add the Christmas gift boxes to my 1:1 with Brad." (stage 2)

**Stage 2 adds a few updates.** Claude can tick or update tasks, tick Definition of Done lines,
add and tick off to-dos, move issue cards, enter weekly metric numbers and add items to a
meeting's agenda. It checks with you
before each change, follows the same rules as the app about who can change what, never saves
over an edit someone made in the meantime, and logs every change (see `list_recent_changes`).
Filling in weekly metrics automatically (stage 3) comes later.

Each person connects with their own Round Up login, and Claude sees only what that
person sees in the app. A Team-role user gets only the priorities they PM or have a task on,
the metrics they own, and their own to-dos. A Super Admin sees every meeting.

---

## How it fits together

```
Claude ──► claude-connector (Supabase Edge Function) ──► the app's tables, as the person signed in
              ▲
              └── sign-in: Supabase OAuth Server ──► oauth-consent.html (on the app's site) ──► "Allow"
```

- `claude-connector-function.ts`: the connector itself. It holds no keys and no
  passwords. It only uses the token of whoever signed in.
- `oauth-consent.html`: the "Allow Claude to read Round Up?" page. It's on the
  app's site, so anyone already logged in to the app just clicks **Allow**. It only
  approves requests that come back to Claude (claude.ai / claude.com).

Nothing else in the app changes, and the app keeps working exactly as before.

---

## One-time setup

### 1. Push the two files

Push `oauth-consent.html` along with everything else. GitHub Pages will serve it at
`https://farquhar86.github.io/Purple-Cow-Meetings/oauth-consent.html`.

### 2. Turn on Supabase's OAuth Server

Supabase ▸ Authentication ▸ **OAuth Server** (marked Beta):

1. **Enable** the OAuth server.
2. **Authorization Path:** `/oauth-consent.html`
   Supabase adds this to the Site URL, so the preview shows a double slash
   (`…/Purple-Cow-Meetings//oauth-consent.html`). That's fine: GitHub Pages serves it.
3. **Allow Dynamic OAuth Apps: OFF.** Leaving it on would let anyone register an app and try
   to trick staff into approving it. Claude is registered by hand instead (next step).
4. Save.

There's no extra charge for this on the Pro plan. People who sign in this way count toward
monthly active users, but they're people who already use the app.

### 2b. Register Claude as an OAuth app

Supabase ▸ Authentication ▸ **OAuth Apps** ▸ **New OAuth App**:

- Name: `Claude`
- Redirect URIs: `https://claude.ai/api/mcp/auth_callback` and
  `https://claude.com/api/mcp/auth_callback`
- Public Client: off. Token Endpoint Auth Method: `client_secret_basic`.

Create it, then copy the **Client ID** and **Client Secret** into a password manager.
Supabase shows the secret only once. If it's lost, generate a new one from the same page and
update the connector in Claude.

### 3. Deploy the function

1. Supabase ▸ Edge Functions ▸ **Create function**, name it exactly `claude-connector`.
2. Paste in the whole of `claude-connector-function.ts`. **Deploy.**
3. **Check that the "Last deployed" timestamp actually changed.** Deploys have silently
   failed before (see the handoff notes).
4. Open the function's **Settings** and turn **Verify JWT OFF**. The function checks the
   token itself, and it has to answer signed-out requests with the sign-in details Claude
   needs. (`SUPABASE_URL` and `SUPABASE_ANON_KEY` are already set. No new secrets needed.)

### 4. Quick check

Open this in a browser:
`https://pabuedfwiinvlhvmrslm.supabase.co/functions/v1/claude-connector/.well-known/oauth-protected-resource`

You should see a short block of text that includes
`"authorization_servers":["https://pabuedfwiinvlhvmrslm.supabase.co/auth/v1"]`.

### 5. Add it in Claude

**Your own Claude account:** in Claude's Connectors settings, choose **Add custom connector**.
- Name: `Round Up`
- URL: `https://pabuedfwiinvlhvmrslm.supabase.co/functions/v1/claude-connector`
- Open **Advanced settings** and paste the **OAuth Client ID** and **OAuth Client Secret**
  from step 2b.

Click **Connect**. You'll land on the Round Up approval page. Sign in if asked, then
click **Allow**.

**A company Team account:** an Owner adds it once with the same name, URL, Client ID and
Client Secret, and then each person clicks **Connect** and signs in.

### 6. Test it

In a new chat with the connector turned on, ask:
1. "Who am I in Round Up?" It should show your email and role.
2. "List the Q4 priorities that are off track." Compare the answer with the Priorities screen.
3. "Which metrics are missing a number this week?"

Then have a Team-role person run the same three and check that they only see their own work.

---

## If something goes wrong

| What you see | Likely cause |
|---|---|
| Claude says it can't connect, or the approval page never shows | OAuth Server not enabled, the Client ID/Secret weren't entered in Advanced settings, or the function's **Verify JWT** is still on. |
| You click **Allow**, land back in Claude, and it still says it couldn't connect | The Client Secret was mistyped, or Claude sends it differently. Re-paste it. If that doesn't fix it, change the Claude app's Token Endpoint Auth Method in Supabase to `client_secret_post`. |
| The approval page shows "Page not found" | The Authorization Path doesn't match the file name, or `oauth-consent.html` isn't pushed yet. Check the address bar: it should end in `/Purple-Cow-Meetings/oauth-consent.html?authorization_id=…`. |
| "This sign-in request has expired" | The approval code only lasts 10 minutes. Go back to Claude and click Connect again. |
| "This request isn't coming from Claude" | Something other than Claude tried to get access. Close the page. |
| Claude connects but every answer is an error | Redeploy the function and confirm "Last deployed" changed. The function's **Logs** tab shows the real error. |
| Someone sees less than they expect | They're a Team-role user. That's by design, and it matches the app. |
| Claude says "Updates aren't switched on yet" | `supabase-role-rules.sql` hasn't been run. Run it once in the SQL Editor (see "Turning on updates" below). |
| Claude says the database refused a change | The person's role doesn't allow it (the same rule as in the app). Nothing was saved. |
| Claude says someone else is editing it | Someone saved the same priority three times while Claude tried. Nothing was saved; try again. |

To cut off someone's access, remove the connector in Claude. To cut off everyone's, turn
the OAuth Server off or delete the function. Neither affects the app itself.

---

## Turning on updates (stage 2)

1. In Supabase ▸ SQL Editor, run **`supabase-role-rules.sql`** once. It's safe to run again.
   - It makes the database itself enforce the app's role rules (until now it only checked that
     someone was logged in), and adds the two pieces the connector's updates need:
     `ru_save_if_unchanged` and the `connector_log` table.
   - If anything goes wrong in the app afterwards, run **`supabase-role-rules-undo.sql`**. It
     puts the rules back exactly as they were and leaves the connector's pieces in place.
2. Redeploy the `claude-connector` function with the new `claude-connector-function.ts`
   (paste it in, Deploy, and check that "Last deployed" changed). Verify JWT stays OFF.
3. Push `oauth-consent.html` so the Allow page lists what Claude can now change.
4. In Claude, open the Round Up connector and reconnect it (or start a new chat) so the new
   tools show up. Then try one low-risk change, like ticking one of your own tasks.
5. For metric comments (`set_metric_comment`), also run **`supabase-metric-comments.sql`** once.
   It lets the connector's safe save work on metrics. Safe to run again.

A login with no role set counts as Admin, in the app and in the database. Set a role in the
app's Team panel for anyone who shouldn't be an Admin.

---

## What Claude can read

| Tool | What it answers |
|---|---|
| `who_am_i` | Your email, role, and what that role can see |
| `list_quarters` | Quarters, their themes and goals, and how many priorities are in play |
| `list_priorities` | Priorities by quarter, department (home or contributing), person, stage or off-track/behind |
| `get_priority` | One priority in full: why, notes, Definition of Done, and every task |
| `list_tasks` | Tasks across priorities for a person or a contributing department |
| `list_metrics` | Scorecard metrics: how each one fills, this week, last week, quarter target, and what's missing |
| `get_metric` | One metric's weekly history, with any weekly comments |
| `list_todos` | To-dos (yours by default; Admins can see everyone's) |
| `list_issues` | Issues board cards from meetings you can see |
| `list_meetings` | Meetings you're in: when they run, the next date, who's in them, and which sections take entries |
| `get_meeting` | One meeting's agenda for a date (the next one by default): notes, topics and their points, to-dos, open issue cards |
| `list_special_projects` | Special projects by status |
| `get_core_values` | The Core Values / Vision page |
| `list_recent_changes` | Changes made through Claude: who, when, what (Admins see everyone's) |

## What Claude can change (stage 2)

Claude confirms each change with you first, and does one change per call.

| Tool | What it does | Who can |
|---|---|---|
| `update_task` | Tick a task done or un-tick it, set its %, move its start or end date, add a note. Works like the app: a finished task drops to the bottom, un-ticking restores its old %, a later end date counts as a bump, and the priority's stage updates itself. Works on special projects too. | Anyone on that priority (Team users: only priorities they PM, are assigned to, or have a task on) |
| `set_dod_line` | Tick or un-tick a Definition of Done line. All lines ticked = the priority is complete. | Same as above |
| `add_todo` | Add a to-do to the To-Dos page, due in a week unless a date is given. | Everyone for themselves; Admins and Leadership for anyone |
| `complete_todo` | Mark a to-do done or not done. | The to-do's owner, plus Admins and Super Admins |
| `move_issue` | Move an issue card between Not started, In progress, Has update and Done. | Anyone who can see that meeting |
| `set_metric_value` | Enter or clear one week's number. Defaults to last week (Monday's number is last week's). Won't fill calculated or roll-up metrics. | The metric's owner (Team users); everyone else for any metric |
| `set_metric_comment` | Add, change or clear the comment on one week of a metric (the 🗣️ note on the scorecard). Defaults to this week, the week the scorecard is showing. Works on roll-up and calculated metrics too. | The metric's owner (Team users); everyone else for any metric |
| `add_to_meeting` | Put an item on a meeting's agenda: a topic (with points under it), a note, a to-do for someone in the meeting, or an issue card. Goes on the next meeting that hasn't ended yet unless a date is given. With no section named it goes in Topics, or the Issues list if there's no Topics section. Won't add the same thing twice. | Anyone in that meeting (as in the app) |

Not yet: creating or deleting priorities, changing owners or departments, or editing or removing what's already in a meeting.

"Off track" and "behind" use the same rules as the app: off track means a task is past its
end date and not at 100%, and behind means progress is more than 10 points under where the
timeline says it should be.

---

## Coming next

- **Stage 3: weekly metrics fill themselves.** Metrics tagged Salesforce or AWS Connect get
  their number each week. The rest stay with their owners. A check flags any auto metric
  that didn't get its number.

# Claude connector — setup

Connects Claude to Not Metronome so you can ask things like:

- "What's off track in Q4?"
- "What tasks does Operations owe other departments' priorities?"
- "Which metrics don't have a number yet this week?"
- "What are my open to-dos?"

**Stage 1 is read-only.** Claude can look things up but can't change anything in the app.
Updates (stage 2) and filling in weekly metrics (stage 3) come later.

Each person connects with their own Not Metronome login, and Claude sees only what that
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
- `oauth-consent.html`: the "Allow Claude to read Not Metronome?" page. It's on the
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
   Supabase adds this to the Site URL (`https://farquhar86.github.io/Purple-Cow-Meetings/`).
3. **Allow dynamic client registration: ON.** This is how Claude registers itself the
   first time someone clicks Connect.
4. Save.

There's no extra charge for this on the Pro plan. People who sign in this way count toward
monthly active users, but they're people who already use the app.

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
- Name: `Not Metronome`
- URL: `https://pabuedfwiinvlhvmrslm.supabase.co/functions/v1/claude-connector`

Click **Connect**. You'll land on the Not Metronome approval page. Sign in if asked, then
click **Allow**.

**A company Team account:** an Owner adds it once with the same name and URL, and then each
person clicks **Connect** and signs in.

### 6. Test it

In a new chat with the connector turned on, ask:
1. "Who am I in Not Metronome?" It should show your email and role.
2. "List the Q4 priorities that are off track." Compare the answer with the Priorities screen.
3. "Which metrics are missing a number this week?"

Then have a Team-role person run the same three and check that they only see their own work.

---

## If something goes wrong

| What you see | Likely cause |
|---|---|
| Claude says it can't connect, or the approval page never shows | OAuth Server not enabled, dynamic client registration off, or the function's **Verify JWT** is still on. |
| The approval page shows "Page not found" | The Authorization Path doesn't match the file name, or `oauth-consent.html` isn't pushed yet. Check the address bar: it should end in `/Purple-Cow-Meetings/oauth-consent.html?authorization_id=…`. |
| "This sign-in request has expired" | The approval code only lasts 10 minutes. Go back to Claude and click Connect again. |
| "This request isn't coming from Claude" | Something other than Claude tried to get access. Close the page. |
| Claude connects but every answer is an error | Redeploy the function and confirm "Last deployed" changed. The function's **Logs** tab shows the real error. |
| Someone sees less than they expect | They're a Team-role user. That's by design, and it matches the app. |

To cut off someone's access, remove the connector in Claude. To cut off everyone's, turn
the OAuth Server off or delete the function. Neither affects the app itself.

---

## What Claude can read (stage 1)

| Tool | What it answers |
|---|---|
| `who_am_i` | Your email, role, and what that role can see |
| `list_quarters` | Quarters, their themes and goals, and how many priorities are in play |
| `list_priorities` | Priorities by quarter, department (home or contributing), person, stage or off-track/behind |
| `get_priority` | One priority in full: why, notes, Definition of Done, and every task |
| `list_tasks` | Tasks across priorities for a person or a contributing department |
| `list_metrics` | Scorecard metrics: how each one fills, this week, last week, quarter target, and what's missing |
| `get_metric` | One metric's weekly history |
| `list_todos` | To-dos (yours by default; Admins can see everyone's) |
| `list_issues` | Issues board cards from meetings you can see |
| `list_special_projects` | Special projects by status |
| `get_core_values` | The Core Values / Vision page |

"Off track" and "behind" use the same rules as the app: off track means a task is past its
end date and not at 100%, and behind means progress is more than 10 points under where the
timeline says it should be.

---

## Coming next

- **Stage 2: updates from Claude.** Tick tasks, change task %, add to-dos, and move issues,
  limited to what each person can already change in the app.
- **Stage 3: weekly metrics fill themselves.** Metrics tagged Salesforce or AWS Connect get
  their number each week. The rest stay with their owners. A check flags any auto metric
  that didn't get its number.

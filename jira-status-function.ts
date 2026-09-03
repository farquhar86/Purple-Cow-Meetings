// Supabase Edge Function: jira-status
// Looks up the status of Jira tickets for the planning app.
//
// The app can't call Jira from the browser (Jira Cloud blocks cross-site calls, and the
// API token would be visible to anyone who views the page), so the token lives here on
// the server and the site asks this function instead.
//
// ---- Environment variables (Supabase ▸ Project Settings ▸ Edge Functions ▸ Secrets) ----
//   SUPABASE_URL                (already set for the project)
//   SUPABASE_ANON_KEY           (already set)
//   JIRA_BASE_URL               https://purplecowinternet.atlassian.net
//   JIRA_EMAIL                  the Atlassian account the token belongs to
//   JIRA_API_TOKEN              an API token from id.atlassian.com ▸ Security ▸ API tokens
//
// "Verify JWT" must be OFF (Edge Functions ▸ jira-status ▸ Settings) — like manage-users,
// this function checks the caller's login itself.
//
// Call it with:  { action:'status', keys:['PCHT-1234','DEV-77'] }
// It answers with: { issues:{ 'PCHT-1234':{summary,status,category,resolved,url} },
//                    unknown:['Q1-2026'], errors:[] }
// `category` is Jira's status category: 'new' | 'indeterminate' | 'done'.
// The app treats category === 'done' as "the ticket is finished".

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_KEYS = 100;

// The list of real project keys, remembered between calls so we don't ask Jira every time.
let projectKeys: Set<string> | null = null;
let projectKeysAt = 0;
const PROJECTS_TTL = 10 * 60 * 1000; // 10 minutes

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const json = (obj: unknown, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // 1) Confirm the caller is a logged-in user
    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const asUser = createClient(url, anonKey, { global: { headers: { Authorization: `Bearer ${token}` } } });
    const { data: { user }, error: authErr } = await asUser.auth.getUser(token);
    if (authErr || !user) return json({ error: "Not authorized — please log in again." }, 401);

    // 2) Jira credentials
    const base = (Deno.env.get("JIRA_BASE_URL") || "").replace(/\/+$/, "");
    const email = Deno.env.get("JIRA_EMAIL") || "";
    const apiToken = Deno.env.get("JIRA_API_TOKEN") || "";
    if (!base || !email || !apiToken) {
      return json({ error: "Jira isn't set up yet — JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN need to be added as secrets." }, 503);
    }
    const jiraHeaders = {
      Authorization: "Basic " + btoa(`${email}:${apiToken}`),
      Accept: "application/json",
      "Content-Type": "application/json",
    };

    const body = await req.json().catch(() => ({}));
    if (body.action && body.action !== "status") return json({ error: "Unknown action." }, 400);

    // 3) Tidy the requested keys: upper-case, de-duplicated, capped.
    const raw: string[] = Array.isArray(body.keys) ? body.keys : [];
    const keys = [...new Set(raw.map((k) => String(k || "").trim().toUpperCase()).filter((k) => /^[A-Z][A-Z0-9]{0,9}-\d+$/.test(k)))]
      .slice(0, MAX_KEYS);
    if (!keys.length) return json({ issues: {}, unknown: [], errors: [] });

    // 4) Which project prefixes actually exist? Anything else (e.g. "Q1-2026" typed in a
    //    task title) is reported back as unknown rather than sent to Jira, because a single
    //    bad key makes the whole JQL search fail.
    const errors: string[] = [];
    if (!projectKeys || Date.now() - projectKeysAt > PROJECTS_TTL) {
      try {
        const found = new Set<string>();
        let startAt = 0;
        while (true) {
          const r = await fetch(`${base}/rest/api/3/project/search?maxResults=100&startAt=${startAt}`, { headers: jiraHeaders });
          if (!r.ok) throw new Error(`project/search ${r.status}`);
          const j = await r.json();
          (j.values || []).forEach((p: { key: string }) => found.add(String(p.key).toUpperCase()));
          if (j.isLast !== false) break;
          startAt += (j.values || []).length;
          if (!(j.values || []).length || startAt > 1000) break;
        }
        projectKeys = found;
        projectKeysAt = Date.now();
      } catch (e) {
        // Couldn't list projects — carry on and let the per-issue fallback sort it out.
        errors.push("Couldn't list Jira projects: " + (e instanceof Error ? e.message : String(e)));
      }
    }

    const unknown: string[] = [];
    const wanted = keys.filter((k) => {
      if (!projectKeys) return true;
      if (projectKeys.has(k.split("-")[0])) return true;
      unknown.push(k);
      return false;
    });
    if (!wanted.length) return json({ issues: {}, unknown, errors });

    // 5) Ask Jira. One search for the lot; if that fails (a key that was deleted or that
    //    this account can't see makes the whole query 400), fall back to one call per key.
    const issues: Record<string, unknown> = {};
    const shape = (it: { key: string; fields?: Record<string, any> }) => {
      const f = it.fields || {};
      const st = f.status || {};
      return {
        summary: f.summary || "",
        status: st.name || "",
        category: (st.statusCategory && st.statusCategory.key) || "",
        resolved: f.resolutiondate || null,
        url: `${base}/browse/${it.key}`,
      };
    };

    let bulkOk = false;
    try {
      const r = await fetch(`${base}/rest/api/3/search/jql`, {
        method: "POST",
        headers: jiraHeaders,
        body: JSON.stringify({
          jql: `key in (${wanted.join(",")})`,
          fields: ["summary", "status", "resolutiondate"],
          maxResults: MAX_KEYS,
        }),
      });
      if (r.ok) {
        const j = await r.json();
        (j.issues || []).forEach((it: { key: string }) => { issues[String(it.key).toUpperCase()] = shape(it as never); });
        bulkOk = true;
      }
    } catch (_e) { /* fall through to the per-key path */ }

    if (!bulkOk) {
      for (const k of wanted) {
        try {
          const r = await fetch(`${base}/rest/api/3/issue/${encodeURIComponent(k)}?fields=summary,status,resolutiondate`, { headers: jiraHeaders });
          if (r.status === 404 || r.status === 403) { unknown.push(k); continue; }
          if (!r.ok) { errors.push(`${k}: Jira returned ${r.status}`); continue; }
          const it = await r.json();
          issues[k] = shape(it);
        } catch (e) {
          errors.push(`${k}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } else {
      // Anything the search didn't return doesn't exist for this account.
      wanted.forEach((k) => { if (!issues[k]) unknown.push(k); });
    }

    return json({ issues, unknown, errors });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

// Supabase Edge Function: sync-mdu-metric
// Pulls a Salesforce report total each week and writes it into a metric's
// weekly value in the app — no human step.
//
// It runs INSIDE Supabase (which can reach both Salesforce and the database),
// triggered on a schedule by pg_cron (see supabase-mdu-cron.sql).
//
// ---- Environment variables (Supabase ▸ Project Settings ▸ Edge Functions ▸ Secrets) ----
//   SUPABASE_URL                (already set for the project)
//   SUPABASE_SERVICE_ROLE_KEY   (already set — server-side only, never in the site)
//   SYNC_SECRET                 a shared secret; the cron job must send the same value
//   SF_LOGIN_URL                https://login.salesforce.com   (or https://test.salesforce.com for sandbox)
//   SF_CLIENT_ID                Connected App consumer key
//   SF_CLIENT_SECRET            Connected App consumer secret
//   SF_USERNAME                 the integration user's Salesforce username
//   SF_PASSWORD                 that user's password IMMEDIATELY followed by their security token
//
// "Verify JWT" must be OFF for this function (Edge Functions ▸ sync-mdu-metric ▸ Settings),
// because the cron job calls it without a user login. It is protected by SYNC_SECRET instead.

// Which Salesforce report feeds which metric. Add more rows here to sync more metrics.
const JOBS = [
  {
    reportId: "00OOO000005fnt72AA",             // "Units Signed This Quarter"
    metricName: "MDU Access Agreements Signed",  // must match the metric name in the app
    aggregateIndex: 0,                            // 0 = Sum of Residential Unit Count (the grand-total column)
  },
];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-sync-secret, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const p2 = (n: number) => String(n).padStart(2, "0");

// First day of the current calendar quarter, America/Halifax, as YYYY-MM-DD.
function halifaxQuarterStart(): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Halifax", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const y = +get("year"), mo = +get("month");
  const qStartMonth = Math.floor((mo - 1) / 3) * 3 + 1; // 1,4,7,10
  return y + "-" + p2(qStartMonth) + "-01";
}

// The Sunday that starts the current week, in America/Halifax time, as YYYY-MM-DD.
// Matches the "week start" the app uses (default week start = Sunday).
function halifaxWeekStart(): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Halifax",
    year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const y = +get("year"), mo = +get("month"), d = +get("day");
  const dow = ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 } as Record<string, number>)[get("weekday")];
  const base = new Date(Date.UTC(y, mo - 1, d));
  base.setUTCDate(base.getUTCDate() - dow);
  return base.getUTCFullYear() + "-" + p2(base.getUTCMonth() + 1) + "-" + p2(base.getUTCDate());
}

async function salesforceToken(): Promise<{ access_token: string; instance_url: string }> {
  const login = Deno.env.get("SF_LOGIN_URL") || "https://login.salesforce.com";
  const body = new URLSearchParams({
    grant_type: "password",
    client_id: Deno.env.get("SF_CLIENT_ID")!,
    client_secret: Deno.env.get("SF_CLIENT_SECRET")!,
    username: Deno.env.get("SF_USERNAME")!,
    password: Deno.env.get("SF_PASSWORD")!, // password + security token, concatenated
  });
  const r = await fetch(login + "/services/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error("Salesforce auth failed: " + JSON.stringify(j));
  return { access_token: j.access_token, instance_url: j.instance_url };
}

async function reportGrandTotal(auth: { access_token: string; instance_url: string }, reportId: string, aggIdx: number): Promise<number> {
  const r = await fetch(`${auth.instance_url}/services/data/v60.0/analytics/reports/${reportId}?includeDetails=false`, {
    headers: { Authorization: `Bearer ${auth.access_token}` },
  });
  const j = await r.json();
  if (!r.ok) throw new Error("Report fetch failed: " + JSON.stringify(j));
  const agg = j?.factMap?.["T!T"]?.aggregates?.[aggIdx];
  const val = agg && (typeof agg.value === "number" ? agg.value : Number(agg.value));
  if (val === undefined || val === null || isNaN(val)) throw new Error("Could not read grand total from report " + reportId);
  return Math.round(val);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const json = (o: unknown, status = 200) =>
    new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const secret = Deno.env.get("SYNC_SECRET")!;

    // Simple shared-secret guard (header or JSON body)
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const given = req.headers.get("x-sync-secret") || (body as { secret?: string }).secret || "";
    if (!secret || given !== secret) return json({ error: "Unauthorized" }, 401);

    const wk = halifaxWeekStart();
    const auth = await salesforceToken();

    // Load the metric list once so we can resolve each job's metric by name.
    const mres = await fetch(`${url}/rest/v1/metrics?select=id,data`, {
      headers: { apikey: service, Authorization: `Bearer ${service}` },
    });
    const metrics = await mres.json();
    if (!Array.isArray(metrics)) throw new Error("Could not read metrics: " + JSON.stringify(metrics));

    const results: unknown[] = [];
    for (const job of JOBS) {
      const metric = metrics.find(
        (m: { data?: { name?: string } }) => ((m.data && m.data.name) || "").trim().toLowerCase() === job.metricName.toLowerCase(),
      );
      if (!metric) { results.push({ metric: job.metricName, error: "metric not found in the app" }); continue; }

      const reportTotal = await reportGrandTotal(auth, job.reportId, job.aggregateIndex);

      // The metric is a "running total" that SUMS the weekly numbers, but the report is
      // already cumulative for the quarter — so store this week's NEW amount:
      //   thisWeek = report total − everything already counted earlier this quarter.
      const qStart = halifaxQuarterStart();
      let priorSum = 0;
      try {
        const pv = await fetch(
          `${url}/rest/v1/metric_values?metric_id=eq.${metric.id}&wk=gte.${qStart}&wk=lt.${wk}&select=value`,
          { headers: { apikey: service, Authorization: `Bearer ${service}` } },
        );
        const prior = await pv.json();
        if (Array.isArray(prior)) priorSum = prior.reduce((s: number, r: { value?: unknown }) => s + (Number(r.value) || 0), 0);
      } catch (_) { /* first run of the quarter: nothing prior */ }

      const value = reportTotal - priorSum;
      const rowId = `${metric.id}|${wk}`;

      const up = await fetch(`${url}/rest/v1/metric_values`, {
        method: "POST",
        headers: {
          apikey: service,
          Authorization: `Bearer ${service}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates",
        },
        body: JSON.stringify({ id: rowId, metric_id: metric.id, wk, value }),
      });
      if (!up.ok) { results.push({ metric: job.metricName, error: "write failed: " + (await up.text()) }); continue; }
      results.push({ metric: job.metricName, week: wk, reportTotal, priorSum, thisWeek: value });
    }
    return json({ ok: true, ranAt: new Date().toISOString(), results });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});

// Supabase Edge Function: herd-products
// Live product breakdown for the Active Herd Members popup in Round Up.
// Pulls the counts from Salesforce, checks them, and saves one row to herd_product_counts.
//
// Two ways it runs:
//   1. On a schedule (every 15 minutes, see supabase-herd-products.sql). The cron job sends
//      the shared SYNC_SECRET in the x-sync-secret header.
//   2. When someone presses "Refresh" in the popup. The app sends the person's login token,
//      and this function checks it. If a good pull is less than a minute old, it hands that
//      back instead of asking Salesforce again.
//
// ---- Environment variables (Supabase ▸ Project Settings ▸ Edge Functions ▸ Secrets) ----
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY   (already set for the project)
//   SYNC_SECRET                 shared secret the cron job sends (same one sync-mdu-metric uses)
//   SF_LOGIN_URL                https://login.salesforce.com
//   SF_CLIENT_ID / SF_CLIENT_SECRET / SF_USERNAME / SF_PASSWORD
//                               the same Salesforce Connected App login sync-mdu-metric uses
//
// "Verify JWT" must be OFF (Edge Functions ▸ herd-products ▸ Settings). The cron job has no
// login, so this function checks the secret or the person's login itself.
//
// What each number is (all from Salesforce):
//   internet        live internet services: SUM(Customer_Details__c.Live_Internet_Count__c)
//   fibre           of those, Purple Fibre: SUM(Live_Purple_Fibre_Internet_Count__c)
//   cable           internet minus fibre (TPIA: Eastlink and Bell)
//   mobile_lines    Mobile__c with Line_Status__c = 'Active'
//   mobile_members  Customer_Details__c with Has_Active_Mobile__c = true
//   mobile_only     ...and Is_Mobile_Only__c = true
//   tv              TV__c (Purple Cow TV record type) with current_account_status__c = 'ACTIVE'
//   phone           Phone__c with Account_Status__c = 'Active' and Stage__c = 'Live'

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-sync-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const REUSE_IF_NEWER_THAN_MS = 60 * 1000; // a Refresh within a minute of a good pull reuses it

type SfAuth = { access_token: string; instance_url: string };

async function salesforceToken(): Promise<SfAuth> {
  const login = Deno.env.get("SF_LOGIN_URL") || "https://login.salesforce.com";
  const body = new URLSearchParams({
    grant_type: "password",
    client_id: Deno.env.get("SF_CLIENT_ID") || "",
    client_secret: Deno.env.get("SF_CLIENT_SECRET") || "",
    username: Deno.env.get("SF_USERNAME") || "",
    password: Deno.env.get("SF_PASSWORD") || "", // password + security token, concatenated
  });
  const r = await fetch(login + "/services/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error("Salesforce login failed: " + (j.error_description || j.error || r.status));
  return { access_token: j.access_token, instance_url: j.instance_url };
}

async function soql(auth: SfAuth, q: string): Promise<{ totalSize: number; records: Record<string, unknown>[] }> {
  const r = await fetch(`${auth.instance_url}/services/data/v60.0/query?q=${encodeURIComponent(q)}`, {
    headers: { Authorization: `Bearer ${auth.access_token}` },
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j) {
    const msg = Array.isArray(j) && j[0] ? (j[0].message || j[0].errorCode) : r.status;
    throw new Error("Salesforce query failed (" + msg + "): " + q.slice(0, 80));
  }
  return j;
}

const num = (v: unknown) => (v === null || v === undefined || v === "" || isNaN(Number(v)) ? null : Math.round(Number(v)));

async function pullCounts(auth: SfAuth) {
  const [inet, mob, mobMembers, mobOnly, tv, phone] = await Promise.all([
    soql(auth, "SELECT SUM(Live_Internet_Count__c) total, SUM(Live_Purple_Fibre_Internet_Count__c) fibre FROM Customer_Details__c"),
    soql(auth, "SELECT COUNT() FROM Mobile__c WHERE Line_Status__c = 'Active'"),
    soql(auth, "SELECT COUNT() FROM Customer_Details__c WHERE Has_Active_Mobile__c = true"),
    soql(auth, "SELECT COUNT() FROM Customer_Details__c WHERE Has_Active_Mobile__c = true AND Is_Mobile_Only__c = true"),
    soql(auth, "SELECT COUNT() FROM TV__c WHERE current_account_status__c = 'ACTIVE' AND RecordType.DeveloperName = 'Purple_Cow_TV'"),
    soql(auth, "SELECT COUNT() FROM Phone__c WHERE Account_Status__c = 'Active' AND Stage__c = 'Live'"),
  ]);
  const agg = inet.records[0] || {};
  const internet = num(agg.total);
  const fibre = num(agg.fibre);
  return {
    internet,
    fibre,
    cable: internet !== null && fibre !== null ? internet - fibre : null,
    mobile_lines: mob.totalSize,
    mobile_members: mobMembers.totalSize,
    mobile_only: mobOnly.totalSize,
    tv: tv.totalSize,
    phone: phone.totalSize,
  };
}

// The check: every number has to come back, and TPIA (cable) and Fibre are checked on their
// own so one side quietly coming back empty can't hide inside the internet total.
function problems(c: Record<string, number | null>): string[] {
  const out: string[] = [];
  const need: [string, string][] = [
    ["internet", "Internet"], ["cable", "Cable (TPIA)"], ["fibre", "Purple Fibre"],
    ["mobile_lines", "Mobile"], ["tv", "TV"], ["phone", "Home Phone"],
  ];
  for (const [k, label] of need) {
    const v = c[k];
    if (v === null || v === undefined) out.push(label + " came back blank");
    else if (v <= 0) out.push(label + " came back 0");
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const json = (o: unknown, status = 200) =>
    new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

  const url = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const db = createClient(url, service);

  // 1) Who's asking: the schedule (shared secret) or a logged-in person (Refresh button)
  let source = "";
  const secret = Deno.env.get("SYNC_SECRET") || "";
  if (secret && req.headers.get("x-sync-secret") === secret) source = "schedule";
  else {
    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    if (token && token !== anonKey) {
      const asUser = createClient(url, anonKey, { global: { headers: { Authorization: `Bearer ${token}` } } });
      const { data: { user } } = await asUser.auth.getUser(token);
      if (user) source = "refresh:" + (user.email || user.id);
    }
  }
  if (!source) return json({ error: "Not authorized. Please log in again." }, 401);

  // 2) A Refresh right after a good pull just gets that pull back
  if (source !== "schedule") {
    const { data: recent } = await db.from("herd_product_counts").select("*")
      .eq("ok", true).order("taken_at", { ascending: false }).limit(1);
    const last = recent && recent[0];
    if (last && Date.now() - new Date(last.taken_at).getTime() < REUSE_IF_NEWER_THAN_MS) {
      return json({ ok: true, reused: true, row: last });
    }
  }

  // 3) Pull, check, save. A failed pull is saved too, so the popup can show it.
  let row: Record<string, unknown>;
  try {
    const auth = await salesforceToken();
    const counts = await pullCounts(auth);
    const issues = problems(counts);
    row = { ...counts, source, ok: issues.length === 0, error: issues.length ? issues.join("; ") : null };
  } catch (e) {
    row = { source, ok: false, error: String((e as Error)?.message || e).slice(0, 500) };
  }
  const { data: saved, error: saveErr } = await db.from("herd_product_counts").insert(row).select().single();
  if (saveErr) return json({ error: "Pulled from Salesforce but couldn't save: " + saveErr.message, row }, 500);
  return json({ ok: row.ok, row: saved }, row.ok ? 200 : 502);
});

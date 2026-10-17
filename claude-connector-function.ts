// Supabase Edge Function: claude-connector
// Lets Claude read Round Up: quarterly priorities and their tasks, the weekly
// metrics scorecard, to-dos, issues, special projects and the core values page.
//
// Stage 1 is READ-ONLY. Nothing in this file writes to the database.
//
// How it fits together
//   Claude ──► this function (an MCP server) ──► the app's Supabase tables, as the person signed in
//   Sign-in uses Supabase's OAuth 2.1 Server. When someone clicks Connect in Claude, Supabase sends
//   them to oauth-consent.html on the app's site, they approve, and Claude gets a token for that
//   person. Every request runs with that person's token, so the database's own rules apply, and on
//   top of that this file hides what the app hides from Team-role users.
//
// ---- Environment variables (Supabase sets both for every function automatically) ----
//   SUPABASE_URL                the project URL
//   SUPABASE_ANON_KEY           the publishable key
//   CONNECTOR_URL   (optional)  this function's public URL, if it ever differs from
//                               <SUPABASE_URL>/functions/v1/claude-connector
//
// "Verify JWT" must be OFF (Edge Functions ▸ claude-connector ▸ Settings). This function checks
// the token itself, and it has to answer signed-out requests with the sign-in details Claude needs.
//
// The connector URL to paste into Claude:
//   https://pabuedfwiinvlhvmrslm.supabase.co/functions/v1/claude-connector
//
// Full setup: MCP-CONNECTOR-SETUP.md

const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") || "").replace(/\/+$/, "");
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const FN_NAME = "claude-connector";
const RESOURCE = (Deno.env.get("CONNECTOR_URL") || `${SUPABASE_URL}/functions/v1/${FN_NAME}`).replace(/\/+$/, "");
const RESOURCE_METADATA_URL = `${RESOURCE}/.well-known/oauth-protected-resource`;
const AUTH_SERVER = `${SUPABASE_URL}/auth/v1`;
const APP_URL = "https://farquhar86.github.io/Purple-Cow-Meetings/";
const TZ = "America/Halifax";

const SERVER_INFO = { name: "round-up", title: "Round Up", version: "0.1.0" };
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = [
  "Round Up is Purple Cow Internet's planning app (" + APP_URL + ").",
  "It holds quarterly priorities (also called rocks) with their tasks, the weekly metrics scorecard,",
  "to-dos from meetings, the issues board, special projects and the core values page.",
  "This connector is read-only. 'me' means the person who connected it.",
  "Dates are Atlantic time; metric weeks start on Sunday and are keyed by that Sunday's date.",
  "A task is off track when it is past its end date and not 100%. A priority is off track when",
  "any task is off track, and behind when its progress is more than 10 points under where the",
  "timeline says it should be.",
].join(" ");

const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
};

// deno-lint-ignore no-explicit-any
type Json = any;

// ============================================================================================
// Dates (string-based, Atlantic time)
// ============================================================================================

const p2 = (n: number) => String(n).padStart(2, "0");

function todayYMD(): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function ymd(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function dayNum(s: string): number {
  const [y, m, d] = s.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

function fromDayNum(n: number): string {
  const d = new Date(n * 86400000);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}

const addDays = (s: string, n: number) => fromDayNum(dayNum(s) + n);
const daysBetween = (a: string, b: string) => dayNum(b) - dayNum(a);

// The app's default week starts on Sunday.
function weekStartOf(s: string): string {
  const dow = new Date(dayNum(s) * 86400000).getUTCDay();
  return addDays(s, -dow);
}

function quarterOfDate(s: string) {
  const [y, m] = s.split("-").map(Number);
  const q = Math.floor((m - 1) / 3) + 1;
  return { key: `${y}-Q${q}`, name: `Q${q} ${y}` };
}

// "Q4 2026" → {start, end}; matches the app's quarterRange().
function quarterRange(name: string): { start: string; end: string } | null {
  const m = String(name || "").match(/Q([1-4])\s*(\d{4})/i);
  if (!m) return null;
  const q = +m[1], y = +m[2];
  const start = `${y}-${p2((q - 1) * 3 + 1)}-01`;
  const endMonth = q * 3;
  const lastDay = new Date(Date.UTC(y, endMonth, 0)).getUTCDate();
  return { start, end: `${y}-${p2(endMonth)}-${p2(lastDay)}` };
}

// ============================================================================================
// Small helpers
// ============================================================================================

const arr = (v: unknown): Json[] => (Array.isArray(v) ? v : []);
const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));
const lc = (v: unknown) => str(v).trim().toLowerCase();

function stripHtml(html: unknown, max = 400): string {
  let t = str(html)
    .replace(/<(br|\/p|\/li|\/h\d|\/tr)\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  if (t.length > max) t = t.slice(0, max).trimEnd() + "…";
  return t;
}

function clip(v: unknown, max = 400): string {
  const t = str(v).trim();
  return t.length > max ? t.slice(0, max).trimEnd() + "…" : t;
}

// Drop empty fields so results stay short.
function compact<T extends Record<string, unknown>>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = v;
  }
  return out as T;
}

// ============================================================================================
// People. The app stores some people as emails and some as first names ("Krystina").
// ============================================================================================

class Directory {
  emails = new Set<string>();
  add(v: unknown) {
    const s = lc(v);
    if (s.includes("@")) this.emails.add(s);
  }
  // A name like "Holly" → holly.carver@… when exactly one known email starts that way.
  resolve(v: unknown): string {
    const s = lc(v);
    if (!s || s.includes("@")) return s;
    const hits = [...this.emails].filter((e) => {
      const local = e.split("@")[0];
      return local === s || local.split(/[._-]/)[0] === s;
    });
    return hits.length === 1 ? hits[0] : s;
  }
  // Does the stored value (email or name) refer to the person asked about (email or name)?
  matches(stored: unknown, query: string): boolean {
    const a = this.resolve(stored), q = this.resolve(query);
    if (!a || !q) return false;
    if (a === q) return true;
    const local = (x: string) => (x.includes("@") ? x.split("@")[0] : x);
    const la = local(a), lq = local(q);
    if (la === lq) return true;
    if (!q.includes("@") && (la.split(/[._-]/)[0] === lq || la.startsWith(lq) || a.startsWith(lq))) return true;
    return false;
  }
}

// ============================================================================================
// Who is calling
// ============================================================================================

interface Caller {
  email: string;
  role: string; // superadmin | admin | leadership | team (the app treats a missing role as admin)
  token: string;
}

async function whoIs(token: string): Promise<Caller | null> {
  if (!token) return null;
  const r = await fetch(`${AUTH_SERVER}/user`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const u = await r.json().catch(() => null);
  if (!u || !u.email) return null;
  const role = (u.app_metadata && u.app_metadata.role) || "admin";
  return { email: lc(u.email), role: String(role), token };
}

const canSeeEveryone = (me: Caller) => me.role === "admin" || me.role === "superadmin";

// ============================================================================================
// Database reads (PostgREST, as the caller)
// ============================================================================================

class ToolError extends Error {}

async function selectAll(me: Caller, table: string, select: string, filters: Record<string, string> = {}): Promise<Json[]> {
  const out: Json[] = [];
  const size = 1000;
  for (let offset = 0; ; offset += size) {
    const qs = new URLSearchParams({ select, order: "id", limit: String(size), offset: String(offset), ...filters });
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${qs}`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${me.token}`, Accept: "application/json" },
    });
    if (!r.ok) throw new ToolError(`Couldn't read ${table} (${r.status}): ${(await r.text()).slice(0, 200)}`);
    const rows = await r.json();
    if (!Array.isArray(rows)) throw new ToolError(`Unexpected reply reading ${table}`);
    out.push(...rows);
    if (rows.length < size) break;
  }
  return out;
}

// One request can call several loaders; each table is read at most once per request.
class Ctx {
  me: Caller;
  today = todayYMD();
  dir = new Directory();
  private cache = new Map<string, Promise<Json>>();
  constructor(me: Caller) {
    this.me = me;
    this.dir.add(me.email);
  }
  once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (!this.cache.has(key)) this.cache.set(key, fn());
    return this.cache.get(key)! as Promise<T>;
  }
  // "me" / blank → the caller
  person(q: unknown): string {
    const s = str(q).trim();
    if (!s || lc(s) === "me" || lc(s) === "myself" || lc(s) === "i") return this.me.email;
    return s;
  }

  quarters(): Promise<{ id: string; name: string; theme: string; goal: string; range: { start: string; end: string } | null }[]> {
    return this.once("quarters", async () => {
      const rows = await selectAll(this.me, "meetings", "id,data");
      return rows.map((r) => ({
        id: r.id,
        name: str(r.data?.name),
        theme: str(r.data?.theme),
        goal: str(r.data?.goal),
        range: quarterRange(str(r.data?.name)),
      }));
    });
  }

  // Every priority across all quarters, with its quarter attached.
  priorities(): Promise<Json[]> {
    return this.once("priorities", async () => {
      const [qs, rows] = await Promise.all([
        this.quarters(),
        selectAll(this.me, "entries", "id,meeting_id,data", { "data->>type": "eq.priority" }),
      ]);
      const byId = new Map(qs.map((q) => [q.id, q]));
      const list = rows
        .filter((r) => r.data)
        .map((r) => ({ ...r.data, _quarterId: r.meeting_id, _quarter: byId.get(r.meeting_id)?.name || "" }));
      list.forEach((e) => {
        this.dir.add(e.pm);
        arr(e.plan).forEach((p) => this.dir.add(p?.owner));
      });
      return list.filter((e) => teamVisible(e, this.me));
    });
  }

  specialProjects(): Promise<Json[]> {
    return this.once("special", async () => {
      const rows = await selectAll(this.me, "special_projects", "id,data");
      const list = rows.map((r) => r.data).filter((d) => d && !d.deleted);
      list.forEach((e) => {
        this.dir.add(e.pm);
        this.dir.add(e.assignee);
        arr(e.plan).forEach((p) => this.dir.add(p?.owner));
      });
      return list.filter((e) => teamVisible(e, this.me, true));
    });
  }

  // All metrics (unfiltered — calculated and roll-up metrics need their inputs), values attached.
  metricsAll(): Promise<Json[]> {
    return this.once("metrics", async () => {
      const [ms, vs] = await Promise.all([
        selectAll(this.me, "metrics", "id,data"),
        selectAll(this.me, "metric_values", "id,metric_id,wk,value"),
      ]);
      const vals = new Map<string, Record<string, Json>>();
      vs.forEach((v) => {
        if (!vals.has(v.metric_id)) vals.set(v.metric_id, {});
        vals.get(v.metric_id)![v.wk] = v.value;
      });
      const list = ms
        .filter((r) => r.id !== "fnconfig" && r.data && !r.data.deleted)
        .map((r) => ({ ...r.data, id: r.id, values: vals.get(r.id) || {} }));
      list.forEach((m) => this.dir.add(m.owner));
      return list;
    });
  }

  meetings(): Promise<Json[]> {
    return this.once("mtgs", async () => {
      const rows = await selectAll(this.me, "mtgs", "id,data");
      const list = rows.filter((r) => r.id !== "app-vision" && r.data).map((r) => ({ ...r.data, id: r.id }));
      list.forEach((m) => {
        arr(m.attendees).forEach((a) => this.dir.add(a));
        this.dir.add(m.organizer);
      });
      return list;
    });
  }

  items(type: string): Promise<Json[]> {
    return this.once("items:" + type, async () => {
      const rows = await selectAll(this.me, "mtg_items", "id,meeting_id,section,inst,data", { "data->>type": `eq.${type}` });
      rows.forEach((r) => {
        this.dir.add(r.data?.author);
        this.dir.add(r.data?.assignee);
      });
      return rows.filter((r) => r.data);
    });
  }

  async vision(): Promise<Json> {
    const rows = await selectAll(this.me, "mtgs", "id,data", { id: "eq.app-vision" });
    return rows[0]?.data || null;
  }
}

// ============================================================================================
// What the app hides from Team-role users (mirrors teamVisible / metricVisible / mtgVisible)
// ============================================================================================

function teamVisible(e: Json, me: Caller, special = false): boolean {
  if (me.role !== "team") return true;
  if (!e) return false;
  if (!special && e.type !== "priority") return true;
  return lc(e.pm) === me.email || lc(e.assignee) === me.email || arr(e.plan).some((p) => p && lc(p.owner) === me.email);
}

function metricVisible(m: Json, me: Caller): boolean {
  return me.role !== "team" || lc(m.owner) === me.email;
}

function mtgVisible(m: Json, me: Caller, dir: Directory): boolean {
  if (me.role === "superadmin") return true;
  if (arr(m.attendees).some((a) => lc(a) === me.email)) return true;
  return [m.organizer, m.by].some((p) => p && dir.resolve(p) === me.email);
}

// ============================================================================================
// Priority logic (ported from index.html so answers match what the app shows)
// ============================================================================================

const STAGE_ORDER = ["new", "reviewed", "proposed", "sized", "committed", "scheduled", "complete"];
const IN_PLAY = ["committed", "scheduled", "complete"];

function dodLines(e: Json): string[] {
  return Array.isArray(e?.dod) ? e.dod.map(str) : [];
}

function dodHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function dodIds(e: Json): string[] {
  const L = dodLines(e);
  const ids: string[] = Array.isArray(e.dodIds) ? e.dodIds.slice(0, L.length) : [];
  const seen = new Set(ids);
  while (ids.length < L.length) {
    const i = ids.length;
    let id = "d" + dodHash(L[i]);
    if (seen.has(id)) id += "_" + i;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function dodItems(e: Json) {
  const ids = dodIds(e), met = e.dodMet || {};
  return dodLines(e).map((text, i) => ({ id: ids[i], text, met: !!met[ids[i]], by: str(met[ids[i]]?.by), at: str(met[ids[i]]?.at) }));
}

function dodAllMet(e: Json): boolean {
  const it = dodItems(e);
  return it.length > 0 && it.every((x) => x.met);
}

function prioPct(e: Json): number {
  const done = arr(e.done), plan = arr(e.plan);
  if (!done.length) return 0;
  let sum = 0;
  done.forEach((_, i) => (sum += Number(plan[i]?.pct) || 0));
  return Math.round(sum / done.length);
}

function prioRange(e: Json): { min: string; max: string } | null {
  const dated = arr(e.plan)
    .map((p) => ({ s: ymd(p?.start), en: ymd(p?.end) }))
    .filter((p) => p.s && p.en && p.en >= p.s) as { s: string; en: string }[];
  if (!dated.length) return null;
  let min = dated[0].s, max = dated[0].en;
  dated.forEach((p) => {
    if (p.s < min) min = p.s;
    if (p.en > max) max = p.en;
  });
  return { min, max };
}

function legacyStage(e: Json): string {
  const full = dodLines(e).length ? dodAllMet(e) : (e.completed === true || (arr(e.done).length > 0 && prioPct(e) === 100));
  if (full) return "complete";
  if (prioRange(e)) return "scheduled";
  if (e.committed) return "committed";
  if (e.size) return "sized";
  if (e.reviewed) return "reviewed";
  return "new";
}

const stageOf = (e: Json) => (e.stage && STAGE_ORDER.includes(e.stage) ? e.stage : legacyStage(e));
const isComplete = (e: Json) => stageOf(e) === "complete";

function isOverduePlan(p: Json, today: string): boolean {
  const en = ymd(p?.end);
  return !!(en && en < today && (Number(p?.pct) || 0) < 100);
}

function planExpectedPct(p: Json, today: string): number {
  const s = ymd(p?.start), en = ymd(p?.end);
  if (!s || !en || en < s) return 0;
  if (today <= s) return 0;
  if (today >= en) return 100;
  return (daysBetween(s, today) / (daysBetween(s, en) + 1)) * 100;
}

function isPlanBehind(p: Json, today: string): boolean {
  const s = ymd(p?.start), en = ymd(p?.end);
  if (!s || !en) return false;
  if (today < s || today > en) return false;
  return (Number(p?.pct) || 0) < planExpectedPct(p, today) - 10;
}

const isOffTrack = (e: Json, today: string) => !isComplete(e) && arr(e.plan).some((p) => isOverduePlan(p, today));

function isPrioBehind(e: Json, today: string): boolean {
  if (isComplete(e)) return false;
  const r = prioRange(e);
  if (!r || today < r.min || today > r.max) return false;
  const expected = (daysBetween(r.min, today) / (daysBetween(r.min, r.max) + 1)) * 100;
  return prioPct(e) < expected - 10;
}

function bumpInfo(p: Json): string | null {
  const oe = ymd(p?.origEnd), ne = ymd(p?.end);
  if (!oe || !ne || ne <= oe) return null;
  const w = Math.max(1, Math.round(daysBetween(oe, ne) / 7));
  const n = Number(p.bumps) || 1;
  return `bumped ${n} time${n === 1 ? "" : "s"}, ${w} week${w === 1 ? "" : "s"} later than first planned (was due ${oe})`;
}

const taskDept = (e: Json, i: number) => str(arr(e.plan)[i]?.dept) || str(e.dept);

function taskStatus(p: Json, today: string): string {
  const pct = Number(p?.pct) || 0;
  if (pct >= 100) return "done";
  if (isOverduePlan(p, today)) return "off track";
  if (isPlanBehind(p, today)) return "behind";
  if (pct > 0) return "in progress";
  return "not started";
}

function tasksOf(e: Json, today: string) {
  const plan = arr(e.plan);
  return arr(e.done).map((title, i) => {
    const p = plan[i] || {};
    const pct = Number(p.pct) || 0;
    return compact({
      task: str(title),
      owner: str(p.owner) || "Unassigned",
      department: taskDept(e, i) || "Unassigned",
      start: ymd(p.start) || "",
      end: ymd(p.end) || "",
      pct,
      status: taskStatus(p, today),
      bumped: bumpInfo(p) || "",
      note: clip(p.note, 300),
      supports_dod: dodIds(e).length && Array.isArray(p.ocs)
        ? p.ocs.map((id: string) => dodLines(e)[dodIds(e).indexOf(id)]).filter(Boolean)
        : [],
    });
  });
}

function prioSummary(e: Json, today: string) {
  const tasks = arr(e.done);
  const plan = arr(e.plan);
  const doneN = tasks.filter((_, i) => (Number(plan[i]?.pct) || 0) >= 100).length;
  const offN = tasks.filter((_, i) => isOverduePlan(plan[i], today)).length;
  const depts = [...new Set(tasks.map((_, i) => taskDept(e, i)).filter(Boolean))];
  const dod = dodItems(e);
  const flag = isComplete(e) ? "" : isOffTrack(e, today) ? "off track" : isPrioBehind(e, today) ? "behind" : "";
  const r = prioRange(e);
  return compact({
    id: str(e.id),
    title: str(e.title) || "(untitled)",
    quarter: e._quarter || "",
    stage: stageOf(e),
    kind: str(e.kind),
    home_department: str(e.dept) || "Unassigned",
    pm: str(e.pm) || "needs a PM",
    impact: str(e.impact),
    size: str(e.size),
    progress_pct: prioPct(e),
    flag,
    tasks: tasks.length,
    tasks_done: doneN,
    tasks_off_track: offN,
    dod: dod.length ? `${dod.filter((d) => d.met).length}/${dod.length} met` : "",
    contributing_departments: depts.filter((d) => d !== str(e.dept)),
    dates: r ? `${r.min} to ${r.max}` : "",
  });
}

// ============================================================================================
// Metric logic (ported: calculated and roll-up metrics work their numbers out from others)
// ============================================================================================

const isCalc = (m: Json) => !!(m && m.source === "calc" && m.calc && m.calc.a && m.calc.b);
const isRollup = (m: Json) => !!(m && m.source === "rollup");
const rollupKids = (m: Json, all: Json[]) => all.filter((x) => x.parent === m.id && x.id !== m.id);

// A week's typed number. The app's week start is a per-browser setting, so people whose
// browser starts the week on Monday save their numbers under that Monday's date. Those still
// belong to the Sunday-to-Saturday week that contains them; an exact Sunday entry wins.
function typedValue(m: Json, wk: string): Json {
  const vals = m.values || {};
  const empty = (v: Json) => v === undefined || v === null || v === "";
  if (!empty(vals[wk])) return vals[wk];
  const end = addDays(wk, 6);
  const inWeek = Object.keys(vals)
    .filter((k) => {
      const d = ymd(k);
      return d !== null && k.length === 10 && d > wk && d <= end && !empty(vals[k]);
    })
    .sort();
  return inWeek.length ? vals[inWeek[inWeek.length - 1]] : null;
}

function effValue(m: Json, wk: string, all: Json[], depth = 0): number | string | null {
  const typed = typedValue(m, wk);
  if (typed !== null) return typeof typed === "number" ? typed : (isNaN(Number(typed)) ? String(typed) : Number(typed));
  if (depth > 4) return null;
  if (isRollup(m)) {
    const vals = rollupKids(m, all)
      .map((k) => effValue(k, wk, all, depth + 1))
      .filter((v): v is number => typeof v === "number" && !isNaN(v));
    if (!vals.length) return null;
    const sum = vals.reduce((a, b) => a + b, 0);
    const v = m.rollRule === "avg" ? Math.round((sum / vals.length) * 10) / 10 : sum;
    return isFinite(v) ? Math.round(v * 100) / 100 : null;
  }
  if (isCalc(m)) {
    const A = all.find((x) => x.id === m.calc.a), B = all.find((x) => x.id === m.calc.b);
    if (!A || !B || A.id === m.id || B.id === m.id) return null;
    const av = effValue(A, wk, all, depth + 1), bv = effValue(B, wk, all, depth + 1);
    if (typeof av !== "number" || typeof bv !== "number") return null;
    let v: number;
    if (m.calc.op === "add") v = av + bv;
    else if (m.calc.op === "sub") v = av - bv;
    else if (m.calc.op === "mul") v = av * bv;
    else {
      if (!bv) return null;
      v = av / bv;
    }
    if (m.calc.x100) v *= 100;
    return isFinite(v) ? Math.round(v * 100) / 100 : null;
  }
  return null;
}

function weekKeys(m: Json, all: Json[], depth = 0): Set<string> {
  const keys = new Set(Object.keys(m.values || {}).filter((k) => ymd(k)).map((k) => weekStartOf(ymd(k)!)));
  if (depth > 4) return keys;
  const inputs = isRollup(m) ? rollupKids(m, all) : isCalc(m) ? all.filter((x) => x.id === m.calc.a || x.id === m.calc.b) : [];
  inputs.forEach((k) => weekKeys(k, all, depth + 1).forEach((x) => keys.add(x)));
  return keys;
}

function fillMethod(m: Json, all: Json[]): string {
  if (isRollup(m)) {
    const kids = rollupKids(m, all).map((k) => str(k.name));
    return `roll-up (${m.rollRule === "avg" ? "average" : "sum"} of: ${kids.join(", ") || "no channels yet"})`;
  }
  if (isCalc(m)) {
    const A = all.find((x) => x.id === m.calc.a), B = all.find((x) => x.id === m.calc.b);
    const op = ({ div: "÷", mul: "×", add: "+", sub: "−" } as Record<string, string>)[m.calc.op] || "÷";
    return `calculated (${str(A?.name) || "?"} ${op} ${str(B?.name) || "?"}${m.calc.x100 ? " × 100" : ""})`;
  }
  if (m.source === "salesforce") return `tagged Salesforce${m.sourceName ? ": " + clip(m.sourceName, 80) : ""}`;
  if (m.source === "connect") return `tagged AWS Connect${m.sourceName ? ": " + clip(m.sourceName, 80) : ""}`;
  return "manual (the owner enters it)";
}

const GOAL_KINDS: Record<string, string> = {
  total: "weekly target (quarter target ÷ 13 each week)",
  rate: "a rate that has to hold every week",
  balance: "a balance that grows to the target",
  cumulative: "a running total by quarter-end",
};

function metricKind(m: Json): string {
  // The app stores the choice as goalKind + levelMode; map back to the four plain-language kinds (mxKindOf).
  if (m.goalKind === "level") return m.levelMode === "climb" ? GOAL_KINDS.balance : GOAL_KINDS.rate;
  if (m.goalKind === "cumulative") return GOAL_KINDS.cumulative;
  return GOAL_KINDS[str(m.goalKind)] || GOAL_KINDS.total;
}

function metricTarget(m: Json, qk: string): number | null {
  let v = m.quarterGoals?.[qk];
  if (v === undefined || v === null || v === "") v = m.goal;
  return v === undefined || v === null || v === "" || isNaN(Number(v)) ? null : Number(v);
}

function metricSummary(m: Json, all: Json[], today: string) {
  const thisWk = weekStartOf(today), lastWk = addDays(thisWk, -7);
  const keys = [...weekKeys(m, all)].sort();
  const filled = keys.filter((k) => effValue(m, k, all) !== null);
  const qk = quarterOfDate(today).key;
  return compact({
    id: str(m.id),
    name: str(m.name),
    owner: str(m.owner) || "no owner",
    department: str(m.dept),
    company_metric: m.company ? "yes" : "",
    unit: str(m.unit),
    how_it_fills: fillMethod(m, all),
    kind: metricKind(m),
    direction: m.direction === "lower" ? "lower is better" : "higher is better",
    quarter_target: metricTarget(m, qk),
    this_week: { week_of: thisWk, value: effValue(m, thisWk, all) },
    last_week: { week_of: lastWk, value: effValue(m, lastWk, all) },
    last_filled_week: filled[filled.length - 1] || "never",
    rolls_up_into: m.parent ? str(all.find((x) => x.id === m.parent)?.name) : "",
  });
}

function findMetric(all: Json[], q: string): Json[] {
  const s = lc(q);
  const exact = all.filter((m) => m.id === q || lc(m.name) === s);
  if (exact.length) return exact;
  return all.filter((m) => lc(m.name).includes(s));
}

// ============================================================================================
// Shared filters
// ============================================================================================

async function resolveQuarter(ctx: Ctx, q: unknown): Promise<{ id: string; name: string } | null> {
  const qs = await ctx.quarters();
  const s = lc(q);
  if (s === "all") return null;
  if (!s || s === "current" || s === "this quarter" || s === "now") {
    const hit = qs.find((x) => x.range && x.range.start <= ctx.today && ctx.today <= x.range.end);
    if (hit) return hit;
    return [...qs].sort((a, b) => str(b.range?.start).localeCompare(str(a.range?.start)))[0] || null;
  }
  if (s === "next" || s === "last" || s === "previous") {
    const dated = qs.filter((x) => x.range).sort((a, b) => a.range!.start.localeCompare(b.range!.start));
    const i = dated.findIndex((x) => x.range!.start <= ctx.today && ctx.today <= x.range!.end);
    const j = s === "next" ? i + 1 : i - 1;
    if (i < 0 || !dated[j]) throw new ToolError(`There's no ${s} quarter in the app.`);
    return dated[j];
  }
  const hit = qs.find((x) => x.id === q || lc(x.name) === s) ||
    qs.find((x) => lc(x.name).replace(/\s+/g, "") === s.replace(/\s+/g, "")) ||
    qs.find((x) => lc(x.name).includes(s));
  if (!hit) throw new ToolError(`No quarter called "${q}". Quarters: ${qs.map((x) => x.name).join(", ")}.`);
  return hit;
}

const deptMatches = (stored: unknown, q: string) => !q || lc(stored) === lc(q) || lc(stored).includes(lc(q));

function textMatches(hay: unknown[], q: string): boolean {
  if (!q) return true;
  const words = lc(q).split(/\s+/).filter(Boolean);
  const h = hay.map(lc).join(" ");
  return words.every((w) => h.includes(w));
}

// ============================================================================================
// Tools
// ============================================================================================

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Json;
  run: (args: Json, ctx: Ctx) => Promise<Json>;
}

const quarterArg = {
  type: "string",
  description: 'Quarter name like "Q4 2026", or "current" (default), "next", "last", or "all".',
};
const personArg = {
  type: "string",
  description: 'Email or first name, or "me" for the person using Claude.',
};

const TOOLS: Tool[] = [
  {
    name: "who_am_i",
    title: "Who am I in Round Up",
    description: "The signed-in person's email and app role, and what that role can see.",
    inputSchema: { type: "object", properties: {} },
    run: (_a, ctx) => Promise.resolve({
      email: ctx.me.email,
      role: ctx.me.role,
      today: ctx.today,
      can_see: ctx.me.role === "team"
        ? "Only priorities and special projects they PM or have a task on, metrics they own, their own to-dos, and meetings they attend."
        : canSeeEveryone(ctx.me)
        ? (ctx.me.role === "superadmin" ? "Every priority, metric and special project, and everyone's to-dos." : "Every priority, metric and special project, and everyone's to-dos except ones from meetings they aren't in.") +
          (ctx.me.role === "superadmin" ? " Every meeting." : " Meetings they attend or organize.")
        : "Every priority, metric and special project, their own to-dos, and meetings they attend or organize.",
      app: APP_URL,
    }),
  },
  {
    name: "list_quarters",
    title: "List quarters",
    description: "The planning quarters in the app (theme, goal, number of priorities), with the current one marked.",
    inputSchema: { type: "object", properties: {} },
    run: async (_a, ctx) => {
      const [qs, ps] = await Promise.all([ctx.quarters(), ctx.priorities()]);
      return qs
        .sort((a, b) => str(a.range?.start).localeCompare(str(b.range?.start)))
        .map((q) => compact({
          id: q.id,
          name: q.name,
          current: q.range && q.range.start <= ctx.today && ctx.today <= q.range.end ? "yes" : "",
          theme: clip(q.theme, 200),
          goal: clip(q.goal, 300),
          priorities: ps.filter((e) => e._quarterId === q.id).length,
          in_play: ps.filter((e) => e._quarterId === q.id && IN_PLAY.includes(stageOf(e))).length,
        }));
    },
  },
  {
    name: "list_priorities",
    title: "List quarterly priorities",
    description:
      "Quarterly priorities (rocks) with PM, home department, progress %, off-track/behind flag, task counts, Definition of Done status and contributing departments. " +
      'By default shows the current quarter and only what\'s "in play" (committed, scheduled or complete), like the app does. ' +
      "Filter by department (home department OR a department contributing tasks), person (PM or task owner), stage, flag or text.",
    inputSchema: {
      type: "object",
      properties: {
        quarter: quarterArg,
        department: { type: "string", description: "Department name, e.g. Operations, Dev, Customer Care, Marketing, Product, TELUS." },
        person: personArg,
        stage: {
          type: "string",
          enum: ["in_play", "all", ...STAGE_ORDER],
          description: 'in_play (default) = committed, scheduled or complete. "all" includes new intake submissions.',
        },
        flag: { type: "string", enum: ["off_track", "behind", "flagged", "complete", "open"], description: "flagged = off track or behind." },
        search: { type: "string", description: "Words that must appear in the title." },
        limit: { type: "number", description: "Default 100." },
      },
    },
    run: async (a, ctx) => {
      const q = await resolveQuarter(ctx, a.quarter);
      const stage = str(a.stage) || "in_play";
      const person = a.person ? ctx.person(a.person) : "";
      const dept = str(a.department);
      let list = (await ctx.priorities()).filter((e) => !q || e._quarterId === q.id);
      if (stage === "in_play") list = list.filter((e) => IN_PLAY.includes(stageOf(e)));
      else if (stage !== "all") list = list.filter((e) => stageOf(e) === stage);
      if (dept) list = list.filter((e) => deptMatches(e.dept, dept) || arr(e.done).some((_, i) => deptMatches(taskDept(e, i), dept)));
      if (person) list = list.filter((e) => ctx.dir.matches(e.pm, person) || arr(e.plan).some((p) => ctx.dir.matches(p?.owner, person)));
      if (a.search) list = list.filter((e) => textMatches([e.title], str(a.search)));
      const f = str(a.flag);
      if (f === "off_track") list = list.filter((e) => isOffTrack(e, ctx.today));
      if (f === "behind") list = list.filter((e) => !isOffTrack(e, ctx.today) && isPrioBehind(e, ctx.today));
      if (f === "flagged") list = list.filter((e) => isOffTrack(e, ctx.today) || isPrioBehind(e, ctx.today));
      if (f === "complete") list = list.filter(isComplete);
      if (f === "open") list = list.filter((e) => !isComplete(e));
      const limit = Number(a.limit) > 0 ? Number(a.limit) : 100;
      const rows = list.map((e) => {
        const s: Json = prioSummary(e, ctx.today);
        if (person) {
          const roles = [];
          if (ctx.dir.matches(e.pm, person)) roles.push("PM");
          const owned = arr(e.done).filter((_, i) => ctx.dir.matches(arr(e.plan)[i]?.owner, person)).length;
          if (owned) roles.push(`owns ${owned} task${owned === 1 ? "" : "s"}`);
          s.person_role = roles.join(", ");
        }
        return s;
      });
      rows.sort((x: Json, y: Json) => str(x.home_department).localeCompare(str(y.home_department)) || str(x.title).localeCompare(str(y.title)));
      return {
        quarter: q ? q.name : "all quarters",
        stage_filter: stage,
        count: rows.length,
        priorities: rows.slice(0, limit),
        ...(rows.length > limit ? { more: `${rows.length - limit} more not shown; narrow the filters or raise limit.` } : {}),
      };
    },
  },
  {
    name: "get_priority",
    title: "Get one priority in full",
    description: "Everything about one priority: why, notes, Definition of Done lines (met or not), and every task with owner, contributing department, dates, %, status, bumps and notes. Pass the id from list_priorities, or a title.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string", description: "Title or part of it, if you don't have the id." },
        quarter: { ...quarterArg, description: quarterArg.description + ' Only used with title; default "all".' },
      },
    },
    run: async (a, ctx) => {
      let list = await ctx.priorities();
      let hits: Json[] = [];
      if (a.id) hits = list.filter((e) => e.id === a.id);
      else if (a.title) {
        const q = a.quarter ? await resolveQuarter(ctx, a.quarter) : null;
        if (q) list = list.filter((e) => e._quarterId === q.id);
        const t = lc(a.title);
        hits = list.filter((e) => lc(e.title) === t);
        if (!hits.length) hits = list.filter((e) => textMatches([e.title], str(a.title)));
      } else throw new ToolError("Pass an id or a title.");
      if (!hits.length) {
        // Maybe it's a special project.
        const sp = (await ctx.specialProjects()).filter((e) => (a.id ? e.id === a.id : textMatches([e.title], str(a.title))));
        if (sp.length === 1) hits = sp;
        else throw new ToolError("No priority found (or you don't have access to it).");
      }
      if (hits.length > 1) {
        return { matches: hits.length, note: "More than one priority matches; call again with an id.", candidates: hits.slice(0, 20).map((e) => prioSummary(e, ctx.today)) };
      }
      const e = hits[0];
      return compact({
        ...prioSummary(e, ctx.today),
        special_project: e.special ? `yes (status: ${str(e.status) || "backlog"})` : "",
        why: clip(e.why, 1500),
        notes: stripHtml(e.notes, 1500),
        definition_of_done: dodItems(e).map((d) => compact({ line: d.text, met: d.met, ticked_by: d.by, ticked_at: d.at })),
        tasks: tasksOf(e, ctx.today),
      });
    },
  },
  {
    name: "list_tasks",
    title: "List tasks across priorities",
    description:
      "Tasks across all priorities for a person (their assigned tasks) or a department (tasks it contributes, including to other departments' priorities). " +
      "Each task comes with its priority, dates, %, and status (done, in progress, not started, behind, off track).",
    inputSchema: {
      type: "object",
      properties: {
        person: personArg,
        department: { type: "string", description: "Contributing department." },
        quarter: quarterArg,
        status: {
          type: "string",
          enum: ["open", "off_track", "behind", "done", "unassigned", "all"],
          description: "open (default) = not done yet.",
        },
        in_play_only: { type: "boolean", description: "Only tasks on committed/scheduled/complete priorities. Default true." },
      },
    },
    run: async (a, ctx) => {
      if (!a.person && !a.department) throw new ToolError("Pass a person or a department.");
      const q = await resolveQuarter(ctx, a.quarter);
      const person = a.person ? ctx.person(a.person) : "";
      const dept = str(a.department);
      const status = str(a.status) || "open";
      const inPlay = a.in_play_only !== false;
      const out: Json[] = [];
      for (const e of await ctx.priorities()) {
        if (q && e._quarterId !== q.id) continue;
        if (inPlay && !IN_PLAY.includes(stageOf(e))) continue;
        const plan = arr(e.plan);
        arr(e.done).forEach((title, i) => {
          const p = plan[i] || {};
          if (person && !ctx.dir.matches(p.owner, person)) return;
          if (dept && !deptMatches(taskDept(e, i), dept)) return;
          const st = taskStatus(p, ctx.today);
          if (status === "open" && st === "done") return;
          if (status === "off_track" && st !== "off track") return;
          if (status === "behind" && st !== "behind") return;
          if (status === "done" && st !== "done") return;
          if (status === "unassigned" && str(p.owner)) return;
          out.push(compact({
            task: str(title),
            priority: str(e.title),
            priority_id: str(e.id),
            quarter: e._quarter,
            priority_pm: str(e.pm),
            owner: str(p.owner) || "Unassigned",
            department: taskDept(e, i) || "Unassigned",
            start: ymd(p.start) || "",
            end: ymd(p.end) || "",
            pct: Number(p.pct) || 0,
            status: st,
            bumped: bumpInfo(p) || "",
          }));
        });
      }
      out.sort((x, y) => (str(x.end) || "9999").localeCompare(str(y.end) || "9999"));
      return { quarter: q ? q.name : "all quarters", count: out.length, tasks: out.slice(0, 300) };
    },
  },
  {
    name: "list_metrics",
    title: "List scorecard metrics",
    description:
      "Weekly scorecard metrics with owner, department, how each one gets filled (manual, tagged Salesforce/AWS Connect, calculated, roll-up), " +
      "this week's and last week's numbers, the quarter target and the last week that has a number.",
    inputSchema: {
      type: "object",
      properties: {
        person: { ...personArg, description: "Metric owner. " + personArg.description },
        department: { type: "string" },
        company_only: { type: "boolean", description: "Only the company metrics shown on meeting scorecards." },
        fill: { type: "string", enum: ["manual", "salesforce", "connect", "calculated", "rollup", "all"] },
        missing_this_week: { type: "boolean", description: "Only metrics with no number yet for this week." },
      },
    },
    run: async (a, ctx) => {
      const all = await ctx.metricsAll();
      const person = a.person ? ctx.person(a.person) : "";
      let list = all.filter((m) => metricVisible(m, ctx.me));
      if (person) list = list.filter((m) => ctx.dir.matches(m.owner, person));
      if (a.department) list = list.filter((m) => deptMatches(m.dept, str(a.department)));
      if (a.company_only) list = list.filter((m) => !!m.company);
      const f = str(a.fill);
      if (f === "manual") list = list.filter((m) => !m.source || m.source === "manual");
      if (f === "salesforce") list = list.filter((m) => m.source === "salesforce");
      if (f === "connect") list = list.filter((m) => m.source === "connect");
      if (f === "calculated") list = list.filter(isCalc);
      if (f === "rollup") list = list.filter(isRollup);
      let rows = list.map((m) => metricSummary(m, all, ctx.today));
      if (a.missing_this_week) rows = rows.filter((r: Json) => r.this_week.value === null);
      rows.sort((x: Json, y: Json) => str(x.department).localeCompare(str(y.department)) || str(x.name).localeCompare(str(y.name)));
      return { this_week_of: weekStartOf(ctx.today), count: rows.length, metrics: rows };
    },
  },
  {
    name: "get_metric",
    title: "Get a metric's weekly history",
    description: "One metric's weekly numbers (newest first), quarter targets and settings. Pass the id or the name (or part of it).",
    inputSchema: {
      type: "object",
      properties: {
        metric: { type: "string", description: "Metric id or name." },
        weeks: { type: "number", description: "How many weeks back. Default 13 (one quarter)." },
      },
      required: ["metric"],
    },
    run: async (a, ctx) => {
      const all = await ctx.metricsAll();
      const hits = findMetric(all.filter((m) => metricVisible(m, ctx.me)), str(a.metric));
      if (!hits.length) throw new ToolError(`No metric matching "${a.metric}" (or you don't have access to it).`);
      if (hits.length > 1) return { note: "More than one metric matches; call again with the exact name or id.", candidates: hits.map((m) => ({ id: m.id, name: m.name })) };
      const m = hits[0];
      const n = Number(a.weeks) > 0 ? Math.min(Number(a.weeks), 104) : 13;
      const thisWk = weekStartOf(ctx.today);
      const history = [];
      for (let i = 0; i < n; i++) {
        const wk = addDays(thisWk, -7 * i);
        const typed = typedValue(m, wk);
        const v = effValue(m, wk, all);
        history.push(compact({ week_of: wk, value: v, worked_out: v !== null && typed === null ? "yes" : "" }));
      }
      return compact({
        ...metricSummary(m, all, ctx.today),
        quarter_targets: m.quarterGoals && Object.keys(m.quarterGoals).length ? m.quarterGoals : "",
        default_target: m.goal === "" || m.goal === undefined ? "" : m.goal,
        warning_band_pct: m.tierPct ?? 10,
        channels: isRollup(m) ? rollupKids(m, all).map((k) => k.name) : [],
        history,
      });
    },
  },
  {
    name: "list_todos",
    title: "List to-dos",
    description:
      "To-dos from meetings and the To-Dos page, with owner, due date, done/overdue and which meeting they came from. " +
      "Defaults to the signed-in person's open to-dos. Admins can ask for everyone's.",
    inputSchema: {
      type: "object",
      properties: {
        person: personArg,
        everyone: { type: "boolean", description: "Everyone's to-dos (Admins and Super Admins only)." },
        status: { type: "string", enum: ["open", "overdue", "done", "all"], description: "Default open." },
        meeting: { type: "string", description: "Meeting title (or part of it)." },
        search: { type: "string" },
      },
    },
    run: async (a, ctx) => {
      const [items, mtgs] = await Promise.all([ctx.items("pri"), ctx.meetings()]);
      const mtgTitle = (id: string) => (id === "standalone" ? "To-Dos page" : str(mtgs.find((m) => m.id === id)?.title) || "a meeting");
      let person = ctx.person(a.person);
      if (a.everyone || (a.person && person !== ctx.me.email)) {
        if (!canSeeEveryone(ctx.me)) {
          if (a.everyone) throw new ToolError("Only Admins and Super Admins can see everyone's to-dos.");
          person = ctx.me.email;
        }
      }
      const owner = (it: Json) => str(it.data.author || it.data.owner);
      const due = (it: Json) => ymd(it.data.due) || (ymd(it.inst) ? addDays(ymd(it.inst)!, 7) : null);
      let list = a.everyone && canSeeEveryone(ctx.me) ? items : items.filter((it) => ctx.dir.matches(owner(it), person));
      const status = str(a.status) || "open";
      if (status === "open") list = list.filter((it) => !it.data.done);
      if (status === "done") list = list.filter((it) => it.data.done);
      if (status === "overdue") list = list.filter((it) => !it.data.done && due(it) && due(it)! < ctx.today);
      if (a.meeting) list = list.filter((it) => textMatches([mtgTitle(it.meeting_id)], str(a.meeting)));
      if (a.search) list = list.filter((it) => textMatches([it.data.text], str(a.search)));
      const rows = list.map((it) => {
        const d = due(it);
        return compact({
          todo: clip(it.data.text, 300),
          owner: owner(it),
          assigned_by: str(it.data.assignedBy),
          due: d || "",
          status: it.data.done ? "done" : d && d < ctx.today ? "overdue" : "open",
          done_at: it.data.doneAt ? str(it.data.doneAt).slice(0, 10) : "",
          meeting: mtgTitle(it.meeting_id),
          meeting_date: it.inst && it.inst !== "static" ? str(it.inst) : "",
          from_issue: it.data.fromIssue ? "yes" : "",
        });
      });
      rows.sort((x, y) => (str(x.due) || "9999").localeCompare(str(y.due) || "9999"));
      return { who: a.everyone && canSeeEveryone(ctx.me) ? "everyone" : person, status, count: rows.length, todos: rows.slice(0, 300) };
    },
  },
  {
    name: "list_issues",
    title: "List issues",
    description: "Cards on the issues boards (Not started, In progress, Has update, Done) from meetings the signed-in person can see, with notes.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["not_done", "notstarted", "inprogress", "hasupdate", "done", "all"], description: "Default not_done." },
        meeting: { type: "string" },
        search: { type: "string" },
      },
    },
    run: async (a, ctx) => {
      const [items, mtgs] = await Promise.all([ctx.items("issue"), ctx.meetings()]);
      const byId = new Map(mtgs.map((m) => [m.id, m]));
      let list = items.filter((it) => {
        const m = byId.get(it.meeting_id);
        return m ? mtgVisible(m, ctx.me, ctx.dir) : ctx.me.role === "superadmin";
      });
      const status = str(a.status) || "not_done";
      const st = (it: Json) => str(it.data.status) || "notstarted";
      if (status === "not_done") list = list.filter((it) => st(it) !== "done");
      else if (status !== "all") list = list.filter((it) => st(it) === status);
      if (a.meeting) list = list.filter((it) => textMatches([byId.get(it.meeting_id)?.title], str(a.meeting)));
      if (a.search) list = list.filter((it) => textMatches([it.data.text, stripHtml(it.data.notes, 5000)], str(a.search)));
      const label: Record<string, string> = { notstarted: "Not started", inprogress: "In progress", hasupdate: "Has update", done: "Done" };
      return {
        count: list.length,
        issues: list.map((it) => compact({
          issue: clip(it.data.text, 200),
          status: label[st(it)] || st(it),
          raised_by: str(it.data.author),
          meeting: str(byId.get(it.meeting_id)?.title),
          last_edited: it.data.editedAt ? new Date(Number(it.data.editedAt)).toISOString().slice(0, 10) : "",
          last_edited_by: str(it.data.editedBy),
          notes: stripHtml(it.data.notes, 600),
        })),
      };
    },
  },
  {
    name: "list_special_projects",
    title: "List special projects",
    description: "Special projects (work outside the quarterly cycle) with status column, PM, who's working on it and progress.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["backlog", "inprogress", "blocked", "done", "not_done", "all"], description: "Default not_done." },
        person: personArg,
      },
    },
    run: async (a, ctx) => {
      let list = await ctx.specialProjects();
      const status = str(a.status) || "not_done";
      const st = (e: Json) => str(e.status) || "backlog";
      if (status === "not_done") list = list.filter((e) => st(e) !== "done");
      else if (status !== "all") list = list.filter((e) => st(e) === status);
      if (a.person) {
        const p = ctx.person(a.person);
        list = list.filter((e) => ctx.dir.matches(e.pm, p) || ctx.dir.matches(e.assignee, p) || arr(e.plan).some((x) => ctx.dir.matches(x?.owner, p)));
      }
      const label: Record<string, string> = { backlog: "Backlog", inprogress: "In progress", blocked: "Blocked", done: "Done" };
      list.sort((x, y) => STATUS_ORDER.indexOf(st(x)) - STATUS_ORDER.indexOf(st(y)) || (Number(x.ord) || 0) - (Number(y.ord) || 0));
      return {
        count: list.length,
        projects: list.map((e) => compact({ ...prioSummary(e, ctx.today), quarter: "", stage: "", status: label[st(e)] || st(e), working_on_it: str(e.assignee) })),
      };
    },
  },
  {
    name: "get_core_values",
    title: "Core values and vision",
    description: "The Core Values / Vision page: strategy, purpose, core values and the 1-year, 3-year and big goals.",
    inputSchema: { type: "object", properties: {} },
    run: async (_a, ctx) => {
      const v = await ctx.vision();
      if (!v) return { note: "The vision page is empty." };
      // Shape varies as the page evolves; return text fields cleaned up.
      const clean = (x: Json): Json => {
        if (typeof x === "string") return /<[a-z][\s\S]*>/i.test(x) ? stripHtml(x, 3000) : clip(x, 3000);
        if (Array.isArray(x)) return x.map(clean);
        if (x && typeof x === "object") {
          const o: Json = {};
          for (const [k, val] of Object.entries(x)) if (!["t", "by", "updatedAt", "updatedBy"].includes(k)) o[k] = clean(val);
          return o;
        }
        return x;
      };
      return clean(v);
    },
  },
];

const STATUS_ORDER = ["inprogress", "blocked", "backlog", "done"];

// ============================================================================================
// MCP over HTTP (stateless JSON responses; no server-sent streams needed for read tools)
// ============================================================================================

const rpcOk = (id: Json, result: Json) => ({ jsonrpc: "2.0", id, result });
const rpcErr = (id: Json, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function handleRpc(msg: Json, me: Caller): Promise<Json | null> {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcErr(msg?.id ?? null, -32600, "Invalid request");
  }
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;
  switch (method) {
    case "initialize": {
      const asked = params?.protocolVersion;
      return rpcOk(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return rpcOk(id, {});
    case "tools/list":
      return rpcOk(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { title: t.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        })),
      });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return rpcErr(id, -32602, `Unknown tool: ${params?.name}`);
      try {
        const result = await tool.run(params?.arguments || {}, new Ctx(me));
        return rpcOk(id, { content: [{ type: "text", text: JSON.stringify(result) }] });
      } catch (e) {
        const text = e instanceof ToolError ? e.message : `Something went wrong: ${String((e as Error)?.message || e)}`;
        if (!(e instanceof ToolError)) console.error(`tool ${tool.name} failed`, e);
        return rpcOk(id, { content: [{ type: "text", text }], isError: true });
      }
    }
    case "resources/list":
      return rpcOk(id, { resources: [] });
    case "prompts/list":
      return rpcOk(id, { prompts: [] });
    default:
      if (isNotification) return null; // notifications/initialized, notifications/cancelled, …
      return rpcErr(id, -32601, `Method not found: ${method}`);
  }
}

function json(body: Json, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json", ...extra } });
}

function unauthorized(hadToken: boolean) {
  const challenge = `Bearer resource_metadata="${RESOURCE_METADATA_URL}"` +
    (hadToken ? `, error="invalid_token", error_description="Sign in again"` : "");
  return json({ error: "unauthorized", message: "Connect Round Up in Claude to sign in." }, 401, { "WWW-Authenticate": challenge });
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const path = new URL(req.url).pathname.replace(/\/+$/, "");

  // Where Claude learns which sign-in server to use (RFC 9728).
  if (path.endsWith("/.well-known/oauth-protected-resource")) {
    return json({
      resource: RESOURCE,
      resource_name: "Round Up",
      authorization_servers: [AUTH_SERVER],
      bearer_methods_supported: ["header"],
    });
  }

  if (req.method === "GET") {
    // No server-to-client stream is offered.
    return new Response("Method Not Allowed", { status: 405, headers: { ...cors, Allow: "POST, OPTIONS" } });
  }
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { ...cors, Allow: "POST, OPTIONS" } });

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const me = await whoIs(token);
  if (!me) return unauthorized(!!token);

  let body: Json;
  try {
    body = await req.json();
  } catch {
    return json(rpcErr(null, -32700, "Parse error"), 400);
  }

  if (Array.isArray(body)) {
    const replies = (await Promise.all(body.map((m) => handleRpc(m, me)))).filter((r) => r !== null);
    return replies.length ? json(replies) : new Response(null, { status: 202, headers: cors });
  }
  const reply = await handleRpc(body, me);
  return reply === null ? new Response(null, { status: 202, headers: cors }) : json(reply);
}

Deno.serve(handler);

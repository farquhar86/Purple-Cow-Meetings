// Supabase Edge Function: claude-connector
// Lets Claude read Round Up: quarterly priorities and their tasks, the weekly
// metrics scorecard, to-dos, issues, special projects and the core values page.
//
// Stage 2 adds a few updates: tick or change a task, tick a Definition of Done line, add or
// complete a to-do, move an issue card, and enter a weekly metric number. Each one follows the
// same rules as the app (a Team-role user can only change what the app lets them change), saves
// only if nobody else changed that record since Claude read it, and is written to connector_log.
// Updates need supabase-role-rules.sql to have been run once (it adds ru_save_if_unchanged and
// connector_log). Reads work without it.
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

const SERVER_INFO = { name: "round-up", title: "Round Up", version: "0.2.0" };
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = [
  "Round Up is Purple Cow Internet's planning app (" + APP_URL + ").",
  "It holds quarterly priorities (also called rocks) with their tasks, the weekly metrics scorecard,",
  "to-dos from meetings, the issues board, special projects and the core values page.",
  "'me' means the person who connected it.",
  "It can also make a few updates (update_task, set_dod_line, add_todo, complete_todo, move_issue,",
  "set_metric_value). Before calling any of them, tell the person exactly what will change and wait",
  "for them to say yes; make one change per call. Each update follows the app's own rules about who",
  "can change what, and reports what it changed. list_recent_changes shows changes made through Claude.",
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
      number: i + 1,
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
  write?: boolean;        // changes something in the app
  repeatable?: boolean;   // calling it twice with the same arguments changes nothing more
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
            task_number: i + 1,
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
          id: str(it.id),
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
          id: str(it.id),
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
// Updates (stage 2)
//
// Every update follows the same steps: find the record the person means, check the app would let
// this person change it, then read it fresh, apply the change the way the app does, and save it
// only if nobody changed it in between (ru_save_if_unchanged). The database's own rules
// (supabase-role-rules.sql) check the same thing again. Each change is written to connector_log.
// ============================================================================================

const NEEDS_SETUP =
  "Updates aren't switched on yet: the one-time database update (supabase-role-rules.sql) hasn't been run in Supabase. Reading still works.";

// Same shape as the app's uid().
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const firstName = (email: string) => {
  const s = email.split("@")[0].split(/[._-]/)[0] || email;
  return s.charAt(0).toUpperCase() + s.slice(1);
};

async function rest(me: Caller, method: string, path: string, body?: Json, prefer?: string) {
  const headers: Record<string, string> = { apikey: ANON_KEY, Authorization: `Bearer ${me.token}`, Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data: Json = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { ok: r.ok, status: r.status, data, text };
}

async function readRow(me: Caller, table: string, id: string): Promise<Json | null> {
  const r = await rest(me, "GET", `${table}?select=*&id=eq.${encodeURIComponent(id)}`);
  if (!r.ok) throw new ToolError(`Couldn't read ${table} (${r.status}): ${r.text.slice(0, 200)}`);
  return Array.isArray(r.data) && r.data.length ? r.data[0] : null;
}

const same = (a: Json, b: Json) => JSON.stringify(a) === JSON.stringify(b);

// Read the record, apply the change, and save it only if it's still exactly what was read.
// If someone saved in between, start again from their version (up to three tries).
async function changeRecord(me: Caller, table: string, id: string, apply: (d: Json) => void): Promise<{ before: Json; after: Json; changed: boolean }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await readRow(me, table, id);
    if (!row || !row.data) throw new ToolError("That record no longer exists in the app.");
    const before = row.data;
    const after = JSON.parse(JSON.stringify(before));
    apply(after);
    if (same(after, before)) return { before, after, changed: false };
    const r = await rest(me, "POST", "rpc/ru_save_if_unchanged", { p_table: table, p_id: id, p_expected: before, p_new: after });
    if (r.status === 404 || (r.data && r.data.code === "PGRST202")) throw new ToolError(NEEDS_SETUP);
    if (!r.ok) throw new ToolError(`The database didn't accept the change (${r.status}): ${r.text.slice(0, 200)}`);
    if (r.data === true) return { before, after, changed: true };
    // Not saved. Either someone changed it in between (go again from their version) or the rules said no.
    const now = await readRow(me, table, id);
    if (now && same(now.data, before)) throw new ToolError("The database refused this change for your account. Nothing was saved.");
  }
  throw new ToolError("Someone else is editing this right now. Nothing was saved; try again in a minute.");
}

async function logChange(me: Caller, tool: string, target: string, summary: string, before: Json, after: Json): Promise<boolean> {
  try {
    const r = await rest(me, "POST", "connector_log", { by_email: me.email, tool, target, summary, before, after }, "return=minimal");
    if (!r.ok) console.warn("connector_log insert failed", r.status, r.text.slice(0, 200));
    return r.ok;
  } catch (e) {
    console.warn("connector_log insert failed", e);
    return false;
  }
}

function saved(summary: string, logged: boolean, extra: Json = {}) {
  return compact({ saved: "yes", summary, ...extra, ...(logged ? {} : { note: "Saved, but it couldn't be added to the change log." }) });
}

// ---------- Priority helpers, ported from the app (autoStage, syncStageFlags, sinkTask) ----------

const stageRank = (k: string) => Math.max(0, STAGE_ORDER.indexOf(k));

function syncStageFlags(e: Json) {
  const r = stageRank(stageOf(e));
  e.reviewed = r >= stageRank("reviewed");
  e.committed = r >= stageRank("committed");
  e.completed = stageOf(e) === "complete";
}

function autoStage(e: Json) {
  if (!e.stage) e.stage = legacyStage(e);
  if (e.size && stageRank(e.stage) < stageRank("sized")) e.stage = "sized";
  if (prioRange(e) && stageRank(e.stage) < stageRank("scheduled")) e.stage = "scheduled";
  if (dodLines(e).length) {
    // with Definition of Done lines, a priority is complete when every line is ticked
    if (dodAllMet(e)) {
      if (stageRank(e.stage) < stageRank("complete")) e.stage = "complete";
    } else if (e.stage === "complete") e.stage = prioRange(e) ? "scheduled" : "committed";
  } else if (arr(e.done).length > 0 && prioPct(e) === 100 && stageRank(e.stage) < stageRank("complete")) e.stage = "complete";
  syncStageFlags(e);
}

const blankPlan = () => ({ start: "", end: "", pct: 0, owner: "", dept: "", note: "", origStart: "", origEnd: "", datesSetAt: 0, bumps: 0, pctBefore: 0, ocs: [] });

// Make plan[] line up with done[] (one entry per task), keeping everything already there.
function alignPlan(e: Json) {
  if (!Array.isArray(e.done)) e.done = [];
  if (!Array.isArray(e.plan)) e.plan = [];
  for (let i = 0; i < e.done.length; i++) if (!e.plan[i] || typeof e.plan[i] !== "object") e.plan[i] = blankPlan();
  e.plan.length = e.done.length;
}

// A finished task drops to the bottom of the list, like in the app.
function sinkTask(e: Json, i: number) {
  const d = e.done.splice(i, 1)[0];
  const p = e.plan.splice(i, 1)[0];
  e.done.push(d);
  e.plan.push(p);
}

const canChangePrio = (e: Json, me: Caller) => me.role !== "team" || teamVisible(e, me, true);

// Which priority (or special project) the person means, and may they change it?
async function findPrioForUpdate(ctx: Ctx, a: Json): Promise<{ table: string; e: Json }> {
  const idq = str(a.priority_id).trim(), tq = str(a.priority).trim();
  if (!idq && !tq) throw new ToolError("Say which priority: pass priority_id (from list_priorities or get_priority), or its title as priority.");
  const [ps, sps] = await Promise.all([ctx.priorities(), ctx.specialProjects()]);
  const pool = [...ps.map((e) => ({ table: "entries", e })), ...sps.map((e) => ({ table: "special_projects", e }))];
  let hits = idq ? pool.filter((x) => x.e.id === idq) : pool.filter((x) => lc(x.e.title) === lc(tq));
  if (!hits.length && !idq) hits = pool.filter((x) => textMatches([x.e.title], tq));
  if (hits.length > 1) {
    // the same title is often carried over from quarter to quarter; prefer the current one
    const q = await resolveQuarter(ctx, "current").catch(() => null);
    const cur = hits.filter((x) => q && x.e._quarterId === q.id);
    if (cur.length === 1) hits = cur;
  }
  if (!hits.length) throw new ToolError("No priority or special project found with that id or title (or you can't see it).");
  if (hits.length > 1) {
    throw new ToolError(
      "More than one matches: " +
        hits.slice(0, 8).map((x) => `"${x.e.title}" (${x.e._quarter || "special project"}, id ${x.e.id})`).join("; ") +
        ". Call again with priority_id.",
    );
  }
  if (!canChangePrio(hits[0].e, ctx.me)) {
    throw new ToolError("Your account can only change priorities you PM, are assigned to, or have a task on.");
  }
  return hits[0];
}

// Which task: its number (as get_priority lists them) or its title.
function findTaskIndex(e: Json, q: unknown): number {
  const tasks = arr(e.done).map(str);
  if (!tasks.length) throw new ToolError("This priority has no tasks.");
  const s = str(q).trim();
  if (!s) throw new ToolError("Say which task: its number from get_priority, or its title.");
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (n >= 1 && n <= tasks.length) return n - 1;
    throw new ToolError(`There's no task ${n}; this one has ${tasks.length}.`);
  }
  let idx = tasks.map((t, i) => (lc(t) === lc(s) ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) idx = tasks.map((t, i) => (textMatches([t], s) ? i : -1)).filter((i) => i >= 0);
  if (idx.length === 1) return idx[0];
  if (!idx.length) throw new ToolError(`No task matching "${s}". Tasks: ${tasks.map((t, i) => `${i + 1}. ${t}`).join("; ")}`);
  throw new ToolError(`More than one task matches "${s}": ${idx.map((i) => `${i + 1}. ${tasks[i]}`).join("; ")}. Use the number.`);
}

// Tasks can move (a finished one drops to the bottom), so find it again in the fresh copy by title.
function relocateTask(d: Json, title: string, wasAt: number): number {
  const tasks = arr(d.done).map(str);
  if (tasks[wasAt] === title) return wasAt;
  const idx = tasks.map((t, i) => (t === title ? i : -1)).filter((i) => i >= 0);
  if (idx.length === 1) return idx[0];
  throw new ToolError("That task changed or moved while saving. Nothing was saved; check get_priority and try again.");
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function dateArg(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = str(v).trim();
  if (s === "" || lc(s) === "none" || lc(s) === "clear") return "";
  if (!DATE_RE.test(s) || ymd(s) !== s) throw new ToolError(`${name} must be a date like 2026-11-15.`);
  return s;
}

// Which to-do or issue card: its id (from list_todos / list_issues), or words from its text.
function pickItem(list: Json[], a: Json, kind: string): Json {
  if (a.id) {
    const hit = list.find((it) => it.id === a.id);
    if (!hit) throw new ToolError(`No ${kind} with that id that you can change.`);
    return hit;
  }
  if (!a.search) throw new ToolError(`Say which ${kind}: pass id (from list_${kind === "to-do" ? "todos" : "issues"}) or search words.`);
  const hits = list.filter((it) => textMatches([it.data.text], str(a.search)));
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new ToolError(`No ${kind} matching "${a.search}" that you can change.`);
  throw new ToolError(
    `More than one ${kind} matches: ` + hits.slice(0, 8).map((it) => `"${clip(it.data.text, 80)}" (id ${it.id})`).join("; ") + ". Use the id.",
  );
}

const ISSUE_LABEL: Record<string, string> = { notstarted: "Not started", inprogress: "In progress", hasupdate: "Has update", done: "Done" };

const priorityArgs = {
  priority_id: { type: "string", description: "The id from list_priorities, get_priority or list_tasks (best)." },
  priority: { type: "string", description: "Or the priority's title (or a unique part of it)." },
};

TOOLS.push(
  {
    name: "update_task",
    title: "Update a task",
    write: true,
    repeatable: true,
    description:
      "Change one task on a priority or special project: tick it done (or un-tick it), set its %, move its start or end date, or add a note. " +
      "Works the way the app does: a finished task drops to the bottom, un-ticking puts back the % it had, pushing the end date out counts as a bump, " +
      "and the priority's stage updates itself. Confirm the change with the person first.",
    inputSchema: {
      type: "object",
      properties: {
        ...priorityArgs,
        task: { type: "string", description: "The task's number (as get_priority lists it) or its title." },
        done: { type: "boolean", description: "true = tick it done (100%); false = un-tick it." },
        pct: { type: "number", description: "Set the % complete (0 to 100)." },
        start: { type: "string", description: "New start date, YYYY-MM-DD." },
        end: { type: "string", description: "New end date, YYYY-MM-DD." },
        add_note: { type: "string", description: "A line to add to the task's notes (dated, marked as added via Claude)." },
      },
      required: ["task"],
    },
    run: async (a, ctx) => {
      const has = (k: string) => a[k] !== undefined && a[k] !== null && a[k] !== "";
      if (!["done", "pct", "start", "end", "add_note"].some(has)) throw new ToolError("Nothing to change: pass done, pct, start, end or add_note.");
      if (has("done") && has("pct")) throw new ToolError("Pass done or pct, not both.");
      let pct: number | undefined;
      if (has("pct")) {
        pct = Number(a.pct);
        if (!isFinite(pct) || pct < 0 || pct > 100) throw new ToolError("pct must be a number from 0 to 100.");
        pct = Math.round(pct);
      }
      const start = dateArg(a.start, "start"), end = dateArg(a.end, "end");
      const note = str(a.add_note).trim();
      const { table, e } = await findPrioForUpdate(ctx, a);
      const at = findTaskIndex(e, a.task);
      const title = str(arr(e.done)[at]);
      const me = ctx.me;
      let oldPct = 0, newPct = 0;
      const res = await changeRecord(me, table, e.id, (d) => {
        if (!canChangePrio(d, me)) throw new ToolError("Your account can only change priorities you PM, are assigned to, or have a task on.");
        alignPlan(d);
        const i = relocateTask(d, title, at);
        const p = d.plan[i];
        oldPct = Number(p.pct) || 0;
        if (a.done === true || pct === 100) {
          if (oldPct < 100) {
            p.pctBefore = oldPct;
            p.pct = 100;
          }
        } else if (a.done === false) {
          if (oldPct >= 100) {
            if (p.jiraDone) p.jiraSkip = true; // un-ticked on purpose: the Jira sync leaves it alone
            p.pct = Math.max(0, Math.min(99, Number(p.pctBefore) || 0));
            p.pctBefore = 0;
          }
        } else if (pct !== undefined) {
          if (oldPct >= 100 && p.jiraDone) p.jiraSkip = true;
          p.pct = pct;
          p.pctBefore = 0;
        }
        if (end !== undefined) {
          // same bump rules as the app's task popup: a later end date counts as a bump after a 48-hour grace
          const oldEnd = ymd(p.end) || "";
          if (!oldEnd && end) p.datesSetAt = Date.now();
          else if (oldEnd && end && end > oldEnd && Date.now() - (Number(p.datesSetAt) || 0) > 48 * 3600 * 1000) {
            if (!p.origEnd) {
              p.origStart = p.start || "";
              p.origEnd = oldEnd;
            }
            p.bumps = (Number(p.bumps) || 0) + 1;
          }
          p.end = end;
          if (p.origEnd && end && end <= (ymd(p.origEnd) || "")) {
            p.origStart = "";
            p.origEnd = "";
          }
        }
        if (start !== undefined) p.start = start;
        const s2 = ymd(p.start), e2 = ymd(p.end);
        if (s2 && e2 && e2 < s2) throw new ToolError("The end date would be before the start date. Nothing was saved.");
        if (note) p.note = (str(p.note) ? str(p.note) + "\n" : "") + `${ctx.today} (${firstName(me.email)}, via Claude): ${note}`;
        newPct = Number(p.pct) || 0;
        if (newPct >= 100 && oldPct < 100) sinkTask(d, i);
        autoStage(d);
      });
      if (!res.changed) return { saved: "no", summary: `Nothing to change: "${title}" already looks like that.` };
      const bits = [];
      if (newPct !== oldPct) bits.push(newPct >= 100 ? "ticked done" : oldPct >= 100 ? `un-ticked (back to ${newPct}%)` : `${oldPct}% → ${newPct}%`);
      if (end !== undefined) bits.push(end ? `end date ${end}` : "end date cleared");
      if (start !== undefined) bits.push(start ? `start date ${start}` : "start date cleared");
      if (note) bits.push("note added");
      const p = res.after;
      const summary = `"${title}" on "${str(p.title)}": ${bits.join(", ")}. Priority now ${prioPct(p)}%, stage ${stageOf(p)}.`;
      const ti = arr(p.done).findIndex((t: Json) => str(t) === title);
      const bi = arr(res.before.done).findIndex((t: Json) => str(t) === title);
      const logged = await logChange(me, "update_task", `${table}:${e.id}`, summary,
        { task: title, ...arr(res.before.plan)[bi] }, { task: title, ...arr(p.plan)[ti] });
      return saved(summary, logged, { bumped: ti >= 0 ? bumpInfo(arr(p.plan)[ti]) || "" : "" });
    },
  },
  {
    name: "set_dod_line",
    title: "Tick a Definition of Done line",
    write: true,
    repeatable: true,
    description:
      "Tick (or un-tick) one Definition of Done line on a priority. When every line is ticked the priority becomes complete, as in the app. Confirm with the person first.",
    inputSchema: {
      type: "object",
      properties: {
        ...priorityArgs,
        line: { type: "string", description: "The line's number (as get_priority lists them) or its text." },
        met: { type: "boolean", description: "true (default) = tick it; false = un-tick it." },
      },
      required: ["line"],
    },
    run: async (a, ctx) => {
      const met = a.met !== false;
      const { table, e } = await findPrioForUpdate(ctx, a);
      const lines = dodLines(e);
      if (!lines.length) throw new ToolError("This priority has no Definition of Done lines.");
      const s = str(a.line).trim();
      let at = -1;
      if (/^\d+$/.test(s) && Number(s) >= 1 && Number(s) <= lines.length) at = Number(s) - 1;
      else {
        let idx = lines.map((t, i) => (lc(t) === lc(s) ? i : -1)).filter((i) => i >= 0);
        if (!idx.length) idx = lines.map((t, i) => (textMatches([t], s) ? i : -1)).filter((i) => i >= 0);
        if (idx.length !== 1) throw new ToolError(`Couldn't pick one line from "${s}". Lines: ${lines.map((t, i) => `${i + 1}. ${t}`).join("; ")}`);
        at = idx[0];
      }
      const text = lines[at];
      const me = ctx.me;
      const res = await changeRecord(me, table, e.id, (d) => {
        if (!canChangePrio(d, me)) throw new ToolError("Your account can only change priorities you PM, are assigned to, or have a task on.");
        const L = dodLines(d);
        const i = L[at] === text ? at : L.indexOf(text);
        if (i < 0) throw new ToolError("That line changed while saving. Nothing was saved; check get_priority and try again.");
        d.dodIds = dodIds(d);
        const id = d.dodIds[i];
        if (!d.dodMet || typeof d.dodMet !== "object" || Array.isArray(d.dodMet)) d.dodMet = {};
        if (met) {
          if (!d.dodMet[id]) d.dodMet[id] = { by: me.email, at: ctx.today };
        } else delete d.dodMet[id];
        autoStage(d);
      });
      if (!res.changed) return { saved: "no", summary: `Nothing to change: "${text}" is already ${met ? "ticked" : "not ticked"}.` };
      const it = dodItems(res.after);
      const summary = `${met ? "Ticked" : "Un-ticked"} "${text}" on "${str(res.after.title)}" (${it.filter((x) => x.met).length} of ${it.length} met). ` +
        (stageOf(res.after) === "complete" ? "The priority is now complete." : `Stage: ${stageOf(res.after)}.`);
      const logged = await logChange(me, "set_dod_line", `${table}:${e.id}`, summary, { line: text, met: !met }, { line: text, met });
      return saved(summary, logged);
    },
  },
  {
    name: "add_todo",
    title: "Add a to-do",
    write: true,
    description:
      "Add a to-do to the To-Dos page, for the signed-in person or (Admins and Leadership) for someone else. " +
      "Due in a week unless a date is given. Confirm the wording, owner and due date with the person first.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "What needs doing." },
        owner: { ...personArg, description: "Who it's for: an email, a first name, or \"me\" (default)." },
        due: { type: "string", description: "Due date, YYYY-MM-DD. Default: a week from today." },
      },
      required: ["text"],
    },
    run: async (a, ctx) => {
      const text = str(a.text).trim();
      if (!text) throw new ToolError("The to-do needs some text.");
      if (text.length > 1000) throw new ToolError("That's too long for a to-do; keep it under 1,000 characters.");
      const me = ctx.me;
      let owner = ctx.person(a.owner);
      if (!owner.includes("@")) {
        await Promise.all([ctx.priorities(), ctx.meetings(), ctx.metricsAll(), ctx.items("pri")]);
        owner = ctx.dir.resolve(owner);
      }
      owner = lc(owner);
      if (!owner.includes("@")) throw new ToolError(`Couldn't tell who "${a.owner}" is. Use their email.`);
      if (owner !== me.email && me.role === "team") throw new ToolError("Your account can only add to-dos for yourself.");
      const due = dateArg(a.due, "due") || addDays(ctx.today, 7);
      const row = {
        id: newId(),
        meeting_id: "standalone",
        section: "todos",
        inst: due,
        data: { type: "pri", text, done: false, author: owner, due, assignedBy: me.email, standalone: true, t: Date.now(), via: "claude" },
      };
      const r = await rest(me, "POST", "mtg_items", row, "return=minimal");
      if (!r.ok) throw new ToolError(`The database didn't accept the to-do (${r.status}): ${r.text.slice(0, 200)}`);
      const summary = `Added to-do "${clip(text, 120)}" for ${owner === me.email ? "you" : owner}, due ${due}.`;
      const logged = await logChange(me, "add_todo", `mtg_items:${row.id}`, summary, null, row.data);
      return saved(summary, logged, { id: row.id });
    },
  },
  {
    name: "complete_todo",
    title: "Tick off a to-do",
    write: true,
    repeatable: true,
    description:
      "Mark a to-do done (or not done). People can tick their own to-dos; Admins and Super Admins can tick anyone's. " +
      "Pass the id from list_todos, or search words that match exactly one. Confirm with the person first.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The to-do's id from list_todos (best)." },
        search: { type: "string", description: "Or words from the to-do's text." },
        done: { type: "boolean", description: "true (default) = done; false = not done." },
      },
    },
    run: async (a, ctx) => {
      const done = a.done !== false;
      const me = ctx.me;
      // whose it is: the To-Dos page goes by who it's for (author); the meeting view also lets
      // the person it's assigned to tick it
      const owner = (it: Json) => str(it.data.author || it.data.owner);
      const isMine = (it: Json) => [it.data.author, it.data.owner, it.data.assignee].some((x) => x && ctx.dir.matches(x, me.email));
      const all = await ctx.items("pri");
      const mine = all.filter((it) => isMine(it) || canSeeEveryone(me));
      const pool = a.id ? mine : mine.filter((it) => !!it.data.done !== done);
      const it = pickItem(pool, a, "to-do");
      const res = await changeRecord(me, "mtg_items", it.id, (d) => {
        d.done = done;
        d.doneBy = done ? me.email : "";
        d.doneAt = done ? Date.now() : null;
        if (!done && d.jiraDone) d.jiraSkip = true;
      });
      if (!res.changed) return { saved: "no", summary: `Nothing to change: it's already ${done ? "done" : "open"}.` };
      const summary = `${done ? "Ticked off" : "Re-opened"} to-do "${clip(it.data.text, 120)}"${isMine(it) ? "" : ` (${owner(it)}'s)`}.`;
      const logged = await logChange(me, "complete_todo", `mtg_items:${it.id}`, summary, { done: !!res.before.done }, { done });
      return saved(summary, logged);
    },
  },
  {
    name: "move_issue",
    title: "Move an issue card",
    write: true,
    repeatable: true,
    description:
      "Move a card on an issues board to Not started, In progress, Has update or Done, in a meeting the person can see (any attendee can, as in the app). " +
      "Pass the id from list_issues, or search words that match exactly one. Confirm with the person first.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The issue's id from list_issues (best)." },
        search: { type: "string", description: "Or words from the issue's title." },
        status: { type: "string", enum: ["notstarted", "inprogress", "hasupdate", "done"] },
      },
      required: ["status"],
    },
    run: async (a, ctx) => {
      const status = str(a.status);
      if (!ISSUE_LABEL[status]) throw new ToolError("status must be notstarted, inprogress, hasupdate or done.");
      const me = ctx.me;
      const [items, mtgs] = await Promise.all([ctx.items("issue"), ctx.meetings()]);
      const byId = new Map(mtgs.map((m) => [m.id, m]));
      const visible = items.filter((it) => {
        const m = byId.get(it.meeting_id);
        return m ? mtgVisible(m, me, ctx.dir) : me.role === "superadmin";
      });
      const it = pickItem(visible, a, "issue");
      const was = str(it.data.status) || "notstarted";
      if (was === status) return { saved: "no", summary: `Nothing to change: "${clip(it.data.text, 120)}" is already ${ISSUE_LABEL[status]}.` };
      const res = await changeRecord(me, "mtg_items", it.id, (d) => {
        d.status = status;
        d.editedAt = Date.now();
        d.editedBy = me.email;
      });
      const summary = `Moved issue "${clip(it.data.text, 120)}" from ${ISSUE_LABEL[was] || was} to ${ISSUE_LABEL[status]}` +
        (byId.get(it.meeting_id) ? ` (${str(byId.get(it.meeting_id)!.title)}).` : ".");
      const logged = await logChange(me, "move_issue", `mtg_items:${it.id}`, summary, { status: was }, { status });
      return saved(summary, logged);
    },
  },
  {
    name: "set_metric_value",
    title: "Enter a weekly metric number",
    write: true,
    repeatable: true,
    description:
      "Enter (or clear) one week's number on a scorecard metric. Weeks run Sunday to Saturday. " +
      "By the team's convention, the number reported on Monday is last week's, so week defaults to last_week. " +
      "Team-role users can only fill metrics they own. Calculated and roll-up metrics work their numbers out from others, so fill their inputs instead. " +
      "Confirm the metric, week and number with the person first.",
    inputSchema: {
      type: "object",
      properties: {
        metric: { type: "string", description: "Metric id or name." },
        value: { type: "number", description: "The number, without % or $ signs." },
        clear: { type: "boolean", description: "true = remove that week's number instead of entering one." },
        week: { type: "string", description: 'last_week (default), this_week, or any date in the week (YYYY-MM-DD).' },
      },
      required: ["metric"],
    },
    run: async (a, ctx) => {
      const me = ctx.me;
      const all = await ctx.metricsAll();
      const hits = findMetric(all.filter((m) => metricVisible(m, me)), str(a.metric));
      if (!hits.length) throw new ToolError(`No metric matching "${a.metric}" (or you don't have access to it).`);
      if (hits.length > 1) throw new ToolError("More than one metric matches: " + hits.map((m) => `"${m.name}" (id ${m.id})`).join("; ") + ". Use the id or exact name.");
      const m = hits[0];
      if (me.role === "team" && lc(m.owner) !== me.email) throw new ToolError("Your account can only fill in metrics you own.");
      if (isRollup(m) || isCalc(m)) throw new ToolError(`"${m.name}" works its number out (${fillMethod(m, all)}). Fill in its inputs instead.`);
      const wq = lc(a.week || "last_week").replace(/\s+/g, "_");
      const thisWk = weekStartOf(ctx.today);
      let wk: string;
      if (wq === "last_week") wk = addDays(thisWk, -7);
      else if (wq === "this_week") wk = thisWk;
      else {
        const d = dateArg(a.week, "week");
        if (!d) throw new ToolError("week must be last_week, this_week or a date.");
        wk = weekStartOf(d);
      }
      const raw = a.value;
      const clear = a.clear === true;
      if (!clear && (raw === null || raw === undefined || str(raw).trim() === "")) throw new ToolError("Pass a value, or clear: true to remove that week's number.");
      let value: number | null = null;
      if (!clear) {
        value = typeof raw === "number" ? raw : Number(str(raw).trim().replace(/,/g, ""));
        if (!isFinite(value)) throw new ToolError(`"${raw}" isn't a number. Pass just the number, without % or $ signs.`);
      }
      const prev = (m.values || {})[wk];
      const prevV = prev === undefined || prev === "" ? null : prev;
      if ((clear && prevV === null) || (!clear && Number(prevV) === value && prevV !== null)) {
        return { saved: "no", summary: `Nothing to change: "${m.name}" for the week of ${wk} is already ${clear ? "empty" : value}.` };
      }
      const key = `${m.id}|${wk}`;
      if (clear) {
        const r = await rest(me, "DELETE", `metric_values?id=eq.${encodeURIComponent(key)}`, undefined, "return=representation");
        if (!r.ok) throw new ToolError(`The database didn't accept that (${r.status}): ${r.text.slice(0, 200)}`);
        if (!Array.isArray(r.data) || !r.data.length) throw new ToolError("The database refused to clear that week for your account. Nothing was changed.");
      } else {
        const r = await rest(me, "POST", "metric_values", { id: key, metric_id: m.id, wk, value }, "resolution=merge-duplicates,return=representation");
        if (!r.ok) {
          if (r.status === 401 || r.status === 403 || /row-level security/i.test(r.text)) throw new ToolError("The database refused that number for your account. Nothing was saved.");
          throw new ToolError(`The database didn't accept that number (${r.status}): ${r.text.slice(0, 200)}`);
        }
        const back = await readRow(me, "metric_values", key);
        if (!back || Number(back.value) !== value) throw new ToolError("The number didn't stick (the metric may have been deleted). Nothing was saved.");
      }
      const summary = `"${m.name}", week of ${wk}: ${prevV === null ? "empty" : prevV} → ${clear ? "empty" : value}.`;
      const logged = await logChange(me, "set_metric_value", `metric_values:${key}`, summary, { value: prevV }, { value: clear ? null : value });
      return saved(summary, logged);
    },
  },
  {
    name: "list_recent_changes",
    title: "Changes made through Claude",
    description: "What's been changed in Round Up through Claude, newest first: who, when and what. Admins see everyone's; others see their own.",
    inputSchema: {
      type: "object",
      properties: { days: { type: "number", description: "How far back. Default 7." } },
    },
    run: async (a, ctx) => {
      const days = Number(a.days) > 0 ? Math.min(Number(a.days), 365) : 7;
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const r = await rest(ctx.me, "GET", `connector_log?select=at,by_email,tool,summary&at=gte.${encodeURIComponent(since)}&order=at.desc&limit=300`);
      if (r.status === 404 || (r.data && r.data.code === "42P01") || (r.data && r.data.code === "PGRST205")) throw new ToolError(NEEDS_SETUP);
      if (!r.ok) throw new ToolError(`Couldn't read the change log (${r.status}): ${r.text.slice(0, 200)}`);
      const rows = (Array.isArray(r.data) ? r.data : []).map((x: Json) => ({
        when: new Date(x.at).toLocaleString("en-CA", { timeZone: TZ, dateStyle: "medium", timeStyle: "short" }),
        who: str(x.by_email),
        what: str(x.summary),
      }));
      return { days, count: rows.length, changes: rows };
    },
  },
);

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
          annotations: t.write
            ? { title: t.title, readOnlyHint: false, destructiveHint: false, idempotentHint: !!t.repeatable, openWorldHint: false }
            : { title: t.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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

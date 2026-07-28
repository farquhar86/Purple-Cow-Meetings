// Supabase Edge Function: manage-users
// Lets logged-in managers list / add / remove login accounts.
// The admin (service-role) key stays here on the server — never in the website.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const json = (obj: unknown, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // 1) Confirm the caller is a logged-in user
    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const asUser = createClient(url, anonKey, { global: { headers: { Authorization: `Bearer ${token}` } } });
    const { data: { user }, error: authErr } = await asUser.auth.getUser(token);
    if (authErr || !user) return json({ error: "Not authorized — please log in again." }, 401);

    // 2) Do the admin action with the service key
    const admin = createClient(url, serviceKey);
    const body = await req.json().catch(() => ({}));

    const ROLES = ["superadmin", "admin", "leadership", "team"];

    // Look up a teammate's Slack profile photo by email.
    // Needs a Supabase secret SLACK_BOT_TOKEN with scopes: users:read, users:read.email
    // If the token isn't set, this quietly returns null and everything else still works.
    const slackAvatar = async (email: string): Promise<string | null> => {
      const token = Deno.env.get("SLACK_BOT_TOKEN");
      if (!token || !email) return null;
      try {
        const r = await fetch(
          "https://slack.com/api/users.lookupByEmail?email=" + encodeURIComponent(email),
          { headers: { Authorization: `Bearer ${token}` } },
        );
        const j = await r.json();
        if (!j.ok || !j.user) return null;
        const p = j.user.profile || {};
        return p.image_192 || p.image_512 || p.image_72 || null;
      } catch (_e) {
        return null;
      }
    };

    if (body.action === "list") {
      const { data, error } = await admin.auth.admin.listUsers();
      if (error) throw error;
      const users = data.users.map((u) => ({
        id: u.id,
        email: u.email,
        created_at: u.created_at,
        role: (u.app_metadata && (u.app_metadata as any).role) || "admin",
        avatar: (u.app_metadata && (u.app_metadata as any).avatar) || null,
        last_sign_in_at: u.last_sign_in_at || null,
        confirmed: !!(u.email_confirmed_at || u.confirmed_at),
      }));
      return json({ users });
    }

    if (body.action === "create") {
      if (!body.email) return json({ error: "Email is required." }, 400);
      const role = ROLES.includes(body.role) ? body.role : "team";
      // Send an invite email; the person clicks the link and sets their own password.
      const { data, error } = await admin.auth.admin.inviteUserByEmail(
        body.email,
        body.redirectTo ? { redirectTo: body.redirectTo } : undefined,
      );
      if (error) {
        const detail = (error as any)?.message || (error as any)?.name || (error as any)?.code || "unknown error";
        return json({ error: "Invite failed — " + detail + ". This usually means the email couldn't be sent (check Custom SMTP / verified sender), or the person is already invited." }, 400);
      }
      // Stamp the chosen role — and their Slack photo, if we can find one — onto the new account.
      const avatar = await slackAvatar(body.email);
      await admin.auth.admin.updateUserById(data.user.id, { app_metadata: { role, avatar } });
      return json({ user: { id: data.user.id, email: data.user.email, role, avatar }, invited: true });
    }

    if (body.action === "syncavatars") {
      if (!Deno.env.get("SLACK_BOT_TOKEN")) {
        return json({ error: "No Slack token configured. Add a SLACK_BOT_TOKEN secret to this function first." }, 400);
      }
      const { data, error } = await admin.auth.admin.listUsers();
      if (error) throw error;
      let updated = 0;
      for (const u of data.users) {
        if (!u.email) continue;
        const avatar = await slackAvatar(u.email);
        if (!avatar) continue;
        const meta = (u.app_metadata || {}) as Record<string, unknown>;
        await admin.auth.admin.updateUserById(u.id, { app_metadata: { ...meta, avatar } });
        updated++;
      }
      return json({ ok: true, updated });
    }

    if (body.action === "setrole") {
      if (!body.id) return json({ error: "User id is required." }, 400);
      if (!ROLES.includes(body.role)) return json({ error: "Unknown role." }, 400);
      // Keep any existing metadata (like their Slack photo) and just change the role.
      const existing = await admin.auth.admin.getUserById(body.id);
      const meta = (existing.data?.user?.app_metadata || {}) as Record<string, unknown>;
      const { error } = await admin.auth.admin.updateUserById(body.id, { app_metadata: { ...meta, role: body.role } });
      if (error) throw error;
      return json({ ok: true, role: body.role });
    }

    if (body.action === "delete") {
      if (!body.id) return json({ error: "User id is required." }, 400);
      if (body.id === user.id) return json({ error: "You can't remove your own account." }, 400);
      const { error } = await admin.auth.admin.deleteUser(body.id);
      if (error) throw error;
      return json({ ok: true });
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});

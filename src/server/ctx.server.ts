// Server-only helpers shared by all server functions.
import type { SupabaseClient } from "@supabase/supabase-js";

export type Role = "admin" | "hr" | "employee";
export type Ctx = { supabase: SupabaseClient; userId: string; email?: string };

export function fail(message: string, status = 400): never {
  const e = new Error(message) as Error & { status?: number };
  e.status = status;
  throw e;
}

export async function getRole(supabase: SupabaseClient, userId: string): Promise<Role | null> {
  const { data } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .maybeSingle();
  return (data?.role as Role) ?? null;
}

export async function requireRole(ctx: Ctx, allowed: Role[]): Promise<Role> {
  const role = await getRole(ctx.supabase, ctx.userId);
  if (!role || !allowed.includes(role)) fail("Forbidden: you do not have permission for this action.", 403);
  return role;
}

export async function getMyEmployee(supabase: SupabaseClient, userId: string) {
  const { data } = await supabase.from("employees").select("*").eq("user_id", userId).maybeSingle();
  return data;
}

export async function getSettings(supabase: SupabaseClient) {
  const { data } = await supabase
    .from("company_settings")
    .select("*")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return data;
}

export async function getHolidayKeys(supabase: SupabaseClient, fromKey: string, toKey: string): Promise<string[]> {
  const { data } = await supabase
    .from("holidays")
    .select("holiday_date")
    .gte("holiday_date", fromKey)
    .lte("holiday_date", toKey);
  return (data ?? []).map((h: { holiday_date: string }) => h.holiday_date);
}

export async function writeAudit(
  supabase: SupabaseClient,
  actor: { id: string; email?: string },
  action: string,
  entity: string,
  entityId?: string | null,
  before?: unknown,
  after?: unknown,
) {
  await supabase.from("audit_log").insert({
    actor_id: actor.id,
    actor_email: actor.email ?? null,
    action,
    entity,
    entity_id: entityId ?? null,
    before_json: (before ?? null) as never,
    after_json: (after ?? null) as never,
  });
}

export async function notifyUsers(
  supabase: SupabaseClient,
  userIds: string[],
  title: string,
  body?: string,
  link?: string,
) {
  if (!userIds.length) return;
  await supabase.from("notifications").insert(
    userIds.map((user_id) => ({ user_id, title, body: body ?? null, link: link ?? null })),
  );
}

export async function getMgmtUserIds(supabase: SupabaseClient): Promise<string[]> {
  const { data } = await supabase.from("user_roles").select("user_id").in("role", ["admin", "hr"]);
  return (data ?? []).map((r: { user_id: string }) => r.user_id);
}

/** Resolve the acting employee row, enforcing scope for employee-role callers. */
export async function requireEmployeeFor(ctx: Ctx, employeeId?: string) {
  const role = await requireRole(ctx, ["admin", "hr", "employee"]);
  if (role === "employee") {
    const me = await getMyEmployee(ctx.supabase, ctx.userId);
    if (!me) fail("No employee profile is linked to your account.", 403);
    if (employeeId && employeeId !== me.id) fail("Forbidden: you can only access your own data.", 403);
    return { role, employee: me };
  }
  if (employeeId) {
    const { data: emp } = await ctx.supabase.from("employees").select("*").eq("id", employeeId).maybeSingle();
    if (!emp) fail("Employee not found.", 404);
    return { role, employee: emp };
  }
  const me = await getMyEmployee(ctx.supabase, ctx.userId);
  return { role, employee: me ?? null };
}

export function weekStartKey(key: string): string {
  const d = new Date(key + "T12:00:00Z");
  const day = d.getUTCDay();
  const diff = day === 0 ? 6 : day - 1; // Monday start
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().slice(0, 10);
}

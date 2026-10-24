-- ===== HCM Lite schema =====
create type public.app_role as enum ('admin','hr','employee');

create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  role public.app_role not null,
  unique (user_id, role)
);
grant select on public.user_roles to authenticated;
grant all on public.user_roles to service_role;
alter table public.user_roles enable row level security;

create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_roles where user_id = _user_id and role = _role)
$$;

create or replace function public.has_any_role(_user_id uuid, _roles public.app_role[])
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_roles where user_id = _user_id and role = any(_roles))
$$;

create policy "users read own role" on public.user_roles for select to authenticated using (user_id = auth.uid());
create policy "admins manage roles" on public.user_roles for all to authenticated using (public.has_role(auth.uid(),'admin')) with check (public.has_role(auth.uid(),'admin'));

create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  must_change_password boolean not null default false,
  created_at timestamptz not null default now()
);
grant select, update on public.profiles to authenticated;
grant all on public.profiles to service_role;
alter table public.profiles enable row level security;
create policy "read own or mgmt" on public.profiles for select to authenticated using (user_id = auth.uid() or public.has_any_role(auth.uid(), '{admin,hr}'));
create policy "update own" on public.profiles for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create table public.company_settings (
  id uuid primary key default gen_random_uuid(),
  company_name text not null,
  office_start_time text not null default '09:00',
  grace_minutes int not null default 15,
  half_day_hours numeric not null default 5,
  weekend_days jsonb not null default '[0,6]',
  timezone text not null default 'Asia/Karachi',
  office_lat numeric,
  office_lng numeric,
  office_radius_m int not null default 150,
  is_configured boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select, update on public.company_settings to authenticated;
grant all on public.company_settings to service_role;
alter table public.company_settings enable row level security;
create policy "all read settings" on public.company_settings for select to authenticated using (true);
create policy "admin update settings" on public.company_settings for update to authenticated using (public.has_role(auth.uid(),'admin')) with check (public.has_role(auth.uid(),'admin'));

create table public.departments (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);
create table public.designations (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);
create table public.leave_types (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  annual_quota numeric not null,
  is_unpaid boolean not null default false,
  active boolean not null default true
);
create table public.holidays (
  id uuid primary key default gen_random_uuid(),
  holiday_date date not null unique,
  name text not null
);
grant select on public.departments to authenticated;
grant select on public.designations to authenticated;
grant select on public.leave_types to authenticated;
grant select on public.holidays to authenticated;
grant all on public.departments to service_role;
grant all on public.designations to service_role;
grant all on public.leave_types to service_role;
grant all on public.holidays to service_role;
grant insert, update, delete on public.departments to authenticated;
grant insert, update, delete on public.designations to authenticated;
grant insert, update, delete on public.leave_types to authenticated;
grant insert, update, delete on public.holidays to authenticated;
alter table public.departments enable row level security;
alter table public.designations enable row level security;
alter table public.leave_types enable row level security;
alter table public.holidays enable row level security;
create policy "all read" on public.departments for select to authenticated using (true);
create policy "admin write" on public.departments for all to authenticated using (public.has_role(auth.uid(),'admin')) with check (public.has_role(auth.uid(),'admin'));
create policy "all read" on public.designations for select to authenticated using (true);
create policy "admin write" on public.designations for all to authenticated using (public.has_role(auth.uid(),'admin')) with check (public.has_role(auth.uid(),'admin'));
create policy "all read" on public.leave_types for select to authenticated using (true);
create policy "admin write" on public.leave_types for all to authenticated using (public.has_role(auth.uid(),'admin')) with check (public.has_role(auth.uid(),'admin'));
create policy "all read" on public.holidays for select to authenticated using (true);
create policy "admin write" on public.holidays for all to authenticated using (public.has_role(auth.uid(),'admin')) with check (public.has_role(auth.uid(),'admin'));

create table public.employees (
  id uuid primary key default gen_random_uuid(),
  employee_code text not null unique,
  user_id uuid,
  full_name text not null,
  email text not null unique,
  phone text,
  address text,
  gender text,
  department_id uuid references public.departments(id) on delete set null,
  designation_id uuid references public.designations(id) on delete set null,
  date_of_joining date not null,
  exit_date date,
  basic_salary numeric not null check (basic_salary > 0),
  status text not null default 'active'
);
grant select, insert, update on public.employees to authenticated;
grant all on public.employees to service_role;
alter table public.employees enable row level security;
create policy "mgmt read all" on public.employees for select to authenticated using (public.has_any_role(auth.uid(), '{admin,hr}'));
create policy "employee read own" on public.employees for select to authenticated using (user_id = auth.uid());
create policy "mgmt insert" on public.employees for insert to authenticated with check (public.has_any_role(auth.uid(), '{admin,hr}'));
create policy "mgmt update" on public.employees for update to authenticated using (public.has_any_role(auth.uid(), '{admin,hr}')) with check (public.has_any_role(auth.uid(), '{admin,hr}'));
create policy "employee update own contact" on public.employees for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace function public.guard_employee_self_edit()
returns trigger language plpgsql security definer set search_path = public as $$
declare is_mgr boolean;
begin
  select public.has_any_role(auth.uid(), '{admin,hr}') into is_mgr;
  if coalesce(is_mgr, false) then return new; end if;
  if new.employee_code is distinct from old.employee_code
     or new.full_name is distinct from old.full_name
     or new.email is distinct from old.email
     or new.basic_salary is distinct from old.basic_salary
     or new.status is distinct from old.status
     or new.date_of_joining is distinct from old.date_of_joining
     or new.department_id is distinct from old.department_id
     or new.designation_id is distinct from old.designation_id
     or new.user_id is distinct from old.user_id
     or new.exit_date is distinct from old.exit_date
     or new.gender is distinct from old.gender then
    raise exception 'Employees may only change their phone and address';
  end if;
  return new;
end $$;
create trigger trg_guard_employee_self_edit before update on public.employees
for each row execute function public.guard_employee_self_edit();

create table public.attendance (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  work_date date not null,
  check_in timestamptz,
  check_out timestamptz,
  status text not null default 'present',
  minutes_worked int,
  unique (employee_id, work_date)
);
grant select, insert, update on public.attendance to authenticated;
grant all on public.attendance to service_role;
alter table public.attendance enable row level security;
create policy "mgmt all" on public.attendance for all to authenticated using (public.has_any_role(auth.uid(), '{admin,hr}')) with check (public.has_any_role(auth.uid(), '{admin,hr}'));
create policy "employee own" on public.attendance for select to authenticated using (exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid()));
create policy "employee check in own" on public.attendance for insert to authenticated with check (exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid()));
create policy "employee update own" on public.attendance for update to authenticated using (exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid())) with check (exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid()));

create table public.attendance_corrections (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  work_date date not null,
  requested_check_in timestamptz,
  requested_check_out timestamptz,
  reason text not null,
  status text not null default 'pending',
  reviewed_by uuid,
  review_comment text,
  created_at timestamptz not null default now()
);
grant select, insert, update on public.attendance_corrections to authenticated;
grant all on public.attendance_corrections to service_role;
alter table public.attendance_corrections enable row level security;
create policy "mgmt all" on public.attendance_corrections for all to authenticated using (public.has_any_role(auth.uid(), '{admin,hr}')) with check (public.has_any_role(auth.uid(), '{admin,hr}'));
create policy "employee own" on public.attendance_corrections for select to authenticated using (exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid()));
create policy "employee insert own" on public.attendance_corrections for insert to authenticated with check (exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid()) and status = 'pending');

create table public.leave_applications (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  leave_type_id uuid not null references public.leave_types(id),
  start_date date not null,
  end_date date not null,
  days numeric not null,
  reason text not null,
  status text not null default 'pending',
  decided_by uuid,
  decision_comment text,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
grant select, insert, update on public.leave_applications to authenticated;
grant all on public.leave_applications to service_role;
alter table public.leave_applications enable row level security;
create policy "mgmt all" on public.leave_applications for all to authenticated using (public.has_any_role(auth.uid(), '{admin,hr}')) with check (public.has_any_role(auth.uid(), '{admin,hr}'));
create policy "employee own" on public.leave_applications for select to authenticated using (exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid()));
create policy "employee apply own" on public.leave_applications for insert to authenticated with check (exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid()) and status = 'pending');
create policy "employee cancel own" on public.leave_applications for update to authenticated using (exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid())) with check (exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid()));

create table public.payroll_runs (
  id uuid primary key default gen_random_uuid(),
  period_month date not null unique,
  status text not null default 'draft',
  working_days int not null,
  created_by uuid,
  finalized_by uuid,
  finalized_at timestamptz,
  created_at timestamptz not null default now()
);
grant select, insert, update on public.payroll_runs to authenticated;
grant all on public.payroll_runs to service_role;
alter table public.payroll_runs enable row level security;
create policy "mgmt all" on public.payroll_runs for all to authenticated using (public.has_any_role(auth.uid(), '{admin,hr}')) with check (public.has_any_role(auth.uid(), '{admin,hr}'));

create table public.payslips (
  id uuid primary key default gen_random_uuid(),
  payroll_run_id uuid not null references public.payroll_runs(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  working_days int not null,
  employed_days int not null,
  payable_days numeric not null,
  gross numeric not null,
  deductions numeric not null,
  tax numeric not null,
  net numeric not null,
  breakdown jsonb not null default '{}',
  unique (payroll_run_id, employee_id)
);
grant select, insert on public.payslips to authenticated;
grant all on public.payslips to service_role;
alter table public.payslips enable row level security;
create policy "mgmt all" on public.payslips for all to authenticated using (public.has_any_role(auth.uid(), '{admin,hr}')) with check (public.has_any_role(auth.uid(), '{admin,hr}'));
create policy "employee own" on public.payslips for select to authenticated using (exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid()));

create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid,
  actor_email text,
  action text not null,
  entity text not null,
  entity_id text,
  before_json jsonb,
  after_json jsonb,
  created_at timestamptz not null default now()
);
grant insert, select on public.audit_log to authenticated;
grant all on public.audit_log to service_role;
alter table public.audit_log enable row level security;
create policy "admin read" on public.audit_log for select to authenticated using (public.has_role(auth.uid(),'admin'));
create policy "authenticated append" on public.audit_log for insert to authenticated with check (true);

create table public.announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  created_by uuid,
  created_at timestamptz not null default now()
);
grant select, insert, delete on public.announcements to authenticated;
grant all on public.announcements to service_role;
alter table public.announcements enable row level security;
create policy "all read" on public.announcements for select to authenticated using (true);
create policy "mgmt post" on public.announcements for insert to authenticated with check (public.has_any_role(auth.uid(), '{admin,hr}'));
create policy "admin delete" on public.announcements for delete to authenticated using (public.has_role(auth.uid(),'admin'));

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  title text not null,
  body text,
  link text,
  read boolean not null default false,
  created_at timestamptz not null default now()
);
grant select, insert, update on public.notifications to authenticated;
grant all on public.notifications to service_role;
alter table public.notifications enable row level security;
create policy "read own" on public.notifications for select to authenticated using (user_id = auth.uid());
create policy "update own" on public.notifications for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "mgmt send" on public.notifications for insert to authenticated with check (public.has_any_role(auth.uid(), '{admin,hr}'));

create table public.ai_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  kind text not null,
  tokens int,
  created_at timestamptz not null default now()
);
grant select, insert on public.ai_logs to authenticated;
grant all on public.ai_logs to service_role;
alter table public.ai_logs enable row level security;
create policy "insert own" on public.ai_logs for insert to authenticated with check (user_id = auth.uid());
create policy "read own" on public.ai_logs for select to authenticated using (user_id = auth.uid());

create index idx_attendance_emp_date on public.attendance(employee_id, work_date);
create index idx_leave_emp on public.leave_applications(employee_id, status);
create index idx_audit_created on public.audit_log(created_at desc);
create index idx_notifications_user on public.notifications(user_id, read);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (user_id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email,'@',1)))
  on conflict (user_id) do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_user();
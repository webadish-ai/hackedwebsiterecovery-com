create extension if not exists pgcrypto;

create type public.user_role as enum ('customer', 'staff', 'admin');
create type public.organization_kind as enum ('owner', 'agency');
create type public.membership_role as enum ('owner', 'member', 'agency_admin');
create type public.case_status as enum ('awaiting_payment', 'awaiting_access', 'triage', 'awaiting_approval', 'in_progress', 'verification', 'monitoring', 'completed', 'quoted_separately', 'refunded', 'cancelled');

create table public.profiles (id uuid primary key references auth.users(id) on delete cascade, email text not null, display_name text, role public.user_role not null default 'customer', mfa_enrolled_at timestamptz, created_at timestamptz not null default now());
create table public.organizations (id uuid primary key default gen_random_uuid(), name text not null, kind public.organization_kind not null default 'owner', created_at timestamptz not null default now());
create table public.organization_members (organization_id uuid not null references public.organizations(id) on delete cascade, user_id uuid not null references auth.users(id) on delete cascade, role public.membership_role not null, created_at timestamptz not null default now(), primary key (organization_id, user_id));
create table public.plans (id text not null, version text not null, name text not null, price_paise bigint not null check (price_paise >= 0), billing text not null, active boolean not null default false, snapshot jsonb not null default '{}'::jsonb, created_at timestamptz not null default now(), primary key (id, version));
create table public.orders (id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), customer_user_id uuid not null references auth.users(id), plan_id text not null, plan_version text not null, quantity integer not null check (quantity > 0), subtotal_paise bigint not null check (subtotal_paise >= 0), gst_paise bigint not null check (gst_paise >= 0), total_paise bigint not null check (total_paise = subtotal_paise + gst_paise), terms_version text not null, payment_state text not null default 'pending', created_at timestamptz not null default now(), unique (id, organization_id), foreign key (plan_id, plan_version) references public.plans(id, version));
create table public.order_items (id uuid primary key default gen_random_uuid(), order_id uuid not null references public.orders(id) on delete cascade, site_id uuid, quantity integer not null check (quantity > 0), plan_snapshot jsonb not null, created_at timestamptz not null default now());
create table public.payments (id uuid primary key default gen_random_uuid(), order_id uuid not null references public.orders(id) on delete cascade, provider text not null, provider_transaction_id text not null unique, state text not null, amount_paise bigint not null, webhook_fingerprint text unique, verified_at timestamptz, created_at timestamptz not null default now());
create table public.subscriptions (id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), order_id uuid not null, provider_customer_ref text, provider_mandate_ref text, state text not null, renews_at timestamptz, created_at timestamptz not null default now(), foreign key (order_id, organization_id) references public.orders(id, organization_id));
create table public.sites (id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), order_id uuid not null, url text not null, access_state text not null default 'not_requested', created_at timestamptz not null default now(), unique (id, organization_id), foreign key (order_id, organization_id) references public.orders(id, organization_id));
create table public.cases (id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), order_id uuid not null, site_id uuid not null, status public.case_status not null default 'awaiting_payment', assigned_staff_id uuid references auth.users(id), payment_verified_at timestamptz, access_usable_at timestamptz, response_deadline_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique (id, organization_id), foreign key (order_id, organization_id) references public.orders(id, organization_id), foreign key (site_id, organization_id) references public.sites(id, organization_id), check (response_deadline_at is null or (payment_verified_at is not null and access_usable_at is not null)));
create table public.case_events (id uuid primary key default gen_random_uuid(), case_id uuid not null, organization_id uuid not null references public.organizations(id), type text not null, from_status public.case_status, to_status public.case_status, body text not null default '', customer_visible boolean not null default false, actor_user_id uuid not null references auth.users(id), created_at timestamptz not null default now(), foreign key (case_id, organization_id) references public.cases(id, organization_id) on delete cascade);
create table public.quotes (id uuid primary key default gen_random_uuid(), case_id uuid not null, organization_id uuid not null references public.organizations(id), amount_paise bigint not null check (amount_paise >= 0), terms text not null, state text not null default 'pending', accepted_at timestamptz, created_at timestamptz not null default now(), foreign key (case_id, organization_id) references public.cases(id, organization_id) on delete cascade);
create table public.credential_sets (id uuid primary key default gen_random_uuid(), case_id uuid not null, organization_id uuid not null references public.organizations(id), state text not null default 'not_submitted', ciphertext text, key_version text, created_at timestamptz not null default now(), expires_at timestamptz, foreign key (case_id, organization_id) references public.cases(id, organization_id) on delete cascade);
create table public.attachments (id uuid primary key default gen_random_uuid(), case_id uuid not null, organization_id uuid not null references public.organizations(id), kind text not null, storage_path text not null unique, content_type text not null, byte_size bigint not null check (byte_size > 0 and byte_size <= 26214400), customer_visible boolean not null default false, scan_state text not null default 'pending', created_at timestamptz not null default now(), foreign key (case_id, organization_id) references public.cases(id, organization_id) on delete cascade);
create table public.webhook_events (id uuid primary key default gen_random_uuid(), provider text not null, fingerprint text not null unique, payload_hash text not null, received_at timestamptz not null default now(), processed_at timestamptz);
create table public.audit_logs (id uuid primary key default gen_random_uuid(), organization_id uuid references public.organizations(id), actor_user_id uuid references auth.users(id), action text not null, target_type text not null, target_id text, metadata jsonb not null default '{}'::jsonb, created_at timestamptz not null default now());

create index cases_queue_idx on public.cases (response_deadline_at, status);
create index case_events_timeline_idx on public.case_events (case_id, created_at);
create unique index order_items_site_unique on public.order_items(order_id, site_id) where site_id is not null;

create or replace function public.is_staff() returns boolean language sql stable security definer set search_path = public as $$ select (auth.jwt()->>'aal') = 'aal2' and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('staff', 'admin') and p.mfa_enrolled_at is not null) $$;
create or replace function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$ select (auth.jwt()->>'aal') = 'aal2' and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin' and p.mfa_enrolled_at is not null) $$;
create or replace function public.is_org_member(org uuid) returns boolean language sql stable security definer set search_path = public as $$ select exists (select 1 from public.organization_members m where m.organization_id = org and m.user_id = auth.uid()) $$;
create or replace function public.set_response_deadline() returns trigger language plpgsql set search_path = public as $$ begin if new.payment_verified_at is not null and new.access_usable_at is not null then new.response_deadline_at := greatest(new.payment_verified_at, new.access_usable_at) + interval '4 hours'; else new.response_deadline_at := null; end if; new.updated_at := now(); return new; end $$;
create trigger cases_response_deadline before insert or update of payment_verified_at, access_usable_at, status on public.cases for each row execute function public.set_response_deadline();
create or replace function public.enforce_case_transition() returns trigger language plpgsql set search_path = public as $$ begin if new.status <> old.status and not ((old.status, new.status) in (('awaiting_payment','awaiting_access'),('awaiting_payment','refunded'),('awaiting_payment','cancelled'),('awaiting_access','triage'),('awaiting_access','refunded'),('awaiting_access','cancelled'),('triage','awaiting_access'),('triage','awaiting_approval'),('triage','in_progress'),('triage','quoted_separately'),('triage','refunded'),('triage','cancelled'),('awaiting_approval','in_progress'),('awaiting_approval','quoted_separately'),('awaiting_approval','cancelled'),('in_progress','awaiting_approval'),('in_progress','verification'),('in_progress','awaiting_access'),('in_progress','cancelled'),('verification','in_progress'),('verification','monitoring'),('verification','completed'),('monitoring','in_progress'),('monitoring','completed'),('completed','monitoring'),('completed','refunded'),('quoted_separately','awaiting_approval'),('quoted_separately','refunded'),('quoted_separately','cancelled'))) then raise exception 'invalid case transition from % to %', old.status, new.status; end if; return new; end $$;
create trigger cases_transition_guard before update of status on public.cases for each row execute function public.enforce_case_transition();
create or replace function public.prevent_event_update() returns trigger language plpgsql set search_path = public as $$ begin raise exception 'case events are append-only'; end $$;
create trigger case_events_append_only before update or delete on public.case_events for each row execute function public.prevent_event_update();
create or replace function public.prevent_audit_update() returns trigger language plpgsql set search_path = public as $$ begin raise exception 'audit logs are append-only'; end $$;
create trigger audit_logs_append_only before update or delete on public.audit_logs for each row execute function public.prevent_audit_update();

alter table public.profiles enable row level security;
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.plans enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.payments enable row level security;
alter table public.subscriptions enable row level security;
alter table public.sites enable row level security;
alter table public.cases enable row level security;
alter table public.case_events enable row level security;
alter table public.quotes enable row level security;
alter table public.credential_sets enable row level security;
alter table public.attachments enable row level security;
alter table public.webhook_events enable row level security;
alter table public.audit_logs enable row level security;

create policy profiles_self on public.profiles for select using (id = auth.uid() or public.is_staff());
create policy organizations_member on public.organizations for select using (public.is_org_member(id) or public.is_staff());
create policy organization_members_member on public.organization_members for select using (user_id = auth.uid() or public.is_org_member(organization_id) or public.is_staff());
create policy plans_public_active on public.plans for select using (active = true or public.is_staff());
create policy orders_tenant_read on public.orders for select using (customer_user_id = auth.uid() or public.is_org_member(organization_id) or public.is_staff());
create policy order_items_tenant on public.order_items for select using (exists (select 1 from public.orders o where o.id = order_id and (o.customer_user_id = auth.uid() or public.is_org_member(o.organization_id) or public.is_staff())));
create policy payments_staff_or_owner on public.payments for select using (exists (select 1 from public.orders o where o.id = order_id and (o.customer_user_id = auth.uid() or public.is_staff())));
create policy subscriptions_tenant on public.subscriptions for select using (public.is_org_member(organization_id) or public.is_staff());
create policy sites_tenant on public.sites for all using (public.is_org_member(organization_id) or public.is_staff()) with check (public.is_org_member(organization_id) or public.is_admin());
create policy cases_tenant on public.cases for select using (public.is_org_member(organization_id) or public.is_staff());
create policy cases_staff_write on public.cases for update using (public.is_staff()) with check (public.is_staff());
create policy case_events_customer_safe on public.case_events for select using ((customer_visible and public.is_org_member(organization_id)) or public.is_staff());
create policy case_events_staff_insert on public.case_events for insert with check (public.is_staff());
create policy quotes_tenant on public.quotes for select using (public.is_org_member(organization_id) or public.is_staff());
create policy quotes_staff_write on public.quotes for all using (public.is_staff()) with check (public.is_staff());
-- Credential ciphertext is a Milestone 3 concern. No exposed-role read policy
-- exists until assigned-staff reveal with recent MFA is implemented.
create policy attachments_customer_safe on public.attachments for select using ((customer_visible and public.is_org_member(organization_id)) or public.is_staff());
create policy attachments_staff_insert on public.attachments for insert with check (public.is_staff());
create policy webhook_staff_only on public.webhook_events for all using (public.is_staff()) with check (public.is_staff());
create policy audit_staff_only on public.audit_logs for select using (public.is_staff());
create policy audit_staff_insert on public.audit_logs for insert with check (public.is_staff() and auth.uid() = actor_user_id);

insert into storage.buckets (id, name, public) values ('case-reports', 'case-reports', false) on conflict (id) do nothing;
create policy case_reports_read on storage.objects for select using (bucket_id = 'case-reports' and (public.is_staff() or exists (select 1 from public.attachments a where a.storage_path = name and a.customer_visible and public.is_org_member(a.organization_id))));
create policy case_reports_staff_upload on storage.objects for insert with check (bucket_id = 'case-reports' and public.is_staff());

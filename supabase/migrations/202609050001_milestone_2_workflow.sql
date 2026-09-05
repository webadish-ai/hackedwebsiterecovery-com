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
create table public.credential_sets (id uuid primary key default gen_random_uuid(), case_id uuid not null, organization_id uuid not null references public.organizations(id), state text not null default 'active' check (state in ('active', 'revoked', 'expired')), algorithm text not null default 'aes-256-gcm' check (algorithm = 'aes-256-gcm'), nonce text, auth_tag text, ciphertext text, key_version text, created_at timestamptz not null default now(), expires_at timestamptz, revoked_at timestamptz, expired_at timestamptz, foreign key (case_id, organization_id) references public.cases(id, organization_id) on delete cascade, check ((state = 'active' and nonce is not null and auth_tag is not null and ciphertext is not null and key_version is not null) or state in ('revoked', 'expired')));
create table public.attachments (id uuid primary key default gen_random_uuid(), case_id uuid not null, organization_id uuid not null references public.organizations(id), kind text not null, storage_path text not null unique, content_type text not null, byte_size bigint not null check (byte_size > 0 and byte_size <= 26214400), customer_visible boolean not null default false, scan_state text not null default 'pending', created_at timestamptz not null default now(), foreign key (case_id, organization_id) references public.cases(id, organization_id) on delete cascade);
create table public.webhook_events (id uuid primary key default gen_random_uuid(), provider text not null, fingerprint text not null unique, payload_hash text not null, received_at timestamptz not null default now(), processed_at timestamptz);
create table public.audit_logs (id uuid primary key default gen_random_uuid(), organization_id uuid references public.organizations(id), actor_user_id uuid references auth.users(id), action text not null, target_type text not null, target_id text, metadata jsonb not null default '{}'::jsonb, created_at timestamptz not null default now());

create index cases_queue_idx on public.cases (response_deadline_at, status);
create index case_events_timeline_idx on public.case_events (case_id, created_at);
create unique index credential_sets_one_active_per_case on public.credential_sets(case_id) where state = 'active';
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

create or replace function public.case_status_transition_allowed(from_status public.case_status, to_status public.case_status) returns boolean language sql immutable set search_path = public as $$
  select (from_status = 'awaiting_payment' and to_status in ('awaiting_access', 'refunded', 'cancelled'))
      or (from_status = 'awaiting_access' and to_status in ('triage', 'refunded', 'cancelled'))
      or (from_status = 'triage' and to_status in ('awaiting_access', 'awaiting_approval', 'in_progress', 'quoted_separately', 'refunded', 'cancelled'))
      or (from_status = 'awaiting_approval' and to_status in ('in_progress', 'quoted_separately', 'cancelled'))
      or (from_status = 'in_progress' and to_status in ('awaiting_approval', 'verification', 'awaiting_access', 'cancelled'))
      or (from_status = 'verification' and to_status in ('in_progress', 'monitoring', 'completed'))
      or (from_status = 'monitoring' and to_status in ('in_progress', 'completed'))
      or (from_status = 'completed' and to_status in ('monitoring', 'refunded'))
      or (from_status = 'quoted_separately' and to_status in ('awaiting_approval', 'refunded', 'cancelled'))
$$;

create or replace function public.staff_assign_case(p_case_id uuid, p_staff_id uuid) returns public.cases
language plpgsql security definer set search_path = public as $$
declare case_record public.cases;
begin
  if not public.is_staff() then raise exception 'Staff MFA is required.' using errcode = '42501'; end if;
  if not public.is_admin() and p_staff_id <> auth.uid() then raise exception 'Only an admin can assign another operator.' using errcode = '42501'; end if;
  if not exists (select 1 from public.profiles p where p.id = p_staff_id and p.role in ('staff', 'admin') and p.mfa_enrolled_at is not null) then raise exception 'The assignee must be an enrolled staff account.' using errcode = '22023'; end if;
  select * into case_record from public.cases where id = p_case_id for update;
  if not found then raise exception 'Case not found.' using errcode = 'P0002'; end if;
  if case_record.assigned_staff_id is not null and case_record.assigned_staff_id <> auth.uid() and not public.is_admin() then raise exception 'Only the assigned operator or an admin can update this case.' using errcode = '42501'; end if;
  update public.cases set assigned_staff_id = p_staff_id, updated_at = now() where id = p_case_id returning * into case_record;
  insert into public.case_events (case_id, organization_id, type, body, customer_visible, actor_user_id) values (case_record.id, case_record.organization_id, 'case_assigned', 'Case assignment updated.', false, auth.uid());
  insert into public.audit_logs (organization_id, actor_user_id, action, target_type, target_id, metadata) values (case_record.organization_id, auth.uid(), 'case_assigned', 'case', case_record.id::text, jsonb_build_object('assigned_staff_id', p_staff_id));
  return case_record;
end $$;

create or replace function public.staff_transition_case(p_case_id uuid, p_to_status public.case_status, p_body text default '') returns public.cases
language plpgsql security definer set search_path = public as $$
declare case_record public.cases; from_status public.case_status; event_body text := coalesce(trim(p_body), '');
begin
  if not public.is_staff() then raise exception 'Staff MFA is required.' using errcode = '42501'; end if;
  select * into case_record from public.cases where id = p_case_id for update;
  if not found then raise exception 'Case not found.' using errcode = 'P0002'; end if;
  if case_record.assigned_staff_id is not null and case_record.assigned_staff_id <> auth.uid() and not public.is_admin() then raise exception 'Only the assigned operator or an admin can update this case.' using errcode = '42501'; end if;
  if not public.case_status_transition_allowed(case_record.status, p_to_status) then raise exception 'Invalid case transition.' using errcode = '22023'; end if;
  if p_to_status = 'awaiting_access' and not exists (select 1 from public.orders o where o.id = case_record.order_id and o.payment_state = 'verified') then raise exception 'Payment must be verified before access can be requested.' using errcode = '22023'; end if;
  if p_to_status = 'triage' and case_record.access_usable_at is null then raise exception 'Usable access is required before triage.' using errcode = '22023'; end if;
  if length(event_body) > 5000 or event_body ~* '(password|secret|api[_ -]?key|bearer|private key)\s*[:=]' then raise exception 'Secrets must never be written to case events.' using errcode = '22023'; end if;
  from_status := case_record.status;
  update public.cases set status = p_to_status, updated_at = now() where id = p_case_id returning * into case_record;
  insert into public.case_events (case_id, organization_id, type, from_status, to_status, body, customer_visible, actor_user_id) values (case_record.id, case_record.organization_id, 'status_changed', from_status, p_to_status, event_body, true, auth.uid());
  insert into public.audit_logs (organization_id, actor_user_id, action, target_type, target_id, metadata) values (case_record.organization_id, auth.uid(), 'case_status_changed', 'case', case_record.id::text, jsonb_build_object('to_status', p_to_status));
  return case_record;
end $$;

create or replace function public.staff_add_case_update(p_case_id uuid, p_body text, p_customer_visible boolean) returns public.case_events
language plpgsql security definer set search_path = public as $$
declare case_record public.cases; event_record public.case_events; event_body text := coalesce(trim(p_body), '');
begin
  if not public.is_staff() then raise exception 'Staff MFA is required.' using errcode = '42501'; end if;
  select * into case_record from public.cases where id = p_case_id for update;
  if not found then raise exception 'Case not found.' using errcode = 'P0002'; end if;
  if case_record.assigned_staff_id is not null and case_record.assigned_staff_id <> auth.uid() and not public.is_admin() then raise exception 'Only the assigned operator or an admin can update this case.' using errcode = '42501'; end if;
  if event_body = '' or length(event_body) > 5000 or p_customer_visible is null then raise exception 'Update text is empty or too long.' using errcode = '22023'; end if;
  if event_body ~* '(password|secret|api[_ -]?key|bearer|private key)\s*[:=]' then raise exception 'Secrets must never be written to case events.' using errcode = '22023'; end if;
  update public.cases set updated_at = now() where id = p_case_id returning * into case_record;
  insert into public.case_events (case_id, organization_id, type, body, customer_visible, actor_user_id) values (case_record.id, case_record.organization_id, case when p_customer_visible then 'customer_update' else 'internal_note' end, event_body, p_customer_visible, auth.uid()) returning * into event_record;
  insert into public.audit_logs (organization_id, actor_user_id, action, target_type, target_id, metadata) values (case_record.organization_id, auth.uid(), 'case_update_added', 'case', case_record.id::text, jsonb_build_object('customer_visible', p_customer_visible));
  return event_record;
end $$;

create or replace function public.staff_mark_access_usable(p_case_id uuid, p_access_usable_at timestamptz default now()) returns public.cases
language plpgsql security definer set search_path = public as $$
declare case_record public.cases;
begin
  if not public.is_staff() then raise exception 'Staff MFA is required.' using errcode = '42501'; end if;
  if p_access_usable_at is null or p_access_usable_at > now() then raise exception 'Usable access time must be present and cannot be in the future.' using errcode = '22023'; end if;
  select * into case_record from public.cases where id = p_case_id for update;
  if not found then raise exception 'Case not found.' using errcode = 'P0002'; end if;
  if case_record.assigned_staff_id is not null and case_record.assigned_staff_id <> auth.uid() and not public.is_admin() then raise exception 'Only the assigned operator or an admin can update this case.' using errcode = '42501'; end if;
  update public.sites set access_state = 'usable' where id = case_record.site_id and organization_id = case_record.organization_id;
  update public.cases set access_usable_at = p_access_usable_at, updated_at = now() where id = p_case_id returning * into case_record;
  insert into public.case_events (case_id, organization_id, type, body, customer_visible, actor_user_id) values (case_record.id, case_record.organization_id, 'access_verified', 'Usable access received.', true, auth.uid());
  insert into public.audit_logs (organization_id, actor_user_id, action, target_type, target_id, metadata) values (case_record.organization_id, auth.uid(), 'case_access_marked_usable', 'case', case_record.id::text, jsonb_build_object('access_usable_at', p_access_usable_at));
  return case_record;
end $$;

revoke all on function public.staff_assign_case(uuid, uuid) from public;
revoke all on function public.staff_transition_case(uuid, public.case_status, text) from public;
revoke all on function public.staff_add_case_update(uuid, text, boolean) from public;
revoke all on function public.staff_mark_access_usable(uuid, timestamptz) from public;
grant execute on function public.staff_assign_case(uuid, uuid) to authenticated;
grant execute on function public.staff_transition_case(uuid, public.case_status, text) to authenticated;
grant execute on function public.staff_add_case_update(uuid, text, boolean) to authenticated;
grant execute on function public.staff_mark_access_usable(uuid, timestamptz) to authenticated;

-- Credential writes and reveals are controlled server actions. There are no
-- exposed table policies, so clients cannot insert arbitrary ciphertext or
-- read an encrypted row around these checks.
create or replace function public.submit_credentials(p_case_id uuid, p_algorithm text, p_key_version text, p_nonce text, p_auth_tag text, p_ciphertext text, p_expires_at timestamptz default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare case_record public.cases; order_owner uuid; old_record public.credential_sets; new_record public.credential_sets;
begin
  if p_algorithm <> 'aes-256-gcm' or p_key_version is null or p_key_version !~ '^[A-Za-z0-9._-]{1,64}$' or p_nonce is null or p_auth_tag is null or p_ciphertext is null then raise exception 'Invalid credential envelope.' using errcode = '22023'; end if;
  if length(p_nonce) > 128 or length(p_auth_tag) > 128 or length(p_ciphertext) > 200000 then raise exception 'Invalid credential envelope.' using errcode = '22023'; end if;
  select c into case_record from public.cases c where c.id = p_case_id for update;
  if not found then raise exception 'Case not found.' using errcode = 'P0002'; end if;
  select o.customer_user_id into order_owner from public.orders o where o.id = case_record.order_id and o.organization_id = case_record.organization_id;
  if order_owner is null then raise exception 'Case order was not found.' using errcode = 'P0002'; end if;
  if auth.uid() <> order_owner and not public.is_staff() then raise exception 'Credential owner or MFA staff access is required.' using errcode = '42501'; end if;
  if public.is_staff() and (case_record.assigned_staff_id is null or case_record.assigned_staff_id <> auth.uid()) and not public.is_admin() then raise exception 'Only the assigned operator or an admin may manage credentials.' using errcode = '42501'; end if;
  if p_expires_at is not null and p_expires_at <= now() then raise exception 'Credential expiry must be in the future.' using errcode = '22023'; end if;
  update public.credential_sets set state = 'revoked', nonce = null, auth_tag = null, ciphertext = null, revoked_at = now() where case_id = p_case_id and state = 'active' returning * into old_record;
  if old_record.id is not null then insert into public.audit_logs (organization_id, actor_user_id, action, target_type, target_id, metadata) values (case_record.organization_id, auth.uid(), 'credentials_replaced', 'credential_set', old_record.id::text, '{}'::jsonb); end if;
  insert into public.credential_sets (case_id, organization_id, state, algorithm, nonce, auth_tag, ciphertext, key_version, expires_at) values (p_case_id, case_record.organization_id, 'active', p_algorithm, p_nonce, p_auth_tag, p_ciphertext, p_key_version, p_expires_at) returning * into new_record;
  insert into public.audit_logs (organization_id, actor_user_id, action, target_type, target_id, metadata) values (new_record.organization_id, auth.uid(), 'credentials_submitted', 'credential_set', new_record.id::text, jsonb_build_object('key_version', new_record.key_version));
  return jsonb_build_object('id', new_record.id, 'case_id', new_record.case_id, 'organization_id', new_record.organization_id, 'state', new_record.state, 'algorithm', new_record.algorithm, 'key_version', new_record.key_version, 'created_at', new_record.created_at, 'expires_at', new_record.expires_at, 'revoked_at', new_record.revoked_at, 'expired_at', new_record.expired_at);
end $$;

create or replace function public.revoke_credentials(p_case_id uuid, p_credential_set_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare credential_record public.credential_sets; case_record public.cases; order_owner uuid;
begin
  select cs into credential_record from public.credential_sets cs where cs.id = p_credential_set_id and cs.case_id = p_case_id for update;
  if not found then raise exception 'Credential set not found.' using errcode = 'P0002'; end if;
  select c into case_record from public.cases c where c.id = credential_record.case_id and c.organization_id = credential_record.organization_id;
  select o.customer_user_id into order_owner from public.orders o where o.id = case_record.order_id and o.organization_id = case_record.organization_id;
  if auth.uid() <> order_owner and not public.is_staff() then raise exception 'Credential owner or MFA staff access is required.' using errcode = '42501'; end if;
  if public.is_staff() and (case_record.assigned_staff_id is null or case_record.assigned_staff_id <> auth.uid()) and not public.is_admin() then raise exception 'Only the assigned operator or an admin may manage credentials.' using errcode = '42501'; end if;
  if credential_record.state = 'active' then update public.credential_sets set state = 'revoked', nonce = null, auth_tag = null, ciphertext = null, revoked_at = coalesce(revoked_at, now()) where id = p_credential_set_id returning * into credential_record; end if;
  insert into public.audit_logs (organization_id, actor_user_id, action, target_type, target_id, metadata) values (credential_record.organization_id, auth.uid(), 'credentials_revoked', 'credential_set', credential_record.id::text, jsonb_build_object('state', credential_record.state));
  return jsonb_build_object('id', credential_record.id, 'case_id', credential_record.case_id, 'organization_id', credential_record.organization_id, 'state', credential_record.state, 'algorithm', credential_record.algorithm, 'key_version', credential_record.key_version, 'created_at', credential_record.created_at, 'expires_at', credential_record.expires_at, 'revoked_at', credential_record.revoked_at, 'expired_at', credential_record.expired_at);
end $$;

create or replace function public.reveal_credentials(p_case_id uuid, p_credential_set_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare credential_record public.credential_sets; case_record public.cases;
begin
  if not public.is_staff() then raise exception 'Recent MFA staff access is required.' using errcode = '42501'; end if;
  if not exists (select 1 from jsonb_array_elements(case when jsonb_typeof(auth.jwt()->'amr') = 'array' then auth.jwt()->'amr' else '[]'::jsonb end) as amr where lower(amr->>'method') in ('totp', 'phone') and (case when amr->>'timestamp' ~ '^[0-9]+(\.[0-9]+)?$' then (amr->>'timestamp')::numeric else null end) >= extract(epoch from now() - interval '15 minutes') and (case when amr->>'timestamp' ~ '^[0-9]+(\.[0-9]+)?$' then (amr->>'timestamp')::numeric else null end) <= extract(epoch from now())) then raise exception 'Recent MFA staff access is required.' using errcode = '42501'; end if;
  select cs into credential_record from public.credential_sets cs where cs.id = p_credential_set_id and cs.case_id = p_case_id for update;
  if not found then raise exception 'Credential set not found.' using errcode = 'P0002'; end if;
  select c into case_record from public.cases c where c.id = credential_record.case_id and c.organization_id = credential_record.organization_id;
  if case_record.assigned_staff_id is null or (case_record.assigned_staff_id <> auth.uid() and not public.is_admin()) then raise exception 'Only the assigned operator or an admin may reveal credentials.' using errcode = '42501'; end if;
  if credential_record.state <> 'active' or (credential_record.expires_at is not null and credential_record.expires_at <= now()) then
    update public.credential_sets set state = 'expired', nonce = null, auth_tag = null, ciphertext = null, expired_at = coalesce(expired_at, now()) where id = p_credential_set_id returning * into credential_record;
    return null;
  end if;
  insert into public.audit_logs (organization_id, actor_user_id, action, target_type, target_id, metadata) values (credential_record.organization_id, auth.uid(), 'credentials_revealed', 'credential_set', credential_record.id::text, '{}'::jsonb);
  return jsonb_build_object('id', credential_record.id, 'case_id', credential_record.case_id, 'organization_id', credential_record.organization_id, 'algorithm', credential_record.algorithm, 'key_version', credential_record.key_version, 'nonce', credential_record.nonce, 'auth_tag', credential_record.auth_tag, 'ciphertext', credential_record.ciphertext, 'expires_at', credential_record.expires_at);
end $$;

create or replace function public.list_credentials_metadata(p_case_id uuid) returns table (id uuid, case_id uuid, organization_id uuid, state text, algorithm text, key_version text, created_at timestamptz, expires_at timestamptz, revoked_at timestamptz, expired_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare case_record public.cases; order_owner uuid;
begin
  select c into case_record from public.cases c where c.id = p_case_id;
  if not found then raise exception 'Case not found.' using errcode = 'P0002'; end if;
  select o.customer_user_id into order_owner from public.orders o where o.id = case_record.order_id and o.organization_id = case_record.organization_id;
  if auth.uid() <> order_owner and not public.is_staff() then raise exception 'Credential ownership is required.' using errcode = '42501'; end if;
  if public.is_staff() and (case_record.assigned_staff_id is null or case_record.assigned_staff_id <> auth.uid()) and not public.is_admin() then raise exception 'Only the assigned operator or an admin may view credentials.' using errcode = '42501'; end if;
  return query select cs.id, cs.case_id, cs.organization_id, cs.state, cs.algorithm, cs.key_version, cs.created_at, cs.expires_at, cs.revoked_at, cs.expired_at from public.credential_sets cs where cs.case_id = p_case_id order by cs.created_at desc;
end $$;

-- A scheduler/service-role job can call this function after completion. It
-- destroys secret material while retaining an auditable metadata row.
create or replace function public.purge_expired_credentials(p_completed_before timestamptz) returns integer
language plpgsql security definer set search_path = public as $$
declare removed integer;
begin
  if p_completed_before is null then raise exception 'A completion cutoff is required.' using errcode = '22023'; end if;
  if p_completed_before > now() - interval '7 days' then raise exception 'Credential retention period has not elapsed.' using errcode = '22023'; end if;
  with expired as (
    update public.credential_sets cs set state = 'expired', nonce = null, auth_tag = null, ciphertext = null, expired_at = coalesce(cs.expired_at, now()) from public.cases c where c.id = cs.case_id and c.organization_id = cs.organization_id and c.status = 'completed' and c.updated_at <= p_completed_before and cs.state = 'active' returning cs.*
  ) insert into public.audit_logs (organization_id, action, target_type, target_id, metadata) select organization_id, 'credentials_retention_purged', 'credential_set', id::text, '{}'::jsonb from expired;
  get diagnostics removed = row_count;
  return removed;
end $$;

revoke all on function public.submit_credentials(uuid, text, text, text, text, text, timestamptz) from public;
revoke all on function public.revoke_credentials(uuid, uuid) from public;
revoke all on function public.reveal_credentials(uuid, uuid) from public;
revoke all on function public.list_credentials_metadata(uuid) from public;
revoke all on function public.purge_expired_credentials(timestamptz) from public;
grant execute on function public.submit_credentials(uuid, text, text, text, text, text, timestamptz) to authenticated;
grant execute on function public.revoke_credentials(uuid, uuid) to authenticated;
grant execute on function public.reveal_credentials(uuid, uuid) to authenticated;
grant execute on function public.list_credentials_metadata(uuid) to authenticated;
grant execute on function public.purge_expired_credentials(timestamptz) to service_role;

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
-- Case changes go through the MFA-checked staff RPCs above so every action has
-- an event and audit record in the same transaction.
create policy case_events_customer_safe on public.case_events for select using ((customer_visible and public.is_org_member(organization_id)) or public.is_staff());
create policy case_events_staff_insert on public.case_events for insert with check (public.is_staff());
create policy quotes_tenant on public.quotes for select using (public.is_org_member(organization_id) or public.is_staff());
create policy quotes_staff_write on public.quotes for all using (public.is_staff()) with check (public.is_staff());
-- Credential ciphertext is a Milestone 3 concern. No exposed-role read policy
-- exists until assigned-staff reveal with recent MFA is implemented.
create policy attachments_customer_safe on public.attachments for select using ((customer_visible and public.is_org_member(organization_id)) or public.is_staff());
create policy attachments_staff_insert on public.attachments for insert with check (public.is_staff() and scan_state = 'pending');
create policy webhook_staff_only on public.webhook_events for all using (public.is_staff()) with check (public.is_staff());
create policy audit_staff_only on public.audit_logs for select using (public.is_staff());
create policy audit_staff_insert on public.audit_logs for insert with check (public.is_staff() and auth.uid() = actor_user_id);

insert into storage.buckets (id, name, public) values ('case-reports', 'case-reports', false) on conflict (id) do nothing;
create policy case_reports_read on storage.objects for select using (bucket_id = 'case-reports' and exists (select 1 from public.attachments a where a.storage_path = name and a.scan_state = 'clean' and (public.is_staff() or (a.customer_visible and public.is_org_member(a.organization_id)))));
create policy case_reports_staff_upload on storage.objects for insert with check (bucket_id = 'case-reports' and public.is_staff());

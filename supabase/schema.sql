-- =====================================================================
-- AUNTY TAUHU APP: database setup for Supabase
-- Paste ALL of this into Supabase > SQL Editor > New query > Run.
-- Safe to run more than once.
--
-- Who can see what (enforced by the database, not just the app):
--   owner    : everything
--   kitchen  : customer orders, the order menu and settings (read only)
--   pending  : nothing (new sign-ups wait here until the owner approves)
-- The FIRST person to create an account becomes the owner.
-- =====================================================================

-- ---------- staff accounts ----------
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  name       text,
  email      text,
  role       text not null default 'pending' check (role in ('owner','kitchen','pending')),
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name, email, role)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data->>'name', ''), split_part(new.email, '@', 1)),
    new.email,
    case when exists (select 1 from public.profiles where role = 'owner') then 'pending' else 'owner' end
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.my_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid()
$$;

-- ---------- data tables (one row per record, stored as JSON) ----------
do $$
declare t text;
begin
  foreach t in array array['kv','booths','booth_entries','vendors','vendor_entries','menu','orders','audit'] loop
    execute format('create table if not exists public.%I (
      id text primary key,
      data jsonb not null,
      updated_at timestamptz not null default now())', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists owner_all on public.%I', t);
    execute format('create policy owner_all on public.%I for all to authenticated
      using (public.my_role() = ''owner'') with check (public.my_role() = ''owner'')', t);
  end loop;
end $$;

-- kitchen staff: customer orders (read, add, update)
drop policy if exists kitchen_orders_select on public.orders;
drop policy if exists kitchen_orders_insert on public.orders;
drop policy if exists kitchen_orders_update on public.orders;
create policy kitchen_orders_select on public.orders for select to authenticated using (public.my_role() = 'kitchen');
create policy kitchen_orders_insert on public.orders for insert to authenticated with check (public.my_role() = 'kitchen');
create policy kitchen_orders_update on public.orders for update to authenticated using (public.my_role() = 'kitchen') with check (public.my_role() = 'kitchen');
-- kitchen staff: read the order menu and settings (prices, business details for invoices)
drop policy if exists kitchen_menu_select on public.menu;
create policy kitchen_menu_select on public.menu for select to authenticated using (public.my_role() = 'kitchen');
drop policy if exists kitchen_kv_select on public.kv;
create policy kitchen_kv_select on public.kv for select to authenticated using (public.my_role() = 'kitchen');
-- kitchen staff: add lines to the activity log (cannot read it)
drop policy if exists kitchen_audit_insert on public.audit;
create policy kitchen_audit_insert on public.audit for insert to authenticated with check (public.my_role() = 'kitchen');

-- profiles: everyone sees their own; the owner sees and manages all
alter table public.profiles enable row level security;
drop policy if exists profiles_select on public.profiles;
drop policy if exists profiles_owner_update on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.my_role() = 'owner');
create policy profiles_owner_update on public.profiles for update to authenticated
  using (public.my_role() = 'owner') with check (public.my_role() = 'owner');

-- ---------- running numbers (orders BWA-0001, AT-0001, invoices) ----------
create table if not exists public.counters (kind text primary key, n integer not null default 0);
alter table public.counters enable row level security;
create or replace function public.next_number(p_kind text)
returns integer language plpgsql security definer set search_path = public as $$
declare v integer;
begin
  if public.my_role() not in ('owner','kitchen') then raise exception 'not allowed'; end if;
  insert into public.counters (kind, n) values (p_kind, 1)
    on conflict (kind) do update set n = public.counters.n + 1
    returning n into v;
  return v;
end $$;
revoke all on function public.next_number(text) from public, anon;
grant execute on function public.next_number(text) to authenticated;

-- ---------- starting data (only added if missing) ----------
insert into public.kv (id, data) values
  ('settings', '{"priceT":1200,"priceP":1000,"pct":20,"kitchenSeesMoney":false}'),
  ('business', '{"name":"Aunty Tauhu Enterprise","ssm":"202403023188 (003570185-P)","phone":"019-311 1128","address":"","email":"","bank":""}')
on conflict (id) do nothing;

insert into public.booths (id, data) values
  ('b1', '{"id":"b1","name":"Alamanda","defT":22,"defP":10,"active":true}'),
  ('b2', '{"id":"b2","name":"citta mall","defT":6,"defP":4,"active":true}'),
  ('b3', '{"id":"b3","name":"uoa","defT":22,"defP":14,"active":true}'),
  ('b4', '{"id":"b4","name":"Apu","defT":10,"defP":6,"active":true}'),
  ('b5', '{"id":"b5","name":"pjaya","defT":8,"defP":0,"active":true}'),
  ('b6', '{"id":"b6","name":"Cm","defT":10,"defP":6,"active":true}'),
  ('b7', '{"id":"b7","name":"Mmu","defT":10,"defP":0,"active":true}')
on conflict (id) do nothing;

insert into public.vendors (id, data) values
  ('v1', '{"id":"v1","name":"DD","defT":20,"defP":20,"priceT":1000,"priceP":1000,"pct":20,"promoOn":true,"promoPct":20,"active":true}'),
  ('v2', '{"id":"v2","name":"Kuekas","defT":20,"defP":20,"priceT":1000,"priceP":1000,"pct":20,"promoOn":false,"promoPct":20,"active":true}')
on conflict (id) do nothing;

insert into public.menu (id, data) values
  ('m01', '{"id":"m01","cat":"Tauhu","name":"Small Tauhu (5pcs)","price":1200,"active":true}'),
  ('m02', '{"id":"m02","cat":"Tauhu","name":"Medium Tauhu (12pcs)","price":2600,"active":true}'),
  ('m03', '{"id":"m03","cat":"Tauhu","name":"Big Tauhu (25pcs)","price":5000,"active":true}'),
  ('m04', '{"id":"m04","cat":"Tauhu","name":"Frozen Tauhu (12pcs)","price":2000,"active":true}'),
  ('m05', '{"id":"m05","cat":"Tauhu","name":"Combo A","price":4500,"active":true}'),
  ('m06', '{"id":"m06","cat":"Tauhu","name":"Combo B","price":6000,"active":true}'),
  ('m07', '{"id":"m07","cat":"Popia","name":"Small Popia (6pcs)","price":1000,"active":true}'),
  ('m08', '{"id":"m08","cat":"Popia","name":"Medium Popia (16pcs)","price":2400,"active":true}'),
  ('m09', '{"id":"m09","cat":"Popia","name":"Big Popia (40pcs)","price":5600,"active":true}'),
  ('m10', '{"id":"m10","cat":"Popia","name":"Frozen Popia (20pcs)","price":2500,"active":true}'),
  ('m11', '{"id":"m11","cat":"Add-on","name":"Kuah (per pack)","price":200,"active":true}')
on conflict (id) do nothing;

select 'Aunty Tauhu database is ready' as result;

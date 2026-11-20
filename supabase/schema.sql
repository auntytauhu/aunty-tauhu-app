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

-- ---------- login with name + PIN ----------
-- Is there an owner yet? (the login screen uses this to offer first-time setup)
create or replace function public.owner_exists()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where role = 'owner')
$$;
-- Owner sets a new PIN for a staff member
create extension if not exists pgcrypto with schema extensions;
create or replace function public.owner_set_password(target uuid, new_password text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if public.my_role() is distinct from 'owner' then raise exception 'Only the owner can reset PINs'; end if;
  if length(new_password) < 6 then raise exception 'PIN too short'; end if;
  update auth.users set encrypted_password = extensions.crypt(new_password, extensions.gen_salt('bf')), updated_at = now()
  where id = target;
end $$;
revoke all on function public.owner_exists() from public;
grant execute on function public.owner_exists() to anon, authenticated;
revoke all on function public.owner_set_password(uuid, text) from public, anon;
grant execute on function public.owner_set_password(uuid, text) to authenticated;

-- ---------- permissions for logged-in users (row rules above still apply) ----------
grant usage on schema public to authenticated;
grant select, insert, update, delete on
  public.profiles, public.kv, public.booths, public.booth_entries, public.vendors,
  public.vendor_entries, public.menu, public.orders, public.audit
  to authenticated;
revoke all on public.counters from anon, authenticated;
grant execute on function public.my_role() to authenticated;
grant execute on function public.next_number(text) to authenticated;

-- ---------- repair: accounts created before this setup was run ----------
insert into public.profiles (id, name, email, role)
select u.id, coalesce(nullif(u.raw_user_meta_data->>'name', ''), split_part(u.email, '@', 1)), u.email, 'pending'
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id);
update public.profiles set role = 'owner'
where id = (select id from public.profiles order by created_at, email limit 1)
  and not exists (select 1 from public.profiles where role = 'owner');

-- =====================================================================
-- INVENTORY (raw materials, packaging, frozen & sauce)
-- Kept completely separate from booth/vendor/BWA settlement records.
--   owner   : everything (items, suppliers, prices, minimum levels, reports)
--   kitchen : read items/suppliers/stock; record daily stock, usage,
--             stock received and production for TODAY (yesterday is also
--             accepted so a late sync after midnight is not lost).
--             Cannot read purchase prices. Cannot delete anything.
-- =====================================================================
do $$
declare t text;
begin
  foreach t in array array['inv_items','inv_suppliers','inv_counts','inv_purchases','inv_prices','inv_restock','inv_recipes','inv_production'] loop
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

-- today's date in Malaysia (the server clock is UTC)
create or replace function public.kl_today()
returns date language sql stable as $$ select (now() at time zone 'Asia/Kuala_Lumpur')::date $$;
grant execute on function public.kl_today() to authenticated;

-- kitchen staff: read (prices table excluded on purpose)
do $$
declare t text;
begin
  foreach t in array array['inv_items','inv_suppliers','inv_counts','inv_purchases','inv_restock','inv_recipes','inv_production'] loop
    execute format('drop policy if exists kitchen_select on public.%I', t);
    execute format('create policy kitchen_select on public.%I for select to authenticated using (public.my_role() = ''kitchen'')', t);
  end loop;
  -- kitchen staff: add / correct records dated today (or yesterday, for late sync) only
  foreach t in array array['inv_counts','inv_purchases','inv_production'] loop
    execute format('drop policy if exists kitchen_insert on public.%I', t);
    execute format('drop policy if exists kitchen_update on public.%I', t);
    execute format('create policy kitchen_insert on public.%I for insert to authenticated
      with check (public.my_role() = ''kitchen'' and (data->>''date'')::date >= public.kl_today() - 1)', t);
    execute format('create policy kitchen_update on public.%I for update to authenticated
      using (public.my_role() = ''kitchen'' and (data->>''date'')::date >= public.kl_today() - 1)
      with check (public.my_role() = ''kitchen'' and (data->>''date'')::date >= public.kl_today() - 1)', t);
  end loop;
end $$;
-- kitchen staff: tick items on the restock list
drop policy if exists kitchen_insert on public.inv_restock;
drop policy if exists kitchen_update on public.inv_restock;
create policy kitchen_insert on public.inv_restock for insert to authenticated with check (public.my_role() = 'kitchen');
create policy kitchen_update on public.inv_restock for update to authenticated using (public.my_role() = 'kitchen') with check (public.my_role() = 'kitchen');

grant select, insert, update, delete on
  public.inv_items, public.inv_suppliers, public.inv_counts, public.inv_purchases,
  public.inv_prices, public.inv_restock, public.inv_recipes, public.inv_production
  to authenticated;

-- ---------- starting stock (20 Nov 2026), only added if missing ----------
-- Units are kept separate (e.g. large sacks and small sacks are never added
-- together unless the owner sets a conversion). Minimum levels start empty:
-- the owner sets them in the app.
insert into public.inv_items (id, data) values
  ('i01','{"id":"i01","name":"Bawang goreng","en":"Fried onions","cat":"dry","mode":"count","raw":true,"units":[{"id":"u1","name":"small pack"}],"start":{"u1":15},"startDate":"2026-11-20","active":true}'),
  ('i02','{"id":"i02","name":"Cukup rasa","en":"Seasoning","cat":"dry","mode":"count","raw":true,"units":[{"id":"u1","name":"pack"}],"start":{"u1":17},"startDate":"2026-11-20","active":true}'),
  ('i03','{"id":"i03","name":"Lada","en":"Pepper","cat":"dry","mode":"count","raw":true,"units":[{"id":"u1","name":"pack"}],"start":{"u1":12},"startDate":"2026-11-20","active":true}'),
  ('i04','{"id":"i04","name":"Tepung jagung","en":"Corn flour","cat":"dry","mode":"count","raw":true,"units":[{"id":"u1","name":"pack"}],"start":{"u1":20},"startDate":"2026-11-20","active":true}'),
  ('i05','{"id":"i05","name":"Minyak","en":"Cooking oil","cat":"dry","mode":"count","raw":true,"units":[{"id":"u1","name":"bottle"}],"start":{"u1":12},"startDate":"2026-11-20","active":true}'),
  ('i06','{"id":"i06","name":"Kentang","en":"Potatoes","cat":"wet","mode":"count","raw":true,"units":[{"id":"u1","name":"large sack"},{"id":"u2","name":"small sack"}],"start":{"u1":8,"u2":3},"startDate":"2026-11-20","active":true}'),
  ('i07','{"id":"i07","name":"Tahu","en":"Tahu","cat":"wet","mode":"count","raw":true,"units":[{"id":"u1","name":"large pack"}],"start":{"u1":7},"startDate":"2026-11-20","active":true}'),
  ('i08','{"id":"i08","name":"Telur","en":"Eggs","cat":"wet","mode":"count","raw":true,"units":[{"id":"u1","name":"tray"}],"start":{"u1":15},"startDate":"2026-11-20","active":true}'),
  ('i09','{"id":"i09","name":"Daging burger","en":"Burger meat","cat":"wet","mode":"count","raw":true,"units":[{"id":"u1","name":"pack"}],"start":{"u1":33},"startDate":"2026-11-20","active":true}'),
  ('i10','{"id":"i10","name":"Burger ayam","en":"Chicken burger","cat":"wet","mode":"count","raw":true,"units":[{"id":"u1","name":"pack"}],"start":{"u1":10},"startDate":"2026-11-20","active":true}'),
  ('i11','{"id":"i11","name":"Daun sup","en":"Soup leaves","cat":"wet","mode":"status","raw":true,"units":[],"start":{},"startStatus":"available","startDate":"2026-11-20","active":true}'),
  ('i12','{"id":"i12","name":"Kulit popia","en":"Spring roll pastry","cat":"wet","mode":"count","raw":true,"units":[{"id":"u1","name":"pack"}],"start":{"u1":2},"startDate":"2026-11-20","active":true}'),
  ('i13','{"id":"i13","name":"Kotak small","en":"Small box","cat":"pack","mode":"count","raw":false,"units":[{"id":"u1","name":"carton"},{"id":"u2","name":"plastic"}],"start":{"u1":2,"u2":1},"startDate":"2026-11-20","active":true}'),
  ('i14','{"id":"i14","name":"Bekas medium","en":"Medium container","cat":"pack","mode":"count","raw":false,"units":[{"id":"u1","name":"plastic"},{"id":"u2","name":"pack"}],"start":{"u1":3,"u2":27},"startDate":"2026-11-20","active":true}'),
  ('i15','{"id":"i15","name":"Kotak large","en":"Large box","cat":"pack","mode":"status","raw":false,"units":[],"start":{},"startStatus":"available","startDate":"2026-11-20","active":true}'),
  ('i16','{"id":"i16","name":"Popia small","en":"Small popia container","cat":"pack","mode":"count","raw":false,"units":[{"id":"u1","name":"plastic"}],"start":{"u1":2},"startDate":"2026-11-20","active":true}'),
  ('i17','{"id":"i17","name":"Tauhu frozen","en":"Frozen tauhu","cat":"frozen","mode":"count","raw":false,"note":"daging","units":[{"id":"u1","name":"pack"}],"start":{"u1":2},"startDate":"2026-11-20","active":true}'),
  ('i18','{"id":"i18","name":"Kuah tauhu","en":"Tauhu sauce","cat":"frozen","mode":"count","raw":false,"units":[{"id":"u1","name":"pack"}],"start":{"u1":10},"startDate":"2026-11-20","active":true}'),
  ('i19','{"id":"i19","name":"Kuah popia","en":"Popia sauce","cat":"frozen","mode":"count","raw":false,"units":[{"id":"u1","name":"pack"}],"start":{"u1":14},"startDate":"2026-11-20","active":true}')
on conflict (id) do nothing;

select 'Aunty Tauhu database is ready' as result,
       (select string_agg(name || ' (' || role || ')', ', ' order by created_at) from public.profiles) as accounts;

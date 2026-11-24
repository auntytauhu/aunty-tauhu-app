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

-- kitchen staff: read back only their own activity-log lines (the app saves with INSERT ... RETURNING,
-- which needs read access to the new row); everyone else's lines stay hidden
drop policy if exists kitchen_audit_select_own on public.audit;
create policy kitchen_audit_select_own on public.audit for select to authenticated
  using (public.my_role() = 'kitchen' and data->>'by' = (select name from public.profiles where id = auth.uid()));

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
  ('i01','{"id":"i01","name":"Bawang goreng","en":"Fried onions","cat":"dry","mode":"count","raw":true,"units":[{"id":"u1","name":"small pack"},{"id":"u2","name":"large pack"}],"start":{"u1":15,"u2":0},"startDate":"2026-11-20","active":true}'),
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
  ('i13','{"id":"i13","name":"Kotak small","en":"Small box","cat":"pack","mode":"count","raw":false,"units":[{"id":"u1","name":"box"},{"id":"u2","name":"plastic"}],"start":{"u1":2,"u2":1},"startDate":"2026-11-20","active":true}'),
  ('i14','{"id":"i14","name":"Bekas medium","en":"Medium container","cat":"pack","mode":"count","raw":false,"units":[{"id":"u3","name":"box"},{"id":"u1","name":"plastic"},{"id":"u2","name":"pack"}],"start":{"u1":3,"u2":27,"u3":0},"startDate":"2026-11-20","active":true}'),
  ('i15','{"id":"i15","name":"Kotak large","en":"Large box","cat":"pack","mode":"count","raw":false,"units":[{"id":"u1","name":"box"},{"id":"u2","name":"plastic"}],"start":{"u1":0,"u2":0},"startDate":"2026-11-20","active":true}'),
  ('i16','{"id":"i16","name":"Popia small","en":"Small popia container","cat":"pack","mode":"count","raw":false,"units":[{"id":"u2","name":"box"},{"id":"u1","name":"plastic"}],"start":{"u1":2,"u2":0},"startDate":"2026-11-20","active":true}'),
  ('i17','{"id":"i17","name":"Tauhu frozen","en":"Frozen tauhu","cat":"frozen","mode":"count","raw":false,"note":"daging","units":[{"id":"u1","name":"pack"}],"start":{"u1":2},"startDate":"2026-11-20","active":true}'),
  ('i18','{"id":"i18","name":"Kuah tauhu","en":"Tauhu sauce","cat":"frozen","mode":"count","raw":false,"units":[{"id":"u1","name":"pack"}],"start":{"u1":10},"startDate":"2026-11-20","active":true}'),
  ('i19','{"id":"i19","name":"Kuah popia","en":"Popia sauce","cat":"frozen","mode":"count","raw":false,"units":[{"id":"u1","name":"pack"}],"start":{"u1":14},"startDate":"2026-11-20","active":true}')
  ,('i20','{"id":"i20","name":"Kicap","en":"Soy sauce","cat":"dry","mode":"count","raw":true,"units":[{"id":"u1","name":"small bottle"},{"id":"u2","name":"large bottle"}],"start":{"u1":0,"u2":0},"startDate":"2026-11-20","active":true}')
on conflict (id) do nothing;

-- Bawang goreng comes in two sizes (added for databases set up before this)
update public.inv_items
   set data = jsonb_set(jsonb_set(data, '{units}', (data->'units') || '[{"id":"u2","name":"large pack"}]'), '{start,u2}', '0')
 where id = 'i01' and not (data->'units' @> '[{"id":"u2"}]');

-- ============================================================
-- Daily 5 PM shopping-list push notification
-- (secrets live in Supabase Vault: push_vapid_public, push_vapid_private, push_cron_key — never in this file)
-- ============================================================
create extension if not exists pg_cron;
create extension if not exists pg_net;

create table if not exists public.push_subs (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.push_subs enable row level security;
drop policy if exists own_select on public.push_subs;
drop policy if exists own_insert on public.push_subs;
drop policy if exists own_update on public.push_subs;
drop policy if exists own_delete on public.push_subs;
create policy own_select on public.push_subs for select to authenticated using ((data->>'uid') = auth.uid()::text);
create policy own_insert on public.push_subs for insert to authenticated
  with check ((data->>'uid') = auth.uid()::text and public.my_role() in ('owner','kitchen'));
create policy own_update on public.push_subs for update to authenticated
  using ((data->>'uid') = auth.uid()::text) with check ((data->>'uid') = auth.uid()::text);
create policy own_delete on public.push_subs for delete to authenticated using ((data->>'uid') = auth.uid()::text);
grant select, insert, update, delete on public.push_subs to authenticated;

create or replace function public.push_secrets()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(name, decrypted_secret), '{}'::jsonb)
    from vault.decrypted_secrets where name in ('push_vapid_public','push_vapid_private','push_cron_key');
$$;
revoke all on function public.push_secrets() from public, anon, authenticated;
grant execute on function public.push_secrets() to service_role;

grant select on public.inv_items, public.inv_counts, public.inv_purchases, public.inv_prices, public.inv_restock, public.inv_suppliers to service_role;
grant select, delete on public.push_subs to service_role;

-- 09:00 UTC = 5:00 PM Malaysia. Change '0 9' to '0 10' for 6 PM.
select cron.unschedule('daily-restock-push') where exists (select 1 from cron.job where jobname = 'daily-restock-push');
select cron.schedule('daily-restock-push', '0 9 * * *', $c$
  select net.http_post(
    url := 'https://dztitujrqmweepqdeppt.supabase.co/functions/v1/daily-restock-push',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-key',
      (select decrypted_secret from vault.decrypted_secrets where name = 'push_cron_key')),
    body := '{"mode":"daily"}'::jsonb)
$c$);

-- ============================================================
-- Customer order form (public page order.html)
-- Customers are NOT logged in. They can only:
--   1) read the active menu + shop name/phone (order_form_info)
--   2) send one order (submit_order). Prices are taken from the menu here,
--      never from the customer's phone. The order arrives as "Pending".
-- ============================================================
create or replace function public.order_form_info()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'menu', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.data->>'name', 'cat', m.data->>'cat', 'price', (m.data->>'price')::int)
              order by
                case m.data->>'cat' when 'Tauhu' then 0 when 'Popia' then 1 when 'Add-on' then 2 else 5 end,
                case when m.data->>'name' ~* '(small|kecil)' then 0 when m.data->>'name' ~* '(medium|sederhana)' then 1
                     when m.data->>'name' ~* '(big|large|besar)' then 2 when m.data->>'name' ~* '(frozen|beku)' then 3 else 4 end,
                (m.data->>'price')::int, m.data->>'name')
              from public.menu m where coalesce((m.data->>'active')::boolean, true)), '[]'::jsonb),
    'shop', (select jsonb_build_object('name', k.data->>'name', 'phone', k.data->>'phone') from public.kv k where k.id = 'business'),
    'today', to_char((now() at time zone 'Asia/Kuala_Lumpur')::date, 'YYYY-MM-DD'),
    'now', to_char(now() at time zone 'Asia/Kuala_Lumpur', 'HH24:MI'),
    'cutoff', '15:00');
$$;
revoke all on function public.order_form_info() from public;
grant execute on function public.order_form_info() to anon, authenticated;

create or replace function public.submit_order(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  v_name text := btrim(coalesce(p->>'name', ''));
  v_phone text := btrim(coalesce(p->>'phone', ''));
  v_digits text := regexp_replace(coalesce(p->>'phone', ''), '\D', '', 'g');
  v_addr text := btrim(coalesce(p->>'address', ''));
  v_notes text := btrim(coalesce(p->>'notes', ''));
  v_del boolean := coalesce((p->>'delivery')::boolean, false);
  v_time text := btrim(coalesce(p->>'time', ''));
  v_opt text; v_cat text;
  v_date date; v_items jsonb := '[]'::jsonb; v_total int := 0;
  it jsonb; m record; q int; n int; v_no text; v_id text;
begin
  if char_length(v_name) < 2 or char_length(v_name) > 60 then raise exception 'name' using errcode = 'P0001'; end if;
  if char_length(v_digits) < 9 or char_length(v_digits) > 15 or char_length(v_phone) > 20 then raise exception 'phone' using errcode = 'P0001'; end if;
  if v_del and (char_length(v_addr) < 10 or char_length(v_addr) > 300) then raise exception 'address' using errcode = 'P0001'; end if;
  if char_length(v_notes) > 300 then raise exception 'notes' using errcode = 'P0001'; end if;
  -- time slots: 9:00 AM to 6:00 PM, every hour
  if v_time not in ('9:00 AM','10:00 AM','11:00 AM','12:00 PM','1:00 PM','2:00 PM','3:00 PM','4:00 PM','5:00 PM','6:00 PM') then raise exception 'time' using errcode = 'P0001'; end if;
  begin v_date := (p->>'date')::date; exception when others then raise exception 'date' using errcode = 'P0001'; end;
  if v_date is null or v_date < v_today or v_date > v_today + 180 then raise exception 'date' using errcode = 'P0001'; end if;
  -- same-day orders: only until 3:00 PM, and only for a time that has not passed
  if v_date = v_today then
    if (now() at time zone 'Asia/Kuala_Lumpur')::time >= time '15:00' then raise exception 'same_day_closed' using errcode = 'P0001'; end if;
    if to_timestamp(v_time, 'HH12:MI AM')::time <= (now() at time zone 'Asia/Kuala_Lumpur')::time then raise exception 'time_passed' using errcode = 'P0001'; end if;
  end if;
  if jsonb_typeof(p->'items') <> 'array' or jsonb_array_length(p->'items') = 0 or jsonb_array_length(p->'items') > 40 then raise exception 'items' using errcode = 'P0001'; end if;
  for it in select * from jsonb_array_elements(p->'items') loop
    select id, data->>'name' as name, (data->>'price')::int as price, data->>'cat' as cat into m from public.menu where id = it->>'id' and coalesce((data->>'active')::boolean, true);
    if not found then raise exception 'items' using errcode = 'P0001'; end if;
    begin q := (it->>'qty')::int; exception when others then raise exception 'items' using errcode = 'P0001'; end;
    if q is null or q < 1 or q > 200 then raise exception 'items' using errcode = 'P0001'; end if;
    -- filling: Daging / Ayam / Veggie for every item except add-ons
    v_opt := btrim(coalesce(it->>'opt', ''));
    if lower(coalesce(m.cat, '')) like 'add%' then
      if v_opt <> '' then raise exception 'items' using errcode = 'P0001'; end if;
    elsif v_opt not in ('Daging','Ayam','Veggie') then raise exception 'filling' using errcode = 'P0001'; end if;
    if v_items @> jsonb_build_array(jsonb_build_object('menuId', m.id, 'opt', v_opt)) then raise exception 'items' using errcode = 'P0001'; end if;
    v_items := v_items || jsonb_build_array(jsonb_build_object('menuId', m.id, 'name', m.name || case when v_opt <> '' then ' - ' || v_opt else '' end, 'qty', q, 'price', m.price, 'opt', v_opt));
    v_total := v_total + q * m.price;
  end loop;
  -- simple limits against spam
  if (select count(*) from public.orders where data->>'src' = 'form' and regexp_replace(data->>'phone', '\D', '', 'g') = v_digits
        and (data->>'createdAt')::bigint > (extract(epoch from now()) * 1000)::bigint - 86400000) >= 5 then raise exception 'too_many' using errcode = 'P0001'; end if;
  if (select count(*) from public.orders where data->>'src' = 'form'
        and (data->>'createdAt')::bigint > (extract(epoch from now()) * 1000)::bigint - 3600000) >= 40 then raise exception 'busy' using errcode = 'P0001'; end if;
  insert into public.counters (kind, n) values ('order_direct', 1) on conflict (kind) do update set n = public.counters.n + 1 returning public.counters.n into n;
  v_no := 'AT-' || lpad(n::text, 4, '0');
  v_id := 'web' || substr(md5(random()::text || clock_timestamp()::text), 1, 12);
  insert into public.orders (id, data, updated_at) values (v_id, jsonb_build_object(
    'id', v_id, 'channel', 'direct', 'no', v_no, 'createdAt', (extract(epoch from now()) * 1000)::bigint,
    'date', to_char(v_date, 'YYYY-MM-DD'), 'time', v_time, 'customer', v_name, 'phone', v_phone, 'notes', v_notes, 'items', v_items,
    'delivery', case when v_del then jsonb_build_object('fee', 0, 'address', v_addr, 'feeTbc', true) else null end,
    'status', 'new', 'paid', false, 'pending', true, 'src', 'form', 'by', 'Customer form'), now());
  return jsonb_build_object('no', v_no, 'total', v_total, 'date', to_char(v_date, 'YYYY-MM-DD'), 'time', v_time, 'delivery', v_del);
end $$;
revoke all on function public.submit_order(jsonb) from public;
grant execute on function public.submit_order(jsonb) to anon, authenticated;

select 'Aunty Tauhu database is ready' as result,
       (select string_agg(name || ' (' || role || ')', ', ' order by created_at) from public.profiles) as accounts;

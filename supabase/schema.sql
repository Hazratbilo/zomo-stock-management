-- ZOMO Advanced Technologies Limited: inventory, sales, and owner-managed team.
-- Run in Supabase SQL Editor as the project owner. See README.md before production use.
create extension if not exists pgcrypto;

create type public.app_role as enum ('owner', 'sales_rep');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  owner_id uuid references auth.users(id) on delete cascade,
  full_name text not null check (length(trim(full_name)) between 1 and 120),
  email text not null,
  role public.app_role not null default 'sales_rep',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint profiles_owner_check check ((role = 'owner' and owner_id is null) or (role = 'sales_rep' and owner_id is not null))
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  category text not null default 'Accessories',
  sku text,
  stock integer not null default 0 check (stock >= 0),
  price numeric(14,2) not null check (price >= 0),
  cost numeric(14,2) not null default 0 check (cost >= 0),
  image text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_id, sku)
);

create table public.sales (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  representative_id uuid not null constraint sales_representative_profile_fkey references public.profiles(id),
  product_id uuid not null references public.products(id),
  quantity integer not null check (quantity > 0),
  unit_price numeric(14,2) not null check (unit_price >= 0),
  total numeric(14,2) generated always as (quantity * unit_price) stored,
  amount_paid numeric(14,2) not null default 0 check (amount_paid >= 0 and amount_paid <= quantity * unit_price),
  status text not null default 'completed' check (status in ('completed', 'pending', 'cancelled')),
  customer_name text,
  created_at timestamptz not null default now()
);

-- NIN requests and SIM network inventory are separate company workflows.
create table public.nin_requests (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  representative_id uuid not null constraint nin_requests_representative_profile_fkey references public.profiles(id),
  customer_name text not null check (length(trim(customer_name)) between 1 and 120),
  customer_phone text not null check (customer_phone ~ '^[0-9]{10,15}$'),
  amount_paid numeric(14,2) not null check (amount_paid >= 0),
  status text not null default 'pending' check (status in ('pending','done')),
  created_at timestamptz not null default now()
);

create table public.sim_network_stock (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  network text not null check (network in ('Glo','Airtel','MTN','Etisalat')),
  stock integer not null default 0 check (stock >= 0),
  updated_at timestamptz not null default now(),
  unique(owner_id, network)
);

create table public.sim_registrations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  representative_id uuid not null constraint sim_registrations_representative_profile_fkey references public.profiles(id),
  customer_name text not null check (length(trim(customer_name)) between 1 and 120),
  phone_number text not null check (phone_number ~ '^[0-9]{10,15}$'),
  network text not null check (network in ('Glo','Airtel','MTN','Etisalat')),
  amount_paid numeric(14,2) not null default 0 check (amount_paid >= 0),
  created_at timestamptz not null default now()
);

-- Seed one zero-count row per network for every owner; owner can later set quantities.
create or replace function public.seed_sim_network_stock()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.role = 'owner' then
    insert into public.sim_network_stock(owner_id, network, stock)
      values (new.id,'Glo',0),(new.id,'Airtel',0),(new.id,'MTN',0),(new.id,'Etisalat',0)
      on conflict (owner_id,network) do nothing;
  end if;
  return new;
end
$$;
create trigger profiles_seed_sim_stock after insert on public.profiles
  for each row execute function public.seed_sim_network_stock();
revoke all on function public.seed_sim_network_stock() from public;

-- Also seed current owners when applying the base schema to a non-empty profiles table.
insert into public.sim_network_stock(owner_id, network, stock)
select p.id, n.network, 0 from public.profiles p
cross join (values ('Glo'),('Airtel'),('MTN'),('Etisalat')) as n(network)
where p.role='owner'
on conflict (owner_id,network) do nothing;

create index products_owner_idx on public.products(owner_id);
create index sales_owner_date_idx on public.sales(owner_id, created_at desc);
create index sales_rep_date_idx on public.sales(representative_id, created_at desc);
create index nin_requests_owner_date_idx on public.nin_requests(owner_id, created_at desc);
create index nin_requests_rep_date_idx on public.nin_requests(representative_id, created_at desc);
create index sim_registrations_owner_date_idx on public.sim_registrations(owner_id, created_at desc);
create index sim_registrations_rep_date_idx on public.sim_registrations(representative_id, created_at desc);

-- Broadcast committed inventory and sale changes to signed-in workspace members.
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='products') then
    alter publication supabase_realtime add table public.products;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='sales') then
    alter publication supabase_realtime add table public.sales;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='nin_requests') then alter publication supabase_realtime add table public.nin_requests; end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='sim_network_stock') then alter publication supabase_realtime add table public.sim_network_stock; end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='sim_registrations') then alter publication supabase_realtime add table public.sim_registrations; end if;
end $$;

create or replace function public.current_owner_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select case when p.role = 'owner' then p.id when p.active then p.owner_id else null end
  from public.profiles p where p.id = (select auth.uid())
$$;

create or replace function public.is_owner()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'owner')
$$;

alter table public.profiles enable row level security;
alter table public.products enable row level security;
alter table public.sales enable row level security;
alter table public.nin_requests enable row level security;
alter table public.sim_network_stock enable row level security;
alter table public.sim_registrations enable row level security;

create policy "Users can read their workspace profiles" on public.profiles for select to authenticated
  using (id = (select auth.uid()) or owner_id = (select public.current_owner_id()));
create policy "Owners can update their own profile" on public.profiles for update to authenticated
  using (id = (select auth.uid()) and role = 'owner') with check (id = (select auth.uid()) and role = 'owner');

create policy "Workspace members can read products" on public.products for select to authenticated
  using (owner_id = (select public.current_owner_id()));
create policy "Owners can add products" on public.products for insert to authenticated
  with check (owner_id = (select auth.uid()) and (select public.is_owner()));
create policy "Owners can update products" on public.products for update to authenticated
  using (owner_id = (select auth.uid()) and (select public.is_owner()))
  with check (owner_id = (select auth.uid()) and (select public.is_owner()));
create policy "Owners can delete products" on public.products for delete to authenticated
  using (owner_id = (select public.current_owner_id()) and (select public.is_owner()));

drop policy if exists "Workspace members can read sales" on public.sales;
drop policy if exists "Owners and representatives can read permitted sales" on public.sales;
create policy "Owners and representatives can read permitted sales" on public.sales for select to authenticated
  using (
    owner_id = (select public.current_owner_id())
    and ((select public.is_owner()) or representative_id = (select auth.uid()))
  );
create policy "Sales reps can record their sales" on public.sales for insert to authenticated
  with check (owner_id = (select public.current_owner_id()) and representative_id = (select auth.uid()));
create policy "Owners can update sales" on public.sales for update to authenticated
  using (owner_id = (select public.current_owner_id()) and (select public.is_owner()))
  with check (owner_id = (select public.current_owner_id()) and (select public.is_owner()));
create policy "Owners can delete sales" on public.sales for delete to authenticated
  using (owner_id = (select public.current_owner_id()) and (select public.is_owner()));

drop policy if exists "Owners and reps can read NIN requests" on public.nin_requests;
create policy "Owners and reps can read NIN requests" on public.nin_requests for select to authenticated
  using (owner_id = (select public.current_owner_id()) and ((select public.is_owner()) or representative_id = (select auth.uid())));
drop policy if exists "Representatives can submit NIN requests" on public.nin_requests;
create policy "Representatives can submit NIN requests" on public.nin_requests for insert to authenticated
  with check (owner_id = (select public.current_owner_id()) and representative_id = (select auth.uid()));
drop policy if exists "Owners can update NIN request status" on public.nin_requests;
create policy "Owners can update NIN request status" on public.nin_requests for update to authenticated
  using (owner_id = (select public.current_owner_id()) and (select public.is_owner()))
  with check (owner_id = (select public.current_owner_id()) and (select public.is_owner()));
drop policy if exists "Owners can read SIM network stock" on public.sim_network_stock;
create policy "Owners can read SIM network stock" on public.sim_network_stock for select to authenticated
  using (owner_id = (select public.current_owner_id()));
drop policy if exists "Owners can insert SIM network stock" on public.sim_network_stock;
create policy "Owners can insert SIM network stock" on public.sim_network_stock for insert to authenticated
  with check (owner_id = (select auth.uid()) and (select public.is_owner()));
drop policy if exists "Owners can update SIM network stock" on public.sim_network_stock;
create policy "Owners can update SIM network stock" on public.sim_network_stock for update to authenticated
  using (owner_id = (select auth.uid()) and (select public.is_owner()))
  with check (owner_id = (select auth.uid()) and (select public.is_owner()));
drop policy if exists "Owners and reps can read permitted SIM registrations" on public.sim_registrations;
create policy "Owners and reps can read permitted SIM registrations" on public.sim_registrations for select to authenticated
  using (owner_id = (select public.current_owner_id()) and ((select public.is_owner()) or representative_id = (select auth.uid())));
revoke all on public.nin_requests, public.sim_network_stock, public.sim_registrations from anon, authenticated;
grant select, insert on public.nin_requests to authenticated;
grant update(status) on public.nin_requests to authenticated;
grant select, insert, update on public.sim_network_stock to authenticated;
grant select on public.sim_registrations to authenticated;
revoke delete, truncate, references, trigger on public.nin_requests, public.sim_network_stock, public.sim_registrations from authenticated;
revoke all on public.nin_requests, public.sim_network_stock, public.sim_registrations from anon;

-- Reserve inventory atomically to prevent overselling during concurrent checkouts.
drop function if exists public.record_sale(uuid, integer, text);
create or replace function public.record_sale(p_product_id uuid, p_quantity integer, p_customer_name text default null, p_amount_paid numeric default null)
returns public.sales language plpgsql security definer set search_path = '' as $$
declare
  v_owner_id uuid := public.current_owner_id();
  v_product public.products;
  v_sale public.sales;
  v_total numeric(14,2);
  v_paid numeric(14,2);
begin
  if (select auth.uid()) is null or v_owner_id is null then raise exception 'Sign in is required'; end if;
  if p_quantity is null or p_quantity < 1 then raise exception 'Sale quantity must be at least one'; end if;
  update public.products set stock = stock - p_quantity, updated_at = now()
    where id = p_product_id and owner_id = v_owner_id and stock >= p_quantity returning * into v_product;
  if not found then raise exception 'Product not found or insufficient stock'; end if;
  v_total := p_quantity * v_product.price;
  v_paid := coalesce(p_amount_paid, v_total);
  if v_paid < 0 or v_paid > v_total then raise exception 'Amount received must be between zero and the sale total'; end if;
  insert into public.sales(owner_id, representative_id, product_id, quantity, unit_price, amount_paid, status, customer_name)
    values (v_owner_id, (select auth.uid()), v_product.id, p_quantity, v_product.price, v_paid,
      case when v_paid >= v_total then 'completed' else 'pending' end,
      nullif(trim(p_customer_name), ''))
    returning * into v_sale;
  return v_sale;
end
$$;

-- Deduct one SIM atomically so two reps cannot register the final line at once.
drop function if exists public.record_sim_registration(text, text, text);
create or replace function public.record_sim_registration(p_customer_name text, p_phone_number text, p_network text, p_amount_paid numeric default 0)
returns public.sim_registrations language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := public.current_owner_id();
  v_registration public.sim_registrations;
  v_phone text := regexp_replace(coalesce(p_phone_number,''), '[^0-9]', '', 'g');
begin
  if (select auth.uid()) is null or v_owner is null then raise exception 'Sign in is required'; end if;
  if p_customer_name is null or length(trim(p_customer_name)) not between 1 and 120 then raise exception 'Enter the customer name'; end if;
  if length(v_phone) not between 10 and 15 then raise exception 'Enter a valid customer phone number'; end if;
  if p_network not in ('Glo','Airtel','MTN','Etisalat') then raise exception 'Select a valid SIM network'; end if;
  if p_amount_paid is null or p_amount_paid < 0 then raise exception 'Enter a valid amount paid'; end if;
  update public.sim_network_stock set stock=stock-1, updated_at=now()
    where owner_id=v_owner and network=p_network and stock>0;
  if not found then raise exception 'No SIM stock is available for this network'; end if;
  insert into public.sim_registrations(owner_id,representative_id,customer_name,phone_number,network,amount_paid)
    values(v_owner,(select auth.uid()),trim(p_customer_name),v_phone,p_network,p_amount_paid)
    returning * into v_registration;
  return v_registration;
end
$$;

-- Run this function from a trusted owner session; the service key never belongs in the browser.
create or replace function public.owner_assign_sales_rep(rep_user_id uuid, rep_name text, rep_email text)
returns public.profiles language plpgsql security definer set search_path = '' as $$
declare v_profile public.profiles; v_owner uuid := public.current_owner_id();
begin
  if not (select public.is_owner()) then raise exception 'Only the workspace owner can assign sales representatives'; end if;
  insert into public.profiles(id, owner_id, full_name, email, role)
  values (rep_user_id, v_owner, trim(rep_name), lower(trim(rep_email)), 'sales_rep')
  on conflict (id) do update set owner_id=excluded.owner_id, full_name=excluded.full_name, email=excluded.email, role='sales_rep'
  returning * into v_profile;
  return v_profile;
end
$$;

create or replace function public.admin_remove_sales_rep(rep_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not (select public.is_owner()) then raise exception 'Only the workspace owner can remove sales representatives'; end if;
  if not exists (select 1 from public.profiles where id=rep_user_id and owner_id=(select auth.uid()) and role='sales_rep') then raise exception 'Sales representative not found in your workspace'; end if;
  -- Deactivate and detach the representative while retaining historical sales.
  update public.profiles set active=false where id=rep_user_id and role='sales_rep';
  delete from auth.sessions where user_id=rep_user_id;
end
$$;

revoke all on function public.record_sale(uuid, integer, text, numeric) from public;
grant execute on function public.record_sale(uuid, integer, text, numeric) to authenticated;
revoke all on function public.record_sim_registration(text, text, text, numeric) from public;
grant execute on function public.record_sim_registration(text, text, text, numeric) to authenticated;
revoke all on function public.owner_assign_sales_rep(uuid, text, text) from public;
grant execute on function public.owner_assign_sales_rep(uuid, text, text) to authenticated;
revoke all on function public.admin_remove_sales_rep(uuid) from public;
grant execute on function public.admin_remove_sales_rep(uuid) to authenticated;

-- Profile creation should happen after the owner creates their Auth account.
-- Replace the UUID below with the owner's auth.users.id and run as the project owner:
-- insert into public.profiles(id, full_name, email, role)
-- values ('OWNER-AUTH-UUID', 'Workspace Owner', 'owner@zomo.ng', 'owner');


-- Payment tracking extension for existing installations and fresh installations.
-- Record the agreed service fee and keep an auditable, date-accurate payment ledger.
alter table public.nin_requests add column if not exists total_amount numeric(14,2);
alter table public.sim_registrations add column if not exists total_amount numeric(14,2);

-- Older service entries did not record a fee. Treat their recorded payment as the known total
-- so this migration never invents an unpaid balance for historical customers.
update public.nin_requests set total_amount=amount_paid where total_amount is null;
update public.sim_registrations set total_amount=amount_paid where total_amount is null;
alter table public.nin_requests alter column total_amount set not null;
alter table public.sim_registrations alter column total_amount set not null;
do $$ begin
  if not exists(select 1 from pg_constraint where conname='nin_requests_amounts_check' and conrelid='public.nin_requests'::regclass) then
    alter table public.nin_requests add constraint nin_requests_amounts_check check (total_amount >= 0 and amount_paid >= 0 and amount_paid <= total_amount) not valid;
  end if;
  if not exists(select 1 from pg_constraint where conname='sim_registrations_amounts_check' and conrelid='public.sim_registrations'::regclass) then
    alter table public.sim_registrations add constraint sim_registrations_amounts_check check (total_amount >= 0 and amount_paid >= 0 and amount_paid <= total_amount) not valid;
  end if;
end $$;

create table if not exists public.payment_transactions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  representative_id uuid not null references public.profiles(id),
  record_type text not null check (record_type in ('sale','nin','sim')),
  record_id uuid not null,
  amount numeric(14,2) not null check (amount > 0),
  created_at timestamptz not null default now()
);
create index if not exists payment_transactions_owner_date_idx on public.payment_transactions(owner_id,created_at desc);
create index if not exists payment_transactions_record_idx on public.payment_transactions(record_type,record_id);

-- Capture the initial payment for newly created sales and service records.
create or replace function public.log_initial_payment()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_paid numeric(14,2); v_type text;
begin
  v_paid := coalesce(new.amount_paid,0);
  if v_paid > 0 then
    v_type := case tg_table_name when 'sales' then 'sale' when 'nin_requests' then 'nin' else 'sim' end;
    insert into public.payment_transactions(owner_id,representative_id,record_type,record_id,amount,created_at)
      values(new.owner_id,new.representative_id,v_type,new.id,v_paid,new.created_at);
  end if;
  return new;
end
$$;
drop trigger if exists sales_log_initial_payment on public.sales;
create trigger sales_log_initial_payment after insert on public.sales for each row execute function public.log_initial_payment();
drop trigger if exists nin_log_initial_payment on public.nin_requests;
create trigger nin_log_initial_payment after insert on public.nin_requests for each row execute function public.log_initial_payment();
drop trigger if exists sim_log_initial_payment on public.sim_registrations;
create trigger sim_log_initial_payment after insert on public.sim_registrations for each row execute function public.log_initial_payment();
revoke all on function public.log_initial_payment() from public;

-- Backfill older receipts for historical weekly/monthly reporting.
insert into public.payment_transactions(owner_id,representative_id,record_type,record_id,amount,created_at)
select s.owner_id,s.representative_id,'sale',s.id,s.amount_paid,s.created_at from public.sales s
where s.amount_paid>0 and not exists(select 1 from public.payment_transactions p where p.record_type='sale' and p.record_id=s.id);
insert into public.payment_transactions(owner_id,representative_id,record_type,record_id,amount,created_at)
select n.owner_id,n.representative_id,'nin',n.id,n.amount_paid,n.created_at from public.nin_requests n
where n.amount_paid>0 and not exists(select 1 from public.payment_transactions p where p.record_type='nin' and p.record_id=n.id);
insert into public.payment_transactions(owner_id,representative_id,record_type,record_id,amount,created_at)
select r.owner_id,r.representative_id,'sim',r.id,r.amount_paid,r.created_at from public.sim_registrations r
where r.amount_paid>0 and not exists(select 1 from public.payment_transactions p where p.record_type='sim' and p.record_id=r.id);

alter table public.payment_transactions enable row level security;
revoke all on public.payment_transactions from anon,authenticated;
grant select on public.payment_transactions to authenticated;
drop policy if exists "Workspace members can read payment history" on public.payment_transactions;
create policy "Workspace members can read payment history" on public.payment_transactions for select to authenticated
  using(owner_id=(select public.current_owner_id()) and ((select public.is_owner()) or representative_id=(select auth.uid())));

-- Payments are added atomically, scoped to the signed-in user's workspace and permitted records.
create or replace function public.record_customer_payment(p_record_type text,p_record_id uuid,p_amount numeric)
returns public.payment_transactions language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := public.current_owner_id();
  v_rep uuid := (select auth.uid());
  v_record_owner uuid;
  v_record_rep uuid;
  v_balance numeric(14,2);
  v_payment public.payment_transactions;
begin
  if v_rep is null or v_owner is null then raise exception 'Sign in is required'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter a payment greater than zero'; end if;
  if p_record_type='sale' then
    select owner_id,representative_id,total-amount_paid into v_record_owner,v_record_rep,v_balance from public.sales where id=p_record_id and status<>'cancelled' for update;
  elsif p_record_type='nin' then
    select owner_id,representative_id,total_amount-amount_paid into v_record_owner,v_record_rep,v_balance from public.nin_requests where id=p_record_id for update;
  elsif p_record_type='sim' then
    select owner_id,representative_id,total_amount-amount_paid into v_record_owner,v_record_rep,v_balance from public.sim_registrations where id=p_record_id for update;
  else raise exception 'Invalid payment record type';
  end if;
  if v_record_owner is null or v_record_owner<>v_owner or (not (select public.is_owner()) and v_record_rep<>v_rep) then raise exception 'You do not have access to this customer record'; end if;
  if p_amount>v_balance then raise exception 'Payment is greater than the remaining balance'; end if;
  if p_record_type='sale' then
    update public.sales set amount_paid=amount_paid+p_amount,status=case when amount_paid+p_amount>=total then 'completed' else 'pending' end where id=p_record_id;
  elsif p_record_type='nin' then
    update public.nin_requests set amount_paid=amount_paid+p_amount where id=p_record_id;
  else
    update public.sim_registrations set amount_paid=amount_paid+p_amount where id=p_record_id;
  end if;
  insert into public.payment_transactions(owner_id,representative_id,record_type,record_id,amount)
    values(v_owner,v_rep,p_record_type,p_record_id,p_amount) returning * into v_payment;
  return v_payment;
end
$$;
revoke all on function public.record_customer_payment(text,uuid,numeric) from public;
grant execute on function public.record_customer_payment(text,uuid,numeric) to authenticated;

-- Replace SIM registration RPC to store fee and first payment together with the stock deduction.
drop function if exists public.record_sim_registration(text,text,text,numeric);
create or replace function public.record_sim_registration(p_customer_name text,p_phone_number text,p_network text,p_total_amount numeric,p_amount_paid numeric default 0)
returns public.sim_registrations language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := public.current_owner_id();
  v_record public.sim_registrations;
  v_phone text := regexp_replace(coalesce(p_phone_number,''),'[^0-9]','','g');
begin
  if (select auth.uid()) is null or v_owner is null then raise exception 'Sign in is required'; end if;
  if p_customer_name is null or length(trim(p_customer_name)) not between 1 and 120 then raise exception 'Enter the customer name'; end if;
  if length(v_phone) not between 10 and 15 then raise exception 'Enter a valid customer phone number'; end if;
  if p_network not in ('Glo','Airtel','MTN','Etisalat') then raise exception 'Select a valid SIM network'; end if;
  if p_total_amount is null or p_total_amount<0 or p_amount_paid is null or p_amount_paid<0 or p_amount_paid>p_total_amount then raise exception 'Payment must be between zero and the SIM service fee'; end if;
  update public.sim_network_stock set stock=stock-1,updated_at=now() where owner_id=v_owner and network=p_network and stock>0;
  if not found then raise exception 'No SIM stock is available for this network'; end if;
  insert into public.sim_registrations(owner_id,representative_id,customer_name,phone_number,network,total_amount,amount_paid)
    values(v_owner,(select auth.uid()),trim(p_customer_name),v_phone,p_network,p_total_amount,p_amount_paid) returning * into v_record;
  return v_record;
end
$$;
revoke all on function public.record_sim_registration(text,text,text,numeric,numeric) from public;
grant execute on function public.record_sim_registration(text,text,text,numeric,numeric) to authenticated;

do $$ begin
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='payment_transactions') then
    alter publication supabase_realtime add table public.payment_transactions;
  end if;
end $$;
notify pgrst,'reload schema';

-- Owner-managed SIM and NIN service fees.
-- Representatives can read configured fees, but all fees are resolved server-side
-- when a registration is created so a client cannot choose its own price.

alter table public.sim_network_stock
  add column if not exists service_fee numeric(14,2) check (service_fee is null or service_fee >= 0);

create table if not exists public.service_pricing (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  nin_fee numeric(14,2) check (nin_fee is null or nin_fee >= 0),
  updated_at timestamptz not null default now()
);

insert into public.service_pricing(owner_id)
select id from public.profiles where role='owner'
on conflict(owner_id) do nothing;

insert into public.sim_network_stock(owner_id,network,stock)
select p.id,n.network,0 from public.profiles p
cross join (values('Glo'),('Airtel'),('MTN'),('Etisalat')) as n(network)
where p.role='owner' on conflict(owner_id,network) do nothing;

create or replace function public.seed_sim_network_stock()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.role = 'owner' then
    insert into public.sim_network_stock(owner_id,network,stock)
      values(new.id,'Glo',0),(new.id,'Airtel',0),(new.id,'MTN',0),(new.id,'Etisalat',0)
      on conflict(owner_id,network) do nothing;
    insert into public.service_pricing(owner_id) values(new.id) on conflict(owner_id) do nothing;
  end if;
  return new;
end
$$;
revoke all on function public.seed_sim_network_stock() from public;

alter table public.service_pricing enable row level security;
revoke all on public.service_pricing from anon,authenticated;
grant select,insert,update on public.service_pricing to authenticated;
drop policy if exists "Workspace members can read service pricing" on public.service_pricing;
create policy "Workspace members can read service pricing" on public.service_pricing for select to authenticated
  using(owner_id=(select public.current_owner_id()));
drop policy if exists "Owners can insert service pricing" on public.service_pricing;
create policy "Owners can insert service pricing" on public.service_pricing for insert to authenticated
  with check(owner_id=(select auth.uid()) and (select public.is_owner()));
drop policy if exists "Owners can update service pricing" on public.service_pricing;
create policy "Owners can update service pricing" on public.service_pricing for update to authenticated
  using(owner_id=(select auth.uid()) and (select public.is_owner()))
  with check(owner_id=(select auth.uid()) and (select public.is_owner()));

drop function if exists public.create_nin_request(text,text,numeric);
create function public.create_nin_request(p_customer_name text,p_customer_phone text,p_amount_paid numeric default 0)
returns public.nin_requests language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := public.current_owner_id();
  v_fee numeric(14,2);
  v_request public.nin_requests;
  v_phone text := regexp_replace(coalesce(p_customer_phone,''),'[^0-9]','','g');
begin
  if (select auth.uid()) is null or v_owner is null then raise exception 'Sign in is required'; end if;
  if p_customer_name is null or length(trim(p_customer_name)) not between 1 and 120 then raise exception 'Enter the customer name'; end if;
  if length(v_phone) not between 10 and 15 then raise exception 'Enter a valid customer phone number'; end if;
  select nin_fee into v_fee from public.service_pricing where owner_id=v_owner;
  if v_fee is null then raise exception 'The owner has not set the NIN service fee yet'; end if;
  if p_amount_paid is null or p_amount_paid < 0 or p_amount_paid > v_fee then raise exception 'Amount paid must be between zero and the NIN service fee'; end if;
  insert into public.nin_requests(owner_id,representative_id,customer_name,customer_phone,total_amount,amount_paid)
    values(v_owner,(select auth.uid()),trim(p_customer_name),v_phone,v_fee,p_amount_paid) returning * into v_request;
  return v_request;
end
$$;
revoke all on function public.create_nin_request(text,text,numeric) from public;
grant execute on function public.create_nin_request(text,text,numeric) to authenticated;

-- Direct inserts would let a representative choose a NIN fee, so requests must use the RPC.
revoke insert on public.nin_requests from authenticated;

-- Keep the existing RPC signature for compatibility, but ignore the submitted total.
-- The official fee is always read from the owner's SIM network stock record.
drop function if exists public.record_sim_registration(text,text,text,numeric,numeric);
create function public.record_sim_registration(p_customer_name text,p_phone_number text,p_network text,p_total_amount numeric,p_amount_paid numeric default 0)
returns public.sim_registrations language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := public.current_owner_id();
  v_record public.sim_registrations;
  v_phone text := regexp_replace(coalesce(p_phone_number,''),'[^0-9]','','g');
  v_fee numeric(14,2);
begin
  if (select auth.uid()) is null or v_owner is null then raise exception 'Sign in is required'; end if;
  if p_customer_name is null or length(trim(p_customer_name)) not between 1 and 120 then raise exception 'Enter the customer name'; end if;
  if length(v_phone) not between 10 and 15 then raise exception 'Enter a valid customer phone number'; end if;
  if p_network not in ('Glo','Airtel','MTN','Etisalat') then raise exception 'Select a valid SIM network'; end if;
  select service_fee into v_fee from public.sim_network_stock where owner_id=v_owner and network=p_network;
  if v_fee is null then raise exception 'The owner has not set the service fee for this network yet'; end if;
  if p_amount_paid is null or p_amount_paid<0 or p_amount_paid>v_fee then raise exception 'Amount paid must be between zero and the owner-set SIM service fee'; end if;
  update public.sim_network_stock set stock=stock-1,updated_at=now()
    where owner_id=v_owner and network=p_network and stock>0;
  if not found then raise exception 'No SIM stock is available for this network'; end if;
  insert into public.sim_registrations(owner_id,representative_id,customer_name,phone_number,network,total_amount,amount_paid)
    values(v_owner,(select auth.uid()),trim(p_customer_name),v_phone,p_network,v_fee,p_amount_paid) returning * into v_record;
  return v_record;
end
$$;
revoke all on function public.record_sim_registration(text,text,text,numeric,numeric) from public;
grant execute on function public.record_sim_registration(text,text,text,numeric,numeric) to authenticated;

do $$ begin
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='service_pricing') then
    alter publication supabase_realtime add table public.service_pricing;
  end if;
end $$;

notify pgrst,'reload schema';


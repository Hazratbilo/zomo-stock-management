-- Separate NIN requests from SIM inventory and line registrations.
-- Apply once to the existing ZOMO project. The legacy SIM/NIN table is not dropped.
alter table public.products alter column sku drop not null;

create table if not exists public.nin_requests (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  representative_id uuid not null references auth.users(id),
  customer_name text not null check (length(trim(customer_name)) between 1 and 120),
  customer_phone text not null check (customer_phone ~ '^[0-9]{10,15}$'),
  amount_paid numeric(14,2) not null check (amount_paid >= 0),
  status text not null default 'pending' check (status in ('pending','done')),
  created_at timestamptz not null default now()
);

-- NIN service entries are applications; they do not require an existing NIN.
alter table public.nin_requests drop column if exists nin_number;

create table if not exists public.sim_network_stock (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  network text not null check (network in ('Glo','Airtel','MTN','Etisalat')),
  stock integer not null default 0 check (stock >= 0),
  updated_at timestamptz not null default now(),
  unique(owner_id, network)
);

create table if not exists public.sim_registrations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  representative_id uuid not null references auth.users(id),
  customer_name text not null check (length(trim(customer_name)) between 1 and 120),
  phone_number text not null check (phone_number ~ '^[0-9]{10,15}$'),
  network text not null check (network in ('Glo','Airtel','MTN','Etisalat')),
  amount_paid numeric(14,2) not null default 0 check (amount_paid >= 0),
  created_at timestamptz not null default now()
);

alter table public.sim_registrations add column if not exists amount_paid numeric(14,2) not null default 0 check (amount_paid >= 0);

-- Add explicit profile links used by the app's representative-name lookups.
do $$ begin
  if not exists (select 1 from pg_constraint where conname='sales_representative_profile_fkey' and conrelid='public.sales'::regclass) then
    alter table public.sales add constraint sales_representative_profile_fkey foreign key (representative_id) references public.profiles(id) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname='nin_requests_representative_profile_fkey' and conrelid='public.nin_requests'::regclass) then
    alter table public.nin_requests add constraint nin_requests_representative_profile_fkey foreign key (representative_id) references public.profiles(id) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname='sim_registrations_representative_profile_fkey' and conrelid='public.sim_registrations'::regclass) then
    alter table public.sim_registrations add constraint sim_registrations_representative_profile_fkey foreign key (representative_id) references public.profiles(id) not valid;
  end if;
end $$;
notify pgrst, 'reload schema';

-- Track received gadget-sale payments and calculate outstanding balances.
alter table public.sales add column if not exists amount_paid numeric(14,2);
update public.sales set amount_paid = case when status = 'completed' then total else 0 end where amount_paid is null;
alter table public.sales alter column amount_paid set default 0;
alter table public.sales alter column amount_paid set not null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname='sales_amount_paid_check' and conrelid='public.sales'::regclass) then
    alter table public.sales add constraint sales_amount_paid_check check (amount_paid >= 0 and amount_paid <= quantity * unit_price) not valid;
  end if;
end $$;

drop function if exists public.record_sale(uuid,integer,text);
create or replace function public.record_sale(p_product_id uuid,p_quantity integer,p_customer_name text default null,p_amount_paid numeric default null)
returns public.sales language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := public.current_owner_id();
  v_product public.products;
  v_sale public.sales;
  v_total numeric(14,2);
  v_paid numeric(14,2);
begin
  if (select auth.uid()) is null or v_owner is null then raise exception 'Sign in is required'; end if;
  if p_quantity is null or p_quantity < 1 then raise exception 'Sale quantity must be at least one'; end if;
  update public.products set stock=stock-p_quantity,updated_at=now()
    where id=p_product_id and owner_id=v_owner and stock>=p_quantity returning * into v_product;
  if not found then raise exception 'Product not found or insufficient stock'; end if;
  v_total := p_quantity * v_product.price;
  v_paid := coalesce(p_amount_paid,v_total);
  if v_paid < 0 or v_paid > v_total then raise exception 'Amount received must be between zero and the sale total'; end if;
  insert into public.sales(owner_id,representative_id,product_id,quantity,unit_price,amount_paid,status,customer_name)
    values(v_owner,(select auth.uid()),v_product.id,p_quantity,v_product.price,v_paid,
      case when v_paid >= v_total then 'completed' else 'pending' end,nullif(trim(p_customer_name),''))
    returning * into v_sale;
  return v_sale;
end
$$;
revoke all on function public.record_sale(uuid,integer,text,numeric) from public;
grant execute on function public.record_sale(uuid,integer,text,numeric) to authenticated;

create index if not exists nin_requests_owner_date_idx on public.nin_requests(owner_id, created_at desc);
create index if not exists nin_requests_rep_date_idx on public.nin_requests(representative_id, created_at desc);
create index if not exists sim_registrations_owner_date_idx on public.sim_registrations(owner_id, created_at desc);
create index if not exists sim_registrations_rep_date_idx on public.sim_registrations(representative_id, created_at desc);

create or replace function public.seed_sim_network_stock()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.role = 'owner' then
    insert into public.sim_network_stock(owner_id,network,stock)
      values(new.id,'Glo',0),(new.id,'Airtel',0),(new.id,'MTN',0),(new.id,'Etisalat',0)
      on conflict(owner_id,network) do nothing;
  end if;
  return new;
end
$$;
drop trigger if exists profiles_seed_sim_stock on public.profiles;
create trigger profiles_seed_sim_stock after insert on public.profiles
  for each row execute function public.seed_sim_network_stock();
revoke all on function public.seed_sim_network_stock() from public;

insert into public.sim_network_stock(owner_id,network,stock)
select p.id,n.network,0 from public.profiles p
cross join (values('Glo'),('Airtel'),('MTN'),('Etisalat')) as n(network)
where p.role='owner' on conflict(owner_id,network) do nothing;

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='nin_requests') then alter publication supabase_realtime add table public.nin_requests; end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='sim_network_stock') then alter publication supabase_realtime add table public.sim_network_stock; end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='sim_registrations') then alter publication supabase_realtime add table public.sim_registrations; end if;
end $$;

alter table public.nin_requests enable row level security;
alter table public.sim_network_stock enable row level security;
alter table public.sim_registrations enable row level security;

drop policy if exists "Owners and reps can read NIN requests" on public.nin_requests;
create policy "Owners and reps can read NIN requests" on public.nin_requests for select to authenticated
  using(owner_id=(select public.current_owner_id()) and ((select public.is_owner()) or representative_id=(select auth.uid())));
drop policy if exists "Representatives can submit NIN requests" on public.nin_requests;
create policy "Representatives can submit NIN requests" on public.nin_requests for insert to authenticated
  with check(owner_id=(select public.current_owner_id()) and representative_id=(select auth.uid()));
drop policy if exists "Owners can update NIN request status" on public.nin_requests;
create policy "Owners can update NIN request status" on public.nin_requests for update to authenticated
  using(owner_id=(select public.current_owner_id()) and (select public.is_owner()))
  with check(owner_id=(select public.current_owner_id()) and (select public.is_owner()));

drop policy if exists "Workspace members can read SIM network stock" on public.sim_network_stock;
create policy "Workspace members can read SIM network stock" on public.sim_network_stock for select to authenticated
  using(owner_id=(select public.current_owner_id()));
drop policy if exists "Owners can insert SIM network stock" on public.sim_network_stock;
create policy "Owners can insert SIM network stock" on public.sim_network_stock for insert to authenticated
  with check(owner_id=(select auth.uid()) and (select public.is_owner()));
drop policy if exists "Owners can update SIM network stock" on public.sim_network_stock;
create policy "Owners can update SIM network stock" on public.sim_network_stock for update to authenticated
  using(owner_id=(select auth.uid()) and (select public.is_owner()))
  with check(owner_id=(select auth.uid()) and (select public.is_owner()));

drop policy if exists "Owners and reps can read permitted SIM registrations" on public.sim_registrations;
create policy "Owners and reps can read permitted SIM registrations" on public.sim_registrations for select to authenticated
  using(owner_id=(select public.current_owner_id()) and ((select public.is_owner()) or representative_id=(select auth.uid())));

revoke all on public.nin_requests,public.sim_network_stock,public.sim_registrations from anon,authenticated;
grant select,insert on public.nin_requests to authenticated;
grant update(status) on public.nin_requests to authenticated;
grant select,insert,update on public.sim_network_stock to authenticated;
grant select on public.sim_registrations to authenticated;

drop function if exists public.record_sim_registration(text,text,text);
create or replace function public.record_sim_registration(p_customer_name text,p_phone_number text,p_network text,p_amount_paid numeric default 0)
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
  if p_amount_paid is null or p_amount_paid < 0 then raise exception 'Enter a valid amount paid'; end if;
  update public.sim_network_stock set stock=stock-1,updated_at=now()
    where owner_id=v_owner and network=p_network and stock>0;
  if not found then raise exception 'No SIM stock is available for this network'; end if;
  insert into public.sim_registrations(owner_id,representative_id,customer_name,phone_number,network,amount_paid)
    values(v_owner,(select auth.uid()),trim(p_customer_name),v_phone,p_network,p_amount_paid) returning * into v_record;
  return v_record;
end
$$;
revoke all on function public.record_sim_registration(text,text,text,numeric) from public;
grant execute on function public.record_sim_registration(text,text,text,numeric) to authenticated;

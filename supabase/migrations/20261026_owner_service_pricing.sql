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

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

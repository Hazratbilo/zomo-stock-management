-- Preserve sales history when a product leaves active inventory and add a
-- locked NIN collection state plus owner-controlled refund tracking.

alter table public.products add column if not exists archived_at timestamptz;

alter table public.nin_requests add column if not exists refunded_amount numeric(14,2) not null default 0;
alter table public.nin_requests drop constraint if exists nin_requests_status_check;
alter table public.nin_requests add constraint nin_requests_status_check
  check (status in ('pending','done','collected'));
alter table public.nin_requests drop constraint if exists nin_requests_refund_check;
alter table public.nin_requests add constraint nin_requests_refund_check
  check (refunded_amount >= 0 and refunded_amount <= amount_paid);

alter table public.payment_transactions add column if not exists transaction_kind text not null default 'payment';
alter table public.payment_transactions add column if not exists created_by uuid references public.profiles(id);
alter table public.payment_transactions alter column created_by set default auth.uid();
alter table public.payment_transactions drop constraint if exists payment_transactions_transaction_kind_check;
alter table public.payment_transactions add constraint payment_transactions_transaction_kind_check
  check (transaction_kind in ('payment','refund'));

drop policy if exists "Owners and reps can read NIN requests" on public.nin_requests;
create policy "Workspace members can read NIN requests" on public.nin_requests for select to authenticated
  using (owner_id=(select public.current_owner_id()));

drop policy if exists "Representatives can collect completed NIN requests" on public.nin_requests;
create policy "Representatives can collect completed NIN requests" on public.nin_requests for update to authenticated
  using (owner_id=(select public.current_owner_id()) and status='done')
  with check (owner_id=(select public.current_owner_id()) and status='collected');

create or replace function public.guard_nin_lifecycle()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.status='collected' then
    raise exception 'Collected NIN requests are final and cannot be changed';
  end if;
  if new.status is distinct from old.status then
    if old.status='pending' and new.status='done' and (select public.is_owner()) then
      null;
    elsif old.status='done' and new.status='collected' and old.owner_id=(select public.current_owner_id()) then
      null;
    else
      raise exception 'Only the owner can mark a request Done; completed requests can then be marked Collected';
    end if;
  end if;
  if new.refunded_amount is distinct from old.refunded_amount then
    if not (select public.is_owner()) or old.status='collected' or new.refunded_amount < old.refunded_amount then
      raise exception 'Only the owner can record a refund before the request is collected';
    end if;
  end if;
  return new;
end
$$;
drop trigger if exists guard_nin_lifecycle on public.nin_requests;
create trigger guard_nin_lifecycle before update on public.nin_requests
  for each row execute function public.guard_nin_lifecycle();
revoke all on function public.guard_nin_lifecycle() from public;

create or replace function public.refund_nin_payment(p_request_id uuid,p_amount numeric)
returns public.payment_transactions language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := public.current_owner_id();
  v_paid numeric(14,2);
  v_refunded numeric(14,2);
  v_status text;
  v_record_rep uuid;
  v_rep uuid := (select auth.uid());
  v_amount numeric(14,2);
  v_transaction public.payment_transactions;
begin
  if v_rep is null or v_owner is null then raise exception 'Sign in is required'; end if;
  if not (select public.is_owner()) then raise exception 'Only the workspace owner can refund NIN payments'; end if;
  if p_amount is null then raise exception 'Enter a refund greater than zero'; end if;
  v_amount := round(p_amount,2);
  if v_amount <= 0 then raise exception 'Enter a refund of at least ₦0.01'; end if;
  select amount_paid,refunded_amount,status,representative_id into v_paid,v_refunded,v_status,v_record_rep
    from public.nin_requests where id=p_request_id and owner_id=v_owner for update;
  if not found then raise exception 'NIN request not found in this workspace'; end if;
  if v_status='collected' then raise exception 'Collected NIN requests are final and cannot be refunded'; end if;
  if v_amount > v_paid-v_refunded then raise exception 'Refund cannot exceed the amount collected'; end if;
  update public.nin_requests set refunded_amount=refunded_amount+v_amount where id=p_request_id;
  insert into public.payment_transactions(owner_id,representative_id,record_type,record_id,amount,transaction_kind)
    values(v_owner,v_record_rep,'nin',p_request_id,v_amount,'refund') returning * into v_transaction;
  return v_transaction;
end
$$;
revoke all on function public.refund_nin_payment(uuid,numeric) from public;
grant execute on function public.refund_nin_payment(uuid,numeric) to authenticated;

-- Payments after a refund are limited by the net outstanding balance; collected
-- requests are permanently closed to both payments and refunds.
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
    select owner_id,representative_id,total-amount_paid into v_record_owner,v_record_rep,v_balance
      from public.sales where id=p_record_id and status<>'cancelled' for update;
  elsif p_record_type='nin' then
    select owner_id,representative_id,total_amount-amount_paid+refunded_amount into v_record_owner,v_record_rep,v_balance
      from public.nin_requests where id=p_record_id and status<>'collected' for update;
  elsif p_record_type='sim' then
    select owner_id,representative_id,total_amount-amount_paid into v_record_owner,v_record_rep,v_balance
      from public.sim_registrations where id=p_record_id for update;
  else
    raise exception 'Invalid payment record type';
  end if;
  if v_record_owner is null or v_record_owner<>v_owner or (not (select public.is_owner()) and v_record_rep<>v_rep) then
    raise exception 'You do not have access to this customer record';
  end if;
  if p_amount>v_balance then raise exception 'Payment is greater than the remaining balance'; end if;
  if p_record_type='sale' then
    update public.sales set amount_paid=amount_paid+p_amount,status=case when amount_paid+p_amount>=total then 'completed' else 'pending' end where id=p_record_id;
  elsif p_record_type='nin' then
    update public.nin_requests set amount_paid=amount_paid+p_amount where id=p_record_id;
  else
    update public.sim_registrations set amount_paid=amount_paid+p_amount where id=p_record_id;
  end if;
  insert into public.payment_transactions(owner_id,representative_id,record_type,record_id,amount,transaction_kind)
    values(v_owner,v_rep,p_record_type,p_record_id,p_amount,'payment') returning * into v_payment;
  return v_payment;
end
$$;
revoke all on function public.record_customer_payment(text,uuid,numeric) from public;
grant execute on function public.record_customer_payment(text,uuid,numeric) to authenticated;

notify pgrst,'reload schema';

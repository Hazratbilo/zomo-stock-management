-- Make a refunded NIN request a terminal state. Only the workspace owner can
-- move Pending to Done or Refunded; any workspace member can move Done to
-- Collected. Refunding records the refund and status atomically.
alter table public.nin_requests drop constraint if exists nin_requests_status_check;
alter table public.nin_requests add constraint nin_requests_status_check
  check (status in ('pending','done','collected','refunded'));

create or replace function public.guard_nin_lifecycle()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.status in ('collected','refunded') then
    raise exception 'Collected or refunded NIN requests are final and cannot be changed';
  end if;
  if new.status is distinct from old.status then
    if old.status='pending' and new.status in ('done','refunded') and (select public.is_owner()) then
      null;
    elsif old.status='done' and new.status='collected' and old.owner_id=(select public.current_owner_id()) then
      null;
    else
      raise exception 'The owner must mark a pending request Done or Refunded; a completed request can then be marked Collected';
    end if;
  end if;
  if new.refunded_amount is distinct from old.refunded_amount then
    if not (select public.is_owner()) or old.status<>'pending' or new.refunded_amount < old.refunded_amount then
      raise exception 'Only the owner can refund a pending NIN request';
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
  if v_status<>'pending' then raise exception 'Only a pending NIN request can be refunded'; end if;
  if v_amount > v_paid-v_refunded then raise exception 'Refund cannot exceed the amount collected'; end if;
  update public.nin_requests set refunded_amount=refunded_amount+v_amount,status='refunded' where id=p_request_id;
  insert into public.payment_transactions(owner_id,representative_id,record_type,record_id,amount,transaction_kind)
    values(v_owner,v_record_rep,'nin',p_request_id,v_amount,'refund') returning * into v_transaction;
  return v_transaction;
end
$$;
revoke all on function public.refund_nin_payment(uuid,numeric) from public;
grant execute on function public.refund_nin_payment(uuid,numeric) to authenticated;

drop policy if exists "Representatives can collect completed NIN requests" on public.nin_requests;
create policy "Representatives can collect completed NIN requests" on public.nin_requests for update to authenticated
  using (owner_id=(select public.current_owner_id()) and status='done')
  with check (owner_id=(select public.current_owner_id()) and status='collected');

notify pgrst,'reload schema';

-- Add a guarded, owner-only workspace reset. The reset preserves the owner's
-- profile and login while clearing business records and disabling rep access.
create or replace function public.reset_workspace_from_scratch(p_confirmation text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := (select auth.uid());
  v_deleted_sales integer := 0;
  v_deleted_products integer := 0;
  v_deactivated_reps integer := 0;
begin
  if v_owner is null then raise exception 'Sign in as the workspace owner to reset the app'; end if;
  if not (select public.is_owner()) then raise exception 'Only the workspace owner can reset the app'; end if;
  if p_confirmation is distinct from 'RESET ZOMO' then raise exception 'Type RESET ZOMO exactly to confirm'; end if;

  delete from public.payment_transactions where owner_id=v_owner;
  delete from public.sales where owner_id=v_owner;
  get diagnostics v_deleted_sales = row_count;
  delete from public.nin_requests where owner_id=v_owner;
  delete from public.sim_registrations where owner_id=v_owner;
  delete from public.products where owner_id=v_owner;
  get diagnostics v_deleted_products = row_count;

  update public.sim_network_stock
    set stock=0,service_fee=null,updated_at=now()
    where owner_id=v_owner;
  update public.service_pricing
    set nin_fee=null,updated_at=now()
    where owner_id=v_owner;

  update public.profiles
    set active=false
    where owner_id=v_owner and role='sales_rep' and active=true;
  get diagnostics v_deactivated_reps = row_count;

  return jsonb_build_object(
    'sales_deleted',v_deleted_sales,
    'products_deleted',v_deleted_products,
    'representatives_deactivated',v_deactivated_reps,
    'owner_account_preserved',true
  );
end
$$;

revoke all on function public.reset_workspace_from_scratch(text) from public,anon;
grant execute on function public.reset_workspace_from_scratch(text) to authenticated;
notify pgrst,'reload schema';

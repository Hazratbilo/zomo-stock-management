import React, { useEffect, useState } from 'react';
import { Check, ClipboardList, Plus, ShieldCheck, Smartphone, X, Wallet, RotateCcw, PackageCheck } from 'lucide-react';

const NETWORKS = ['Glo', 'Airtel', 'MTN', 'Etisalat'];
const money = (n) => '₦' + Number(n || 0).toLocaleString('en-NG');
const digits = (value) => String(value || '').replace(/\D/g, '');
const mask = (value) => `${'•'.repeat(Math.max(0, digits(value).length - 4))}${digits(value).slice(-4)}`;
const date = (value) => new Date(value).toLocaleDateString('en-NG', { day:'2-digit', month:'short', year:'numeric' });

export default function ServicesView({ client, session, workspaceOwnerId, userRole, notify }) {
  const [tab, setTab] = useState('nin');
  const [ninRequests, setNinRequests] = useState([]);
  const [simStock, setSimStock] = useState([]);
  const [simRecords, setSimRecords] = useState([]);
  const [ninFee, setNinFee] = useState(null);
  const [ninFeeInput, setNinFeeInput] = useState('');
  const [ninModal, setNinModal] = useState(false);
  const [simModal, setSimModal] = useState(false);
  const [detail, setDetail] = useState(null);
  const [paymentTarget, setPaymentTarget] = useState(null);
  const [refundTarget, setRefundTarget] = useState(null);
  const [refundAmount, setRefundAmount] = useState('');
  const [paymentAmount, setPaymentAmount] = useState('');
  const [error, setError] = useState('');
  const [ninForm, setNinForm] = useState({ name:'', phone:'', total:'', amount:'' });
  const [simForm, setSimForm] = useState({ name:'', phone:'', network:'Glo', total:'', amount:'' });
  const [stockInputs, setStockInputs] = useState({});
  const [simFeeInputs, setSimFeeInputs] = useState({});

  async function refresh() {
    try {
    const [nin, stock, sim, pricing] = await Promise.all([
      client.from('nin_requests').select('id, owner_id, representative_id, customer_name, customer_phone, total_amount, amount_paid, refunded_amount, status, created_at, profiles!nin_requests_representative_profile_fkey(full_name)').order('created_at', {ascending:false}),
      client.from('sim_network_stock').select('id, owner_id, network, stock, service_fee, updated_at').order('network'),
      client.from('sim_registrations').select('id, owner_id, representative_id, customer_name, phone_number, network, total_amount, amount_paid, created_at, profiles!sim_registrations_representative_profile_fkey(full_name)').order('created_at', {ascending:false}),
      client.from('service_pricing').select('nin_fee').eq('owner_id',workspaceOwnerId).maybeSingle(),
    ]);
    const failed = nin.error || stock.error || sim.error || pricing.error;
    if (failed) { setError(failed.message || 'Supabase could not load the service-tracking tables.'); return; }
    setError(''); setNinRequests(nin.data || []); setSimStock(stock.data || []); setSimRecords(sim.data || []);
    setNinFee(pricing.data?.nin_fee == null ? null : Number(pricing.data.nin_fee));
    setNinFeeInput(pricing.data?.nin_fee == null ? '' : String(pricing.data.nin_fee));
    setStockInputs(Object.fromEntries((stock.data || []).map(row => [row.network, String(row.stock)])));
    setSimFeeInputs(Object.fromEntries((stock.data || []).map(row => [row.network, row.service_fee == null ? '' : String(row.service_fee)])));
    } catch (loadError) {
      setError(loadError?.message || 'A connection problem stopped the service records from loading. Refresh the page and try again.');
    }
  }

  useEffect(() => {
    if (!client || !session?.user?.id || !workspaceOwnerId) return undefined;
    refresh();
    const channel = client.channel('zomo-service-tracking')
      .on('postgres_changes', {event:'*',schema:'public',table:'nin_requests'}, refresh)
      .on('postgres_changes', {event:'*',schema:'public',table:'sim_network_stock'}, refresh)
      .on('postgres_changes', {event:'*',schema:'public',table:'service_pricing'}, refresh)
      .on('postgres_changes', {event:'*',schema:'public',table:'sim_registrations'}, refresh)
      .subscribe();
    return () => { client.removeChannel(channel); };
  }, [client, session?.user?.id, workspaceOwnerId]);

  async function createNinRequest(event) {
    event.preventDefault();
    const name=ninForm.name.trim();
    const phone = digits(ninForm.phone);
    const amount = Number(ninForm.amount);
    if (name.length < 2 || name.length > 120) { notify('Enter the customer’s full name (2 to 120 characters).'); return; }
    if (phone.length < 10 || phone.length > 15) { notify('Enter a valid customer phone number.'); return; }
    if (ninFee == null) { notify('The owner has not set the NIN service fee yet.'); return; }
    if (!Number.isFinite(amount) || amount < 0 || amount > ninFee) { notify('Amount paid must not be greater than the owner-set NIN service fee.'); return; }
    const { error: saveError } = await client.rpc('create_nin_request', {
      p_customer_name:name, p_customer_phone:phone, p_amount_paid:amount,
    });
    if (saveError) { notify(saveError.message || 'Could not save the NIN request. Please try again.'); return; }
    setNinForm({name:'',phone:'',total:'',amount:''}); setNinModal(false); await refresh(); notify('NIN request recorded as Pending.');
  }

  async function setNinStatus(request, status) {
    if (userRole !== 'owner' || request.status !== 'pending' || status !== 'done') { notify('Only the owner can manually mark a Pending request Done after receiving the completed NIN.'); return; }
    try {
      const { data, error:updateError } = await client.from('nin_requests').update({status:'done'}).eq('id',request.id).eq('status','pending').select('id').maybeSingle();
      if (updateError) throw updateError;
      if (!data) { notify('This NIN request has already changed. Refresh and try again.'); return; }
      await refresh(); notify('Marked Done. Collection is still a separate team action after handing the NIN to the customer.');
    } catch (error) { notify(error.message || 'Could not update this NIN request. Please try again.'); }
  }

  async function markNinCollected(request) {
    if (request.status !== 'done') { notify('The owner must mark this NIN Done before it can be collected.'); return; }
    try {
      const { data, error:updateError } = await client.from('nin_requests').update({status:'collected'}).eq('id',request.id).eq('status','done').select('id').maybeSingle();
      if (updateError) throw updateError;
      if (!data) { notify('This NIN request has already changed or been collected. Refresh the page.'); return; }
      await refresh(); notify('NIN marked Collected. This request is now locked.');
    } catch (error) { notify(error.message || 'Could not mark this NIN as collected. Please try again.'); }
  }

  async function submitRefund(event) {
    event.preventDefault();
    const amount=Number(refundAmount);
    const refundable=refundTarget ? Number(refundTarget.amount_paid)-Number(refundTarget.refunded_amount||0) : 0;
    if(userRole!=='owner'||!refundTarget||!Number.isFinite(amount)||amount<=0||amount>refundable){notify('Enter a refund greater than zero and no more than the amount collected.');return;}
    try {
      const {error:refundError}=await client.rpc('refund_nin_payment',{p_request_id:refundTarget.id,p_amount:amount});
      if(refundError)throw refundError;
      setRefundTarget(null);setRefundAmount('');await refresh();notify('Refund recorded. This request is now locked and the refund is deducted from reports.');
    } catch(error) { notify(error.message || 'Could not record the refund. Please try again.'); }
  }

  async function saveNetworkStock(network) {
    const quantity = Number(stockInputs[network]);
    const feeText = simFeeInputs[network] ?? '';
    const fee = Number(feeText);
    if (!Number.isInteger(quantity) || quantity < 0) { notify('SIM stock must be a whole number of zero or more.'); return; }
    if (feeText.trim() === '' || !Number.isFinite(fee) || fee < 0) { notify('Enter the customer service price for this SIM network.'); return; }
    const { error:saveError } = await client.from('sim_network_stock').upsert({owner_id:workspaceOwnerId,network,stock:quantity,service_fee:fee,updated_at:new Date().toISOString()},{onConflict:'owner_id,network'});
    if (saveError) { notify(saveError.message); return; }
    await refresh(); notify(`${network} SIM stock and customer price saved.`);
  }

  async function saveNinFee(event) {
    event.preventDefault();
    const fee = Number(ninFeeInput);
    if (ninFeeInput.trim() === '' || !Number.isFinite(fee) || fee < 0) { notify('Enter a valid NIN service price.'); return; }
    const { error:saveError } = await client.from('service_pricing').upsert({owner_id:workspaceOwnerId,nin_fee:fee,updated_at:new Date().toISOString()},{onConflict:'owner_id'});
    if (saveError) { notify(saveError.message); return; }
    await refresh(); notify('NIN customer price saved.');
  }

  async function registerSim(event) {
    event.preventDefault();
    const name=simForm.name.trim();
    const phone = digits(simForm.phone);
    const amount = Number(simForm.amount);
    const total = Number(simStock.find(row=>row.network===simForm.network)?.service_fee);
    if (name.length < 2 || name.length > 120) { notify('Enter the customer’s full name (2 to 120 characters).'); return; }
    if (phone.length < 10 || phone.length > 15) { notify('Enter a valid customer SIM phone number.'); return; }
    if (!Number.isFinite(total) || total < 0 || !Number.isFinite(amount) || amount < 0 || amount > total) { notify('Enter an amount paid no greater than the owner-set SIM price.'); return; }
    const { data, error:saveError } = await client.rpc('record_sim_registration', {
      p_customer_name:name, p_phone_number:phone, p_network:simForm.network, p_total_amount:total, p_amount_paid:amount,
    });
    if (saveError) { notify(saveError.message); return; }
    setSimRecords(rows=>[data,...rows]); setSimForm({name:'',phone:'',network:'Glo',total:'',amount:''}); setSimModal(false);
    await refresh(); notify(`${simForm.network} registration recorded and stock reduced by one.`);
  }

  async function addPayment(event) {
    event.preventDefault();
    const amount=Number(paymentAmount);
    if (!paymentTarget || !Number.isFinite(amount) || amount<=0 || amount>paymentTarget.balance) { notify('Enter a payment that is greater than zero and no more than the balance.'); return; }
    try {
      const {error:paymentError}=await client.rpc('record_customer_payment',{p_record_type:paymentTarget.type,p_record_id:paymentTarget.row.id,p_amount:amount});
      if(paymentError)throw paymentError;
      setPaymentTarget(null);setPaymentAmount('');await refresh();notify('Payment saved and balance updated.');
    } catch(error) { notify(error.message || 'Could not save the payment. Please try again.'); }
  }

  const paymentButton=(type,row)=>(Number(row.total_amount)-Number(row.amount_paid)>0)&&<button className="button button-ghost compact" onClick={()=>{setPaymentTarget({type,row,balance:Number(row.total_amount)-Number(row.amount_paid)});setPaymentAmount('')}}><Wallet size={14}/> Add payment</button>;

  const stockFor = (network) => simStock.find(row=>row.network===network)?.stock ?? 0;
  const feeFor = (network) => simStock.find(row=>row.network===network)?.service_fee;
  const pendingNin = ninRequests.filter(row=>row.status==='pending').length;
  const doneNin = ninRequests.filter(row=>row.status==='done').length;
  const collectedNin = ninRequests.filter(row=>row.status==='collected').length;
  const refundedNin = ninRequests.filter(row=>row.status==='refunded').length;

  return <div className="services-view">
    <div className="service-tabs" role="tablist" aria-label="SIM and NIN services">
      <button role="tab" aria-selected={tab==='nin'} className={tab==='nin'?'selected':''} onClick={()=>setTab('nin')}><ClipboardList size={15}/> NIN requests</button>
      <button role="tab" aria-selected={tab==='sim'} className={tab==='sim'?'selected':''} onClick={()=>setTab('sim')}><Smartphone size={15}/> SIM stock & registrations</button>
    </div>
    {error&&<div className="service-db-notice"><ShieldCheck size={17}/><span><strong>Could not load SIM and NIN service data.</strong><br/><code>{error}</code><br/>If this mentions a missing table or column, apply the <a href="/zomo-inventory-nin-lifecycle.sql" download>inventory and NIN update SQL</a> in Supabase → SQL Editor, then click Run.</span></div>}

    {tab==='nin'&&<>
      <div className="service-overview"><div className="service-overview-copy"><span>NIN SERVICE DESK</span><strong>{ninRequests.length} customer requests</strong><small>Requests stay Pending until the owner receives the completed NIN and manually marks Done. Only then can a team member separately mark it Collected after handover. Refunded and Collected requests are locked.</small></div><div className="service-stat-pair"><div><small>Pending</small><strong>{pendingNin}</strong></div><div><small>Done</small><strong>{doneNin}</strong></div><div><small>Collected</small><strong>{collectedNin}</strong></div></div></div>
      {userRole==='owner'?<form className="panel service-panel service-pricing-form" onSubmit={saveNinFee}><div><h2>NIN customer price</h2><p>Set the fee reps will see and use when recording a request.</p></div><label>Fee (₦)<input required min="0" step="0.01" type="number" value={ninFeeInput} onChange={event=>setNinFeeInput(event.target.value)} placeholder="Set NIN price"/></label><button className="button button-primary"><Check size={15}/> Save price</button></form>:<div className="service-overview service-price-readonly"><div className="service-overview-copy"><span>OWNER-SET NIN PRICE</span><strong>{ninFee == null ? 'Not set yet' : money(ninFee)}</strong><small>You can see the fee. Only the owner can change it.</small></div></div>}
      <section className="panel service-panel"><div className="service-panel-head"><div><h2>NIN registration requests</h2><p>Customer identity details, payment received and current processing status.</p></div><button className="button button-primary" disabled={ninFee==null} onClick={()=>setNinModal(true)}><Plus size={15}/> Add NIN request</button></div>
        <div className="table-scroll"><table className="data-table service-table nin-table"><thead><tr><th>CUSTOMER</th>{userRole==='owner'&&<th>SALES REPRESENTATIVE</th>}<th>PHONE</th><th>FEE</th><th>PAID</th><th>REFUNDED</th><th>UNPAID</th><th>STATUS</th><th>DATE</th><th/></tr></thead><tbody>{ninRequests.map(row=>{const netPaid=Math.max(0,Number(row.amount_paid)-Number(row.refunded_amount||0));const due=Math.max(0,Number(row.total_amount)-netPaid);const collected=row.status==='collected';const locked=collected||row.status==='refunded';return <tr key={row.id}><td><strong>{row.customer_name}</strong></td>{userRole==='owner'&&<td className="muted-cell">{row.profiles?.full_name||'Sales representative'}</td>}<td className="muted-cell">{mask(row.customer_phone)}</td><td>{money(row.total_amount)}</td><td><strong>{money(netPaid)}</strong></td><td>{Number(row.refunded_amount||0)>0?<strong>{money(row.refunded_amount)}</strong>:'—'}</td><td><strong>{money(due)}</strong></td><td>{userRole==='owner'&&row.status==='pending'?<button className="nin-state status-done-action" onClick={()=>setNinStatus(row,'done')} title="Click only after the completed NIN is received from the representative">Mark Done</button>:row.status==='done'&&!collected?<button className="nin-state status-collected-action" onClick={()=>markNinCollected(row)} title="Confirm the customer's collection"><PackageCheck size={13}/> Mark collected</button>:<span className={`nin-state-label state-${row.status}`}>{row.status==='collected'?'Collected':row.status==='refunded'?'Refunded':row.status==='done'?'Done':'Pending'}</span>}</td><td className="muted-cell">{date(row.created_at)}</td><td className="nin-row-actions">{!locked&&paymentButton('nin', {...row,amount_paid:netPaid})}{userRole==='owner'&&row.status==='pending'&&netPaid>0&&<button className="button button-ghost compact refund-button" onClick={()=>{setRefundTarget(row);setRefundAmount('')}} title="Record a customer refund"><RotateCcw size={13}/> Refund</button>}</td></tr>})}</tbody></table>{!ninRequests.length&&<Empty icon={<ClipboardList size={22}/>} title="No NIN requests yet" text="Add a customer request and record the amount received."/>}</div>
      </section>
    </>}

    {tab==='sim'&&<>
      <div className="service-overview"><div className="service-overview-copy"><span>SIM SERVICE DESK</span><strong>{simRecords.length} registrations</strong><small>Owner-managed SIM quantities. Each completed registration uses one SIM from that network.</small></div><div className="service-stat-pair"><div><small>SIM units available</small><strong>{NETWORKS.reduce((total,network)=>total+Number(stockFor(network)),0)}</strong></div><div><small>Logged registrations</small><strong>{simRecords.length}</strong></div></div></div>
      <section className="panel service-panel"><div className="service-panel-head"><div><h2>Available SIM stock & customer prices</h2><p>{userRole==='owner'?'Set quantity and the customer service price for each network.':'Check remaining SIMs and the owner-set price before registering a customer.'}</p></div></div><div className="network-stock-grid">{NETWORKS.map(network=><div className="network-stock-card" key={network}><div className={`network-mark network-${network.toLowerCase()}`}>{network==='Etisalat'?'E':network[0]}</div><div className="network-stock-info"><strong>{network}</strong><small>{stockFor(network)} SIMs · {feeFor(network)==null?'Price not set':money(feeFor(network))}</small></div>{userRole==='owner'?<><label className="network-input-label">Units<input aria-label={`${network} stock quantity`} min="0" step="1" type="number" value={stockInputs[network]??String(stockFor(network))} onChange={event=>setStockInputs(current=>({...current,[network]:event.target.value}))}/></label><label className="network-input-label">Customer price (₦)<input aria-label={`${network} customer price`} min="0" step="0.01" type="number" value={simFeeInputs[network]??''} onChange={event=>setSimFeeInputs(current=>({...current,[network]:event.target.value}))}/></label><button className="button button-ghost compact" onClick={()=>saveNetworkStock(network)}>Save</button></>:<span className="stock-readonly">{feeFor(network)==null?'Price not set':money(feeFor(network))}</span>}</div>)}</div></section>
      <section className="panel service-panel"><div className="service-panel-head"><div><h2>SIM registration log</h2><p>Record the customer, network and payment after registering their line.</p></div><button className="button button-primary" onClick={()=>setSimModal(true)}><Plus size={15}/> Record SIM registration</button></div><div className="table-scroll"><table className="data-table service-table sim-table"><thead><tr><th>CUSTOMER</th>{userRole==='owner'&&<th>SALES REPRESENTATIVE</th>}<th>PHONE NUMBER</th><th>LINE / NETWORK</th><th>FEE</th><th>PAID</th><th>UNPAID</th><th>DATE REGISTERED</th><th/></tr></thead><tbody>{simRecords.map(row=><tr key={row.id}><td><strong>{row.customer_name}</strong></td>{userRole==='owner'&&<td className="muted-cell">{row.profiles?.full_name||'Sales representative'}</td>}<td className="muted-cell">{mask(row.phone_number)}</td><td><span className={`network-chip network-${row.network.toLowerCase()}`}>{row.network}</span></td><td>{money(row.total_amount)}</td><td><strong>{money(row.amount_paid)}</strong></td><td><strong>{money(Math.max(0,Number(row.total_amount)-Number(row.amount_paid)))}</strong></td><td className="muted-cell">{date(row.created_at)}</td><td>{paymentButton('sim',row)}</td></tr>)}</tbody></table>{!simRecords.length&&<Empty icon={<Smartphone size={22}/>} title="No SIM registrations yet" text="Recorded customer lines will appear here. Each record reduces available SIM stock by one."/>}</div></section>
    </>}

    {ninModal&&<Modal title="Add NIN request" subtitle="The NIN price is set by the owner. Record only the amount paid today." onClose={()=>setNinModal(false)}><form className="modal-form" onSubmit={createNinRequest}><label>Customer full name<input required maxLength="120" autoComplete="name" value={ninForm.name} onChange={e=>setNinForm({...ninForm,name:e.target.value})} placeholder="Customer name"/></label><label>Customer phone number<input required type="tel" inputMode="tel" value={ninForm.phone} onChange={e=>setNinForm({...ninForm,phone:e.target.value})} placeholder="080 1234 5678"/></label><div className="sale-total">Owner-set NIN price <strong>{ninFee==null?'Not set':money(ninFee)}</strong></div><label>Amount paid today (₦)<input required min="0" max={ninFee??undefined} step="0.01" type="number" value={ninForm.amount} onChange={e=>setNinForm({...ninForm,amount:e.target.value})} placeholder="Amount received"/></label>{ninForm.amount!==''&&ninFee!=null&&<div className="sale-total">Remaining balance <strong>{money(Math.max(0,ninFee-Number(ninForm.amount)))}</strong></div>}<div className="form-footnote"><ShieldCheck size={14}/> Starts as Pending. The owner updates its processing status; the price cannot be changed here.</div><div className="modal-actions"><button type="button" className="button button-ghost" onClick={()=>setNinModal(false)}>Cancel</button><button className="button button-primary"><Plus size={15}/> Save NIN request</button></div></form></Modal>}
    {simModal&&<Modal title="Record SIM registration" subtitle="The network price is set by the owner. Record only the amount paid today." onClose={()=>setSimModal(false)}><form className="modal-form" onSubmit={registerSim}><label>Customer full name<input required maxLength="120" autoComplete="name" value={simForm.name} onChange={e=>setSimForm({...simForm,name:e.target.value})} placeholder="Customer name"/></label><label>Customer phone number<input required type="tel" inputMode="tel" value={simForm.phone} onChange={e=>setSimForm({...simForm,phone:e.target.value})} placeholder="080 1234 5678"/></label><label>Line name / network<select value={simForm.network} onChange={e=>setSimForm({...simForm,network:e.target.value})}>{NETWORKS.map(network=><option key={network}>{network}</option>)}</select></label><div className="sale-total">Owner-set {simForm.network} price <strong>{feeFor(simForm.network)==null?'Not set':money(feeFor(simForm.network))}</strong></div><label>Amount paid today (₦)<input required min="0" max={feeFor(simForm.network)??undefined} step="0.01" type="number" value={simForm.amount} onChange={e=>setSimForm({...simForm,amount:e.target.value})} placeholder="Amount received"/></label>{simForm.amount!==''&&feeFor(simForm.network)!=null&&<div className="sale-total">Remaining balance <strong>{money(Math.max(0,Number(feeFor(simForm.network))-Number(simForm.amount)))}</strong></div>}<div className="form-footnote"><Smartphone size={14}/>{simForm.network}: {stockFor(simForm.network)} SIMs available. Stock reduces when this registration is saved.</div><div className="modal-actions"><button type="button" className="button button-ghost" onClick={()=>setSimModal(false)}>Cancel</button><button className="button button-primary" disabled={stockFor(simForm.network)<1||feeFor(simForm.network)==null}><Check size={15}/> Save registration</button></div></form></Modal>}
    {paymentTarget&&<Modal title="Add customer payment" subtitle={`Balance remaining: ${money(paymentTarget.balance)}. This payment will appear in the date it is received.`} onClose={()=>setPaymentTarget(null)}><form className="modal-form" onSubmit={addPayment}><label>Amount received now (₦)<input autoFocus required min="0.01" max={paymentTarget.balance} step="0.01" type="number" value={paymentAmount} onChange={e=>setPaymentAmount(e.target.value)} placeholder="Amount received"/></label><div className="modal-actions"><button type="button" className="button button-ghost" onClick={()=>setPaymentTarget(null)}>Cancel</button><button className="button button-primary"><Check size={15}/> Save payment</button></div></form></Modal>}
    {refundTarget&&<Modal title="Refund NIN payment" subtitle="Only the owner can issue a refund. Collected NIN requests are locked and cannot be refunded." onClose={()=>setRefundTarget(null)}><form className="modal-form" onSubmit={submitRefund}><div className="sale-total">Available to refund<strong>{money(Number(refundTarget.amount_paid)-Number(refundTarget.refunded_amount||0))}</strong></div><label>Refund amount (₦)<input autoFocus required min="0.01" max={Number(refundTarget.amount_paid)-Number(refundTarget.refunded_amount||0)} step="0.01" type="number" value={refundAmount} onChange={event=>setRefundAmount(event.target.value)} placeholder="Amount to refund"/></label><p className="form-footnote"><ShieldCheck size={14}/> The refund is recorded in the payment history, updates the outstanding balance and is deducted from reports.</p><div className="modal-actions"><button type="button" className="button button-ghost" onClick={()=>setRefundTarget(null)}>Cancel</button><button className="button button-primary"><RotateCcw size={15}/> Record refund</button></div></form></Modal>}
    {detail&&<Modal title="NIN request details" subtitle="Customer request and payment information." onClose={()=>setDetail(null)}><div className="registration-detail"><span>Customer</span><strong>{detail.customer_name}</strong><span>Customer phone number</span><strong className="sensitive-number">{detail.customer_phone}</strong><span>Amount paid</span><strong>{money(detail.amount_paid)}</strong><span>Processing status</span><strong>{detail.status==='done'?'Done':'Pending'}</strong></div></Modal>}
  </div>;
}

function Empty({icon,title,text}){return <div className="empty-state"><div>{icon}</div><strong>{title}</strong><span>{text}</span></div>}
function Modal({title,subtitle,onClose,children}){return <div className="modal-backdrop" onMouseDown={event=>event.target===event.currentTarget&&onClose()}><section className="modal"><div className="modal-header"><div><h2>{title}</h2><p>{subtitle}</p></div><button onClick={onClose} aria-label="Close dialog"><X size={18}/></button></div>{children}</section></div>}

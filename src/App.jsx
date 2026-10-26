import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity, ArrowDownRight, ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpRight,
  Bell, Boxes, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight,
  CircleHelp, ClipboardList, Command, CreditCard, Download, Ellipsis, Eye, EyeOff,
  FileBarChart, Filter, Headphones, LayoutDashboard, LoaderCircle, LogOut,
  Menu, Monitor, Moon, MoreHorizontal, Package, Plus, Search, Settings, ShieldCheck,
  Smartphone, Sparkles, Sun, TrendingUp, UserRound, Users, Wallet, X,
} from 'lucide-react';
import { getSupabaseClient, saveSupabaseProject } from './lib/supabase';
import ServicesView from './ServicesView';

const navGroups = [
  { label: 'WORKSPACE', items: [ ['Overview',LayoutDashboard],['Inventory',Boxes],['Sales',CreditCard],['SIM & NIN',Smartphone],['Team',Users],['Reports',FileBarChart] ] },
  { label: 'MANAGEMENT', items: [ ['Settings',Settings] ] },
];
const money = (n) => '₦' + Number(n).toLocaleString('en-NG');
const getLagosHour = () => Number(new Intl.DateTimeFormat('en-NG',{timeZone:'Africa/Lagos',hour:'2-digit',hourCycle:'h23'}).format(new Date()));
const formatSale = (s, i) => ({ rawId:s.id, id:`#${String(s.id).slice(0,8).toUpperCase()}`, initials:(s.customer_name||'WC').split(' ').map(x=>x[0]).join('').slice(0,2).toUpperCase(), name:s.customer_name||'Walk-in customer', product:s.products?.name||'Product', amount:Number(s.total), amountPaid:Number(s.amount_paid ?? (s.status==='completed'?s.total:0)), quantity:Number(s.quantity||0), unitPrice:Number(s.unit_price||0), productCost:Number(s.products?.cost||0), status:s.status==='completed'?'Completed':s.status==='pending'?'Pending':'Cancelled', time:new Date(s.created_at).toLocaleTimeString('en-NG',{hour:'numeric',minute:'2-digit'}), createdAt:s.created_at, rep:s.profiles?.full_name||'Sales representative', repId:s.representative_id, color:['violet','amber','blue','green'][i%4] });

function App() {
  const [products, setProducts] = useState([]);
  const [sales, setSales] = useState([]);
  const [view, setView] = useState('Overview');
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('zomo-theme') === 'dark' ? 'dark' : 'light'; }
    catch { return 'light'; }
  });
  const [currentHour, setCurrentHour] = useState(getLagosHour);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('All products');
  const [modal, setModal] = useState('');
  const [paymentTarget, setPaymentTarget] = useState(null);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [period, setPeriod] = useState('Last 7 days');
  const [reportPeriod, setReportPeriod] = useState('This week');
  const [simUnits, setSimUnits] = useState(0);
  const [ninPayments, setNinPayments] = useState([]);
  const [simPayments, setSimPayments] = useState([]);
  const [paymentEvents, setPaymentEvents] = useState([]);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [client, setClient] = useState(() => getSupabaseClient());
  const isSupabaseConfigured = Boolean(client);
  const [cloudState, setCloudState] = useState(isSupabaseConfigured ? 'connecting' : 'missing-config');
  const [session, setSession] = useState(null);
  const [authReady, setAuthReady] = useState(!isSupabaseConfigured);
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [setupUrl, setSetupUrl] = useState('');
  const [setupKey, setSetupKey] = useState('');
  const [setupError, setSetupError] = useState('');
  const [workspaceOwnerId, setWorkspaceOwnerId] = useState(null);
  const [profileName, setProfileName] = useState('');
  const [userRole, setUserRole] = useState('owner');
  const [team, setTeam] = useState([]);
  const [form, setForm] = useState({ name: '', category: 'Smartphones', stock: '', price: '', cost: '', email:'', password:'', productId:'', amountPaid:'' });

  useEffect(() => {
    const timer=window.setInterval(()=>setCurrentHour(getLagosHour()),60_000);
    return ()=>window.clearInterval(timer);
  },[]);

  useEffect(() => {
    try { localStorage.setItem('zomo-theme', theme); } catch {}
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  const toggleTheme = () => setTheme(current => current === 'dark' ? 'light' : 'dark');

  useEffect(() => {
    if (!isSupabaseConfigured) return;
    client.auth.getSession().then(({ data }) => { setSession(data.session); setAuthReady(true); });
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, next) => { if (!next) { setProducts([]); setSales([]); setTeam([]); setSimUnits(0); setNinPayments([]); setSimPayments([]); setPaymentEvents([]); setWorkspaceOwnerId(null); setUserRole('owner'); } setSession(next); setAuthReady(true); });
    return () => subscription.unsubscribe();
  }, [client]);

  useEffect(() => {
    if (!isSupabaseConfigured || !authReady || !session) return;
    let cancelled = false;
    (async () => {
      const { data: profile } = await client.from('profiles').select('id, owner_id, role, full_name').eq('id', session.user.id).maybeSingle();
      if (!cancelled && profile) { setUserRole(profile.role); setProfileName(profile.full_name || ''); setWorkspaceOwnerId(profile.role === 'owner' ? profile.id : profile.owner_id); }
      const { data, error } = await client.from('products').select('*').order('created_at', { ascending: false });
      if (!cancelled) {
        if (error) { setCloudState('error'); notify('Could not load your Supabase inventory. Check your project setup and access.'); }
        else { setProducts((data || []).map(p => ({...p,image: p.image || '📦', color: p.color || 'blue', status: p.stock === 0 ? 'Out of stock' : p.stock < 5 ? 'Low stock' : 'In stock', price: Number(p.price) }))); setCloudState('connected'); }
      }
      const { data: reps } = await client.from('profiles').select('*').eq('role', 'sales_rep').eq('active',true);
      if (!cancelled && reps) setTeam(reps.map((p,i) => ({ id:p.id, name:p.full_name, email:p.email, role:'Sales representative', initials:p.full_name.split(' ').map(x=>x[0]).join('').slice(0,2), color:['violet','amber','blue','green'][i%4], sales:0, active:true })));
      const { data: liveSales } = await client.from('sales').select('id, total, amount_paid, quantity, unit_price, status, created_at, customer_name, representative_id, products(name,cost), profiles!sales_representative_profile_fkey(full_name)').order('created_at',{ascending:false}).limit(1000);
      if (!cancelled && liveSales) {
        const recentSales = liveSales.map(formatSale);
        setSales(recentSales);
        setTeam(current => current.map(rep => ({ ...rep, sales: recentSales.filter(s => s.repId === rep.id).reduce((sum,s) => sum + s.amount, 0) })));
      }
      const { data: simStock } = await client.from('sim_network_stock').select('stock');
      if (!cancelled && simStock) setSimUnits(simStock.reduce((sum,row)=>sum+Number(row.stock||0),0));
      await refreshServicePayments();
    })();
    const refreshProducts = () => client.from('products').select('*').order('created_at',{ascending:false}).then(({data})=>data&&setProducts(data.map(p=>({...p,image:p.image||'📦',color:p.color||'blue',status:p.stock===0?'Out of stock':p.stock<5?'Low stock':'In stock',price:Number(p.price)}))));
    const refreshSales = () => client.from('sales').select('id, total, amount_paid, quantity, unit_price, status, created_at, customer_name, representative_id, products(name,cost), profiles!sales_representative_profile_fkey(full_name)').order('created_at',{ascending:false}).limit(1000).then(({data})=>data&&setSales(data.map(formatSale)));
    const refreshSimStock = () => client.from('sim_network_stock').select('stock').then(({data})=>data&&setSimUnits(data.reduce((sum,row)=>sum+Number(row.stock||0),0)));
    const channel = client.channel('zomo-stock-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, refreshProducts)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sales' }, refreshSales)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sim_network_stock' }, refreshSimStock)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'nin_requests' }, refreshServicePayments)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sim_registrations' }, refreshServicePayments)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'payment_transactions' }, refreshServicePayments)
      .subscribe();
    return () => { cancelled=true; client.removeChannel(channel); };
  }, [authReady, session?.user?.id, client]);

  function notify(message) { setToast(message); window.setTimeout(() => setToast(''), 2800); }
  async function refreshServicePayments() {
    if (!client) return;
    const [nin, sim, payments] = await Promise.all([
      client.from('nin_requests').select('id,customer_name,total_amount,amount_paid,status,created_at').order('created_at',{ascending:false}).limit(5000),
      client.from('sim_registrations').select('id,customer_name,network,total_amount,amount_paid,created_at').order('created_at',{ascending:false}).limit(5000),
      client.from('payment_transactions').select('id,record_type,record_id,amount,created_at').order('created_at',{ascending:false}).limit(5000),
    ]);
    if (nin.data) setNinPayments(nin.data);
    if (sim.data) setSimPayments(sim.data);
    if (payments.data) setPaymentEvents(payments.data);
  }
  const filteredProducts = useMemo(() => products.filter(p => (category === 'All products' || (category === 'Low stock' ? p.stock > 0 && p.stock <= 5 : p.status === category)) && p.name.toLowerCase().includes(search.toLowerCase())), [products, category, search]);
  const lowStock = products.filter(p => p.stock <= 5);
  const productUnits = products.reduce((n,p)=>n+Number(p.stock),0);
  const units = productUnits + simUnits;
  const totalValue = products.reduce((n,p)=>n+Number(p.stock)*Number(p.cost || 0),0);
  const totalSales = sales.filter(s=>s.status!=='Cancelled').reduce((n,s)=>n+Number(s.amountPaid||0),0);
  const reportData = useMemo(() => {
    const now = new Date();
    const start = new Date(now);
    if (reportPeriod === 'This week') {
      start.setHours(0,0,0,0);
      start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    } else {
      start.setDate(1);
      start.setHours(0,0,0,0);
    }
    const inPeriod = row => new Date(row.created_at || row.createdAt) >= start && new Date(row.created_at || row.createdAt) <= now;
    return {
      sales:sales.filter(inPeriod).filter(s=>s.status!=='Cancelled'),
      nin:ninPayments.filter(inPeriod),
      sim:simPayments.filter(inPeriod),
      payments:paymentEvents.filter(inPeriod),
    };
  }, [sales, ninPayments, simPayments, paymentEvents, reportPeriod]);
  const periodProductQuantity = reportData.sales.reduce((sum,s)=>sum+s.quantity,0);
  const periodSalesValue = reportData.sales.reduce((sum,s)=>sum+s.amount,0);
  const periodProductPaid = reportData.payments.filter(payment=>payment.record_type==='sale').reduce((sum,payment)=>sum+Number(payment.amount||0),0);
  const periodUnpaid = reportData.sales.reduce((sum,s)=>sum+Math.max(0,s.amount-s.amountPaid),0)
    + reportData.nin.reduce((sum,row)=>sum+Math.max(0,Number(row.total_amount||0)-Number(row.amount_paid||0)),0)
    + reportData.sim.reduce((sum,row)=>sum+Math.max(0,Number(row.total_amount||0)-Number(row.amount_paid||0)),0);
  const periodNinPaid = reportData.payments.filter(payment=>payment.record_type==='nin').reduce((sum,payment)=>sum+Number(payment.amount||0),0);
  const periodSimPaid = reportData.payments.filter(payment=>payment.record_type==='sim').reduce((sum,payment)=>sum+Number(payment.amount||0),0);
  const periodRevenue = periodProductPaid + periodNinPaid + periodSimPaid;
  const categoryBreakdown = ['Smartphones','Laptops','Audio','Wearables','Accessories','Home Appliances','Solar'].map((name,i)=>({name,count:products.filter(p=>p.category===name).reduce((sum,p)=>sum+Number(p.stock),0),tone:['purple','blue','orange','rose','green','blue','orange'][i]}));
  const greeting = currentHour < 12 ? 'Good morning' : currentHour < 17 ? 'Good afternoon' : 'Good evening';
  const topRepresentative = [...team].sort((a,b)=>b.sales-a.sales)[0];
  const accountName = profileName || session?.user?.user_metadata?.full_name || session?.user?.email || 'Account';
  const pageTitle = view === 'Overview' ? 'Stock & sales overview' : view;
  const pageSubtitle = view === 'Overview' ? (userRole==='owner'?'Your company inventory and sales activity.':'Your inventory and the sales you have recorded.') : ({ Inventory:'Manage your products, stock levels and pricing.', Sales:userRole==='owner'?'Review all transactions across your store.':'Review only the sales you have recorded.', 'SIM & NIN':userRole==='owner'?'Manage NIN requests and SIM network stock across the company.':'Submit NIN requests and record customer SIM registrations.', Team:'Manage your sales team and their access.', Reports:'Understand your business performance.', Settings:'View your workspace, access and data connection.' }[view] || 'Stay up to date with your business.');

  async function addProduct(e) {
    e.preventDefault();
    if (!client || !workspaceOwnerId) { notify('Connect and sign in to Supabase before adding products.'); return; }
    const product = { id: Date.now(), name: form.name.trim(), category: form.category, stock: Number(form.stock), price: Number(form.price), cost: Number(form.cost), image: ({Smartphones:'📱',Laptops:'💻',Audio:'🎧',Wearables:'⌚',Accessories:'🔌','Home Appliances':'🏠',Solar:'☀️'}[form.category] || '📦'), color: 'blue', status: Number(form.stock) === 0 ? 'Out of stock' : Number(form.stock) < 5 ? 'Low stock' : 'In stock' };
    const { data, error } = await client.from('products').insert({ owner_id: workspaceOwnerId, name: product.name, category: product.category, stock: product.stock, price: product.price, cost: product.cost, image: product.image }).select().single();
    if (error) { notify(error.message); return; }
    setProducts(p => [{ ...data, id: data.id, image: data.image || product.image, color:'blue', status:data.stock < 5 ? (data.stock===0?'Out of stock':'Low stock'):'In stock', price:Number(data.price) }, ...p]);
    setForm({name:'',category:'Smartphones',stock:'',price:'',cost:''}); setModal(''); notify('Product added to your inventory.');
  }
  async function deleteProduct(product) {
    if (!client) return;
    const { error } = await client.from('products').delete().eq('id', product.id); if(error){notify(error.message);return;}
    setProducts(p=>p.filter(x=>x.id!==product.id)); setMenuOpen(false); notify(`${product.name} removed from inventory.`);
  }
  async function addRep(e) {
    e.preventDefault();
    if (!client) return;
    try {
      const { data, error } = await client.functions.invoke('invite-sales-rep', { body: { fullName: form.name.trim(), email: form.email.trim(), password: form.password } });
      if (error) {
        let message = error.message || 'Could not add the sales representative.';
        try {
          const details = await error.context?.clone?.().json();
          if (details?.error || details?.message) message = details.error || details.message;
        } catch {}
        notify(message);
        return;
      }
      if (!data?.id) { notify('The invitation service did not return a new team member. Please try again.'); return; }
      setTeam(t=>[...t,{ id:data.id, name:form.name.trim(), email:form.email.trim(), role:'Sales representative', initials:form.name.trim().split(' ').map(x=>x[0]).join('').slice(0,2).toUpperCase(), color:'blue', sales:0, active:true }]);
      setForm({name:'',email:'',password:''}); setModal(''); notify('Sales representative added.');
    } catch (error) {
      notify(error?.message || 'Could not reach the invitation service. Check your connection and try again.');
    }
  }
  async function recordSale(e) {
    e.preventDefault();
    if (!client) return;
    const product = products.find(p => String(p.id) === form.productId);
    if (!product || Number(form.stock) < 1 || Number(form.stock) > product.stock) { notify('Enter a sale quantity available in stock.'); return; }
    const quantity=Number(form.stock);
    const saleTotal=Number(product.price)*quantity;
    const amountPaid=form.amountPaid==null||form.amountPaid===''?saleTotal:Number(form.amountPaid);
    if(!Number.isFinite(amountPaid)||amountPaid<0||amountPaid>saleTotal){notify('Amount received must be between zero and the sale total.');return;}
    const { data, error } = await client.rpc('record_sale', { p_product_id: product.id, p_quantity: quantity, p_customer_name: form.name.trim() || null, p_amount_paid: amountPaid });
    if (error) { notify(error.message); return; }
    setProducts(ps=>ps.map(p=>p.id===product.id?{...p,stock:p.stock-Number(form.stock),status:p.stock-Number(form.stock)===0?'Out of stock':p.stock-Number(form.stock)<5?'Low stock':'In stock'}:p));
    setSales(ss=>[{rawId:data.id,id:`#${String(data.id).slice(0,8).toUpperCase()}`,initials:(form.name.trim()||'Walk-in').split(' ').map(x=>x[0]).join('').slice(0,2).toUpperCase(),name:form.name.trim()||'Walk-in customer',product:product.name,amount:saleTotal,amountPaid,quantity,unitPrice:Number(product.price),productCost:Number(product.cost||0),status:amountPaid>=saleTotal?'Completed':'Pending',time:'Just now',createdAt:new Date().toISOString(),repId:session.user.id,rep:accountName,color:'violet'},...ss]);
    setForm({name:'',stock:'',productId:'',amountPaid:''});setModal('');notify(amountPaid>=saleTotal?'Sale recorded and fully paid. Stock updated.':'Sale recorded. The unpaid balance is in the report. Stock updated.');
  }
  async function addSalePayment(e) {
    e.preventDefault();
    const amount=Number(paymentAmount);
    if(!paymentTarget||!Number.isFinite(amount)||amount<=0||amount>paymentTarget.balance){notify('Enter a payment that is greater than zero and no more than the balance.');return;}
    const {error}=await client.rpc('record_customer_payment',{p_record_type:'sale',p_record_id:paymentTarget.rawId,p_amount:amount});
    if(error){notify(error.message);return;}
    setPaymentTarget(null);setPaymentAmount('');
    const {data,refreshError}=await client.from('sales').select('id,total,amount_paid,quantity,unit_price,status,created_at,customer_name,representative_id,products(name,cost),profiles!sales_representative_profile_fkey(full_name)').order('created_at',{ascending:false}).limit(1000);
    if(refreshError)notify(`Payment saved, but sales could not refresh: ${refreshError.message}`);
    else if(data)setSales(data.map(formatSale));
    await refreshServicePayments();notify('Payment saved and balance updated.');
  }
  async function signIn(e) {
    e.preventDefault();
    if (!client) return;
    setAuthBusy(true); const { error }=await client.auth.signInWithPassword({email:authEmail,password:authPassword});setAuthBusy(false);if(error)notify(error.message);
  }
  async function signOut() {
    setModal('');
    if (client) await client.auth.signOut();
  }
  function connectProject(e) {
    e.preventDefault();
    try { const nextClient=saveSupabaseProject(setupUrl,setupKey); setClient(nextClient); setCloudState('connecting'); setSetupError(''); }
    catch(error) { setSetupError(error.message); }
  }
  async function deleteRep(rep) {
    if (!client) return;
    const { error }=await client.rpc('admin_remove_sales_rep',{rep_user_id:rep.id});if(error){notify(error.message);return;}
    setTeam(t=>t.filter(x=>x.id!==rep.id)); setMenuOpen(false); notify(`${rep.name} removed from the team.`);
  }
  function downloadReport() {
    const csv = [['Product','Category','Stock','Price','Stock value'],...products.map(p=>[p.name,p.category,p.stock,p.price,p.stock*p.price])].map(row=>row.map(x=>`"${String(x).replaceAll('"','""')}"`).join(',')).join('\r\n');
    const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download='zomo-inventory-report.csv';a.click();URL.revokeObjectURL(a.href);notify('Inventory report downloaded.');
  }
  function downloadSalesReport() {
    const rows=[['Type','Date','Customer','Product or service','Network','Quantity','Sale amount / fee (₦)','Money received (₦)','Money still unpaid (₦)','Status']];
    const productTotals=new Map();
    reportData.sales.forEach(s=>{
      const paid=reportData.payments.filter(p=>p.record_type==='sale'&&p.record_id===s.rawId).reduce((n,p)=>n+Number(p.amount||0),0);
      const item=productTotals.get(s.product)||{quantity:0,amount:0,received:0,unpaid:0};
      item.quantity+=s.quantity; item.amount+=s.amount; item.received+=paid; item.unpaid+=Math.max(0,s.amount-s.amountPaid);
      productTotals.set(s.product,item);
    });
    rows.push(['PRODUCT TOTALS',reportPeriod,'','','','','','','','']);
    productTotals.forEach((item,product)=>rows.push(['Product total',reportPeriod,'',product,'',item.quantity,item.amount,item.received,item.unpaid,'']));
    rows.push(['TRANSACTIONS','','','','','','','','','']);
    reportData.sales.forEach(s=>rows.push(['Product sale',new Date(s.createdAt).toLocaleDateString('en-NG'),s.name,s.product,'',s.quantity,s.amount,'',Math.max(0,s.amount-s.amountPaid),s.status]));
    reportData.nin.forEach(r=>rows.push(['NIN registration',new Date(r.created_at).toLocaleDateString('en-NG'),r.customer_name,'NIN registration','',1,Number(r.total_amount||0),'',Math.max(0,Number(r.total_amount||0)-Number(r.amount_paid||0)),r.status]));
    reportData.sim.forEach(r=>rows.push(['SIM registration',new Date(r.created_at).toLocaleDateString('en-NG'),r.customer_name,`${r.network} SIM registration`,r.network,1,Number(r.total_amount||0),'',Math.max(0,Number(r.total_amount||0)-Number(r.amount_paid||0)),'Recorded']));
    const customerByKey=new Map([...ninPayments.map(r=>[`nin:${r.id}`,r.customer_name]),...simPayments.map(r=>[`sim:${r.id}`,r.customer_name]),...reportData.sales.map(r=>[`sale:${r.rawId}`,r.name])]);
    reportData.payments.forEach(p=>rows.push(['Payment received',new Date(p.created_at).toLocaleDateString('en-NG'),customerByKey.get(`${p.record_type}:${p.record_id}`)||'Customer',`${p.record_type.toUpperCase()} payment`,'','', '',Number(p.amount||0),'','Received']));
    rows.push(['TOTALS','','','','',periodProductQuantity,periodSalesValue,periodRevenue,periodUnpaid,'']);
    rows.push(['NIN payments','','','','','','',periodNinPaid,'','']);
    rows.push(['SIM payments','','','','','','',periodSimPaid,'','']);
    const csv=rows.map(row=>row.map(value=>`"${String(value??'').replaceAll('"','""')}"`).join(',')).join('\r\n');
    const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download=`zomo-${reportPeriod==='This week'?'weekly':'monthly'}-business-report.csv`;a.click();URL.revokeObjectURL(a.href);notify(`${reportPeriod} business report downloaded.`);
  }

  const authScreenOpen = !isSupabaseConfigured || (authReady && !session);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    if (authScreenOpen) document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; };
  }, [authScreenOpen]);

  return <div className={`app-shell ${theme === 'dark' ? 'dark-mode' : ''} ${authScreenOpen ? 'auth-open' : ''}`}>
    {mobileOpen && <button className="mobile-scrim" onClick={()=>setMobileOpen(false)} aria-label="Close menu" />}
    <aside className={`sidebar ${mobileOpen?'sidebar-open':''}`}>
      <div className="brand"><div className="brand-mark"><span>z</span><span>.</span></div><div className="brand-type">ZOMO<span>ADVANCED TECHNOLOGIES</span></div><button className="sidebar-close" onClick={()=>setMobileOpen(false)}><X size={16}/></button></div>
      <div className="workspace"><div className="workspace-icon"><Monitor size={17}/></div><div className="workspace-meta"><span>WORKSPACE</span><strong>ZOMO Advanced Technologies</strong></div><ChevronDown size={15} className="workspace-chevron"/></div>
      <div className="side-nav">{navGroups.map(group=><div key={group.label}><div className="nav-label">{group.label}</div>{group.items.filter(([label])=>label!=='Team'||userRole==='owner').map(([label,Icon])=><button key={label} className={`nav-item ${view===label?'active':''}`} onClick={()=>{setView(label);setMobileOpen(false)}}><Icon size={17}/><span>{label}</span>{label==='Inventory'&&<span className="nav-count">{products.length}</span>}</button>)}</div>)}</div>
      <div className="sidebar-bottom"><div className="help-card"><div className="help-icon"><CircleHelp size={17}/></div><div><strong>Need a hand?</strong><span>We’re here for you.</span></div><ArrowUpRight size={15} className="help-arrow"/></div><button className="profile-card" onClick={()=>setModal('profile')}><div className="avatar admin-avatar">{accountName.slice(0,2).toUpperCase()}</div><div className="profile-info"><strong>{accountName}</strong><span>{userRole==='owner'?'Workspace owner':'Sales representative'}</span></div><MoreHorizontal size={19} className="profile-menu"/></button><button className="profile-signout" onClick={signOut}><LogOut size={14}/> Sign out</button><div className="sidebar-footer"><ShieldCheck size={12}/> Secured & powered by ZOMO</div></div>
    </aside>

    <main className="main-shell">
      <header className="topbar"><div className="breadcrumb"><button className="mobile-menu" onClick={()=>setMobileOpen(true)} aria-label="Open navigation"><Menu size={20}/></button><span>Workspace</span><ChevronRight size={14}/><strong>{view}</strong></div><div className="topbar-actions"><div className={`sync-status ${cloudState}`}><span/>{cloudState==='connected'?'Connected to cloud':cloudState==='connecting'?'Connecting…':cloudState==='error'?'Connection issue':'Setup required'}</div><span className="topbar-separator"/><span className="today"><CalendarDays size={15}/>{new Intl.DateTimeFormat('en-NG',{day:'2-digit',month:'short',year:'numeric'}).format(new Date())}</span><ThemeToggle theme={theme} onToggle={toggleTheme}/><button className={`icon-button notif-button ${notificationsOpen?'selected':''}`} onClick={()=>setNotificationsOpen(!notificationsOpen)} aria-label="Notifications"><Bell size={17}/>{lowStock.length>0&&<span className="notif-dot"/>}</button>{notificationsOpen&&<div className="notifications"><div className="notif-title"><strong>Notifications</strong><span>{lowStock.length} new</span></div>{lowStock.length?lowStock.slice(0,4).map(p=><div className="notif-row" key={p.id}><span className={`notif-symbol ${p.stock===0?'red':''}`}><Package size={15}/></span><span><strong>{p.name}</strong><small>{p.stock===0?'Out of stock':`Only ${p.stock} units remaining`}</small></span></div>):<div className="notif-empty"><Check size={18}/>Everything is looking good.</div>}<button className="notif-link" onClick={()=>{setView('Inventory');setNotificationsOpen(false)}}>View inventory <ArrowRight size={14}/></button></div>}<button className="topbar-avatar" onClick={()=>setModal('profile')} aria-label="Account settings">{accountName.slice(0,2).toUpperCase()}</button></div></header>

      <section className="content"><div className="page-heading"><div><div className="eyebrow"><Sparkles size={12}/> ZOMO ADVANCED TECHNOLOGIES</div><h1>{view==='Overview'?<>{greeting}, <span>{accountName.split(' ')[0].split('@')[0]}</span></>:pageTitle}</h1><p>{pageSubtitle}</p></div><div className="heading-actions">{((view==='Overview')||(view==='Inventory'&&userRole==='owner')||(view==='Team'&&userRole==='owner'))&&<button className="button button-primary" onClick={()=>{setForm({name:'',category:'Smartphones',stock:'',price:'',cost:'',email:'',password:'',productId:'',amountPaid:''});setModal(view==='Team'?'rep':view==='Overview'&&userRole!=='owner'?'sale':'product')}}>{view==='Overview'&&userRole!=='owner'?<CreditCard size={15}/>:<Plus size={16}/ >}{view==='Team'?'Add team member':view==='Overview'&&userRole!=='owner'?'Record sale':'Add product'}</button>}</div></div>

        {view==='Overview'&&<><div className="metrics-grid"><Metric label="Product types" value={products.length.toLocaleString()} meta="Items added to inventory" icon={<Package size={18}/>} tone="purple" trend="Live count"/><Metric label="Stock on hand" value={units.toLocaleString()} meta={`Gadgets ${productUnits.toLocaleString()} · SIMs ${simUnits.toLocaleString()}`} icon={<Boxes size={18}/>} tone="blue" trend="Available units"/><Metric label="Inventory value" value={money(totalValue)} meta="Gadget purchase cost recorded" icon={<Wallet size={18}/>} tone="green" trend="Current value"/><Metric label={userRole==='owner'?'Recorded sales':'Your recorded sales'} value={money(totalSales)} meta={userRole==='owner'?'Latest transactions':'Only your transactions'} icon={<TrendingUp size={18}/>} tone="orange" trend={`${sales.length} transactions`}/></div>
          <div className="overview-grid"><section className="panel sales-panel"><div className="panel-header"><div><h2>{userRole==='owner'?'Sales overview':'Your sales overview'}</h2><p>{userRole==='owner'?'Completed sales from the whole team.':'Completed sales recorded by you.'}</p></div><select className="subtle-select" value={period} onChange={e=>setPeriod(e.target.value)}><option>Last 7 days</option><option>Last 30 days</option></select></div><div className="chart-legend"><span><i className="legend-dot blue-dot"/>Sales</span><div className="chart-total"><strong>{money(totalSales)}</strong><span className="chart-period">in {period.toLowerCase()}</span></div></div><SalesChart sales={sales.filter(s=>s.status==='Completed')} period={period}/></section>
          <section className="panel stock-panel"><div className="panel-header"><div><h2>Gadget stock by category</h2><p>Products currently recorded in your catalog.</p></div><button className="more-button" aria-label="Open inventory" onClick={()=>setView('Inventory')}><Ellipsis size={20}/></button></div>{productUnits>0?<><div className="category-overview">{categoryBreakdown.map(({name,count,tone})=>{const pct=Math.round(count/productUnits*100);return <div className="category-row" key={name}><div className={`category-icon ${tone}`}><Package size={16}/></div><div className="category-details"><div><strong>{name}</strong><span>{count.toLocaleString()} units</span></div><div className="progress-track"><span className={tone} style={{width:`${pct}%`}}/></div></div><strong className="category-percent">{pct}%</strong></div>})}</div><button className="text-link" onClick={()=>setView('Inventory')}>View inventory <ArrowRight size={14}/></button></>:<div className="category-empty"><Package size={20}/><span>No gadget stock recorded yet.<br/>Add the products you have in hand to see them here.</span></div>}</section></div>
          <section className="panel table-panel"><div className="panel-header table-heading"><div><h2>{userRole==='owner'?'Recent sales':'Your recent sales'}</h2><p>{userRole==='owner'?'Recent transactions from the whole team.':'Only sales you recorded are shown here.'}</p></div><button className="text-link" onClick={()=>setView('Sales')}>View all sales <ArrowRight size={14}/></button></div><SalesTable sales={sales.slice(0,4)} /></section>
          <div className="dashboard-bottom"><section className="panel low-stock-panel"><div className="panel-header"><div><div className="title-inline"><h2>Low stock alerts</h2><span className="alert-count">{lowStock.length} alerts</span></div><p>Products that need your attention.</p></div><button className="more-button" aria-label="Open inventory" onClick={()=>setView('Inventory')}><Ellipsis size={20}/></button></div>{lowStock.length?lowStock.slice(0,3).map(p=><div className="low-stock-row" key={p.id}><div className={`product-thumb ${p.color}`}>{p.image}</div><div className="low-stock-name"><strong>{p.name}</strong><span>{p.category}</span></div><div className="stock-indicator"><span className={p.stock===0?'stock-zero':'stock-low'}/><span>{p.stock===0?'Out of stock':`${p.stock} left`}</span></div></div>):<div className="all-good"><Check size={17}/>{products.length?'No low-stock products.':'No products have been added yet.'}</div>}{products.length>0&&<button className="text-link low-stock-link" onClick={()=>{setView('Inventory');setCategory('Low stock')}}>View all alerts <ArrowRight size={14}/></button>}</section>
            <section className="team-spotlight"><div className="team-spotlight-top"><span>{userRole==='owner'?'SALES TEAM':'YOUR SALES PROFILE'}</span>{userRole==='owner'&&<button onClick={()=>setView('Team')}>Manage team <ArrowRight size={14}/></button>}</div>{team.length?<><div className="team-spotlight-main"><div><div className="avatar-stack">{userRole==='owner'&&team.slice(0,4).map(x=><div key={x.id} className={`avatar sm ${x.color}`}>{x.initials}</div>)}</div><p><strong>{userRole==='owner'?`${team.length} sales representatives`:'Sales representative'}</strong><br/>{userRole==='owner'?'in this workspace':'your account'}</p></div><div className="team-spotlight-stat"><span>{userRole==='owner'?'Top recorded sales':'Your recorded sales'}</span><strong>{topRepresentative?.name.split(' ')[0]}</strong><small>{money(topRepresentative?.sales||0)} in latest transactions</small></div></div></>:<div className="team-empty"><Users size={22}/><span>{userRole==='owner'?'No sales representatives added yet.':'Your sales profile is not linked yet.'}</span></div>}</section></div>
        </>}

        {view==='Inventory'&&<section className="panel full-table-panel"><div className="inventory-toolbar"><div className="filter-tabs">{['All products','In stock','Low stock','Out of stock'].map(x=><button key={x} className={category===x?'filter-active':''} onClick={()=>setCategory(x)}>{x}{x==='All products'&&<span>{products.length}</span>}</button>)}</div><div className="table-tools"><label className="search-box"><Search size={15}/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search products..."/><kbd>⌘ K</kbd></label><button className="filter-button" onClick={downloadReport}><ArrowDownToLine size={15}/> Export</button>{userRole==='owner'&&<button className="button button-primary" onClick={()=>{setForm({name:'',category:'Smartphones',stock:'',price:'',cost:''});setModal('product')}}><Plus size={15}/> Add product</button>}</div></div><ProductTable products={filteredProducts} onDelete={deleteProduct} canDelete={userRole==='owner'}/></section>}
        {view==='Sales'&&<section className="panel full-table-panel"><div className="inventory-toolbar"><div className="table-view-heading"><h2>{userRole==='owner'?'All transactions':'Your transactions'}</h2><span>{sales.length} total</span></div><div className="table-tools"><label className="search-box"><Search size={15}/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search sales..."/></label><button className="filter-button" onClick={downloadSalesReport}><ArrowDownToLine size={15}/> Export report</button><button className="button button-primary" onClick={()=>{setForm({name:'',stock:'',productId:'',amountPaid:''});setModal('sale')}}><Plus size={15}/> Record sale</button></div></div><SalesTable sales={sales.filter(s=>`${s.id} ${s.name} ${s.product}`.toLowerCase().includes(search.toLowerCase()))} all onAddPayment={setPaymentTarget}/></section>}
        {view==='SIM & NIN'&&<ServicesView client={client} session={session} workspaceOwnerId={workspaceOwnerId} userRole={userRole} notify={notify}/>}
        {view==='Team'&&(userRole==='owner'?<TeamView team={team} salesCount={sales.length} setModal={setModal} setForm={setForm} deleteRep={deleteRep} notify={notify}/>:<AccessPanel/>)}
        {view==='Reports'&&<section className="reports-grid"><div className="report-intro"><div className="report-icon"><FileBarChart size={20}/></div><div><h2>Business reports</h2><p>Product sales, service payments and outstanding balances for the selected period.</p></div><button className="button button-primary" onClick={downloadSalesReport}><Download size={15}/> Download report</button></div><div className="report-period-control"><span>Report period</span><div role="group" aria-label="Sales report period"><button className={reportPeriod==='This week'?'selected':''} onClick={()=>setReportPeriod('This week')}>Weekly</button><button className={reportPeriod==='This month'?'selected':''} onClick={()=>setReportPeriod('This month')}>Monthly</button></div></div><div className="report-cards"><ReportCard label="Product quantity sold" value={periodProductQuantity.toLocaleString()} caption="Units sold this period" icon={<Package size={17}/>} tone="orange"/><ReportCard label="Gadget sales value" value={money(periodSalesValue)} caption="Value of products sold" icon={<Wallet size={17}/>} tone="blue"/><ReportCard label="Total money received" value={money(periodRevenue)} caption="Payments collected this period" icon={<TrendingUp size={17}/>} tone="green"/><ReportCard label="Money still unpaid" value={money(periodUnpaid)} caption="Open balances on this period’s sales and services" icon={<CreditCard size={17}/>} tone="purple"/><ReportCard label="NIN money received" value={money(periodNinPaid)} caption="NIN payments collected this period" icon={<ClipboardList size={17}/>} tone="blue"/><ReportCard label="SIM money received" value={money(periodSimPaid)} caption="SIM payments collected this period" icon={<Smartphone size={17}/>} tone="orange"/><ReportCard label="Current stock value" value={money(totalValue)} caption="Recorded gadget purchase cost" icon={<Boxes size={17}/>} tone="green"/><ReportCard label="Products to reorder" value={lowStock.length} caption="Low or out of stock" icon={<Package size={17}/>} tone="purple"/></div><section className="panel table-panel"><div className="panel-header"><div><h2>Inventory valuation</h2><p>Calculated from each product’s recorded purchase cost. Stock on hand includes available SIMs.</p></div></div><div className="valuation-list">{categoryBreakdown.map(({name,count,tone})=>{const items=products.filter(p=>p.category===name);const value=items.reduce((s,p)=>s+Number(p.stock)*Number(p.cost||0),0);return <div key={name} className="valuation-row"><span className={`valuation-dot ${tone}`}/><strong>{name}</strong><span>{count.toLocaleString()} units</span><div className="valuation-bar"><i style={{width:`${productUnits?Math.max(count/productUnits*100,0):0}%`}}/></div><b>{money(value)}</b></div>})}</div></section></section>}
        {view==='Settings'&&<SettingsView isConfigured={isSupabaseConfigured} cloudState={cloudState} setView={setView} signOut={signOut}/>}
      </section>
      <footer className="app-footer"><span>© 2026 ZOMO ADVANCED TECHNOLOGIES LIMITED</span><span><ShieldCheck size={12}/> Secure inventory management</span><span>Made for ambitious businesses <span className="footer-heart">✳</span></span></footer>
    </main>

    {modal==='product'&&<Modal title="Add a product" subtitle="Enter the product details to add it to your inventory." onClose={()=>setModal('')}><form className="modal-form" onSubmit={addProduct}><label>Product name<input required maxLength="120" placeholder="e.g. iPhone 16 Pro Max" value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/></label><label>Category<select value={form.category} onChange={e=>setForm({...form,category:e.target.value})}>{['Smartphones','Laptops','Audio','Wearables','Accessories','Home Appliances','Solar'].map(x=><option key={x}>{x}</option>)}</select></label><div className="form-row"><label>Opening stock<input required min="0" type="number" placeholder="0" value={form.stock} onChange={e=>setForm({...form,stock:e.target.value})}/></label><label>Selling price (₦)<input required min="0" type="number" placeholder="0.00" value={form.price} onChange={e=>setForm({...form,price:e.target.value})}/></label></div><label>Purchase cost per unit (₦)<input required min="0" type="number" placeholder="0.00" value={form.cost} onChange={e=>setForm({...form,cost:e.target.value})}/></label><div className="form-footnote"><ShieldCheck size={14}/> Stock value and product margins use this purchase cost.</div><div className="modal-actions"><button type="button" className="button button-ghost" onClick={()=>setModal('')}>Cancel</button><button className="button button-primary"><Plus size={15}/> Add product</button></div></form></Modal>}
    {modal==='rep'&&<Modal title="Add a sales representative" subtitle="Give a team member access to the sales workspace." onClose={()=>setModal('')}><form className="modal-form" onSubmit={addRep}><label>Full name<input required maxLength="120" placeholder="e.g. Tobi Olanrewaju" value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/></label><label>Email address<input required type="email" placeholder="name@example.com" value={form.email} onChange={e=>setForm({...form,email:e.target.value})}/></label><label>Temporary password<PasswordInput required minLength="8" autoComplete="new-password" placeholder="At least 8 characters" value={form.password} onChange={e=>setForm({...form,password:e.target.value})}/></label><div className="form-footnote"><ShieldCheck size={14}/> This person can record sales and view inventory.</div><div className="modal-actions"><button type="button" className="button button-ghost" onClick={()=>setModal('')}>Cancel</button><button className="button button-primary"><Plus size={15}/> Add team member</button></div></form></Modal>}
    {modal==='sale'&&<Modal title="Record a sale" subtitle="Select a product and quantity. Stock will be reduced automatically." onClose={()=>setModal('')}><form className="modal-form" onSubmit={recordSale}><label>Product<select required value={form.productId} onChange={e=>setForm({...form,productId:e.target.value})}><option value="">Select a product</option>{products.filter(p=>p.stock>0).map(p=><option key={p.id} value={p.id}>{p.name} · {p.stock} available · {money(p.price)}</option>)}</select></label><div className="form-row"><label>Quantity<input required min="1" max={products.find(p=>String(p.id)===form.productId)?.stock||undefined} type="number" placeholder="1" value={form.stock} onChange={e=>setForm({...form,stock:e.target.value})}/></label><label>Customer name<input maxLength="120" placeholder="Optional" value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/></label></div>{form.productId&&form.stock&&<div className="sale-total">Sale total <strong>{money((products.find(p=>String(p.id)===form.productId)?.price||0)*Number(form.stock))}</strong></div>}<label>Amount received (₦)<input min="0" step="0.01" type="number" placeholder="Leave blank if paid in full" value={form.amountPaid??''} onChange={e=>setForm({...form,amountPaid:e.target.value})}/></label><div className="form-footnote"><ShieldCheck size={14}/> Leave amount blank for full payment. Any balance remains marked Pending.</div><div className="modal-actions"><button type="button" className="button button-ghost" onClick={()=>setModal('')}>Cancel</button><button className="button button-primary"><Check size={15}/> Save sale</button></div></form></Modal>}
    {paymentTarget&&<Modal title="Add sale payment" subtitle={`Balance remaining: ${money(paymentTarget.balance)}. The collection is reported on the date received.`} onClose={()=>setPaymentTarget(null)}><form className="modal-form" onSubmit={addSalePayment}><label>Amount received now (₦)<input autoFocus required min="0.01" max={paymentTarget.balance} step="0.01" type="number" value={paymentAmount} onChange={e=>setPaymentAmount(e.target.value)} placeholder="Amount received"/></label><div className="modal-actions"><button type="button" className="button button-ghost" onClick={()=>setPaymentTarget(null)}>Cancel</button><button className="button button-primary"><Check size={15}/> Save payment</button></div></form></Modal>}
    {modal==='profile'&&<Modal title="Your account" subtitle="Account and access for this ZOMO workspace." onClose={()=>setModal('')}><div className="profile-details"><div className="avatar admin-avatar large">{accountName.slice(0,2).toUpperCase()}</div><div><strong>{session?.user?.email||'Account'}</strong><p>{userRole==='owner'?'Workspace owner':'Sales representative'}</p></div></div><div className="account-hint"><ShieldCheck size={17}/><span><strong>{userRole==='owner'?'Owner permissions':'Representative access'}</strong><br/>{userRole==='owner'?'Full access to inventory, sales and team management.':'You can record sales and view your workspace inventory.'}</span></div><div className="modal-actions"><button className="button button-ghost" onClick={signOut}><LogOut size={14}/> Sign out</button><button className="button button-ghost" onClick={()=>setModal('')}>Close</button></div></Modal>}
    {authScreenOpen && <div className="auth-screen"><ThemeToggle theme={theme} onToggle={toggleTheme} className="auth-theme-toggle"/><div className={`auth-card ${!isSupabaseConfigured?'setup-card':''}`}><div className="brand-mark"><span>z</span><span>.</span></div><span className="auth-kicker">ZOMO ADVANCED TECHNOLOGIES</span>{!isSupabaseConfigured?<><h1>Connect your stockroom</h1><p>Link a Supabase project to store your company’s stock, sales, and team accounts securely.</p><ol className="setup-steps"><li><span>1</span><div><strong>Create your Supabase project</strong><a href="https://supabase.com/dashboard" target="_blank" rel="noreferrer">Open Supabase Dashboard <ArrowUpRight size={13}/></a></div></li><li><span>2</span><div><strong>Copy your project details</strong><small>In your project, open Connect or Settings → API Keys. Copy the Project URL and publishable key.</small></div></li><li><span>3</span><div><strong>Create the database tables</strong><small>Open SQL Editor in Supabase, paste <code>supabase/schema.sql</code> or <a href="/zomo-stock-schema.sql" download>download the setup SQL</a>, then click Run.</small></div></li><li><span>4</span><div><strong>Set up your owner account</strong><small>In Authentication → Users, add your email and password. Then follow the owner profile SQL instructions at the end of schema.sql.</small></div></li></ol><form className="modal-form setup-form" onSubmit={connectProject}><label>Project URL<input required type="url" placeholder="https://your-project.supabase.co" value={setupUrl} onChange={e=>setSetupUrl(e.target.value)}/></label><label>Publishable key<PasswordInput revealLabel="key" required autoComplete="off" placeholder="sb_publishable_…" value={setupKey} onChange={e=>setSetupKey(e.target.value)}/></label>{setupError&&<div className="setup-error">{setupError}</div>}<button className="button button-primary auth-submit"><ArrowRight size={15}/> Connect project</button></form><div className="auth-security"><ShieldCheck size={14}/>Use the publishable key only. Never enter a secret or service_role key here.</div></>:<><h1>Welcome back</h1><p>Sign in to manage your stock and sales.</p><form className="modal-form" onSubmit={signIn}><label>Email address<input type="email" required autoComplete="username" placeholder="you@example.com" value={authEmail} onChange={e=>setAuthEmail(e.target.value)}/></label><label>Password<PasswordInput required autoComplete="current-password" placeholder="Your password" value={authPassword} onChange={e=>setAuthPassword(e.target.value)}/></label>{toast&&<div className="setup-error">{toast}</div>}<button className="button button-primary auth-submit" disabled={authBusy}>{authBusy?<LoaderCircle size={15} className="spin"/>:<ArrowRight size={15}/>} Sign in securely</button></form></>}</div></div>}
    {toast&&<div className="toast"><Check size={16}/>{toast}</div>}
  </div>;
}

function Metric({label,value,meta,icon,tone,trend,up}){return <article className="metric-card"><div className="metric-top"><span>{label}</span><span className={`metric-icon ${tone}`}>{icon}</span></div><div className="metric-value">{value}</div><div className="metric-bottom"><span>{meta}</span><span className={`metric-trend ${up?'trend-up':''}`}>{up&&<ArrowUpRight size={13}/>} {trend}</span></div></article>}

function SalesChart({sales,period}){const days=period==='Last 7 days'?7:30;const today=new Date();today.setHours(23,59,59,999);const firstDay=new Date(today);firstDay.setDate(today.getDate()-days+1);firstDay.setHours(0,0,0,0);const values=Array(days).fill(0);sales.forEach(s=>{const index=Math.floor((new Date(s.createdAt)-firstDay)/86400000);if(index>=0&&index<days)values[index]+=Number(s.amount)||0});if(!sales.length)return <div className="chart-empty"><TrendingUp size={20}/><span>No sales recorded in this period yet.</span></div>;const max=Math.max(...values,1);const path=values.map((v,i)=>`${i?'L':'M'} ${(i/(days-1))*640} ${130-(v/max)*95}`).join(' ');const labelIndexes=days===7?[0,1,2,3,4,5,6]:[0,5,10,15,20,25,29];const labels=labelIndexes.map(i=>new Intl.DateTimeFormat('en',{weekday:days===7?'short':undefined,day:days===30?'numeric':undefined}).format(new Date(firstDay.getTime()+i*86400000)));return <div className="chart-wrap"><svg className="sales-chart" viewBox="0 0 660 165" preserveAspectRatio="none" role="img" aria-label={`Recorded sales for the ${period.toLowerCase()}`}><defs><linearGradient id="areaFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#6275ef" stopOpacity=".19"/><stop offset="100%" stopColor="#6275ef" stopOpacity="0"/></linearGradient><linearGradient id="lineFill" x1="0" x2="1" y1="0" y2="0"><stop offset="0%" stopColor="#8e7af2"/><stop offset="100%" stopColor="#5268df"/></linearGradient></defs>{[31,64,97,130].map(y=><line key={y} x1="0" y1={y} x2="655" y2={y} stroke="#eef0f5" strokeWidth="1" strokeDasharray={y===130?'0':'3 5'}/>)}<path d={`${path} L 640 145 L 0 145 Z`} fill="url(#areaFill)"/><path d={path} transform="translate(0 13)" fill="none" stroke="url(#lineFill)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"/></svg><div className="chart-x-labels">{labels.map((d,i)=><span key={`${d}-${i}`}>{d}</span>)}</div></div>}

function SalesTable({sales,all=false,onAddPayment}){return <div className="table-scroll"><table className="data-table"><thead><tr><th>ORDER ID</th><th>CUSTOMER</th><th>PRODUCT</th><th>AMOUNT</th><th>PAID</th><th>UNPAID</th><th>STATUS</th><th>{all?'REPRESENTATIVE':'TIME'}</th>{all&&<th/>}</tr></thead><tbody>{sales.map(s=><tr key={s.id}><td><strong className="order-id">{s.id}</strong></td><td><div className="customer-cell"><div className={`avatar xs ${s.color}`}>{s.initials}</div><strong>{s.name}</strong></div></td><td className="muted-cell">{s.product}</td><td><strong>{money(s.amount)}</strong></td><td>{money(s.amountPaid)}</td><td>{money(Math.max(0,s.amount-s.amountPaid))}</td><td><span className={`status-pill ${s.status==='Completed'?'completed':s.status==='Cancelled'?'out':'pending'}`}><i/> {s.status}</span></td><td className="muted-cell">{all?(s.rep||'Sales representative'):s.time}</td>{all&&<td>{s.amount>s.amountPaid&&<button className="button button-ghost compact" onClick={()=>onAddPayment?.({...s,balance:s.amount-s.amountPaid})}><Wallet size={14}/> Add payment</button>}</td>}</tr>)}</tbody></table>{sales.length===0&&<EmptyState icon={<CreditCard size={22}/>} title="No sales found" text="Your sales will appear here after transactions are recorded."/>}</div>}

function ProductTable({products,onDelete,canDelete}){const [open,setOpen]=useState(null);return <div className="table-scroll"><table className="data-table product-table"><thead><tr><th>PRODUCT</th><th>CATEGORY</th><th>UNIT PRICE</th><th>STOCK LEVEL</th><th>STATUS</th><th/></tr></thead><tbody>{products.map(p=><tr key={p.id}><td><div className="product-cell"><div className={`product-thumb ${p.color}`}>{p.image}</div><div><strong>{p.name}</strong><span>Product</span></div></div></td><td className="muted-cell">{p.category}</td><td><strong>{money(p.price)}</strong></td><td><strong>{p.stock} <span className="muted-cell">units</span></strong></td><td><span className={`status-pill ${p.stock===0?'out':p.stock<=5?'pending':'completed'}`}><i/>{p.stock===0?'Out of stock':p.stock<=5?'Low stock':'In stock'}</span></td><td className="action-cell">{canDelete&&<><button className="more-button small-more" aria-label={`Options for ${p.name}`} onClick={()=>setOpen(open===p.id?null:p.id)}><MoreHorizontal size={18}/></button>{open===p.id&&<div className="row-menu"><button className="delete-action" onClick={()=>{onDelete(p);setOpen(null)}}><X size={14}/> Delete product</button></div>}</>}</td></tr>)}</tbody></table>{products.length===0&&<EmptyState icon={<Package size={22}/>} title="No products found" text="Your inventory will appear here after products are added."/>}</div>}

function TeamView({team,salesCount,setModal,setForm,deleteRep,notify}){const [open,setOpen]=useState(null);return <><div className="team-metrics"><div className="team-summary"><span>YOUR SALES TEAM</span><strong>{team.length}<small> members</small></strong><p>All team members report to the workspace owner.</p></div><div className="team-summary"><span>RECORDED REP SALES</span><strong>{money(team.reduce((s,x)=>s+x.sales,0))}</strong><p>Across the latest loaded transactions.</p></div><div className="team-summary"><span>SALES TRANSACTIONS</span><strong>{salesCount}</strong><p>Latest transactions in this workspace.</p></div></div><section className="panel full-table-panel"><div className="inventory-toolbar"><div className="table-view-heading"><h2>Team members</h2><span>{team.length} sales representatives</span></div><button className="button button-primary" onClick={()=>{setForm({name:'',email:'',password:''});setModal('rep')}}><Plus size={15}/> Add team member</button></div><div className="table-scroll"><table className="data-table"><thead><tr><th>TEAM MEMBER</th><th>ROLE</th><th>RECORDED SALES</th><th>STATUS</th><th/></tr></thead><tbody>{team.map(x=><tr key={x.id}><td><div className="customer-cell"><div className={`avatar ${x.color}`}>{x.initials}</div><span><strong>{x.name}</strong><small className="team-email">{x.email}</small></span></div></td><td className="muted-cell">{x.role}</td><td><strong>{x.sales?money(x.sales):'—'}</strong></td><td><span className="status-pill completed"><i/>Active</span></td><td className="action-cell"><button className="more-button small-more" aria-label={`Options for ${x.name}`} onClick={()=>setOpen(open===x.id?null:x.id)}><MoreHorizontal size={18}/></button>{open===x.id&&<div className="row-menu"><button onClick={()=>{navigator.clipboard?.writeText(x.email);notify('Email address copied.');setOpen(null)}}><ClipboardList size={14}/> Copy email</button><button className="delete-action" onClick={()=>{deleteRep(x);setOpen(null)}}><X size={14}/> Remove member</button></div>}</td></tr>)}</tbody></table></div></section></>}

function ReportCard({label,value,caption,icon,tone}){return <article className="report-card"><span className={`metric-icon ${tone}`}>{icon}</span><span>{label}</span><strong>{value}</strong><small>{caption}</small></article>}
function SettingsView({isConfigured,cloudState,setView,signOut}){return <section className="settings-grid"><div className="panel settings-panel"><div className="panel-header"><div><h2>Workspace settings</h2><p>Company details, team access and saved data.</p></div><span className="settings-status"><span/>{isConfigured?'Connected':'Setup required'}</span></div><div className="setting-row"><div className="setting-icon purple"><Command size={17}/></div><div><strong>Workspace name</strong><span>ZOMO Advanced Technologies — shown across the app.</span></div></div><div className="setting-row"><div className="setting-icon blue"><Users size={17}/></div><div><strong>Team access</strong><span>Only the owner can add and remove representatives.</span></div><button className="button button-ghost compact" onClick={()=>setView('Team')}>Open Team</button></div><div className="setting-row"><div className="setting-icon green"><ShieldCheck size={17}/></div><div><strong>Data connection</strong><span>{isConfigured?'Products, stock, sales and team records are stored in Supabase.':'Connect a Supabase project to save company data.'}</span></div><span className={`connection-badge ${cloudState==='connected'?'connected':''}`}><span/>{isConfigured?(cloudState==='connected'?'Live':'Configured'):'Setup required'}</span></div></div><div className="panel settings-panel security-card"><div className="security-art"><div className="security-orbit one"/><div className="security-orbit two"/><div className="security-shield"><ShieldCheck size={26}/></div></div><span className="security-eyebrow">OWNER ACCESS</span><h2>What your access allows</h2><p>You can manage products, stock, sales and representative accounts.</p><div className="security-rule"><ShieldCheck size={15}/> Representatives can view inventory and record sales.</div><div className="security-rule"><ShieldCheck size={15}/> Cloud records use secure database access rules.</div><button className="button button-ghost settings-signout" onClick={signOut}><LogOut size={15}/> Sign out of ZOMO</button></div></section>}

function AccessPanel(){return <section className="panel access-panel"><ShieldCheck size={24}/><h2>Owner access required</h2><p>Ask the workspace owner to manage sales team access.</p></section>}
function EmptyState({icon,title,text}){return <div className="empty-state"><div>{icon}</div><strong>{title}</strong><span>{text}</span></div>}
function Modal({title,subtitle,onClose,children}){useEffect(()=>{function onKey(e){if(e.key==='Escape')onClose()}document.addEventListener('keydown',onKey);return()=>document.removeEventListener('keydown',onKey)},[onClose]);return <div className="modal-backdrop" onMouseDown={e=>e.target===e.currentTarget&&onClose()}><section className="modal"><div className="modal-header"><div><h2>{title}</h2><p>{subtitle}</p></div><button onClick={onClose} aria-label="Close dialog"><X size={18}/></button></div>{children}</section></div>}

function ThemeToggle({theme,onToggle,className=''}){const dark=theme==='dark';return <button type="button" className={`icon-button theme-toggle ${className}`} onClick={onToggle} aria-label={dark?'Switch to light mode':'Switch to dark mode'} title={dark?'Switch to light mode':'Switch to dark mode'}>{dark?<Sun size={17}/>:<Moon size={17}/>}</button>}

function PasswordInput({revealLabel='password',...props}){const [visible,setVisible]=useState(false);return <span className="password-field"><input {...props} type={visible?'text':'password'}/><button type="button" className="password-toggle" onClick={()=>setVisible(current=>!current)} aria-label={`${visible?'Hide':'Show'} ${revealLabel}`} aria-pressed={visible} title={`${visible?'Hide':'Show'} ${revealLabel}`}>{visible?<EyeOff size={15}/>:<Eye size={15}/>}</button></span>}

export default App;





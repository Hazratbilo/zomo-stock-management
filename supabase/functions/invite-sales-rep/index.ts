import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const allowedOrigins = (Deno.env.get('APP_ORIGIN') ?? 'http://127.0.0.1:5173,http://localhost:5173')
  .split(',').map((origin) => origin.trim()).filter(Boolean);

function corsHeaders(origin: string | null) {
  return {
    ...(origin && allowedOrigins.includes(origin) ? { 'Access-Control-Allow-Origin': origin } : {}),
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

function getKey(envName: string, collectionName: string) {
  const legacy = Deno.env.get(envName);
  if (legacy) return legacy;
  const keys = JSON.parse(Deno.env.get(collectionName) ?? '{}');
  return keys.default as string | undefined;
}

Deno.serve(async (req) => {
  const headers = corsHeaders(req.headers.get('Origin'));
  if (req.method === 'OPTIONS') return new Response('ok', { headers });
  if (req.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405, headers });
  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) return Response.json({ error: 'Sign in required' }, { status: 401, headers });
    const url = Deno.env.get('SUPABASE_URL')!;
    const anon = getKey('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEYS');
    const service = getKey('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEYS');
    if (!anon || !service) return Response.json({ error: 'Supabase function keys are not configured' }, { status: 500, headers });
    const caller = createClient(url, anon, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });
    const { data: { user }, error: authError } = await caller.auth.getUser();
    if (authError || !user) return Response.json({ error: 'Invalid session' }, { status: 401, headers });
    const { data: owner, error: roleError } = await caller.from('profiles').select('id, role').eq('id', user.id).single();
    if (roleError || owner?.role !== 'owner') return Response.json({ error: 'Only the workspace owner can invite representatives' }, { status: 403, headers });

    const body = await req.json();
    const fullName = String(body.fullName ?? '').trim();
    const email = String(body.email ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    if (fullName.length < 1 || fullName.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8) {
      return Response.json({ error: 'Enter a valid name, email address, and password of at least 8 characters' }, { status: 400, headers });
    }

    const admin = createClient(url, service, { auth: { persistSession: false } });
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: fullName } });
    if (error || !data.user) return Response.json({ error: error?.message ?? 'Could not create Auth account' }, { status: 400, headers });
    const { error: profileError } = await admin.from('profiles').insert({ id: data.user.id, owner_id: user.id, full_name: fullName, email, role: 'sales_rep' });
    if (profileError) {
      await admin.auth.admin.deleteUser(data.user.id);
      return Response.json({ error: 'Could not create sales profile: ' + profileError.message }, { status: 400, headers });
    }
    return Response.json({ id: data.user.id }, { headers });
  } catch {
    return Response.json({ error: 'Invalid request' }, { status: 400, headers });
  }
});

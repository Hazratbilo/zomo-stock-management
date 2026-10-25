import { createClient } from '@supabase/supabase-js';

const configStorageKey = 'zomo-supabase-project';

function clientFrom(url, key) {
  return url && key ? createClient(url, key) : null;
}

export function getSupabaseClient() {
  const envUrl = import.meta.env.VITE_SUPABASE_URL;
  const envKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (envUrl && envKey) return clientFrom(envUrl, envKey);

  try {
    const config = JSON.parse(localStorage.getItem(configStorageKey) || 'null');
    return clientFrom(config?.url, config?.key);
  } catch {
    return null;
  }
}

export function saveSupabaseProject(urlValue, keyValue) {
  const url = urlValue.trim().replace(/\/$/, '');
  const key = keyValue.trim();
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url)) throw new Error('Enter the Supabase project URL, for example https://abcdefgh.supabase.co.');
  if (!key) throw new Error('Paste the project publishable key.');
  const client = clientFrom(url, key);
  localStorage.setItem(configStorageKey, JSON.stringify({ url, key }));
  return client;
}

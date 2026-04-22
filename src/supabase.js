import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = String(import.meta.env.VITE_SUPABASE_URL || '').trim();
const SUPABASE_KEY = String(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim();
const APP_STATE_ID = String(import.meta.env.VITE_SUPABASE_APP_STATE_ID || 'main').trim() || 'main';
const MEDIA_BUCKET = String(import.meta.env.VITE_SUPABASE_MEDIA_BUCKET || 'guidebook-media').trim() || 'guidebook-media';

let client = null;

export function isSupabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_KEY);
}

export function getSupabaseClient() {
  if (!isSupabaseConfigured()) return null;
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    });
  }
  return client;
}

export function getRemoteAppStateId() {
  return APP_STATE_ID;
}

export function getRemoteMediaBucket() {
  return MEDIA_BUCKET;
}

export async function signInAdmin(email, password) {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('Supabase is not configured');
  return supabase.auth.signInWithPassword({ email, password });
}

export async function signOutAdminRemote() {
  const supabase = getSupabaseClient();
  if (!supabase) return { error: null };
  return supabase.auth.signOut();
}

export async function getCurrentRemoteSession() {
  const supabase = getSupabaseClient();
  if (!supabase) return { session: null, user: null };
  const [{ data: sessionData }, { data: userData }] = await Promise.all([
    supabase.auth.getSession(),
    supabase.auth.getUser(),
  ]);
  return {
    session: sessionData?.session || null,
    user: userData?.user || null,
  };
}

export async function updateOwnAdminPassword(newPassword) {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('Supabase is not configured');
  return supabase.auth.updateUser({ password: newPassword });
}

export async function fetchSharedPayload() {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('Supabase is not configured');
  const { data, error } = await supabase
    .from('guidebook_app_states')
    .select('id,payload,updated_at,updated_by')
    .eq('id', APP_STATE_ID)
    .maybeSingle();
  return { data, error };
}

export async function saveSharedPayload(payload, updatedBy = null) {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('Supabase is not configured');
  return supabase
    .from('guidebook_app_states')
    .upsert({ id: APP_STATE_ID, payload, updated_at: new Date().toISOString(), updated_by: updatedBy }, { onConflict: 'id' })
    .select('id,payload,updated_at,updated_by')
    .single();
}

export async function fetchAdminProfiles() {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('Supabase is not configured');
  return supabase
    .from('guidebook_admin_profiles')
    .select('*')
    .order('is_super_admin', { ascending: false })
    .order('created_at', { ascending: true });
}

export async function updateAdminProfile(profileId, patch) {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('Supabase is not configured');
  return supabase
    .from('guidebook_admin_profiles')
    .update(patch)
    .eq('id', profileId)
    .select('*')
    .single();
}

export async function disableAdminProfile(profileId) {
  return updateAdminProfile(profileId, { disabled: true });
}

export async function fetchPresenceRows() {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('Supabase is not configured');
  return supabase
    .from('guidebook_presence')
    .select('*')
    .order('last_seen_at', { ascending: false })
    .limit(50);
}

export async function upsertPresenceRow(row) {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('Supabase is not configured');
  return supabase
    .from('guidebook_presence')
    .upsert(row, { onConflict: 'session_id' })
    .select('*')
    .single();
}

export async function removePresenceRow(sessionId) {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('Supabase is not configured');
  return supabase
    .from('guidebook_presence')
    .delete()
    .eq('session_id', sessionId);
}

export async function uploadGuidebookMedia(file, adminId = 'anonymous') {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('Supabase is not configured');
  const ext = (file.name?.split('.').pop() || 'bin').toLowerCase();
  const safeAdminId = String(adminId || 'anonymous').replace(/[^a-zA-Z0-9_-]/g, '_');
  const path = `posts/${new Date().toISOString().slice(0, 10)}/${safeAdminId}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
  const { error } = await supabase.storage.from(MEDIA_BUCKET).upload(path, file, {
    cacheControl: '3600',
    upsert: false,
    contentType: file.type || undefined,
  });
  if (error) return { data: null, error };
  const { data } = supabase.storage.from(MEDIA_BUCKET).getPublicUrl(path);
  return { data: { path, publicUrl: data?.publicUrl || '' }, error: null };
}

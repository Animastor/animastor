// Authentication state (Account & Workspace MVP).
// Server-side session cookie is the source of truth; localStorage is never
// used for auth. The store only mirrors /auth/me.
import { signal } from '@preact/signals';
import { getJson, postJson } from '../api/client';

export interface AuthUser { id: string; username: string; display_name?: string | null; role?: string; }
export interface AuthWorkspace { id: string; name: string; type: string; }
export interface AuthMe { authenticated: boolean; user: AuthUser | null; workspace: AuthWorkspace | null; }

export const authMe = signal<AuthMe>({ authenticated: false, user: null, workspace: null });
export const authLoading = signal(false);
export const authError = signal<string | null>(null);

export async function fetchMe(): Promise<AuthMe> {
  try {
    const me = await getJson<AuthMe>('/auth/me');
    authMe.value = me;
    authError.value = null;
    return me;
  } catch {
    // Unauthenticated / server unreachable — reflect as anonymous.
    authMe.value = { authenticated: false, user: null, workspace: null };
    return authMe.value;
  }
}

export async function login(username: string, password: string): Promise<AuthMe> {
  authLoading.value = true;
  authError.value = null;
  try {
    const me = await postJson<AuthMe>('/auth/login', { username, password });
    authMe.value = me;
    return me;
  } catch (e) {
    authError.value = e instanceof Error ? e.message : 'login failed';
    throw e;
  } finally {
    authLoading.value = false;
  }
}

export async function register(username: string, password: string, email?: string): Promise<AuthMe> {
  authLoading.value = true;
  authError.value = null;
  try {
    const me = await postJson<AuthMe>('/auth/register', { username, password, email });
    authMe.value = me;
    return me;
  } catch (e) {
    authError.value = e instanceof Error ? e.message : 'registration failed';
    throw e;
  } finally {
    authLoading.value = false;
  }
}

export async function logout(): Promise<void> {
  authError.value = null;
  try {
    await postJson<unknown>('/auth/logout', {});
  } catch { /* logout is idempotent server-side; cookie clear best-effort */ }
  authMe.value = { authenticated: false, user: null, workspace: null };
}

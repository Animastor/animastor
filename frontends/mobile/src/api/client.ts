// API client — 1:1 with BackendApi.kt endpoints under /api/v1. Provides:
//  - fetch wrapper with base path, JSON/Blob, timeout,
//  - replayWithBackoff (3 attempts, 1s→2→5s) like PlaybackViewModel.retryWithBackoff,
//  - SSE client for generation progress (ProgressStream.kt equivalent),
//  - streaming Blob download for audio/video/image.
const BASE = '/api/v1';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      'Accept': 'application/json',
      ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {})
    }
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { const j = await res.json(); msg = (j as any)?.error || (j as any)?.message || msg; } catch { /* ignore */ }
    throw new ApiError(msg, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function getJson<T>(path: string): Promise<T> { return request<T>(path); }
export async function postJson<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
}
export async function putJson<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
}
export async function patchJson<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
}
export async function deleteJson<T>(path: string): Promise<T> { return request<T>(path, { method: 'DELETE' }); }

export async function getBlob(path: string): Promise<Blob> {
  const res = await fetch(BASE + path, { headers: { 'Accept': 'application/octet-stream' } });
  if (!res.ok) throw new ApiError(res.statusText, res.status);
  return res.blob();
}

export async function postMultipart<T>(path: string, file: File | Blob, fieldName: string = 'file', filename: string = 'upload.vbook'): Promise<T> {
  const fd = new FormData();
  fd.append(fieldName, file, filename);
  return request<T>(path, { method: 'POST', body: fd });
}

// retryWithBackoff — numeric backoff 1s→2→5s (mirrors PlaybackViewModel: 3 attempts, maxDelay 5s).
export async function retryWithBackoff<T>(fn: () => Promise<T>, attempts = 3, initialDelayMs = 1000, maxDelayMs = 5000): Promise<T> {
  let delay = initialDelayMs;
  for (let i = 1; i < attempts; i++) {
    try { return await fn(); }
    catch (e) { await new Promise((r) => setTimeout(r, delay)); delay = Math.min(delay * 2, maxDelayMs); }
  }
  return await fn();
}

// SSE client for generation progress. Yields parsed event objects; reconnects with
// monotonic guard (PROGRESS_HANDOFF F1-F7) handled by the caller in stage 4.
export interface SseEvent {
  id?: string;
  event?: string;
  data: string;
}
export async function* sse(path: string, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  const res = await fetch(BASE + path, {
    headers: { 'Accept': 'text/event-stream' },
    signal
  });
  if (!res.ok || !res.body) throw new ApiError(res.statusText, res.status);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let pending: SseEvent = { data: '' };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() || '';
      for (const frame of frames) {
        pending = { data: '' };
        for (const line of frame.split('\n')) {
          if (line.startsWith('id:')) pending.id = line.slice(3).trim();
          else if (line.startsWith('event:')) pending.event = line.slice(6).trim();
          else if (line.startsWith('data:')) pending.data = (pending.data ? pending.data + '\n' : '') + line.slice(5).trim();
        }
        yield pending;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

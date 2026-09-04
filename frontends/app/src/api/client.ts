// API client — 1:1 with BackendApi.kt endpoints under /api/v1. Provides:
//  - fetch wrapper with base path, JSON/Blob, timeout,
//  - retryWithBackoff (3 attempts, 1s→2s, cap 5s) like PlaybackViewModel.retryWithBackoff,
//  - SSE client for generation progress (ProgressStream.kt equivalent),
//  - streaming Blob download for audio/video/image.
export const API_BASE = '/api/v1';
const REQUEST_TIMEOUT_MS = 30_000; // OkHttp default read timeout
// Long-running endpoints (POST /bootstrap, /bootstrap-next-window) block for the
// WHOLE AI pipeline window (minutes). Mirrors the Android OkHttp config
// (readTimeout = 15 MINUTES) — the 30s default would abort these mid-window and
// freeze the client-side progress/timer while the backend keeps generating.
const LONG_REQUEST_TIMEOUT_MS = 15 * 60_000;
const BLOB_TIMEOUT_MS = 120_000;   // large media downloads

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = 'ApiError';
  }
}

// Combines an external AbortSignal (caller) with an internal timeout signal.
// `timedOut()` distinguishes the timeout abort from a caller abort.
function withTimeout(signal: AbortSignal | null | undefined, timeoutMs: number): { signal: AbortSignal; timedOut: () => boolean; clear: () => void } {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    clear: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
  };
}

async function request<T>(path: string, init: RequestInit = {}, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<T> {
  const { signal, timedOut, clear } = withTimeout(init.signal, timeoutMs);
  try {
    const res = await fetch(API_BASE + path, {
      ...init,
      signal,
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
  } catch (e) {
    if (timedOut()) throw new ApiError('Request timeout', 408);
    throw e;
  } finally {
    clear();
  }
}

export async function getJson<T>(path: string): Promise<T> { return request<T>(path); }
export async function postJson<T>(path: string, body?: unknown, timeoutMs?: number): Promise<T> {
  return request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }, timeoutMs);
}
// Long-running POST (blocking bootstrap/bootstrap-next-window).
export async function postJsonLong<T>(path: string, body?: unknown): Promise<T> {
  return postJson<T>(path, body, LONG_REQUEST_TIMEOUT_MS);
}
export async function putJson<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
}
export async function patchJson<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
}
export async function deleteJson<T>(path: string): Promise<T> { return request<T>(path, { method: 'DELETE' }); }
// DELETE with a JSON body (SH-2: DELETE /workers/:id/share/users { username }).
export async function deleteJsonBody<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'DELETE', body: JSON.stringify(body) });
}

// Streaming Blob download: reads the body in chunks and assembles a Blob,
// so large audio/video can be written into mediaCache progressively.
// onProgress (0..1) is derived from Content-Length when the server sends it
// (mirrors Repository.streamToFile progress callbacks for exports).
export async function getBlob(path: string, signal?: AbortSignal, onProgress?: (progress: number) => void): Promise<Blob> {
  const { signal: s, timedOut, clear } = withTimeout(signal, BLOB_TIMEOUT_MS);
  try {
    const res = await fetch(API_BASE + path, { headers: { 'Accept': 'application/octet-stream' }, signal: s });
    if (!res.ok) throw new ApiError(res.statusText, res.status);
    if (!res.body) return res.blob();
    const reader = res.body.getReader();
    const chunks: BlobPart[] = [];
    const total = Number(res.headers.get('Content-Length')) || 0;
    let received = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value); // Uint8Array chunk (fetch body reader never yields strings)
        received += value.length;
        if (total > 0 && onProgress) onProgress(Math.min(1, received / total));
      }
    } finally {
      reader.releaseLock();
    }
    return new Blob(chunks);
  } catch (e) {
    if (timedOut()) throw new ApiError('Request timeout', 408);
    throw e;
  } finally {
    clear();
  }
}

export async function postMultipart<T>(path: string, file: File | Blob, fieldName: string = 'file', filename: string = 'upload.vbook'): Promise<T> {
  const fd = new FormData();
  fd.append(fieldName, file, filename);
  return request<T>(path, { method: 'POST', body: fd });
}

// Media URL for <img src>/<audio src>/<video src>/download links — the parts of
// the Player/Editor that embed server media directly in the DOM and cannot go
// through fetch(). Centralizes the /api/v1 base (same seam as request());
// path is the endpoint-relative path WITH query string (e.g. build_id).
export function mediaUrl(path: string): string {
  return API_BASE + path;
}

// retryWithBackoff — numeric backoff 1s→2s→… capped at 5s, 3 attempts total
// (mirrors PlaybackViewModel.retryWithBackoff: attempts=3, initialDelay=1s, maxDelay=5s).
export async function retryWithBackoff<T>(fn: () => Promise<T>, attempts = 3, initialDelayMs = 1000, maxDelayMs = 5000): Promise<T> {
  let delay = initialDelayMs;
  for (let i = 1; i < attempts; i++) {
    try { return await fn(); }
    catch (e) { await new Promise((r) => setTimeout(r, delay)); delay = Math.min(delay * 2, maxDelayMs); }
  }
  return await fn();
}

// Streaming chat SSE (LLM Sharing Phase 3). POST + SSE: the response is a
// text/event-stream of {meta, delta, done, error} frames (the production
// backend contract — see docs/04-planning/llm-sharing-phase3-production-sse-ux.md).
// The caller's signal drives cancellation (AbortSignal → browser closes the
// connection → backend chat.cancel → slot release). No client timeout: the
// stream is bounded server-side; the user cancels explicitly.
export interface ChatStreamHandlers {
  onMeta?: (meta: { session_id: string; ai_source: string; model?: string }) => void;
  onDelta: (delta: string) => void;
  onDone: (data: Record<string, unknown>) => void;
  onError: (data: { error?: string; code?: string; partial?: string }) => void;
}

export async function postChatStream(path: string, body: unknown, handlers: ChatStreamHandlers, signal?: AbortSignal): Promise<void> {
  const res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
    body: JSON.stringify(body ?? {}),
    signal,
  });
  if (!res.ok || !res.body) {
    let msg = res.statusText;
    let code: string | undefined;
    try {
      const j = await res.json();
      msg = (j as any)?.error || (j as any)?.message || msg;
      code = (j as any)?.code;
    } catch { /* ignore */ }
    throw new ApiError(msg, res.status, code);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const handleFrame = (frame: string) => {
    let eventName = 'message';
    let data = '';
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!data) return; // SSE comment / keep-alive
    let parsed: any = null;
    try { parsed = JSON.parse(data); } catch { return; }
    if (eventName === 'meta') handlers.onMeta?.(parsed);
    else if (eventName === 'delta') { if (typeof parsed?.delta === 'string') handlers.onDelta(parsed.delta); }
    else if (eventName === 'done') handlers.onDone(parsed ?? {});
    else if (eventName === 'error') handlers.onError(parsed ?? {});
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() || '';
      for (const frame of frames) handleFrame(frame);
    }
    if (buffer.trim()) handleFrame(buffer);
  } finally {
    reader.releaseLock();
  }
}

// SSE client for generation progress. Yields parsed event objects; reconnects with
// monotonic guard (PROGRESS_HANDOFF F1-F7) handled by the caller in stage 4.
export interface SseEvent {
  id?: string;
  event?: string;
  data: string;
}
export async function* sse(path: string, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  const res = await fetch(API_BASE + path, {
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

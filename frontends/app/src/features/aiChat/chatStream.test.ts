// ─────────────────────────────────────────────────────────────────────────
// AI chat streaming UX tests (LLM Sharing Phase 3).
// Covers the user-visible streaming contract without a DOM:
//   - SSE frame parsing (split chunks, multi-line, keep-alive comments);
//   - streaming text appears progressively (per-delta handler);
//   - exactly the terminal frames reach the handlers;
//   - cancel (AbortSignal) aborts the stream and rejects;
//   - error frames surface sanitized codes (no spinner forever);
//   - disconnect (EOF without terminal) does not leave the request stuck;
//   - Private/Shared source badge mapping + unavailable state mapping.
// ─────────────────────────────────────────────────────────────────────────
import { describe, expect, it, vi } from 'vitest';
import { postChatStream } from '../../api/client';
import { sourceBadgeKey, streamErrorKey, isUserCancelled } from './chatStream';

/** Build a fetch Response with a streaming SSE body from string chunks. */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

describe('chatStream — streaming text appears progressively', () => {
  it('delivers meta, every delta, and exactly one done', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([
      frame('meta', { session_id: 's1', ai_source: 'shared', model: 'qwen3:32b' }),
      frame('delta', { delta: 'Hello ' }),
      frame('delta', { delta: 'shared ' }),
      ': ping\n\n', // keep-alive comment — ignored
      frame('delta', { delta: 'SSE!' }),
      frame('done', { reply: 'Hello shared SSE!', ai_source: 'shared', patches_applied: 0 }),
    ]));
    vi.stubGlobal('fetch', fetchMock);

    const deltas: string[] = [];
    let meta: any = null;
    let doneCount = 0;
    await postChatStream('/ai/chat/stream', {}, {
      onMeta: (m) => { meta = m; },
      onDelta: (d) => deltas.push(d),
      onDone: () => { doneCount += 1; },
      onError: () => { throw new Error('error frame must not fire'); },
    });
    vi.unstubAllGlobals();

    expect(meta.ai_source).to.equal('shared');
    expect(meta.session_id).to.equal('s1');
    expect(deltas.join('')).to.equal('Hello shared SSE!');
    expect(doneCount).to.equal(1);
  });

  it('assembles deltas split across arbitrary TCP chunks', async () => {
    const full = frame('meta', { session_id: 's', ai_source: 'private-local' })
      + frame('delta', { delta: 'frag' })
      + frame('done', { reply: 'frag', patches_applied: 0 });
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([
      full.slice(0, 17), full.slice(17, 40), full.slice(40),
    ]));
    vi.stubGlobal('fetch', fetchMock);
    const deltas: string[] = [];
    await postChatStream('/ai/chat/stream', {}, {
      onDelta: (d) => deltas.push(d),
      onDone: () => {},
      onError: () => {},
    });
    vi.unstubAllGlobals();
    expect(deltas.join('')).to.equal('frag');
  });
});

describe('chatStream — cancel changes the UI state (abort → rejection)', () => {
  it('rejects with AbortError when the user aborts mid-stream (no hang)', async () => {
    const encoder = new TextEncoder();
    const controller = new AbortController();
    // A browser-realistic mock: the signal aborts the BODY reader
    // (reader.read() rejects with AbortError, like fetch does).
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        const onAbort = () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          try { streamController.error(err); } catch { /* already closed */ }
        };
        if (controller.signal.aborted) onAbort();
        else controller.signal.addEventListener('abort', onAbort, { once: true });
        streamController.enqueue(encoder.encode(frame('delta', { delta: 'partial ' })));
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(stream, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const deltas: string[] = [];
    const p = postChatStream('/ai/chat/stream', {}, {
      onDelta: (d) => deltas.push(d),
      onDone: () => {},
      onError: () => {},
    }, controller.signal);
    await new Promise((r) => setTimeout(r, 10));
    controller.abort(); // the stop button
    let name = '';
    await p.then(() => { name = 'resolved'; }, (e) => { name = e?.name ?? 'rejected'; });
    vi.unstubAllGlobals();
    expect(deltas.join('')).to.equal('partial ');
    expect(name).to.equal('AbortError'); // isUserCancelled → bubble becomes cancelled
  });
});

describe('chatStream — error terminal does not leave a spinner forever', () => {
  it('surfaces the sanitized error frame (code + message) once', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([
      frame('meta', { session_id: 's', ai_source: 'shared' }),
      frame('delta', { delta: 'partial answer ' }),
      frame('error', { error: 'Local AI stream failed after partial output', code: 'stream_failed', partial: 'partial answer ' }),
    ]));
    vi.stubGlobal('fetch', fetchMock);
    const deltas: string[] = [];
    const errors: any[] = [];
    await postChatStream('/ai/chat/stream', {}, {
      onDelta: (d) => deltas.push(d),
      onDone: () => {},
      onError: (e) => errors.push(e),
    });
    vi.unstubAllGlobals();
    expect(errors).to.have.lengthOf(1);
    expect(errors[0].code).to.equal('stream_failed');
    expect(errors[0].error).to.not.match(/https?:\/\//); // sanitized — no runtime detail
    expect(deltas.join('')).to.equal('partial answer '); // partial preserved
  });

  it('an HTTP error before the stream starts rejects with the sanitized message', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: 'Shared AI is not available right now', code: 'shared_unavailable' }),
      { status: 503 },
    ));
    vi.stubGlobal('fetch', fetchMock);
    let err: any = null;
    await postChatStream('/ai/chat/stream', {}, {
      onDelta: () => {}, onDone: () => {}, onError: () => {},
    }).catch((e) => { err = e; });
    vi.unstubAllGlobals();
    expect(err).to.exist;
    expect(err.status).to.equal(503);
    expect(err.code).to.equal('shared_unavailable');
  });

  it('a disconnect (EOF without terminal) resolves without hanging — the caller sees no done', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([
      frame('delta', { delta: 'partial ' }),
    ]));
    vi.stubGlobal('fetch', fetchMock);
    const deltas: string[] = [];
    let doneCount = 0;
    await postChatStream('/ai/chat/stream', {}, {
      onDelta: (d) => deltas.push(d),
      onDone: () => { doneCount += 1; },
      onError: () => {},
    });
    vi.unstubAllGlobals();
    expect(deltas.join('')).to.equal('partial ');
    expect(doneCount).to.equal(0); // no terminal — caller may treat as dropped
  });
});

describe('chatStream — honest source indicator mapping', () => {
  it('maps the safe ai_source tokens to Private AI / Shared AI badges', () => {
    expect(sourceBadgeKey('shared')).to.equal('ai_source_shared');
    expect(sourceBadgeKey('private-local')).to.equal('ai_source_private');
    expect(sourceBadgeKey('cloud')).to.equal('ai_source_cloud');
    expect(sourceBadgeKey('system')).to.equal('ai_source_system');
    expect(sourceBadgeKey('unknown-garbage')).to.equal(null);
    expect(sourceBadgeKey(null)).to.equal(null);
    expect(sourceBadgeKey(undefined)).to.equal(null);
  });

  it('never maps anything to an owner/endpoint badge (no such token exists)', () => {
    for (const s of ['endpoint', 'owner', 'connector', 'workspace', 'llmc.a.b']) {
      expect(sourceBadgeKey(s)).to.equal(null);
    }
  });

  it('maps sanitized backend codes to honest localized states', () => {
    expect(streamErrorKey('ai_unavailable')).to.equal('ai_state_unavailable');
    expect(streamErrorKey('shared_unavailable')).to.equal('ai_state_shared_unavailable');
    expect(streamErrorKey('connector_offline')).to.equal('ai_state_offline');
    expect(streamErrorKey('session_closed')).to.equal('ai_state_offline');
    expect(streamErrorKey('runtime_unreachable')).to.equal('ai_state_runtime_unreachable');
    expect(streamErrorKey('timeout')).to.equal('ai_state_timeout');
    expect(streamErrorKey('busy')).to.equal('ai_state_busy');
    expect(streamErrorKey('stream_failed')).to.equal('ai_state_stream_failed');
    expect(streamErrorKey('cancelled')).to.equal('ai_cancelled');
    expect(streamErrorKey('mystery_code')).to.equal(null); // fall back to backend message
    expect(streamErrorKey(undefined)).to.equal(null);
  });
});

describe('isUserCancelled — user stop vs other aborts', () => {
  it('flags only the explicit user cancel (stop button)', () => {
    expect(isUserCancelled({ name: 'AbortError' }, { current: true })).to.equal(true);
    expect(isUserCancelled(null, { current: true })).to.equal(true);
    expect(isUserCancelled({ name: 'AbortError' }, { current: false })).to.equal(true);
    expect(isUserCancelled({ name: 'TypeError' }, { current: false })).to.equal(false);
    expect(isUserCancelled(null, { current: false })).to.equal(false);
  });
});

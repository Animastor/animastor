import type { JSX } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { getJson, postJson, deleteJson, postChatStream, mediaUrl, ApiError } from '../api/client';
import type { AiChatResponse, AiMessage, ChatSessionApi, SessionMessageApi, BookData, BookChapter, BookScene } from '../api/models';
import { unitIndex } from '../api/models';
import { t, tf, currentLang, type StrKey } from '../app/i18n';
import { bookId as generateBookId } from '../state/generateStore';
import { position as positionSignal } from '../state/positionStore';
import { bookResource, emitExternal, onResourceInvalidated } from '../state/resourceInvalidations';
import { resilientReload, sharedRecovery } from '../state/resilientReloader';
import { setSecondaryTitle } from '../app/titleStore';
import { Modal, toast } from '../lib/ui';
import { IconMic, IconMicOff, IconSend, IconMenu, IconAdd, IconSparkle, IconDownload, IconEdit, IconMap, IconFile, IconCheck, IconCopy, IconClose, IconStop } from '../app/icons';
import type { IconProps } from '../app/icons';
import { sourceBadgeKey, streamErrorKey, isUserCancelled } from '../features/aiChat/chatStream';

// AiAssistantPage — 1:1 with AiAssistantFragment. Chat with AI: session history
// (/ai/sessions), mode chips (AssistantMode), typing indicator, position context
// bar, voice input (Web Speech API = SpeechRecognizer equivalent; falls back to
// a toast when unsupported, see 06-RISKS).
// LLM Sharing Phase 3: messages ride the production SSE route (/ai/chat/stream)
// — text appears incrementally over Private Local AI, Shared AI and cloud
// providers; the send button becomes a working stop button (cancel → backend
// chat.cancel → local runtime abort); the assistant bubble carries an honest
// Private AI / Shared AI / Cloud AI source badge (safe token only — never
// endpoint or owner detail).

interface ChatMsg {
  id: number;
  text: string;
  isUser: boolean;
  isTyping?: boolean;
  downloadUrl?: string | null;
  // Consumer-side source provenance (safe token from the stream meta/done):
  // 'private-local' | 'shared' | 'cloud' | 'system'.
  source?: string | null;
  // Honest terminal states for the streaming lifecycle.
  streaming?: boolean;
  cancelled?: boolean;
  failed?: boolean;
}

interface AssistantModeDef {
  id: string;
  titleKey: 'ai_mode_conversation' | 'ai_mode_import' | 'ai_mode_edit' | 'ai_mode_director' | 'ai_mode_extraction' | 'ai_mode_validation';
  descKey: 'ai_mode_conversation_desc' | 'ai_mode_import_desc' | 'ai_mode_edit_desc' | 'ai_mode_director_desc' | 'ai_mode_extraction_desc' | 'ai_mode_validation_desc';
  Icon: (p: IconProps) => JSX.Element;
  // Future feature: chip stays visible but dimmed + disabled — clicking it
  // must never send a request (the backend no longer exposes handler-less
  // tools for these modes). Parity: Android AssistantMode.soon.
  soon?: boolean;
}

const MODES: AssistantModeDef[] = [
  { id: 'conversation', titleKey: 'ai_mode_conversation', descKey: 'ai_mode_conversation_desc', Icon: IconSparkle },
  { id: 'edit', titleKey: 'ai_mode_edit', descKey: 'ai_mode_edit_desc', Icon: IconEdit },
  { id: 'import', titleKey: 'ai_mode_import', descKey: 'ai_mode_import_desc', Icon: IconDownload, soon: true },
  { id: 'director', titleKey: 'ai_mode_director', descKey: 'ai_mode_director_desc', Icon: IconMap, soon: true },
  { id: 'extraction', titleKey: 'ai_mode_extraction', descKey: 'ai_mode_extraction_desc', Icon: IconFile, soon: true },
  { id: 'validation', titleKey: 'ai_mode_validation', descKey: 'ai_mode_validation_desc', Icon: IconCheck, soon: true },
];

// Resolved at render time so language switches apply (module-scope t() would go stale).
function modeLabel(id: string): string {
  switch (id) {
    case 'edit': return t('ai_mode_edit');
    case 'import': return t('ai_mode_import');
    case 'director': return t('ai_mode_director');
    case 'extraction': return t('ai_mode_extraction');
    case 'validation': return t('ai_mode_validation');
    default: return t('ai_mode_conversation');
  }
}

let nextId = 1;

// embedded — desktop shell variant (plan §8): the assistant is a docked panel,
// not a route; the mobile "back" arrow becomes a close action so history is
// never polluted by the overlay.
export function AiAssistantPage(props: { path?: string; embedded?: boolean; onClose?: () => void }) {
  void props.path;
  const { embedded = false, onClose } = props;
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [sessions, setSessions] = useState<ChatSessionApi[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [mode, setMode] = useState('conversation');
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [typing, setTyping] = useState(false);
  const [showSessions, setShowSessions] = useState(false);
  const [listening, setListening] = useState(false);
  const [positionLabel, setPositionLabel] = useState(t('navigate_no_position'));
  const listRef = useRef<HTMLDivElement>(null);
  const apiMessagesRef = useRef<AiMessage[]>([]);
  const sessionAtSendRef = useRef<string | null>(null);
  // Mirror of currentSessionId readable inside async callbacks (state alone would
  // be stale there); Android compares against currentSessionId in the coroutine.
  const currentSessionIdRef = useRef<string | null>(null);
  const setSession = useCallback((id: string | null) => {
    currentSessionIdRef.current = id;
    setCurrentSessionId(id);
  }, []);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  const bid = generateBookId.value;

  // Route title is only meaningful when mounted as a route. In the desktop dock
  // (embedded) the assistant has its own header and must NOT overwrite the
  // secondary-bar title of the page rendered underneath the overlay.
  useEffect(() => {
    if (embedded) return;
    setSecondaryTitle(t('ai'));
    return () => setSecondaryTitle(null);
  }, [embedded]);

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      const el = listRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, []);

  // ── Position context bar (include_position_bar equivalent) ──
  // refreshPositionLabel re-fetches the book snapshot and re-renders the label;
  // it is also called after this assistant's own patches invalidate the book
  // (stale chapter/scene titles otherwise stick until the next position change).
  const positionLabelRefreshRef = useRef<(() => void) | null>(null);
  const refreshPositionLabel = useCallback(() => { positionLabelRefreshRef.current?.(); }, []);
  useEffect(() => {
    let alive = true;
    const update = async () => {
      const pos = positionSignal.value;
      if (!pos.chapterId || !generateBookId.value) { setPositionLabel(t('navigate_no_position')); return; }
      const result = await resilientReload({
        recovery: sharedRecovery(),
        attempt: () => getJson<BookData>(`/book/${encodeURIComponent(generateBookId.value)}`),
      });
      if (!alive) return;
      // Keep the current label on final failure (content already visible);
      // only reset to "no position" when there is genuinely nothing selected.
      if (result.kind !== 'success') return;
      const book = result.value;
      const ch: BookChapter | undefined = book.chapters?.find((c) => c.chapter_id === pos.chapterId);
      const sc: BookScene | undefined = ch?.scenes?.find((s) => s.scene_id === pos.sceneId);
      const scIdx = sc?.display_index ?? 0;
      const uIdx = unitIndex(book, pos.chapterId, pos.sceneId, pos.unitIndex);
      const isSpecial = ch?.is_special === true;
      const chTitle = ch?.chapter_title;
      const scTitle = sc?.scene_title;
      const chLabel = isSpecial ? (chTitle || (ch?.type ?? '')?.charAt(0).toUpperCase() + (ch?.type ?? '').slice(1))
        : chTitle || (ch?.display_number != null ? `${t('navigate_chapter')} ${ch.display_number}` : '');
      const scLabel = scIdx > 0 ? `${t('navigate_scene')} ${scIdx}` : '';
      const unitLabel = uIdx > 0 ? `${t('navigate_unit')} ${uIdx}` : '';
      if (!chLabel && !scLabel) { setPositionLabel(t('navigate_no_position')); return; }
      const full = scTitle
        ? `${chLabel} / ${scLabel} — ${scTitle}${unitLabel ? ' / ' + unitLabel : ''}`
        : `${chLabel} / ${scLabel}${unitLabel ? ' / ' + unitLabel : ''}`;
      setPositionLabel(full);
    };
    positionLabelRefreshRef.current = () => { void update(); };
    void update();
    return () => { alive = false; positionLabelRefreshRef.current = null; };
  }, [positionSignal.value, generateBookId.value]);

  // ── Invalidation pipeline (view layer): the book changed outside this
  // screen (editor save / another device) — refresh the context bar so the
  // position label reflects the new titles. Same contract as Android. ──
  useEffect(() => {
    return onResourceInvalidated((e) => {
      const currentBook = generateBookId.value;
      if (e.kind !== 'EXTERNAL') return;
      if (!currentBook || e.resource !== bookResource(currentBook)) return;
      void refreshPositionLabel();
    });
  }, [refreshPositionLabel]);

  // ── Boot: create mode (no book) or load sessions ──
  useEffect(() => {
    if (!bid) {
      setMessages([{ id: nextId++, text: t('ai_creation_welcome'), isUser: false }]);
      return;
    }
    void loadSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bid]);

  const loadSessions = async () => {
    try {
      const res = await getJson<{ sessions: ChatSessionApi[] }>(`/ai/sessions?book_id=${encodeURIComponent(bid)}`);
      setSessions(res.sessions ?? []);
      if (res.sessions?.length) {
        await restoreSession(res.sessions[0]);
      } else {
        await startNewSession();
      }
    } catch {
      setMessages([{ id: nextId++, text: tf('ai_error', 'sessions'), isUser: false }]);
    }
  };

  const restoreSession = async (s: ChatSessionApi) => {
    setSession(s.id);
    setMessages([]);
    apiMessagesRef.current = [];
    try {
      const res = await getJson<{ messages: SessionMessageApi[] }>(`/ai/sessions/${encodeURIComponent(s.id)}/messages`);
      const msgs = (res.messages ?? []).map((m) => {
        if (m.role === 'user') apiMessagesRef.current.push({ role: 'user', content: m.message });
        else apiMessagesRef.current.push({ role: 'assistant', content: m.message });
        return { id: nextId++, text: m.message, isUser: m.role === 'user' };
      });
      setMessages(msgs);
      scrollToBottom();
    } catch { /* keep empty */ }
  };

  const startNewSession = async () => {
    setSession(null);
    setMessages([{ id: nextId++, text: t('ai_welcome'), isUser: false }]);
    apiMessagesRef.current = [];
    if (!bid) return;
    try {
      const res = await postJson<{ session: ChatSessionApi }>('/ai/sessions', {
        book_id: bid, title: t('ai_new_chat'), topic_id: 'book', mode,
      });
      setSession(res.session.id);
      setSessions((s) => [res.session, ...s]);
    } catch { /* session will be created server-side on first message */ }
  };

  const switchMode = (m: AssistantModeDef) => {
    if (m.soon) return; // future feature — chip is disabled, never sends a request
    if (mode === m.id) return;
    setMode(m.id);
    setMessages((prev) => [...prev, {
      id: nextId++,
      text: tf('ai_mode_switch', t(m.titleKey), t(m.descKey)),
      isUser: false,
    }]);
    scrollToBottom();
  };

  // Abort controller of the in-flight streaming request — the stop button
  // and navigation both cancel through it (AbortSignal → backend chat.cancel).
  const abortRef = useRef<AbortController | null>(null);
  // True only when the USER pressed stop (distinguishes their cancel from a
  // navigation/teardown abort — the bubble state differs).
  const userCancelledRef = useRef(false);

  const stopGeneration = useCallback(() => {
    userCancelledRef.current = true;
    abortRef.current?.abort();
  }, []);

  // Cancel the in-flight stream on unmount/navigation so the backend never
  // keeps inferring (and never holds a shared slot) for a gone client.
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    setSending(true);
    userCancelledRef.current = false;
    const userMsg: ChatMsg = { id: nextId++, text, isUser: true };
    apiMessagesRef.current = [...apiMessagesRef.current, { role: 'user', content: text }];
    setMessages((prev) => [...prev, userMsg]);
    setTyping(true);
    scrollToBottom();
    sessionAtSendRef.current = currentSessionId;

    const pos = positionSignal.value;
    const controller = new AbortController();
    abortRef.current = controller;

    // The streaming assistant bubble — created on the first delta.
    let assistantId: number | null = null;
    let streamedText = '';
    let donePayload: Record<string, unknown> | null = null;
    const ensureBubble = (source?: string | null) => {
      if (assistantId != null) return;
      assistantId = nextId++;
      setMessages((prev) => [...prev, { id: assistantId!, text: '', isUser: false, streaming: true, source: source ?? null }]);
      setTyping(false);
    };

    try {
      await postChatStream('/ai/chat/stream', {
        messages: apiMessagesRef.current,
        book_id: bid || null,
        lang: currentLang(),
        mode,
        topic_id: 'book',
        scene_id: pos.sceneId,
        session_id: sessionAtSendRef.current,
      }, {
        onMeta: (meta) => {
          if (sessionAtSendRef.current == null && meta?.session_id) setSession(meta.session_id);
          ensureBubble(meta?.ai_source ?? null);
          if (meta?.ai_source) {
            setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, source: meta.ai_source } : m)));
          }
        },
        onDelta: (delta) => {
          ensureBubble(null);
          streamedText += delta;
          setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, text: streamedText } : m)));
          scrollToBottom();
        },
        onDone: (data) => { donePayload = data; },
        onError: () => { /* handled via the promise result below */ },
      }, controller.signal);

      // Discard the response if the user switched sessions while waiting
      // (1:1 with Android: sessionAtSend != null && currentSessionId != sessionAtSend).
      if (sessionAtSendRef.current != null && currentSessionIdRef.current !== sessionAtSendRef.current) {
        return;
      }

      const res = donePayload as unknown as AiChatResponse | null;
      if (assistantId == null) {
        // No deltas and no terminal — an empty completion. Honest no-result.
        ensureBubble((res as { ai_source?: string } | null)?.ai_source ?? null);
      }
      if (res && res.patches_applied > 0) {
        const patchedBookId = res.book_id || bid;
        if (patchedBookId) {
          emitExternal(bookResource(String(patchedBookId)));
          void refreshPositionLabel();
        }
      }
      apiMessagesRef.current = [...apiMessagesRef.current, { role: 'assistant', content: res?.reply || streamedText || '' }];
      const displayText = res?.reply?.trim() ? res.reply : (streamedText.trim() ? streamedText : buildToolResultMessage(res ?? ({} as AiChatResponse)));
      const downloadUrl = (res && res.book_id) ? mediaUrl(`/book/${String(res.book_id).split('/')[0]}/download`) : null;
      setMessages((prev) => prev.map((m) => (m.id === assistantId
        ? { ...m, text: displayText, streaming: false, downloadUrl, source: res?.ai_source ?? m.source }
        : m)));
    } catch (e) {
      // Cancelled by the user (stop button) → keep the partial answer and
      // mark the bubble cancelled — no error banner, no spinner.
      if (isUserCancelled(e, { current: userCancelledRef.current })) {
        if (assistantId != null) {
          setMessages((prev) => prev.map((m) => (m.id === assistantId
            ? { ...m, streaming: false, cancelled: true, text: m.text || streamedText }
            : m)));
          if (streamedText) {
            apiMessagesRef.current = [...apiMessagesRef.current, { role: 'assistant', content: streamedText }];
          }
        } else {
          setMessages((prev) => [...prev, { id: nextId++, text: t('ai_cancelled'), isUser: false, cancelled: true }]);
        }
      } else {
        // Honest error states: known backend codes map to localized strings,
        // everything else shows the sanitized backend message.
        const err = e as Error;
        const code = e instanceof ApiError ? e.code : undefined;
        const known = streamErrorKey(code);
        const msg = known ? t(known as StrKey) : tf('ai_error', err.message || 'stream failed');
        if (assistantId != null) {
          // Mid-stream failure: the partial answer stays visible, the error
          // note is appended below it (nothing is lost, nothing hangs).
          setMessages((prev) => prev.map((m) => (m.id === assistantId
            ? { ...m, streaming: false, failed: true, text: m.text ? `${m.text}\n\n${msg}` : msg }
            : m)));
          if (streamedText) {
            apiMessagesRef.current = [...apiMessagesRef.current, { role: 'assistant', content: streamedText }];
          }
        } else {
          setMessages((prev) => [...prev, { id: nextId++, text: msg, isUser: false, failed: true }]);
        }
      }
    } finally {
      abortRef.current = null;
      setTyping(false);
      setSending(false);
      scrollToBottom();
    }
  };

  const deleteSession = async (s: ChatSessionApi) => {
    if (!confirm(t('ai_session_delete_confirm'))) return;
    try {
      await deleteJson(`/ai/sessions/${encodeURIComponent(s.id)}`);
      const rest = sessions.filter((x) => x.id !== s.id);
      setSessions(rest);
      if (s.id === currentSessionId) {
        if (rest.length) await restoreSession(rest[0]);
        else await startNewSession();
      }
    } catch (e) {
      toast((e as Error).message);
    }
  };

  // ── Voice input (Web Speech API) ──
  useEffect(() => {
    const SR = (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike; SpeechRecognition?: new () => SpeechRecognitionLike })
      .webkitSpeechRecognition || (window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike }).SpeechRecognition;
    if (!SR) return;
    const rec = new SR();
    rec.lang = currentLang() === 'ru' ? 'ru-RU' : 'en-US';
    rec.continuous = false;
    rec.interimResults = false;
    rec.onresult = (e) => {
      const t0 = e.results[0]?.[0]?.transcript;
      if (t0) { setInput((prev) => prev + t0); }
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    recognitionRef.current = rec;
    return () => { rec.abort(); recognitionRef.current = null; };
  }, []);

  const toggleVoice = () => {
    const rec = recognitionRef.current;
    if (!rec) { toast(t('voice_not_available')); return; }
    if (listening) { rec.stop(); setListening(false); return; }
    setListening(true);
    try { rec.start(); }
    catch { setListening(false); toast(t('voice_not_available')); }
  };

  const copyMessage = (msg: ChatMsg) => {
    void navigator.clipboard?.writeText(msg.text).then(() => toast(t('copied_to_clipboard')));
  };

  return (
    <section class="ai-page">
      {/* Header: back + session list + new chat */}
      {/* Header row — 1:1 with fragment_ai_assistant.xml: back + session-list on
          the left, new-chat on the right, and the position bar in the SAME row
          between them (Android: 0dp positionBar constrained between
          sessionListButton and newChatButton). */}
      <div class="ai-header">
        {embedded ? (
          <button class="toolbar__btn" aria-label={t('edit_close')} onClick={onClose}>
            <IconClose />
          </button>
        ) : (
          <button class="toolbar__btn toolbar__btn--back" aria-label={t('back')} onClick={() => history.back()}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="24" height="24"><path d="M15 18l-6-6 6-6" /></svg>
          </button>
        )}
        <button class="toolbar__btn" aria-label={t('ai_session_list')} onClick={() => setShowSessions(true)}>
          <IconMenu />
        </button>
        <div class="ai-posbar">{positionLabel}</div>
        <button class="toolbar__btn" aria-label={t('ai_new_chat')} onClick={() => void startNewSession()}>
          <IconAdd />
        </button>
      </div>

      {/* Mode chips row — natural horizontal carousel: the next chip peeking
          past the right edge signals scrollability (no chevron indicators). */}
      <div class="ai-mode-row">
        <div class="ai-mode-scroll-x">
          {MODES.map((m) => (
            <button
              key={m.id}
              class={'chip chip--mode' + (mode === m.id ? ' chip--mode-active' : '') + (m.soon ? ' chip--mode-soon' : '')}
              onClick={() => switchMode(m)}
              disabled={m.soon}
              title={m.soon ? `${t(m.titleKey)} — ${t('ai_mode_soon')}` : undefined}
              aria-disabled={m.soon || undefined}
            >
              <m.Icon width={18} height={18} />
              <span>{t(m.titleKey)}</span>
              {m.soon && <span class="chip--mode-soon__badge">{t('ai_mode_soon')}</span>}
            </button>
          ))}
        </div>
      </div>

      {/* Message list */}
      <div class="ai-list" ref={listRef}>
        {messages.map((m) => (
          <ChatBubble key={m.id} msg={m} onCopy={() => copyMessage(m)} />
        ))}
        {typing && <TypingBubble />}
      </div>

      {/* Input bar */}
      <div class="ai-input">
        <button class="ai-input__btn" aria-label={t('ai_mic')} onClick={toggleVoice}>
          {listening ? <IconMicOff /> : <IconMic />}
        </button>
        <input
          class="ai-input__field"
          value={input}
          placeholder={t('ai_input_hint')}
          aria-label={t('ai_input_hint')}
          onKeyDown={(e) => { if (e.key === 'Enter') void sendMessage(); }}
          onInput={(e) => setInput((e.target as HTMLInputElement).value)}
        />
        <button
          class={'ai-input__btn ai-input__btn--send' + (sending ? ' ai-input__btn--stop' : '')}
          aria-label={sending ? t('ai_cancel') : t('ai_send')}
          disabled={sending ? false : !input.trim()}
          onClick={() => (sending ? stopGeneration() : void sendMessage())}
        >
          {sending ? <IconStop /> : <IconSend />}
        </button>
      </div>

      {/* Session list dialog */}
      {showSessions && (
        <Modal title={t('ai_session_list')} onClose={() => setShowSessions(false)}
          footer={<button class="btn btn--outlined" onClick={() => setShowSessions(false)}>{t('param_cancel')}</button>}>
          {sessions.length === 0 ? (
            <p class="wf-empty">{t('ai_no_sessions')}</p>
          ) : (
            <div class="ai-session-list">
              {sessions.map((s) => (
                <div class={'ai-session' + (s.id === currentSessionId ? ' ai-session--active' : '')} key={s.id}
                  onClick={() => { void restoreSession(s); setShowSessions(false); }}>
                  <div class="ai-session__info">
                    <b>{formatDate(s.updated_at || s.created_at)}</b>
                    <span>{modeLabel(s.mode)}</span>
                  </div>
                  <button class="ai-session__del" aria-label={t('ai_session_delete')}
                    onClick={(e) => { e.stopPropagation(); void deleteSession(s); }}>
                    {t('ai_session_delete')}
                  </button>
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────
// Chat bubble — item_chat_message.xml equivalent. The assistant bubble can
// carry an honest source badge (Private AI / Shared AI / …) and the honest
// streaming terminal states (streaming / cancelled / failed).
// ─────────────────────────────────────────────────────
function ChatBubble({ msg, onCopy }: { msg: ChatMsg; onCopy: () => void }) {
  const badgeKey = !msg.isUser ? sourceBadgeKey(msg.source) : null;
  const stateNote = !msg.isUser && msg.cancelled ? t('ai_cancelled') : null;
  return (
    <div class={'ai-bubble-wrap ' + (msg.isUser ? 'ai-bubble-wrap--user' : 'ai-bubble-wrap--bot')}>
      <div class={'ai-bubble' + (msg.isUser ? ' ai-bubble--user' : ' ai-bubble--bot') + (msg.failed ? ' ai-bubble--error' : '')}>
        {(badgeKey || msg.streaming || msg.cancelled) && (
          <div class="ai-bubble__meta">
            {badgeKey && <span class={'ai-bubble__source ai-bubble__source--' + msg.source}>{t(badgeKey as StrKey)}</span>}
            {msg.streaming && <span class="ai-bubble__state">{t('ai_state_streaming')}</span>}
            {msg.cancelled && !msg.text && <span class="ai-bubble__state">{stateNote}</span>}
          </div>
        )}
        <div class="ai-bubble__text" dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.text) }} />
        {msg.downloadUrl && (
          <a class="ai-bubble__dl" href={msg.downloadUrl} download>{t('ai_download_book')}</a>
        )}
        <button class="ai-bubble__copy" aria-label={t('action_copy')} onClick={onCopy}>
          <IconCopy />
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────
// Typing indicator — item_chat_typing.xml equivalent
// ─────────────────────────────────────────────────────
function TypingBubble() {
  return (
    <div class="ai-bubble-wrap ai-bubble-wrap--bot">
      <div class="ai-bubble ai-bubble--bot ai-bubble--typing">
        <span class="ai-typing-dot" /><span class="ai-typing-dot" /><span class="ai-typing-dot" />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────
// renderMarkdown — port of ChatMessage.applyMarkdownTo() (Android HTML pipeline).
// ─────────────────────────────────────────────────────
export function renderMarkdown(text: string): string {
  let p = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  p = p.replace(/```(\w*)\n?(.*?)```/gs, (_m, _lang, code) =>
    `<pre><code>${code.trim()}</code></pre>`);
  p = p.replace(/`([^`]*)`/g, '<code>$1</code>');
  p = p.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
  p = p.replace(/(?<![\w*])\*(?!\*)([^*]+)\*(?![\w*])/g, '<i>$1</i>');
  p = p.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) =>
    `<a href="${sanitizeUrl(url)}">${label}</a>`);
  p = p.replace(/^&gt;\s?(.*)$/gm, '<blockquote>$1</blockquote>');
  p = p.replace(/^-\s+(.*)$/gm, '<li>$1</li>');
  p = p.replace(/^\d+\.\s+(.*)$/gm, '<li>$1</li>');
  p = p.replace(/(<li>.*?<\/li>\s*)+/gs, '<ul>$&</ul>');
  p = p.replace(/^#{1,6}\s+(.*)$/gm, '<b>$1</b><br/>');
  p = p.replace(/\n\n/g, '<br/><br/>');
  p = p.replace(/\n/g, '<br/>');
  return p;
}

// The raw markdown URL goes into an href attribute — block dangerous schemes and
// strip quotes so it cannot break out of the attribute (unlike Android's
// Html.fromHtml, dangerouslySetInnerHTML has no platform sanitizer).
function sanitizeUrl(url: string): string {
  const trimmed = url.trim();
  if (/^(javascript|data|vbscript):/i.test(trimmed)) return '#';
  return trimmed.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { results: ArrayLike<{ 0: { transcript: string } }> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

function formatDate(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function buildToolResultMessage(res: AiChatResponse): string {
  if (res.patches_applied > 0) {
    return `✅ Changes applied: ${res.patches_applied} patch(es) to the book.`;
  }
  const errors = (res.tool_results ?? []).filter((t) => t.error != null);
  const successes = (res.tool_results ?? []).filter((t) => t.result != null || t.applied != null);
  const parts: string[] = [];
  parts.push(...errors.map((t) => `⚠️ ${t.tool}: ${t.error}`));
  parts.push(...successes.map((t) =>
    t.applied != null && t.applied > 0 ? `✅ ${t.tool}: ${t.applied} change(s) applied` : `✅ ${t.tool}: ${t.result ?? 'done'}`));
  // No patches, no tool results, no visible reply — the model produced
  // nothing usable (e.g. all tokens spent on reasoning). Honest retry hint
  // instead of the old misleading 'Tool executed.' ghost message.
  return parts.length ? parts.join('\n') : t('ai_no_result');
}

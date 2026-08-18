import { useState, useCallback, useEffect } from 'preact/hooks';
import { applyTheme, applyLanguage, readPrefs, writePrefs } from '../app/theme';
import type { ThemePref } from '../app/theme';
import { t, tf } from '../app/i18n';
import type { StrKey } from '../app/i18n';
import { getJson, putJson, deleteJson } from '../api/client';
import { bookId, resetProgressState, closeBook as closeGenerateBook } from '../state/generateStore';
import { closeBook as closePlayerBook } from '../state/playbackStore';
import { clearCache as clearMediaCache } from '../cache/mediaCache';
import { Modal, toast } from '../lib/ui';
import { workerType } from '../app/routeState';
import { navigate } from '../app/router';
import type { Route } from '../app/router';

// SettingsPage covers: /settings (general), /settings/vbook (section="vbook"),
// /settings/worker (section="worker"). 1:1 with SettingsFragment +
// VBookSettingsFragment + WorkerSettingsFragment (stage 1).
export function SettingsPage(props: { section?: string; path?: string }) {
  const { section } = props;
  if (section === 'vbook') return <VBookSection />;
  if (section === 'worker') return <WorkerSection />;
  return <GeneralSection />;
}

// ─────────────────────────────────────────────────────────────
// /settings — General (theme + language + server + clear/delete + debug)
// 1:1 with SettingsFragment + fragment_settings.xml (stage 1).
// ─────────────────────────────────────────────────────────────

function GeneralSection() {
  const prefs = readPrefs();
  const [theme, setTheme] = useState<ThemePref>(prefs.theme ?? 'auto');
  const [language, setLanguage] = useState<'auto' | 'ru' | 'en'>(prefs.language ?? 'auto');
  const [, setLanguageTick] = useState(0);
  const [confirm, setConfirm] = useState<null | { kind: 'clear' | 'delete'; message: string }>(null);
  const [busy, setBusy] = useState(false);

  const onTheme = useCallback((v: ThemePref) => {
    setTheme(v); writePrefs({ theme: v }); applyTheme(v);
  }, []);
  const onLang = useCallback((v: 'auto' | 'ru' | 'en') => {
    setLanguage(v); writePrefs({ language: v }); applyLanguage(v);
    // Trigger a re-render to refresh localized strings (lang attr already set).
    setLanguageTick((n) => n + 1);
  }, []);

  // Server URL — web is same-origin (BASE = "/api/v1"), so this mirrors the
  // read-only BuildConfig.BASE_URL display Android pre-fills. §14 deviation:
  // not editable because the web app cannot switch servers per-install.
  const serverUrl = typeof location !== 'undefined' ? location.origin : '';
  const debugText = `App: Animastor Web 0.1\nServer: ${serverUrl}`;

  // clearCacheButton — Android: no book → Repository.clearCache() + toast;
  // book open → confirm dialog → clearBookCache + clearCache + player reset
  // + resetProgressState (book structure stays intact, Navigator keeps it).
  const onClearCache = () => {
    if (!bookId.value) {
      void clearMediaCache()
        .then((n) => toast(tf('settings_cache_cleared_local', n)))
        .catch((e) => toast(tf('ai_error', (e as Error).message), 4000));
      return;
    }
    setConfirm({ kind: 'clear', message: t('settings_cache_clear_confirm') });
  };

  // deleteVbookButton — Android: no book → toast "No book open"; book open →
  // confirm dialog → deleteBook + clearCache + close both ViewModels.
  const onDeleteVbook = () => {
    if (!bookId.value) {
      toast(t('settings_no_book_open'));
      return;
    }
    setConfirm({ kind: 'delete', message: t('settings_delete_vbook_confirm') });
  };

  const runConfirm = async () => {
    if (!confirm || busy) return;
    const currentBook = bookId.value;
    if (!currentBook) { setConfirm(null); return; } // book closed while dialog up
    setBusy(true);
    try {
      if (confirm.kind === 'clear') {
        // DELETE /book/:id/cache — generated assets only; structure preserved.
        await deleteJson(`/book/${encodeURIComponent(currentBook)}/cache`);
        await clearMediaCache();
        closePlayerBook();       // playbackViewModel.closeBook()
        resetProgressState();    // viewModel.resetProgressState()
        toast(t('settings_cache_cleared'));
      } else {
        await deleteJson(`/book/${encodeURIComponent(currentBook)}`);
        await clearMediaCache();
        closeGenerateBook();     // resets generate + playback (closeBook both)
        toast(t('settings_delete_vbook_done'));
      }
    } catch (e) {
      toast(tf('ai_error', (e as Error).message), 4000);
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  return (
    <section class="page settings-page">
      <div class="settings-page__scroll">
        {/* Theme / Language */}
        <div class="settings__group">
          <div class="settings__row">
            <span>{t('settings_theme')}</span>
            <Segmented
              value={theme}
              options={[['auto', t('settings_theme_auto')], ['dark', t('settings_theme_dark')], ['light', t('settings_theme_light')]]}
              onChange={(v) => onTheme(v as ThemePref)}
            />
          </div>
          <div class="settings__row">
            <span>{t('settings_language')}</span>
            <Segmented
              value={language}
              options={[['auto', t('settings_language_auto')], ['ru', t('settings_language_ru')], ['en', t('settings_language_en')]]}
              onChange={(v) => onLang(v as 'auto' | 'ru' | 'en')}
            />
          </div>
        </div>

        {/* Server — settings_server + serverUrlInput (read-only, §14) */}
        <div class="settings__group settings__group--stack">
          <span class="settings__label">{t('settings_server')}</span>
          <input class="settings__input" value={serverUrl} readOnly aria-label={t('settings_server')} />
        </div>

        {/* VBook / Worker — 1:1 with VBookSettingsFragment / WorkerSettingsFragment,
            which Android opens from GenerateFragment's gear icons. Placed ABOVE the
            destructive Cache/Storyboard buttons per user request. */}
        <div class="settings__group">
          <NavRow label={t('vbook_settings_title')} onClick={() => navigate('/settings/vbook')} />
          <NavRow label={t('worker_settings_title')} onClick={() => navigate('/settings/worker')} />
        </div>

        {/* Cache / Storyboard — settings_cache + clearCacheButton + deleteVbookButton
            (Widget.Animastor.Button.Outlined.Error, 42dp, match_parent). */}
        <div class="settings__group settings__group--stack">
          <span class="settings__label">{t('settings_cache')}</span>
          <button class="btn btn--outlined btn--error" onClick={onClearCache} disabled={busy}>
            {t('settings_cache_clear')}
          </button>
          <button class="btn btn--outlined btn--error" onClick={onDeleteVbook} disabled={busy}>
            {t('settings_delete_vbook')}
          </button>
        </div>

        {/* Debug — settings_debug + debugInfo (11sp onSurfaceVariant) */}
        <div class="settings__group settings__group--stack">
          <span class="settings__label">{t('settings_debug')}</span>
          <pre class="settings__debug">{debugText}</pre>
        </div>
      </div>

      {/* Instant apply (web parity): theme/language already apply live on
          selection — no Apply button. Back navigates out. */}

      {/* AlertDialog — DialogDeleteVbookBinding (title + message + OK/Cancel) */}
      {confirm && (
        <Modal
          title={confirm.kind === 'clear' ? t('settings_cache_clear') : t('settings_delete_vbook')}
          onClose={() => { if (!busy) setConfirm(null); }}
        >
          <p class="modal__notice">{confirm.message}</p>
          <div class="modal__footer">
            <button class="btn btn--outlined" onClick={() => { if (!busy) setConfirm(null); }} disabled={busy}>
              {t('dialog_cancel')}
            </button>
            <button class="btn" onClick={runConfirm} disabled={busy}>
              {busy ? t('play_loading') : t('dialog_ok')}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}

function NavRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button class="settings__nav-row" onClick={onClick}>
      <span>{label}</span>
      <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M9 6l6 6-6 6" /></svg>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────
// /settings/vbook — VBookSettings (chunk size, scenes per pass)
// 1:1 with VBookSettingsFragment + fragment_vbook_settings.xml
// ─────────────────────────────────────────────────────────────

type LayerConfig = {
  chunk_size?: number;
  audio_timeout_minutes?: number | null;
  image_timeout_minutes?: number | null;
  video_timeout_minutes?: number | null;
};

const DEFAULT_CHUNK_SIZE = 3;

function VBookSection() {
  const [chunk, setChunk] = useState(DEFAULT_CHUNK_SIZE);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const currentBook = bookId.value;

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!currentBook) return;
      try {
        const cfg = await getJson<LayerConfig>(`/book/${encodeURIComponent(currentBook)}/layer-config`);
        if (alive) setChunk(Math.min(5, Math.max(1, cfg.chunk_size ?? DEFAULT_CHUNK_SIZE)));
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    })();
    return () => { alive = false; };
  }, [currentBook]);

  // Instant apply: the selection IS the save. No Apply button.
  const saveChunk = async (value: number) => {
    if (!currentBook || saving) return;
    setSaving(true); setError('');
    try {
      await putJson(`/book/${encodeURIComponent(currentBook)}/layer-config`, { chunk_size: value });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section class="page settings-page">
      <div class="settings-page__scroll">
        {!currentBook && <p class="settings-page__notice">{t('settings_no_book')}</p>}
        <div class="card">
          <h3 class="card__title">{t('vbook_settings_scenes_per_pass')}</h3>
          <div class="card__row">
            <select
              class="select"
              value={chunk}
              disabled={!currentBook || saving}
              aria-label={t('vbook_settings_scenes_per_pass')}
              onChange={(e) => {
                const v = Number((e.target as HTMLSelectElement).value);
                setChunk(v);
                void saveChunk(v);
              }}
            >
              {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <button class="btn btn--outlined" disabled={!currentBook || saving} onClick={() => {
              setChunk(DEFAULT_CHUNK_SIZE);
              void saveChunk(DEFAULT_CHUNK_SIZE);
            }}>
              {t('vbook_settings_default')}
            </button>
          </div>
          <p class="card__hint">{t('vbook_settings_scenes_per_pass_desc')}</p>
          {error && <p class="settings-page__error">{error}</p>}
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// /settings/worker — WorkerSettings (profile / timeout / workflow)
// 1:1 with WorkerSettingsFragment + fragment_worker_settings.xml.
// Android opens one fragment per worker type; here a segmented
// control switches the type on the single /settings/worker route.
// ─────────────────────────────────────────────────────────────

type WorkerType = 'audio' | 'image' | 'video';

const TIMEOUT_OPTIONS: Record<WorkerType, number[]> = {
  audio: [5, 10, 15, 20, 30, 45, 60, 90, 120],
  image: [5, 10, 15, 20, 30, 45, 60, 90, 120],
  video: [10, 15, 20, 30, 45, 60, 90, 120, 150, 180],
};
const TIMEOUT_DEFAULT: Record<WorkerType, number> = { audio: 30, image: 30, video: 60 };
const TIMEOUT_FIELD: Record<WorkerType, keyof LayerConfig> = {
  audio: 'audio_timeout_minutes',
  image: 'image_timeout_minutes',
  video: 'video_timeout_minutes',
};
const PROFILE_LABEL: Record<WorkerType, StrKey> = {
  audio: 'settings_audio_profile',
  image: 'settings_image_profile',
  video: 'settings_video_profile',
};
// Full localized worker title — Android passes this as workerLabel to
// worker_settings_timeout_label ("Audio Generation Settings timeout").
const WORKER_TITLE: Record<WorkerType, StrKey> = {
  audio: 'worker_settings_title_audio',
  image: 'worker_settings_title_image',
  video: 'worker_settings_title_video',
};
const PROFILE_DEFAULT: Record<WorkerType, string> = {
  audio: 'qwen-tts',
  image: 'qwen-image',
  video: 'ltx-2.3',
};

interface ConnectorProfiles {
  profiles?: { audio?: string | null; image?: string | null; video?: string | null };
  options?: { audio?: string[]; image?: string[]; video?: string[] };
}
interface ConnectorSummary { label: string; workflow: string; enabled: boolean }
interface ConnectorGrouped { audio?: ConnectorSummary[]; image?: ConnectorSummary[]; video?: ConnectorSummary[] }
interface WorkerCounts {
  audio?: number; image?: number; video?: number; vbook?: number;
  active_audio?: number; active_image?: number; active_video?: number; active_vbook?: number;
}

const WORKER_TYPES: { type: WorkerType; label: StrKey }[] = [
  { type: 'audio', label: 'layer_audio' },
  { type: 'image', label: 'layer_image' },
  { type: 'video', label: 'layer_video' },
];
const COUNT_ROWS: { key: WorkerType | 'vbook'; activeKey: 'active_audio' | 'active_image' | 'active_video' | 'active_vbook'; label: StrKey }[] = [
  { key: 'audio', activeKey: 'active_audio', label: 'layer_audio' },
  { key: 'image', activeKey: 'active_image', label: 'layer_image' },
  { key: 'video', activeKey: 'active_video', label: 'layer_video' },
  { key: 'vbook', activeKey: 'active_vbook', label: 'worker_vbook' },
];

function WorkerSection() {
  // WorkerSettingsFragment.newInstance(type, label) equivalent — Generate
  // sets routeState.workerType before navigating (stage 4).
  const [type, setType] = useState<WorkerType>(workerType.value ?? 'audio');
  const [cfg, setCfg] = useState<LayerConfig | null>(null);
  const [profiles, setProfiles] = useState<ConnectorProfiles | null>(null);
  const [grouped, setGrouped] = useState<ConnectorGrouped | null>(null);
  const [counts, setCounts] = useState<WorkerCounts | null>(null);
  const [timeoutMinutes, setTimeoutMinutes] = useState(TIMEOUT_DEFAULT.audio);
  const [profileName, setProfileName] = useState(PROFILE_DEFAULT.audio);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const currentBook = bookId.value;

  // Load all screen data once; selection state follows the active type.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [c, p, g, w] = await Promise.all([
          currentBook
            ? getJson<LayerConfig>(`/book/${encodeURIComponent(currentBook)}/layer-config`).catch(() => null)
            : Promise.resolve(null),
          getJson<ConnectorProfiles>('/connectors/profiles').catch(() => null),
          getJson<ConnectorGrouped>('/connectors/grouped').catch(() => null),
          getJson<WorkerCounts>('/worker/counts').catch(() => null),
        ]);
        if (!alive) return;
        setCfg(c); setProfiles(p); setGrouped(g); setCounts(w);
        setTimeoutMinutes(c?.[TIMEOUT_FIELD.audio] ?? TIMEOUT_DEFAULT.audio);
        setProfileName(p?.profiles?.audio || PROFILE_DEFAULT.audio);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    })();
    return () => { alive = false; };
  }, [currentBook]);

  const onTypeChange = (t: WorkerType) => {
    setType(t);
    setTimeoutMinutes(cfg?.[TIMEOUT_FIELD[t]] ?? TIMEOUT_DEFAULT[t]);
    setProfileName(profiles?.profiles?.[t] || PROFILE_DEFAULT[t]);
  };

  const timeoutOptions = TIMEOUT_OPTIONS[type];
  const selectedTimeoutIdx = Math.max(0, timeoutOptions.findIndex((v) => v >= timeoutMinutes));

  // Coerce to an existing option (Android: options.indexOf(current).coerceAtLeast(0)).
  const opts = profiles?.options?.[type] ?? [];
  const profileOptions = opts.length ? opts : [profileName];
  const displayProfile = profileOptions.includes(profileName)
    ? profileName
    : (profileOptions[0] ?? profileName);

  const activeConnectors = (grouped?.[type] ?? []).filter((c) => c.enabled);
  const workflowText = activeConnectors.length
    ? activeConnectors.map((c) => `${c.label} (${c.workflow})`).join('\n')
    : t('workflow_manager_no_workflows');

  // Instant apply: the timeout selection IS the save. No Apply button.
  const saveTimeout = async (minutes: number) => {
    if (!currentBook || saving) return;
    setSaving(true); setError('');
    try {
      await putJson(`/book/${encodeURIComponent(currentBook)}/layer-config`, {
        [TIMEOUT_FIELD[type]]: minutes,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  // Instant apply: the profile selection IS the save (global override).
  // PUT /connectors/profiles persists it; the backend honors it in prompt
  // assembly + skill injection. No Apply button.
  const saveProfile = async (profile: string) => {
    if (saving) return;
    setSaving(true); setError('');
    try {
      await putJson('/connectors/profiles', { type, profile });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section class="page settings-page">
      <div class="settings-page__scroll">
        {!currentBook && <p class="settings-page__notice">{t('settings_no_book')}</p>}

        {/* Worker type switcher (Android: separate fragment per type) */}
        <div class="seg seg--block" role="tablist" aria-label={t('worker_settings_title')}>
          {WORKER_TYPES.map(({ type: wt, label }) => (
            <button
              key={wt}
              role="tab"
              aria-selected={type === wt}
              class={'seg__btn' + (type === wt ? ' seg__btn--active' : '')}
              onClick={() => onTypeChange(wt)}
            >{t(label)}</button>
          ))}
        </div>

        {/* Save errors from any card (profile/timeout) surface here, above all cards */}
        {error && <p class="settings-page__error">{error}</p>}

        {/* ── Workers (availability) — /worker/counts ── */}
        <div class="card card--counts">
          <h3 class="card__title">{t('worker_settings_workers_title')}</h3>
          {counts ? (
            COUNT_ROWS.map(({ key, activeKey, label }) => (
              <div class="card__row card__row--between" key={key}>
                <span>{t(label)}</span>
                <span class="card__value">{tf('worker_counts_fmt', counts[key] ?? 0, counts[activeKey] ?? 0)}</span>
              </div>
            ))
          ) : error ? (
            <p class="card__hint">—</p>
          ) : (
            <p class="card__hint">{t('play_loading')}</p>
          )}
        </div>

        {/* ── Profile ── */}
        <div class="card">
          <h3 class="card__title">{t('settings_prompt_profiles')}</h3>
          <p class="card__label">{t(PROFILE_LABEL[type])}</p>
          <select
            class="select"
            value={displayProfile}
            aria-label={t(PROFILE_LABEL[type])}
            disabled={saving}
            onChange={(e) => {
              const v = (e.target as HTMLSelectElement).value;
              setProfileName(v);
              void saveProfile(v);
            }}
          >
            {profileOptions.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
          <p class="card__hint">{t('settings_profiles_saved_and_applied')}</p>
        </div>

        {/* ── Timeout ── */}
        <div class="card">
          <h3 class="card__title">{t('worker_settings_timeout_title')}</h3>
          <p class="card__label">{tf('worker_settings_timeout_label', t(WORKER_TITLE[type]))}</p>
          <div class="card__row">
            <select
              class="select"
              value={timeoutOptions[selectedTimeoutIdx]}
              disabled={!currentBook || saving}
              aria-label={tf('worker_settings_timeout_label', t(WORKER_TITLE[type]))}
              onChange={(e) => {
                const v = Number((e.target as HTMLSelectElement).value);
                setTimeoutMinutes(v);
                void saveTimeout(v);
              }}
            >
              {timeoutOptions.map((m) => (
                <option key={m} value={m}>{m} {t('worker_settings_timeout_unit')}</option>
              ))}
            </select>
            <button class="btn btn--outlined" disabled={!currentBook || saving} onClick={() => {
              setTimeoutMinutes(TIMEOUT_DEFAULT[type]);
              void saveTimeout(TIMEOUT_DEFAULT[type]);
            }}>
              {t('worker_settings_default')}
            </button>
          </div>
          <p class="card__hint">{t('worker_settings_timeout_desc')}</p>
        </div>

        {/* ── Workflow ── */}
        <div class="card">
          <h3 class="card__title">{t('workflow_manager_title')}</h3>
          <p class="card__hint card__hint--wrap">{workflowText}</p>
          <button
            class="btn btn--outlined"
            onClick={() => navigate(('/workflows/type/' + type) as Route)}
          >
            {t('workflow_manager_manage')}
          </button>
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// Shared
// ─────────────────────────────────────────────────────────────

function Segmented({ value, options, onChange }:
  { value: string; options: [string, string][]; onChange: (v: string) => void }) {
  return (
    <div class="seg">
      {options.map(([val, label]) => (
        <button
          key={val}
          class={'seg__btn' + (value === val ? ' seg__btn--active' : '')}
          onClick={() => onChange(val)}
        >{label}</button>
      ))}
    </div>
  );
}

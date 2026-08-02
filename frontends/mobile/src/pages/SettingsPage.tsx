import { useState, useCallback, useEffect } from 'preact/hooks';
import { applyTheme, applyLanguage, readPrefs, writePrefs } from '../app/theme';
import type { ThemePref } from '../app/theme';
import { t, tf } from '../app/i18n';
import type { StrKey } from '../app/i18n';
import { getJson, putJson } from '../api/client';
import { bookId } from '../state/generateStore';
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
// /settings — General (theme + language) — stage 0
// ─────────────────────────────────────────────────────────────

function GeneralSection() {
  const prefs = readPrefs();
  const [theme, setTheme] = useState<ThemePref>(prefs.theme ?? 'auto');
  const [language, setLanguage] = useState<'auto' | 'ru' | 'en'>(prefs.language ?? 'auto');
  const [, setLanguageTick] = useState(0);

  const onTheme = useCallback((v: ThemePref) => {
    setTheme(v); writePrefs({ theme: v }); applyTheme(v);
  }, []);
  const onLang = useCallback((v: 'auto' | 'ru' | 'en') => {
    setLanguage(v); writePrefs({ language: v }); applyLanguage(v);
    // Trigger a re-render to refresh localized strings (lang attr already set).
    setLanguageTick((n) => n + 1);
  }, []);

  return (
    <section class="page">
      <h2 style="font-size:1rem;margin:0 0 .75rem">{t('settings_title')}</h2>

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

      {/* VBook / Worker — 1:1 with VBookSettingsFragment / WorkerSettingsFragment,
          which Android opens from GenerateFragment's gear icons. */}
      <div class="settings__group" style="margin-top:1rem">
        <NavRow label={t('vbook_settings_title')} onClick={() => navigate('/settings/vbook')} />
        <NavRow label={t('worker_settings_title')} onClick={() => navigate('/settings/worker')} />
      </div>
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

// Android pops the back stack after Apply; on a deep-link entry there is no
// history to pop, so fall back to the Settings hub to avoid leaving the app.
function goBackToSettings() {
  if (history.length > 1) history.back();
  else navigate('/settings');
}

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

  const onApply = async () => {
    if (!currentBook || saving) return;
    setSaving(true); setError('');
    try {
      await putJson(`/book/${encodeURIComponent(currentBook)}/layer-config`, { chunk_size: chunk });
      goBackToSettings(); // = parentFragmentManager.popBackStack()
    } catch (e) {
      setError((e as Error).message);
      setSaving(false); // keep page open so user can retry
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
              disabled={!currentBook}
              aria-label={t('vbook_settings_scenes_per_pass')}
              onChange={(e) => setChunk(Number((e.target as HTMLSelectElement).value))}
            >
              {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <button class="btn btn--outlined" onClick={() => setChunk(DEFAULT_CHUNK_SIZE)}>
              {t('vbook_settings_default')}
            </button>
          </div>
          <p class="card__hint">{t('vbook_settings_scenes_per_pass_desc')}</p>
        </div>
      </div>
      <div class="settings-page__footer">
        {error && <p class="settings-page__error">{error}</p>}
        <button class="btn btn--block" onClick={onApply} disabled={!currentBook || saving}>
          {saving ? t('play_loading') : t('vbook_settings_apply')}
        </button>
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

  const onApply = async () => {
    if (!currentBook || saving) return;
    setSaving(true); setError('');
    try {
      await putJson(`/book/${encodeURIComponent(currentBook)}/layer-config`, {
        [TIMEOUT_FIELD[type]]: timeoutOptions[selectedTimeoutIdx],
      });
      goBackToSettings(); // = popBackStack
    } catch (e) {
      setError((e as Error).message);
      setSaving(false); // keep page open so user can retry
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

        {/* ── Workers (availability) — /worker/counts ── */}
        <div class="card">
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
            onChange={(e) => setProfileName((e.target as HTMLSelectElement).value)}
          >
            {profileOptions.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
          <p class="card__hint">{t('settings_profiles_determined_by_workflow')}</p>
        </div>

        {/* ── Timeout ── */}
        <div class="card">
          <h3 class="card__title">{t('worker_settings_timeout_title')}</h3>
          <p class="card__label">{tf('worker_settings_timeout_label', t(WORKER_TITLE[type]))}</p>
          <div class="card__row">
            <select
              class="select"
              value={timeoutOptions[selectedTimeoutIdx]}
              aria-label={tf('worker_settings_timeout_label', t(WORKER_TITLE[type]))}
              onChange={(e) => setTimeoutMinutes(Number((e.target as HTMLSelectElement).value))}
            >
              {timeoutOptions.map((m) => (
                <option key={m} value={m}>{m} {t('worker_settings_timeout_unit')}</option>
              ))}
            </select>
            <button class="btn btn--outlined" onClick={() => setTimeoutMinutes(TIMEOUT_DEFAULT[type])}>
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

      <div class="settings-page__footer">
        {error && <p class="settings-page__error">{error}</p>}
        <button class="btn btn--block" onClick={onApply} disabled={!currentBook || saving}>
          {saving ? t('play_loading') : t('worker_settings_apply')}
        </button>
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

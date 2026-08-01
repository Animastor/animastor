import { useState, useCallback } from 'preact/hooks';
import { applyTheme, applyLanguage, readPrefs, writePrefs } from '../app/theme';
import type { ThemePref } from '../app/theme';
import { t } from '../app/i18n';

// SettingsPage covers: /settings (general), /settings/vbook (section="vbook"),
// /settings/worker (section="worker"). Renderer per section is added at stage 1.
export function SettingsPage(props: { section?: string; path?: string }) {
  const { section } = props;
  if (section === 'vbook') return <VBookSection />;
  if (section === 'worker') return <WorkerSection />;
  return <GeneralSection />;
}

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
    </section>
  );
}

function VBookSection() {
  return (
    <section class="page page--centered">
      <p class="page__ph">{t('vbook_settings_title')}</p>
    </section>
  );
}

function WorkerSection() {
  return (
    <section class="page page--centered">
      <p class="page__ph">{t('worker_settings_title')} · /api/v1/worker/counts</p>
    </section>
  );
}

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

import { t } from '../app/i18n';
import type { StrKey } from '../app/i18n';

export function PlaceholderPage({ titleKey }: { titleKey: StrKey; path?: string }) {
  return (
    <section class="page page--centered">
      <p class="page__ph">{t(titleKey)}</p>
      <p class="page__ph" style="opacity:.6;font-size:.875rem;margin-top:.5rem">
        {t('coming_soon')}
      </p>
    </section>
  );
}

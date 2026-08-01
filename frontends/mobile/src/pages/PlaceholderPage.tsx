import { t } from '../app/i18n';

export function PlaceholderPage({ title }: { title: string; path?: string }) {
  return (
    <section class="page page--centered">
      <p class="page__ph">{title}</p>
      <p class="page__ph" style="opacity:.6;font-size:.875rem;margin-top:.5rem">
        {t('play_placeholder')}
      </p>
    </section>
  );
}

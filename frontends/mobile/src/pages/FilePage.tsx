import { t } from '../app/i18n';

export function FilePage(props: { path?: string }) {
  void props;
  return (
    <section class="page page--centered">
      <p class="page__ph">{t('empty_state')}</p>
    </section>
  );
}

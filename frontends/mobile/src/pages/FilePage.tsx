import { t } from '../app/i18n';
import { navigate } from '../app/router';

// FilePage — stub (full implementation is stage 3). The Library card mirrors
// FileFragment.libraryCard → LibraryFragment (Android), giving access to /library.
export function FilePage(props: { path?: string }) {
  void props;
  return (
    <section class="page page--centered">
      <p class="page__ph">{t('empty_state')}</p>
      <button class="btn btn--outlined" style="margin-top:1rem" onClick={() => navigate('/library')}>
        {t('library_title')}
      </button>
    </section>
  );
}

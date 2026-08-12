import { t } from '../app/i18n';

// Library — 1:1 with LibraryFragment (WebView → iframe to animastor.in/library,
// the project's public help/release-notes site, see R13 in 06-RISKS).
// NB: https://animastor.in/ is behind nginx Basic Auth; only /library is public,
// so the iframe must point at the public path (R16, global Basic Auth).
const LIBRARY_URL = 'https://animastor.in/library';

export function LibraryPage(props: { path?: string }) {
  void props;
  return (
    <section class="library-page">
      <iframe
        class="library-page__frame"
        src={LIBRARY_URL}
        title={t('library_title')}
        loading="eager"
      />
      <a class="library-page__open" href={LIBRARY_URL} target="_blank" rel="noopener noreferrer">
        {t('library_open_external')}
      </a>
    </section>
  );
}

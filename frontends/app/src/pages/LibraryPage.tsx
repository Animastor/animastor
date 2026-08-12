import { t } from '../app/i18n';

// Library — 1:1 with LibraryFragment (WebView → iframe of the public library).
// The app lives on app.animastor.in behind nginx Basic Auth; /library is the one
// public route (nginx serves it without auth), so a relative URL is used — it
// resolves on any host (prod app.animastor.in, dev :5174 via vite proxy).
const LIBRARY_URL = '/library';

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

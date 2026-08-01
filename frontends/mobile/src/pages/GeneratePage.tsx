import { generationStatus, vbookProgressStage, bookId } from '../state/generateStore';
import { t } from '../app/i18n';

export function GeneratePage(props: { path?: string }) {
  void props;
  const status = generationStatus.value;
  return (
    <section class="page page--centered">
      <p class="page__ph">{bookId.value ? 'book: ' + bookId.value : t('empty_state')}</p>
      <p class="page__ph" style="opacity:.6;font-size:.875rem;margin-top:.5rem">
        status: {status} · stage: {vbookProgressStage.value}
      </p>
    </section>
  );
}

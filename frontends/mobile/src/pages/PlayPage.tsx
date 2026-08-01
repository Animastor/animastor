import { uiState, bookId } from '../state/playbackStore';
import { t } from '../app/i18n';

export function PlayPage(props: { path?: string }) {
  void props;
  const s = uiState.value;
  return (
    <section class="page page--centered">
      <p class="page__ph">
        {bookId.value ? `${s.phase} · ${s.currentIndex + 1}/${s.sceneCount}` : t('play_placeholder')}
      </p>
      {!bookId.value && (
        <p class="page__ph" style="opacity:.6;font-size:.875rem;margin-top:.5rem">
          {t('empty_state')}
        </p>
      )}
    </section>
  );
}

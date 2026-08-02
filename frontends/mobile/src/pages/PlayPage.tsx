import { uiState, bookId, missingIuPosition } from '../state/playbackStore';
import { t } from '../app/i18n';

// PlayPage — UI stub until stage 7. Stage 5 adds the missing-IU overlay
// (showMissingChunkOverlay equivalent): when a seek from Navigate/Edit targets a
// scene that no longer exists in the book, PlaybackViewModel.seekToPosition sets
// missingIuPosition and the player shows "Не сгенерировано" instead of playing.
export function PlayPage(props: { path?: string }) {
  void props;
  const s = uiState.value;
  const missing = missingIuPosition.value;
  return (
    <section class="page page--centered">
      {missing ? (
        <div class="play-missing" role="alert" aria-live="polite">
          <p class="page__ph" style="font-weight:700">{t('iu_not_generated')}</p>
          <p class="page__ph" style="opacity:.65;font-size:.8125rem">
            {missing.chapterId}/{missing.sceneId}/{missing.unitId ?? ''}
          </p>
        </div>
      ) : (
        <>
          <p class="page__ph">
            {bookId.value ? `${s.phase} · ${s.currentIndex + 1}/${s.sceneCount}` : t('play_placeholder')}
          </p>
          {!bookId.value && (
            <p class="page__ph" style="opacity:.6;font-size:.875rem;margin-top:.5rem">
              {t('empty_state')}
            </p>
          )}
        </>
      )}
    </section>
  );
}

// PlayPage — 1:1 with fragment_play.xml + PlayFragment.kt UI collectors (stage 7).
// The audio/video engine lives in playbackStore (survives tab switches); this
// component renders the media viewport (curtains/cover/result/video/missing/
// subtitle), the 4 layer chips, the big play button, progress and status, plus
// the fullscreen toggle anchored to the displayed image bounds
// (anchorFullscreenToImage). All state comes from playbackStore signals.
import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useSignalEffect } from '@preact/signals';
import { t } from '../app/i18n';
import {
  uiState, bookId, missingIuPosition, coverImage, previewImage, currentIuBlobUrl,
  subtitleText, iuMissing, videoVisible,
  layerAudio, layerImage, layerVideo, layerSubtitles,
  handlePlayButton, pauseIfPlaying, checkPendingExternalSeek, ensureInitialized,
  attachVideo, detachVideo, restoreSavedPositionIfAny, sceneQueueSize,
  setLayerAudio, setLayerImage, setLayerVideo, setLayerSubtitles,
} from '../state/playbackStore';
import type { PlaybackUiState } from '../state/playbackStore';
import { bookId as genBookId, buildId as genBuildId } from '../state/generateStore';
import {
  IconPlay, IconPause, IconVolumeUp, IconVolumeOff, IconImage, IconImageOff,
  IconVideocam, IconVideocamOff, IconSubtitles, IconSubtitlesOff,
  IconFullscreen, IconFullscreenExit,
} from '../app/icons';
import type { IconProps } from '../app/icons';

function statusText(s: PlaybackUiState): string {
  if (s.errorMessage) return `Error: ${s.errorMessage}`;
  switch (s.phase) {
    case 'LOADING_BOOK':
    case 'GENERATING':
    case 'DOWNLOADING':
    case 'IMPORTING_TXT':
      return t('play_loading');
    case 'SCENE_READY':
      return t('play_ready');
    case 'PLAYING':
      return t('play_playing');
    case 'PAUSED':
      return t('play_paused');
    case 'IDLE':
    default:
      if (!bookId.value && !genBookId.value) return t('empty_state');
      if (!bookId.value) return t('play_placeholder_no_generation');
      return t('empty_state_book_loaded');
  }
}

function LayerChip({ checked, onToggle, label, On, Off }: {
  checked: boolean;
  onToggle: (v: boolean) => void;
  label: string;
  On: (p: IconProps) => JSX.Element;
  Off: (p: IconProps) => JSX.Element;
}) {
  return (
    <button
      type="button"
      class={'chip chip--layer' + (checked ? ' chip--layer--on' : '')}
      aria-label={label}
      aria-pressed={checked}
      onClick={() => onToggle(!checked)}
    >
      {checked ? <On width={24} height={24} /> : <Off width={24} height={24} />}
    </button>
  );
}

export function PlayPage(props: { path?: string }) {
  void props;
  const s = uiState.value;
  const missing = missingIuPosition.value;

  const mediaRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLImageElement>(null);
  const coverRef = useRef<HTMLImageElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const subtitleRef = useRef<HTMLParagraphElement>(null);
  const fsBtnRef = useRef<HTMLButtonElement>(null);
  const [isFs, setIsFs] = useState(false);

  // ── Mount: adopt video, restore position, auto-init, execute pending seek;
  //    unmount: tab hidden → pause (onHiddenChanged) + detach video. ──
  useEffect(() => {
    if (videoRef.current) attachVideo(videoRef.current);
    restoreSavedPositionIfAny();
    if (!bookId.value && genBookId.value) {
      void ensureInitialized(genBookId.value, genBuildId.value);
    }
    checkPendingExternalSeek();
    return () => {
      detachVideo();
      pauseIfPlaying();
    };
  }, []);

  // ── Fullscreen (toggleFullscreen) — media container, hides controls via CSS. ──
  useEffect(() => {
    const onFs = () => setIsFs(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);
  function toggleFullscreen() {
    const el = mediaRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen?.().catch(() => { });
    } else if (el.requestFullscreen) {
      void el.requestFullscreen().catch(() => { });
    }
  }

  // ── anchorFullscreenToImage: keep the fs button on the displayed image's
  //    bottom-right corner (letterbox) and above the subtitle when visible. ──
  const anchorFullscreen = () => {
    const btn = fsBtnRef.current;
    const container = mediaRef.current;
    if (!btn || !container) return;
    let tx = 0;
    let ty = 0;
    const vW = container.clientWidth;
    const vH = container.clientHeight;
    const img = resultRef.current?.style.display !== 'none' && resultRef.current?.src
      ? resultRef.current
      : coverRef.current;
    if (img && img.src && vW > 0 && vH > 0) {
      const dW = img.naturalWidth;
      const dH = img.naturalHeight;
      if (dW > 0 && dH > 0) {
        const scale = Math.min(vW / dW, vH / dH);
        tx = -(vW - dW * scale) / 2;
        ty = -(vH - dH * scale) / 2;
      }
    }
    const sub = subtitleRef.current;
    if (sub && subtitleText.value && vH > 0) {
      const containerTop = container.getBoundingClientRect().top;
      const subTop = sub.getBoundingClientRect().top - containerTop;
      const targetBottom = subTop - 6;         // 6dp gap
      const btnDefaultBottom = vH - 14;        // 14dp margin
      ty = Math.min(ty, targetBottom - btnDefaultBottom);
    }
    btn.style.transform = `translate(${tx}px, ${ty}px)`;
  };
  // Re-anchor on signal changes (per-unit IU cycling, cover, subtitle, layers).
  useSignalEffect(() => {
    void currentIuBlobUrl.value;
    void coverImage.value;
    void subtitleText.value;
    void layerImage.value;
    void layerSubtitles.value;
    void uiState.value.phase;
    requestAnimationFrame(anchorFullscreen);
  });
  // Re-anchor on image load (naturalWidth becomes available) and container resize.
  useEffect(() => {
    resultRef.current?.addEventListener('load', anchorFullscreen);
    coverRef.current?.addEventListener('load', anchorFullscreen);
    const ro = new ResizeObserver(anchorFullscreen);
    if (mediaRef.current) ro.observe(mediaRef.current);
    return () => {
      resultRef.current?.removeEventListener('load', anchorFullscreen);
      coverRef.current?.removeEventListener('load', anchorFullscreen);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Render state (fragment observeState collectors) ──
  const imgSrc = s.phase === 'SCENE_READY' && previewImage.value ? previewImage.value : currentIuBlobUrl.value;
  const showResult = !!imgSrc && layerImage.value;
  const showCover = !!coverImage.value && !showResult;
  const showCurtains = !coverImage.value && !showResult && !previewImage.value;
  const loading = s.phase === 'DOWNLOADING' || s.phase === 'LOADING_BOOK';
  const showVideo = videoVisible.value && layerVideo.value;
  const showPause = s.phase === 'PLAYING';
  const buttonEnabled = s.phase === 'SCENE_READY' || s.phase === 'PLAYING' || sceneQueueSize() > 0;
  const subtitle = subtitleText.value;

  let placeholder = '';
  if (s.phase === 'IDLE') {
    if (!bookId.value && !genBookId.value) placeholder = t('play_placeholder');
    else if (!bookId.value) placeholder = t('play_placeholder_no_generation');
    else placeholder = t('play_generate_hint');
  }

  return (
    <section class={'page page--play' + (isFs ? ' play-page--fs' : '')}>
      {/* Media Viewport — cinema screen */}
      <div class="play-media" ref={mediaRef}>
        <div class="play-curtains" aria-hidden="true" style={showCurtains ? undefined : 'display:none'} />
        <img ref={coverRef} class="play-layer play-cover" src={coverImage.value ?? ''} alt="" style={showCover ? undefined : 'display:none'} />
        <img ref={resultRef} class="play-layer play-result" src={imgSrc ?? ''} alt="" style={showResult ? undefined : 'display:none'} />
        <video ref={videoRef} class="play-layer play-video" playsInline preload="auto" style={showVideo ? undefined : 'display:none'} />
        {/* Dark scrim overlay for cinema letterbox effect */}
        <div class="play-scrim" style={loading && coverImage.value ? undefined : 'display:none'} />
        {placeholder && <p class="play-placeholder">{placeholder}</p>}
        {(missing || (!missing && iuMissing.value)) && (
          <div class="play-iu-missing" role="alert" aria-live="polite">
            <span>{t('iu_not_generated')}</span>
          </div>
        )}
        {subtitle && <p ref={subtitleRef} class="play-subtitle">{subtitle}</p>}
        {/* Fullscreen Toggle Button — bottom right, anchored to image bounds */}
        <button ref={fsBtnRef} type="button" class="play-fs" onClick={toggleFullscreen} aria-label={t('play_fullscreen')}>
          {isFs ? <IconFullscreenExit width={20} height={20} /> : <IconFullscreen width={20} height={20} />}
        </button>
      </div>

      {/* Layer Controls — cinema console */}
      <div class="play-layerbar">
        <LayerChip checked={layerAudio.value} onToggle={setLayerAudio} label={t('layer_audio')} On={IconVolumeUp} Off={IconVolumeOff} />
        <LayerChip checked={layerImage.value} onToggle={setLayerImage} label={t('layer_image')} On={IconImage} Off={IconImageOff} />
        <LayerChip checked={layerVideo.value} onToggle={setLayerVideo} label={t('layer_video')} On={IconVideocam} Off={IconVideocamOff} />
        <LayerChip checked={layerSubtitles.value} onToggle={setLayerSubtitles} label={t('layer_subtitles')} On={IconSubtitles} Off={IconSubtitlesOff} />
      </div>

      {/* Progress + status row (above the big button) */}
      <div class="play-meta">
        <div class="play-progress" style={loading ? undefined : 'display:none'}>
          <div class="play-progress__bar" />
        </div>
        <span class="play-status">{missing ? t('iu_not_generated') : statusText(s)}</span>
      </div>

      {/* Big velvet play button */}
      <button type="button" class="play-btn" disabled={!buttonEnabled} onClick={handlePlayButton}>
        {showPause ? <IconPause width={20} height={20} /> : <IconPlay width={20} height={20} />}
        <span>{showPause ? t('play_pause') : t('play_play')}</span>
      </button>
    </section>
  );
}

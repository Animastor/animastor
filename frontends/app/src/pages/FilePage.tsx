import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { t, tf } from '../app/i18n';
import { navigate } from '../app/router';
import {
  bookId, buildId, phase, errorMessage, importMessages, isExporting,
  navigationEvent, importBookFromFile, openBookById, closeBook, setExporting, setExportProgress
} from '../state/generateStore';
import { getBlob } from '../api/client';
import { toast } from '../lib/ui';
import { IconFolder, IconAdd, IconLibrary, IconDownload, IconImage, IconVolumeUp, IconVideo } from '../app/icons';

// FilePage — 1:1 with FileFragment (fragment_file.xml, stage 3).
//  - Import .vbook/txt: <input type=file> + drag-drop → POST /book/import
//    (multipart, server-side format detection). Shows import progress/status and
//    navigates to Play/Generate when done (navigationEvent, like the Android
//    NavigationEvent flow).
//  - Create New Book: closeBook() + → /ai (create-mode welcome).
//  - Library card → /library (public route on the app domain, nginx-served).
//  - Download section: book (.vbook) needs only bookId; storyboard/audio/video
//    need bookId + buildId + a ready phase — with the same enable rules and
//    export progress/saved status as Android (setMerging/setProgress/setSaved).
//  - Deep link: /file?book=<id> (or ?open=<id>) loads an existing server-side
//    book (web equivalent of the .vbook ACTION_VIEW intent, see 06 §12).

type ExportType = 'book' | 'storyboard' | 'audio' | 'video';

export function FilePage(props: { path?: string }) {
  void props;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [exportStatus, setExportStatus] = useState<{ text: string; pct?: number } | null>(null);

  // The desktop shell's no-book empty state (central workspace) can trigger the
  // always-mounted File panel's picker via a custom event (Phase 9) — one
  // "Open" action from the middle of the screen instead of hunting the panel.
  useEffect(() => {
    const onOpenFile = () => fileInputRef.current?.click();
    window.addEventListener('animastor:open-file', onOpenFile);
    return () => window.removeEventListener('animastor:open-file', onOpenFile);
  }, []);

  // ── Deep link: ?book=<id> / ?open=<id> — processed once per page instance,
  // then the param is stripped so tab re-mounts and back/forward don't re-trigger.
  const deepLinkDone = useRef(false);
  useEffect(() => {
    if (deepLinkDone.current) return;
    deepLinkDone.current = true;
    const params = new URLSearchParams(location.search);
    const bookParam = params.get('book') ?? params.get('open');
    if (bookParam) {
      const clean = location.pathname + location.hash;
      history.replaceState(null, '', clean);
      void openBookById(bookParam);
    }
  }, []);

  // ── Consume one-shot navigation events from import/deep-link (1:1 with
  // FileFragment collecting viewModel.navigationEvent, guarded by
  // hasSwitchedToPlay: the store resets the event at the start of every new
  // import, and this ref mirrors the Android guard for the current run). ──
  const hasNavigated = useRef(false);
  useEffect(() => {
    const go = (ev: 'play' | 'generate') => {
      if (hasNavigated.current) return;
      hasNavigated.current = true;
      navigationEvent.value = null;
      navigate(ev === 'play' ? '/play' : '/generate');
    };
    const unsub = navigationEvent.subscribe((ev) => { if (ev) go(ev); });
    const initial = navigationEvent.value;
    if (initial) go(initial);
    return unsub;
  }, []);

  // ── Signal-derived UI (reads in render auto-subscribe, like AppShell) ──
  const exporting = isExporting.value;
  const bid = bookId.value;
  const build = buildId.value;
  const phaseNow = phase.value;
  const bookOk = bid.trim() !== '' && build.trim() !== '';
  const sceneReady = phaseNow === 'SCENE_READY' || phaseNow === 'PLAYING';
  const bookEnabled = !exporting && bid.trim() !== '';
  const mediaEnabled = !exporting && bookOk && sceneReady;

  const err = errorMessage.value;
  const importing = phaseNow === 'IMPORTING_TXT';
  const loading = phaseNow === 'LOADING_BOOK' || phaseNow === 'GENERATING' || phaseNow === 'DOWNLOADING';

  // Android observeState(): error > export status > importing > loading, else hidden.
  let statusText: string | null = null;
  let showBar = false;
  let determinate = false;
  let pct = 0;
  if (err) {
    statusText = err;
  } else if (exportStatus) {
    statusText = exportStatus.text;
    showBar = true;
    if (exportStatus.pct != null) { determinate = true; pct = exportStatus.pct; }
  } else if (importing) {
    const msgs = importMessages.value;
    if (msgs.length) statusText = msgs[msgs.length - 1];
    else { statusText = t('file_status_opening'); showBar = true; }
  } else if (loading) {
    showBar = true;
    statusText = phaseNow === 'LOADING_BOOK' ? t('file_status_opening')
      : phaseNow === 'GENERATING' ? t('file_status_generating')
      : t('file_status_checking');
  }

  const runImport = (file: File) => {
    if (!file) return;
    hasNavigated.current = false; // Android: hasSwitchedToPlay = false before importBookFromFile
    void importBookFromFile(file);
  };

  const doExport = async (type: ExportType) => {
    const bId = bookId.value;
    const buildNow = buildId.value;
    if (!bId) return;
    if (type !== 'book' && (!buildNow || !(phase.value === 'SCENE_READY' || phase.value === 'PLAYING'))) return;
    setExporting(true);
    try {
      const qs = type === 'book' ? '' : `?build_id=${encodeURIComponent(buildNow)}`;
      const path = type === 'book' ? `/book/${encodeURIComponent(bId)}/download`
        : type === 'storyboard' ? `/book/${encodeURIComponent(bId)}/storyboard${qs}`
        : type === 'audio' ? `/book/${encodeURIComponent(bId)}/audio${qs}`
        : `/book/${encodeURIComponent(bId)}/export${qs}`;
      const statusMsg = type === 'storyboard' ? t('export_preparing_storyboard')
        : type === 'audio' ? t('export_merging_audio')
        : type === 'video' ? t('export_merging_video')
        : t('export_preparing');
      setExportStatus({ text: statusMsg });
      const blob = await getBlob(path, undefined, (p) => {
        setExportProgress(p);
        setExportStatus({ text: tf('export_progress', Math.round(p * 100)), pct: Math.round(p * 100) });
      });
      const filename = type === 'video' ? `${bId}_final.mp4`
        : type === 'storyboard' ? `${bId}_storyboard.zip`
        : type === 'audio' ? `${bId}.mp3`
        : `${bId}.vbook`;
      triggerDownload(blob, filename);
      setExportStatus({ text: t('export_saved') });
      await new Promise((r) => setTimeout(r, 3000));
      setExportStatus(null);
    } catch (e) {
      setExportStatus(null);
      toast(`${t('download_failed')}: ${(e as Error).message}`, 4000);
    } finally {
      setExporting(false);
    }
  };

  return (
    <section class="page file-page">
      <input
        ref={fileInputRef}
        type="file"
        accept=".vbook,.epub,text/plain,.txt,application/octet-stream"
        style="display:none"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => {
          const f = (e.target as HTMLInputElement).files?.[0];
          (e.target as HTMLInputElement).value = '';
          if (f) runImport(f);
        }}
      />

      {/* Import from Device */}
      <button
        type="button"
        class={'file-card' + (dragOver ? ' file-card--drag' : '')}
        aria-label={t('file_from_device')}
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer?.files?.[0];
          if (f) runImport(f);
        }}
      >
        <span class="file-card__icon"><IconFolder width={24} height={24} /></span>
        <span class="file-card__body">
          <span class="file-card__title">{t('file_from_device')}</span>
          <span class="file-card__desc">{t('file_from_device_desc')}</span>
        </span>
      </button>

      {/* Create New Book */}
      <button
        type="button"
        class="file-card"
        aria-label={t('file_create')}
        onClick={() => { closeBook(); navigate('/ai'); }}
      >
        {/* ic_create.xml — same glyph as ic_add */}
        <span class="file-card__icon"><IconAdd width={24} height={24} /></span>
        <span class="file-card__body">
          <span class="file-card__title">{t('file_create')}</span>
          <span class="file-card__desc">{t('file_create_desc')}</span>
        </span>
      </button>

      {/* Library */}
      <button
        type="button"
        class="file-card"
        aria-label={t('library_button')}
        onClick={() => navigate('/library')}
      >
        <span class="file-card__icon"><IconLibrary width={24} height={24} /></span>
        <span class="file-card__body">
          <span class="file-card__title">{t('library_button')}</span>
          <span class="file-card__desc">{t('empty_state')}</span>
        </span>
      </button>

      {/* Download section */}
      <h2 class="file-page__label">{t('download_section')}</h2>
      <DownloadCard icon={<IconDownload width={24} height={24} />} title={t('download_book')} desc={t('download_book_desc')} enabled={bookEnabled} onClick={() => void doExport('book')} />
      <DownloadCard icon={<IconImage width={24} height={24} />} title={t('download_storyboard')} desc={t('download_storyboard_desc')} enabled={mediaEnabled} onClick={() => void doExport('storyboard')} />
      <DownloadCard icon={<IconVolumeUp width={24} height={24} />} title={t('download_audio')} desc={t('download_audio_desc')} enabled={mediaEnabled} onClick={() => void doExport('audio')} />
      <DownloadCard icon={<IconVideo width={24} height={24} />} title={t('download_video')} desc={t('download_video_desc')} enabled={mediaEnabled} onClick={() => void doExport('video')} />

      {/* Progress bar + status (LinearProgressIndicator + statusText) */}
      {showBar && (
        <div class="file-page__bar">
          <div class={'progress' + (determinate ? ' progress--determinate' : '')}>
            <div class="progress__bar" style={determinate ? { width: `${pct}%` } : undefined} />
          </div>
        </div>
      )}
      {statusText && <p class="file-page__status">{statusText}</p>}
    </section>
  );
}

// MaterialCardView entry with icon + title + desc (disabled = Android enabled=false).
function DownloadCard({ icon, title, desc, enabled, onClick }: {
  icon: JSX.Element; title: string; desc: string; enabled: boolean; onClick: () => void;
}) {
  return (
    <button
      type="button"
      class={'file-card' + (enabled ? '' : ' file-card--disabled')}
      aria-label={title}
      disabled={!enabled}
      onClick={onClick}
    >
      <span class="file-card__icon">{icon}</span>
      <span class="file-card__body">
        <span class="file-card__title">{title}</span>
        <span class="file-card__desc">{desc}</span>
      </span>
    </button>
  );
}

// CreateDocument → browser download: object URL + <a download> click
// (web equivalent of writing to the SAF content URI).
function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

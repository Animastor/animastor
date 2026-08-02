// Tab icons — inline SVG, recoded 1:1 from res/drawable/ic_*.xml (02 §1.1).
// Inline (not <img>) so fill/stroke="currentColor" follows CSS `color`
// (equivalent of Android app:tint → CSS color, per design-preservation docs).
import type { JSX } from 'preact';

export type IconProps = JSX.SVGAttributes<SVGSVGElement>;

// ic_file.xml — folder
export function IconFile(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z" />
    </svg>
  );
}

// ic_generator.xml — three inputs → converging lines → filled square
export function IconGenerate(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="M4 5m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M4 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M4 19m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0" />
      <path d="M6 5h5M6 12h9M6 19h5M11 5v14" />
      <path d="M15 8h8v8h-8z" fill="currentColor" stroke="none" />
    </svg>
  );
}

// ic_play.xml — triangle
export function IconPlay(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

// ic_edit.xml — pencil
export function IconEdit(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zm17.71-10.21c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
    </svg>
  );
}

// ic_map.xml — folded map
export function IconMap(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M20.5 3l-.16.03L15 5.1 9 3 3.36 4.9c-.21.07-.36.25-.36.48V20.5c0 .28.22.5.5.5l.16-.03L9 18.9l6 2.1 5.64-1.9c.21-.07.36-.25.36-.48V3.5c0-.28-.22-.5-.5-.5zM15 19l-6-2.11V5l6 2.11V19z" />
    </svg>
  );
}

// ── Stage 2 icons — recoded 1:1 from res/drawable/ic_*.xml ──

// ic_mic.xml — microphone
// ic_mic_off.xml — mic with slash (voice input active state)
export function IconMic(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
      <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
    </svg>
  );
}

export function IconMicOff(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z" />
    </svg>
  );
}

// ic_send.xml — send arrow
// ic_content_copy.xml — copy
// ic_menu.xml — hamburger (session list)
// ic_create.xml / ic_add.xml — plus (new chat / add workflow)
// ic_sparkle_outline.xml — sparkle (AI / conversation mode)
// ic_download.xml — download (import mode)
// ic_check.xml — check (validation mode)
// ic_chevron_left.xml / ic_chevron_right.xml — mode scroll indicators
export function IconSend(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
    </svg>
  );
}

export function IconCopy(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" />
    </svg>
  );
}

export function IconMenu(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M3 6h18v2H3V6zm0 5h18v2H3v-2zm0 5h18v2H3v-2z" />
    </svg>
  );
}

export function IconAdd(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
    </svg>
  );
}

export function IconSparkle(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M19 9l1.25-2.75L23 5l-2.75-1.25L19 1l-1.25 2.75L15 5l2.75 1.25L19 9zM11.5 9.5L9 4 6.5 9.5 1 12l5.5 2.5L9 20l2.5-5.5L17 12l-5.5-2.5z" />
    </svg>
  );
}

export function IconDownload(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" />
    </svg>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
    </svg>
  );
}

export function IconChevronLeft(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z" />
    </svg>
  );
}

export function IconChevronRight(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" />
    </svg>
  );
}

// ── Stage 3 icons (File screen) — recoded 1:1 from res/drawable ──

// ic_folder_outline.xml — import from device
export function IconFolder(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
    </svg>
  );
}

// ic_image.xml — download storyboard
export function IconImage(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z" />
    </svg>
  );
}

// ic_volume_up.xml — download audio
export function IconVolumeUp(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z" />
    </svg>
  );
}

// ic_video_outline.xml — download video
export function IconVideo(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" />
    </svg>
  );
}

// ic_library.xml — library card (Android tint is white on primary; web tints
// via currentColor in .file-card__icon like the other stage-3 icons)
export function IconLibrary(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H8V4h12v12zM10 9h8v2h-8zm0 3h4v2h-4zm0-6h8v2h-8z" />
    </svg>
  );
}

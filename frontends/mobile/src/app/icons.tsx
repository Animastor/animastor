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

// ic_spiral.xml — three inputs → converging lines → filled square
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

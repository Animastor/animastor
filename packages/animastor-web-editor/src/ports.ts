// EditorPorts — the complete host contract of the @animastor/web-editor
// package (docs/architecture/web-package-extraction-reconnaissance.md).
//
// Dependency direction (frozen by arch guards):
//
//   host app (EditPage.tsx) ──composition──▶ app/editorAdapters.ts
//   app/editorAdapters.ts ──implements──▶ EditorPorts (this file)
//   Editor modules ──consumes ONLY──▶ EditorPorts (+ package-internal modules)
//
// The Editor contour (entityEditor / waveform / idgen) must never import
// app/i18n / app/icons / lib/ui / api/models / api/client directly. The
// ONLY host-side place where those modules meet this contract is
// app/editorAdapters.ts. This file imports nothing but Preact types — it
// is the future package's public surface.
//
// Port payload types are Editor-local structural types (NOT imports of the
// host types): the host adapter bridges them, and TypeScript rejects
// the adapter the moment a host type drifts from this contract.

import type { JSX } from 'preact';

// ── i18n key union ──────────────────────────────────────────────────────────

/** i18n keys the Editor surface needs (the dictionary stays host-owned). */
export type EditorI18nKey =
  // entity add/delete button aria
  | 'entity_add'
  | 'entity_delete'
  // entity editor schema titles
  | 'entity_add_character'
  | 'entity_delete_character'
  | 'entity_delete_character_confirm'
  | 'entity_add_location'
  | 'entity_delete_location'
  | 'entity_delete_location_confirm'
  | 'entity_add_voice'
  | 'entity_delete_voice'
  | 'entity_delete_voice_confirm'
  | 'entity_add_behavior'
  | 'entity_delete_behavior'
  | 'entity_delete_behavior_confirm'
  // entity field labels
  | 'field_appearance'
  | 'field_clothes'
  | 'field_video_tokens'
  | 'field_description'
  | 'field_time'
  | 'field_season'
  | 'field_lighting'
  | 'field_weather'
  | 'field_mood'
  | 'field_atmosphere'
  | 'field_instruction'
  | 'field_baseline'
  // form validation
  | 'entity_name_required'
  | 'entity_id_exists'
  // dialog buttons
  | 'dialog_cancel'
  | 'edit_saving'
  | 'edit_save'
  // entity form labels
  | 'entity_id'
  | 'entity_id_placeholder'
  | 'entity_id_hint'
  | 'field_name'
  // delete confirm
  | 'entity_delete_btn'
  // behavior dialog
  | 'behavior_character'
  | 'behavior_character_hint'
  | 'behavior_character_required'
  // structure add dialog
  | 'field_chapter_title'
  | 'field_scene_title'
  | 'structure_parent_required'
  | 'structure_add_chapter'
  | 'structure_add_scene'
  | 'structure_add_unit'
  | 'structure_id_hint'
  | 'chapter_auto_create_hint'
  | 'scene_auto_create_hint';

export type EditorT = (key: EditorI18nKey, fallback?: string) => string;

// ── Icon component types ────────────────────────────────────────────────────

/** Icon component props (the SVG kit stays host-owned). */
export type EditorIconProps = JSX.SVGAttributes<SVGSVGElement>;

export type EditorIconComponent = (props: EditorIconProps) => JSX.Element;

// ── Modal component type ────────────────────────────────────────────────────

/** Minimal modal contract consumed by the Editor dialogs. */
export interface EditorModalProps {
  title?: string;
  onClose: () => void;
  footer?: JSX.Element | JSX.Element[];
  children: JSX.Element | JSX.Element[];
}

// ── Ports ──────────────────────────────────────────────────────────────────

/** I18nPort — app/i18n stays host (typed key union, Player/File precedent). */
export interface EditorI18nPort {
  t: EditorT;
}

/** IconsPort — app/icons stays host (2 icons used by the Editor surface). */
export interface EditorIconsPort {
  Add: EditorIconComponent;
  Minus: EditorIconComponent;
}

/** ModalPort — lib/ui Modal stays host (component injection). */
export interface EditorModalPort {
  Modal: (props: EditorModalProps) => JSX.Element;
}

/** The complete host contract consumed by the Editor modules. */
export interface EditorPorts {
  i18n: EditorI18nPort;
  icons: EditorIconsPort;
  modal: EditorModalPort;
}

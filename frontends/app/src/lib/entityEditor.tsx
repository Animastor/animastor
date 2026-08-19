// ─────────────────────────────────────────────────────
// Entity Editor — reusable Add/Delete pattern for the
// Editor tables (Characters / Locations / Voices, and in
// the future Unit / Scene). One schema-driven add dialog
// and one confirmation dialog, so three (or five) nearly
// identical implementations never get forked.
//
//   Table ── EntityAddButton (overlay, top-right)
//              ↓ EntityEditorDialog (schema form)
//              ↓ Save → POST /book/{id}/{entities}
//   Row   ── EntityDeleteButton
//              ↓ DeleteConfirmDialog
//              ↓ Delete → DELETE /book/{id}/{entities}/{id}
//
// The id field is free-form on purpose: a canonical latin
// snake id is kept verbatim, anything else (Cyrillic, …)
// is transliterated SERVER-SIDE via the existing backend
// utility (utils/entity-id reusing cyrToLatin) — the
// frontends never duplicate the algorithm.
// ─────────────────────────────────────────────────────
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { Modal } from './ui';
import { IconAdd, IconMinus } from '../app/icons';
import { t } from '../app/i18n';
import type { StrKey } from '../app/i18n';

export type EntityKind = 'character' | 'location' | 'voice';

export interface EntityFieldDef {
  /** Flat form key — dotted for nested payload keys (passport.appearance). */
  key: string;
  /** i18n key of the field label. */
  labelKey: StrKey;
  multiline?: boolean;
}

export interface EntitySchema {
  kind: EntityKind;
  /** i18n key: add-dialog title ("Add character"). */
  addTitleKey: StrKey;
  /** i18n key: delete-confirm title ("Delete character?"). */
  deleteTitleKey: StrKey;
  /** i18n key: delete-confirm body ("Are you sure…"). */
  deleteConfirmKey: StrKey;
  /** Extra fields beyond id + name, in form order. */
  fields: EntityFieldDef[];
}

// ── Schemas built from the CURRENT entity JSON structure (the fields the
//    editor cards render and PATCH supports — legacy demo keys like
//    base_appearance / cinematic_space are not part of the schema anymore). ──
export const ENTITY_SCHEMAS: Record<EntityKind, EntitySchema> = {
  character: {
    kind: 'character',
    addTitleKey: 'entity_add_character',
    deleteTitleKey: 'entity_delete_character',
    deleteConfirmKey: 'entity_delete_character_confirm',
    fields: [
      { key: 'passport.appearance', labelKey: 'field_appearance', multiline: true },
      { key: 'passport.clothes', labelKey: 'field_clothes', multiline: true },
      { key: 'passport.video_tokens', labelKey: 'field_video_tokens', multiline: true },
    ],
  },
  location: {
    kind: 'location',
    addTitleKey: 'entity_add_location',
    deleteTitleKey: 'entity_delete_location',
    deleteConfirmKey: 'entity_delete_location_confirm',
    fields: [
      { key: 'description', labelKey: 'field_description', multiline: true },
      { key: 'environment.time', labelKey: 'field_time' },
      { key: 'environment.season', labelKey: 'field_season' },
      { key: 'environment.lighting', labelKey: 'field_lighting' },
      { key: 'environment.weather', labelKey: 'field_weather' },
      { key: 'environment.mood', labelKey: 'field_mood' },
      { key: 'environment.atmosphere', labelKey: 'field_atmosphere' },
    ],
  },
  voice: {
    kind: 'voice',
    addTitleKey: 'entity_add_voice',
    deleteTitleKey: 'entity_delete_voice',
    deleteConfirmKey: 'entity_delete_voice_confirm',
    fields: [
      { key: 'instruction', labelKey: 'field_instruction', multiline: true },
    ],
  },
};

// ── Round "+" — floats in the table's top-right corner (overlay, no layout
//    space, sized close to the existing 24dp collapse chevrons). ──
export function EntityAddButton({ onClick }: { onClick: () => void }): JSX.Element {
  return (
    <button class="entity-add-btn" type="button" aria-label={t('entity_add')} title={t('entity_add')} onClick={onClick}>
      <IconAdd width={15} height={15} />
    </button>
  );
}

// ── Small square "−" with a soft destructive accent, next to the row's id. ──
export function EntityDeleteButton({ onClick }: { onClick: () => void }): JSX.Element {
  return (
    <button
      class="entity-del-btn"
      type="button"
      aria-label={t('entity_delete')}
      title={t('entity_delete')}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
    >
      <IconMinus width={15} height={15} />
    </button>
  );
}

// ── Schema-driven add dialog. Validates the required name + id uniqueness
//    client-side (the backend re-checks on save); the id is left free-form so
//    the server can transliterate it. ──
export function EntityEditorDialog({ schema, existingIds, busy, error, onSave, onClose }: {
  schema: EntitySchema;
  existingIds: ReadonlySet<string>;
  busy: boolean;
  error: string | null;
  onSave: (values: Record<string, string>) => void;
  onClose: () => void;
}): JSX.Element {
  const [values, setValues] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const set = (key: string, v: string) => setValues((prev) => ({ ...prev, [key]: v }));

  const handleSave = () => {
    const name = (values.name ?? '').trim();
    if (!name) {
      setFormError(t('entity_name_required'));
      return;
    }
    const id = (values.id ?? '').trim();
    if (id && existingIds.has(id)) {
      setFormError(t('entity_id_exists'));
      return;
    }
    setFormError(null);
    onSave(values);
  };

  return (
    <Modal title={t(schema.addTitleKey)} onClose={onClose} footer={
      <>
        <button type="button" class="btn btn--outlined" disabled={busy} onClick={onClose}>{t('dialog_cancel')}</button>
        <button type="button" class="btn" disabled={busy} onClick={handleSave}>
          {busy ? t('edit_saving') : t('edit_save')}
        </button>
      </>
    }>
      <div class="entity-form">
        <div class="edit-field">
          <label class="edit-field__label" for="entity-id">{t('entity_id')}</label>
          <input
            id="entity-id"
            class="edit-field__input"
            type="text"
            value={values.id ?? ''}
            placeholder={t('entity_id_placeholder')}
            onInput={(e) => set('id', (e.target as HTMLInputElement).value)}
          />
          <span class="entity-form__hint">{t('entity_id_hint')}</span>
        </div>
        <div class="edit-field">
          <label class="edit-field__label" for="entity-name">{t('field_name')} *</label>
          <input
            id="entity-name"
            class="edit-field__input"
            type="text"
            value={values.name ?? ''}
            onInput={(e) => set('name', (e.target as HTMLInputElement).value)}
          />
        </div>
        {schema.fields.map((f) => (
          <div class="edit-field" key={f.key}>
            <label class="edit-field__label" for={`entity-${f.key}`}>{t(f.labelKey)}</label>
            {f.multiline ? (
              <textarea
                id={`entity-${f.key}`}
                class="edit-field__input edit-field__input--area"
                rows={3}
                value={values[f.key] ?? ''}
                onInput={(e) => set(f.key, (e.target as HTMLTextAreaElement).value)}
              />
            ) : (
              <input
                id={`entity-${f.key}`}
                class="edit-field__input"
                type="text"
                value={values[f.key] ?? ''}
                onInput={(e) => set(f.key, (e.target as HTMLInputElement).value)}
              />
            )}
          </div>
        ))}
        {(formError || error) && <div class="entity-form__error">{(formError ?? error) as string}</div>}
      </div>
    </Modal>
  );
}

// ── Delete confirmation — destructive action requires explicit confirmation. ──
export function DeleteConfirmDialog({ title, message, busy, error, onConfirm, onClose }: {
  title: string;
  message: string;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <Modal title={title} onClose={onClose} footer={
      <>
        <button type="button" class="btn btn--outlined" disabled={busy} onClick={onClose}>{t('dialog_cancel')}</button>
        <button type="button" class="btn btn--error-solid" disabled={busy} onClick={onConfirm}>
          {busy ? t('edit_saving') : t('entity_delete_btn')}
        </button>
      </>
    }>
      <>
        <p class="modal__notice">{message}</p>
        {error && <div class="entity-form__error">{error}</div>}
      </>
    </Modal>
  );
}

// ═════════════════════════════════════════════════════════════════
// STRUCTURE add/delete — chapters / scenes / units (editor hierarchy)
//
// Глава → Сцена → Модуль. The add dialog always shows the readonly id
// preview; a scene additionally picks its PARENT chapter (pre-filled with the
// current chapter, still changeable) and a unit picks its parent scene (the
// chapter is derived from the scene — no chapter selection for modules).
// Titles are optional (the entity's name/title is edited in the tab after).
// ═════════════════════════════════════════════════════════════════

export type StructureKind = 'chapter' | 'scene' | 'unit';

export interface StructureParentOption {
  /** chapter_id (for scenes) / scene_id (for units). */
  id: string;
  /** Human label: «Глава 3 — «Прибытие в Москву»» / scene title; hex fallback. */
  label: string;
}

export function StructureAddDialog({ kind, id, chapters, scenes, defaultChapterId, defaultSceneId, busy, error, onSave, onClose }: {
  kind: StructureKind;
  /** Readonly preview id (generated client-side, verified server-side). */
  id: string;
  /** Chapters available as the parent for a scene. */
  chapters: StructureParentOption[];
  /** Scenes available as the parent for a unit. */
  scenes: StructureParentOption[];
  /** Pre-filled parent (current selection), still changeable. */
  defaultChapterId: string | null;
  defaultSceneId: string | null;
  busy: boolean;
  error: string | null;
  onSave: (values: { chapterId: string | null; sceneId: string | null; title: string }) => void;
  onClose: () => void;
}): JSX.Element {
  const [title, setTitle] = useState('');
  const [chapterId, setChapterId] = useState(defaultChapterId ?? chapters[0]?.id ?? '');
  const [sceneId, setSceneId] = useState(defaultSceneId ?? scenes[0]?.id ?? '');
  const [formError, setFormError] = useState<string | null>(null);

  const titleKey: StrKey =
    kind === 'chapter' ? 'field_chapter_title' : kind === 'scene' ? 'field_scene_title' : 'field_name';

  const handleSave = () => {
    if (kind === 'scene' && !chapterId) {
      setFormError(t('structure_parent_required'));
      return;
    }
    if (kind === 'unit' && !sceneId) {
      setFormError(t('structure_parent_required'));
      return;
    }
    setFormError(null);
    onSave({ chapterId: kind === 'scene' ? chapterId : null, sceneId: kind === 'unit' ? sceneId : null, title: title.trim() });
  };

  return (
    <Modal title={t(kind === 'chapter' ? 'structure_add_chapter' : kind === 'scene' ? 'structure_add_scene' : 'structure_add_unit')} onClose={onClose} footer={
      <>
        <button type="button" class="btn btn--outlined" disabled={busy} onClick={onClose}>{t('dialog_cancel')}</button>
        <button type="button" class="btn" disabled={busy} onClick={handleSave}>
          {busy ? t('edit_saving') : t('edit_save')}
        </button>
      </>
    }>
      <div class="entity-form">
        <div class="edit-field">
          <label class="edit-field__label" for="structure-id">{t('entity_id')}</label>
          <input id="structure-id" class="edit-field__input" type="text" value={id} readOnly />
          <span class="entity-form__hint">{t('structure_id_hint')}</span>
        </div>
        {kind === 'scene' && (
          <div class="edit-field">
            <label class="edit-field__label" for="structure-chapter">{t('field_chapter_title')}</label>
            <select
              id="structure-chapter"
              class="edit-field__input"
              value={chapterId}
              onChange={(e) => setChapterId((e.target as HTMLSelectElement).value)}
            >
              {chapters.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </div>
        )}
        {kind === 'unit' && (
          <div class="edit-field">
            <label class="edit-field__label" for="structure-scene">{t('field_scene_title')}</label>
            <select
              id="structure-scene"
              class="edit-field__input"
              value={sceneId}
              onChange={(e) => setSceneId((e.target as HTMLSelectElement).value)}
            >
              {scenes.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </div>
        )}
        <div class="edit-field">
          <label class="edit-field__label" for="structure-title">{t(titleKey)}</label>
          <input
            id="structure-title"
            class="edit-field__input"
            type="text"
            value={title}
            onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
          />
        </div>
        {kind === 'chapter' && <p class="entity-form__hint" style="margin-top:4px;">{t('chapter_auto_create_hint')}</p>}
        {kind === 'scene' && <p class="entity-form__hint" style="margin-top:4px;">{t('scene_auto_create_hint')}</p>}
        {(formError || error) && <div class="entity-form__error">{(formError ?? error) as string}</div>}
      </div>
    </Modal>
  );
}

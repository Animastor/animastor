// @animastor/web-editor public entry point.
//
// Schema-driven editor UI primitives for Animastor web frontend:
//   - Entity add/delete dialogs (Characters / Locations / Voices / Behaviors)
//   - Structure add dialog (Chapters / Scenes / Units)
//   - Canvas waveform renderer with draggable range selection
//   - Preview ID generator (chapter / scene / unit)
//
// Host capabilities (i18n, icons, modal) arrive via the injected EditorPorts
// contract. The package imports nothing from the host app directly.
//
// Host consumers:
//   pages/EditPage.tsx — all exports

// Ports and types
export type { EditorPorts, EditorI18nPort, EditorIconsPort, EditorModalPort, EditorI18nKey, EditorT, EditorIconProps, EditorIconComponent, EditorModalProps } from './ports';
export type { WaveformPeak } from './models';

// Pure utilities (zero host dependencies)
export { chapterId, sceneId, unitId } from './idgen';

// Schema definitions (pure data)
export { ENTITY_SCHEMAS } from './entityEditor';
export type { EntityKind, EntitySchema, EntityFieldDef, StructureKind, StructureParentOption } from './entityEditor';

// Components (require EditorPorts injection)
export { EntityAddButton, EntityDeleteButton, EntityEditorDialog, BehaviorAddDialog, DeleteConfirmDialog, StructureAddDialog } from './entityEditor';
export { Waveform } from './waveform';

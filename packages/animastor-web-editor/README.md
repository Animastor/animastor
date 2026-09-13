# @animastor/web-editor

Schema-driven editor UI primitives for Animastor web frontend.

## Scope

This package provides reusable editor components, canvas waveform rendering, and preview ID generation:

- **Entity Editor** — schema-driven Add/Delete dialogs for Characters, Locations, Voices, Behaviors
- **Structure Editor** — Add dialog for Chapters, Scenes, Units (hierarchy with parent selection)
- **Waveform** — canvas-based waveform renderer with draggable range selection and playback playhead
- **ID Generator** — preview ID generation for chapters, scenes, units (client-side preview only)

**Host capabilities injected via EditorPorts.** The package imports nothing from the host app directly — i18n, icons, and modal arrive through the Ports contract.

## Install

```sh
npm install @animastor/web-editor
```

Peer dependencies: `preact >=10.5.0`, `@preact/signals >=1.0.0`.

## Usage

```tsx
import { EntityAddButton, Waveform, chapterId, type EditorPorts } from '@animastor/web-editor';

// Inject host capabilities via EditorPorts
const ports: EditorPorts = {
  i18n: { t: (key) => translations[key] },
  icons: { Add: IconAdd, Minus: IconMinus },
  modal: { Modal: HostModal },
};

// Use in a component
<EntityAddButton ports={ports} onClick={handleAdd} />

// Waveform
<Waveform peaks={peaks} durationMs={60000} selection={sel} />

// Preview IDs
const id = chapterId(); // "ch-a1b2c3d4"
```

## Public API

| Export | Kind | Purpose |
|---|---|---|
| `EditorPorts` | type | Host contract (i18n + icons + modal) |
| `EditorI18nKey` | type | Typed i18n key union (45 keys) |
| `EditorT` | type | Translation function signature |
| `EditorIconProps` | type | Icon component props |
| `EditorIconComponent` | type | Icon component function type |
| `EditorModalProps` | type | Modal component props |
| `WaveformPeak` | type | Package-owned peak pair (pos/neg) |
| `EntityKind` | type | `'character' | 'location' | 'voice' | 'behavior'` |
| `EntitySchema` | type | Schema for an entity kind |
| `EntityFieldDef` | type | Field definition in an entity schema |
| `StructureKind` | type | `'chapter' | 'scene' | 'unit'` |
| `StructureParentOption` | type | Parent option for structure add dialog |
| `ENTITY_SCHEMAS` | const | Maps EntityKind → EntitySchema |
| `EntityAddButton` | component | Round "+" overlay button |
| `EntityDeleteButton` | component | Small "−" destructive button |
| `EntityEditorDialog` | component | Schema-driven add dialog |
| `BehaviorAddDialog` | component | Behavior-specific add dialog (character picker) |
| `DeleteConfirmDialog` | component | Destructive action confirmation |
| `StructureAddDialog` | component | Chapter/Scene/Unit add dialog |
| `Waveform` | component | Canvas waveform with range selection |
| `chapterId` | function | Preview ID: `ch-<8hex>` |
| `sceneId` | function | Preview ID: `sc-<8hex>` |
| `unitId` | function | Preview ID: `iu-<8hex>` |

## Package boundary

- The package imports only its own internal modules — zero host imports.
- `@animastor/web-editor → host` = forbidden; `host → @animastor/web-editor` = allowed through the public entry point only.
- All host capabilities arrive via the injected `EditorPorts` contract.

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit
npm run test        # vitest (unit tests)
npm run build       # tsup → dist/ (ESM + d.ts + sourcemaps)
```

## License

MIT

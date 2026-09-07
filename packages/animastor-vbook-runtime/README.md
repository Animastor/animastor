# @animastor/vbook-runtime

Canonical **VBook 3.1** bundle/book runtime: multi-file bundle CRUD, draft/import
lifecycle, lazy parse windows, bundle validation, canonical id grammar and the
on-disk path layout.

**Status: PREPARATION PHASE.** The package manifest, public-API freeze, ports
and the bundle schema are in place; the code still physically lives in
`backend/src/book/` and is wired through shims. The physical move
(`backend/src/book → packages/animastor-vbook-runtime/src`) is the next,
separate task — see
[`docs/architecture/VBOOK_RUNTIME_RELOCATION_CHECKLIST.md`](../../docs/architecture/VBOOK_RUNTIME_RELOCATION_CHECKLIST.md)
and [`docs/03-audit/VBOOK_EXTRACTION_READINESS_AUDIT.md`](../../docs/03-audit/VBOOK_EXTRACTION_READINESS_AUDIT.md).

## Ownership map (frozen)

| Concern | Owner |
|---|---|
| Bundle/book canonical state, layout, id grammar, validator | **this package** |
| `{booksRoot}` location (env, docker mounts) | host (injected via `configureBooksRoot`) |
| `{booksRoot}/{bookId}.snapshot.json` files | host (`task-handler.cjs`, `book-deletion.cjs`) |
| Deletion orchestration (Redis cancel flags, PG cascade, hub queue clear) | host (`book-deletion.cjs` — stays host-side, excluded from the package `files` allowlist) |
| Redis / Postgres / GPU Hub (`HUB_URL`, `GPU_HUB_API_KEY`, ...) | host |
| Text structure analysis / parser doctrine (`structure-detector`) | future Parser boundary (C13); consumed via the injectable port below |

## Public API (frozen — audit §4.1)

Operations only. Additive changes only from here (C2 model API is internal-v1).

- **Book/bundle CRUD** (`book/index.js`): `loadBook`, `saveBookBundle`,
  `resetBook`, `extractBookBundle`, `buildBookFromBundle`, `addDirToZip`,
  `collectScenes`, `collectSceneList`, `collectSceneUnits`, `findSceneRuntimeData`.
- **Book Model facade** (`book-model.cjs`): `loadBook(bookId, {mode})`,
  `getBookIdentity`, `getBookManifest`, `BookModelError`, `MODE_FULL`, `MODE_LAZY`.
- **Lazy-book runtime** (`lazy-book/index.js`): draft lifecycle
  (`createDraftBook`, `loadDraftBook`, `updateBookState`), parse windows
  (`lazyParseNextWindow`, `lazyParseChapter`), status (`getBookStatus`,
  `getChaptersSummary`), import/create (`createFromAnalysis`, `appendToBook`,
  `createOrAppendScenes`), metadata (`updateBookMetadata`), chapter utilities,
  appearance helpers.
- **Validation** (`bundle-validator.cjs`): `validateBundleObject`,
  `validateBundleFile`. The de-facto C1 contract; mirrored rule-by-rule by
  [`schemas/vbook-bundle-3.1.schema.json`](schemas/vbook-bundle-3.1.schema.json).
- **Path/id grammar** (`lazy-book/paths.js`): `getBooksDir`, `getBookDir`,
  `getSourcePath`, `getManifestPath`, `getBookMetaPath`, `getCharactersPath`,
  `getBiblePath`, `getChapterDir`, `getChapterPath`, ... and `chapterId`,
  `sceneId`, `unitId`, `generateBookId`.
- **Enums** (`lazy-book/constants.js`): `BookState`, `SceneStatus`, `SourceType`,
  `UnitType`, `DEFAULT_WINDOW_SIZE`.

NOT part of the package: `book-deletion.cjs`, snapshot management, Redis/PG/
orchestration access, GPU Hub env logic — all host-side.

## Ports (injected by the host composition root)

### `booksRoot`

The package never reads `process.env` and never imports host config. The host
binds the filesystem root once at startup:

```js
const { configureBooksRoot } = require('@animastor/vbook-runtime/books-root');
configureBooksRoot(() => config.BOOKS_DIR); // string or () => string
```

Fail-closed: path getters throw until the root is bound. No env fallback.

### `structureDetector`

Text-structure analysis is **Parser doctrine, not bundle format** (Parser ≠
VBook). The package defines one port:

```js
detector.buildDeterministicMap(sourceText)
// → { title?, author?, hasPrologue, hasEpilogue, parts,
//     segments: [{ type, label, title, number, headerLine,
//                  startOffset, endOffset, source }] }
```

The host binds its current implementation once at startup:

```js
const { setStructureDetector } = require('@animastor/vbook-runtime/lazy-book/parser');
setStructureDetector(require('../services/structure-detector'));
```

Fail-closed: parsing throws until a detector is bound. This port is the seed of
the future C13 Parser contract; `services/structure-detector` stays host-side
until that boundary exists.

## Extraction companions

`services/language-detector`, `utils/character-identity`, `utils/snake-guard`,
`utils/scene-title-utils` move **with** the package (audit §1.1). Host consumers
reach them through one-line re-export shims at the old paths, so migration is
behavior-neutral.

## Dependency surface

Node builtins (`fs`, `path`, `crypto`) + `adm-zip` + `tinyld`. Nothing else —
guarded by `backend/tests/architecture/vbook-package-boundary.test.js`.

## License

MIT

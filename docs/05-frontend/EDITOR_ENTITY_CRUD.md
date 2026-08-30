# Editor: Manual Entity Add/Delete

A unified UI pattern for manually adding and deleting **characters, locations, and voices**
on the "Editor" page — directly within existing selector tables.
The pattern is designed for reuse when adding/deleting **Units** and **Scenes**.

Platforms: **web** (`frontends/app`) + **Android** (`frontends/android`), identical UX.

---

## UX Pattern

```
Table
 └── Add (+) overlay button in the top-right corner
       ↓
     Modal/Dialog (form based on entity JSON schema)
       ↓
     Save (required field validation + ID uniqueness)
       ↓
     Table updates without page reload

Table row
 └── [−] ID   (compact "−" button, soft red accent, left of ID)
       ↓
     Confirmation Dialog ("Delete character/location/voice?")
       ↓
     Entire JSON entity object is deleted → table updates immediately
```

Key requirements:

- **"+"** — round, overlay/absolute relative to the table container: does not take
  space in layout, first table row does not shift.
- **Add dialog** — modal, not a separate screen with "Add → Back".
- **Deletion** — only via confirmation dialog; the entire entity is deleted
  (entire JSON object), no dangling/partial data.
- **ID** — valid entered ID is used as-is; free-form input
  (e.g., Cyrillic) is transliterated to snake_case via existing
  transliteration (see below).
- Other selectors/tables state is not broken; if the selected entity is deleted —
  selection is correctly cleared.

---

## Backend API

Routes registered in `backend/src/routes/book-routes.cjs`
(sub-registrar `backend/src/routes/book/entity-crud-routes.cjs`):

| Method | Path | Action |
|---|---|---|
| `POST` | `/api/v1/book/:bookId/entities/:kind` | Add entity `kind` ∈ `characters` \| `locations` \| `voices` |
| `DELETE` | `/api/v1/book/:bookId/entities/:kind/:id` | Delete entity entirely |

- Writes go through the **existing** `book.saveBookBundle` — no parallel save
  mechanism is created; book JSON structure is unchanged.
- POST: required field validation (per entity schema) + ID uniqueness check
  → `409` on duplicate.
- DELETE: entire JSON object removed; when collection is empty, file is
  deleted normally (`saveBookBundle` behavior).

### ID Generation

`backend/src/utils/entity-id.js` — **reuses the existing** transliteration
function `cyrToLatin` (`backend/src/utils/string-utils.js`) + snake_case:

- Entered ID already in accepted format → used as-is.
- Free-form input (e.g., "Михаил Александрович Берлиоз") →
  transliteration + snake_case → `mikhail_aleksandrovich_berlioz`.

No new transliteration function was written — backend utility is reused.

---

## Web (`frontends/app`)

Reusable components in `frontends/app/src/lib/entityEditor.tsx`:

- `EntityAddButton` — round "+" (overlay over table).
- `EntityDeleteButton` — compact "−", soft red accent.
- `EntityEditorDialog` — modal form, built from entity field schema.
- `DeleteConfirmDialog` — confirmation dialog with dynamic entity text.

`frontends/app/src/pages/EditPage.tsx`:

- Field schemas for three entities (`ENTITY_SCHEMAS` in `frontends/app/src/lib/entityEditor.tsx`)
  built from **current** editor JSON models (legacy demo data keys
  like `base_appearance` / `cinematic_space` are excluded from schema):
  - character: `passport.appearance`, `passport.clothes`, `passport.video_tokens`;
  - location: `description`, `environment.time`, `environment.season`,
    `environment.lighting`, `environment.weather`, `environment.mood`,
    `environment.atmosphere`;
  - voice: `instruction`.
  ID — free-form input field (valid format used as-is, otherwise —
  server-side transliteration).
- "+" in top-right of each table; delete button in card header
  left of ID (no overlap with "+").
- After save/delete — table update from local state (no reload).
- Guard: entity deleted after last load is skipped during PATCH
  (otherwise 404 would break entire save).

Styles — `frontends/app/src/styles/base.css` (`.edit-entity-*` classes),
strings — `frontends/app/src/app/i18n.ts` (ru/en), "−" icon — `IconMinus`
in `frontends/app/src/app/icons.tsx`.

---

## Android (`frontends/android`)

- `repository/BackendApi.kt` + `repository/Repository.kt` — CRUD methods
  (`createEntity` / `deleteEntity`).
- `res/layout/fragment_edit.xml` — floating "+" (overlay over table).
- `res/drawable/bg_entity_add.xml` (round button), `res/drawable/ic_remove.xml`.
- `ui/EditFragment.kt`:
  - `EntityKind` enum + `EntityDef`/`EntityField` (field schemas) — unified mechanism for three entities;
  - add dialog — following existing pattern (TextInputLayout, Editor design);
  - confirmation dialog — "Delete …?" / Cancel / Delete;
  - delete button in card header left of ID;
  - table updates after save/delete, guard against PATCH of deleted entity.
- Strings — `res/values/strings.xml` + `res/values-ru/strings.xml`.

---

## Extension to Unit / Scene

Adding a new entity requires:

1. backend: `kind` in `entity-crud-routes.cjs` (field schema for validation);
2. web: field schema in `EditPage.tsx` (form is built automatically);
3. Android: entry in `entityFields` + strings.

Separate dialogs/buttons per entity are not needed.

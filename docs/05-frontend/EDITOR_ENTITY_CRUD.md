# Editor: ручное добавление и удаление сущностей (Add/Delete)

Единый UI-паттерн для ручного добавления и удаления **персонажей, локаций и голосов**
на странице «Редактор» — непосредственно в существующих таблицах селекторов.
Паттерн спроектирован для переиспользования при Add/Delete **Unit** и **Scene**.

Платформы: **web** (`frontends/app`) + **Android** (`frontends/android`), одинаковый UX.

---

## UX-паттерн

```
Table
 └── Add (+) overlay-кнопка в правом верхнем углу
       ↓
     Modal/Dialog (форма по JSON-схеме сущности)
       ↓
     Save (валидация обязательных полей + уникальность ID)
       ↓
     Таблица обновляется без перезагрузки страницы

Table row
 └── [−] ID   (компактная «−»-кнопка, мягкий красный акцент, слева от ID)
       ↓
     Confirmation Dialog («Удалить персонажа/локацию/голос?»)
       ↓
     Удаляется ВЕСЬ JSON-объект сущности → таблица обновляется сразу
```

Ключевые требования:

- **«+»** — круглая, overlay/absolute относительно контейнера таблицы: не занимает
  место в layout, первая строка таблицы не сдвигается.
- **Диалог добавления** — modal, не отдельный экран с «Add → Back».
- **Удаление** — только через confirmation dialog; удаляется вся сущность целиком
  (весь JSON-объект), никаких висячих/частичных данных.
- **ID** — валидный введённый ID используется как есть; свободный ввод
  (например, кириллица) приводится к snake-case через существующую
  транслитерацию (см. ниже).
- Состояние других селекторов/таблиц не ломается; если удалена выбранная
  сущность — выделение корректно снимается.

---

## Backend API

Роуты зарегистрированы в `backend/src/routes/book-routes.cjs`
(под-регистратор `backend/src/routes/book/entity-crud-routes.cjs`):

| Метод | Путь | Действие |
|---|---|---|
| `POST` | `/api/v1/book/:bookId/entities/:kind` | Добавить сущность `kind` ∈ `characters` \| `locations` \| `voices` |
| `DELETE` | `/api/v1/book/:bookId/entities/:kind/:id` | Удалить сущность целиком |

- Запись идёт через **существующий** `book.saveBookBundle` — параллельный механизм
  сохранения не создаётся; JSON-структура книги не меняется.
- POST: валидация обязательных полей (по схеме сущности) + проверка
  уникальности ID → `409` при дубликате.
- DELETE: удаление всего JSON-объекта; при опустошении коллекции файл
  удаляется штатно (поведение `saveBookBundle`).

### Генерация ID

`backend/src/utils/entity-id.js` — **переиспользует существующую** функцию
транслитерации `cyrToLatin` (`backend/src/utils/string-utils.js`) + snake-case:

- Введённый ID уже в принятом формате → используется как есть.
- Свободный ввод (например, «Михаил Александрович Берлиоз») →
  транслитерация + snake-case → `mikhail_aleksandrovich_berlioz`.

Новая функция транслитерации не написана — используется существующий утилит backend'а.

---

## Web (`frontends/app`)

Переиспользуемые компоненты — `frontends/app/src/lib/entityEditor.tsx`:

- `EntityAddButton` — круглая «+» (overlay поверх таблицы).
- `EntityDeleteButton` — компактная «−», мягкий красный акцент.
- `EntityEditorDialog` — modal-форма, строится по схеме полей сущности.
- `DeleteConfirmDialog` — confirmation dialog с динамическим текстом сущности.

`frontends/app/src/pages/EditPage.tsx`:

- Схемы полей трёх сущностей (`ENTITY_SCHEMAS` в `frontends/app/src/lib/entityEditor.tsx`)
  построены по **текущим** JSON-моделям редактора (легаси-ключи демо-данных
  вроде `base_appearance` / `cinematic_space` в схему не входят):
  - character: `passport.appearance`, `passport.clothes`, `passport.video_tokens`;
  - location: `description`, `environment.time`, `environment.season`,
    `environment.lighting`, `environment.weather`, `environment.mood`,
    `environment.atmosphere`;
  - voice: `instruction`.
  ID — свободное поле ввода (валидный формат используется как есть, иначе —
  транслитерация на сервере).
- «+» в правом верхнем углу каждой таблицы; delete-кнопка в заголовке карточки
  слева от ID (не пересекается с «+»).
- После save/delete — обновление таблицы из локального состояния (без reload).
- Guard: сущность, удалённая после последней загрузки, пропускается при PATCH
  (иначе 404 ронял бы весь save).

Стили — `frontends/app/src/styles/base.css` (классы `.edit-entity-*`),
строки — `frontends/app/src/app/i18n.ts` (ru/en), иконка «−» — `IconMinus`
в `frontends/app/src/app/icons.tsx`.

---

## Android (`frontends/android`)

- `repository/BackendApi.kt` + `repository/Repository.kt` — CRUD-методы
  (`createEntity` / `deleteEntity`).
- `res/layout/fragment_edit.xml` — плавающая «+» (overlay поверх таблицы).
- `res/drawable/bg_entity_add.xml` (круглая кнопка), `res/drawable/ic_remove.xml`.
- `ui/EditFragment.kt`:
  - `EntityKind` enum + `EntityDef`/`EntityField` (схемы полей) — единый механизм на три сущности;
  - диалог добавления — по существующему паттерну (TextInputLayout, дизайн Editor);
  - confirmation dialog — «Удалить …?» / Отмена / Удалить;
  - delete-кнопка в заголовке карточки слева от ID;
  - обновление таблиц после save/delete, guard от PATCH удалённой сущности.
- Строки — `res/values/strings.xml` + `res/values-ru/strings.xml`.

---

## Расширение на Unit / Scene

Добавление новой сущности сводится к:

1. backend: `kind` в `entity-crud-routes.cjs` (схема полей для валидации);
2. web: схема полей в `EditPage.tsx` (форма строится автоматически);
3. Android: запись в `entityFields` + строки.

Отдельные диалоги/кнопки под каждую сущность не нужны.

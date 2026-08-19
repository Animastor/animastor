# Account & Workspace Reconnaissance

**Status:** Reconnaissance / Research (no code changed)
**Date:** 2026-08-19
**Source of truth:** existing docs + code (`docs/architecture/ACCOUNT_WORKSPACE_CONCEPT.md`, `backend/src/**`, `gpu-hub/**`, `worker/**`, `frontends/**`, `proxy/conf/default.conf`, `docker-compose.yml`)

---

## 1. Executive Summary

### Что уже есть
- **PostgreSQL как каноническое состояние** — 30+ таблиц (`backend/src/storage/postgres/schema.js`), schema применяется идемпотентно при старте (`runMigrations`), всё завязано на `book_id` как aggregate root.
- **Дремлющий `users`-фундамент**: таблицы `users`, `books.user_id`, `chat_sessions.user_id` существуют в schema, но **ни один запрос в приложении их не использует** (grep по `storage/postgres/repositories/*` и всему `backend/src` не даёт ни одного INSERT/SELECT на `users`). Это не auth, а «скелет на будущее».
- **Готовый идентификационный слой**: bookId, buildId, chapterId/sceneId/unitId, scene_hash, content_hash/file_hash, job_id, dispatch_id (см. §7).
- **Чёткая граница backend ↔ GPU Hub**: gpu-hub принимает от backend задачи с **X-API-Key** (`gpu-hub/gpu-hub.js:33-41`, `backend/src/runtime/gpu-dispatcher.js:64-68`). Workers аутентифицируются **бесключом** (beacon + poll).
- **Filesystem**: два корня — `data/books/<bookId>/` (исходная книга, multi-file vbook) и `data/output/<buildId>/` (сгенерированные артефакты). Path строится только из серверных ID.

### Чего нет
- **Никакой application-level аутентификации**: нет сессий, cookies, JWT, per-user токенов, middleware auth. Единственная защита — nginx **Basic Auth** на `app.animastor.in` (`proxy/conf/default.conf:282-287`), закрывающая весь SPA кроме `/library`. Это один общий пароль на всех, **не** identity.
- **Никакого понятия workspace / project / owner** в рантайме. `GET /api/v1/books` отдаёт **все** книги сервера любому клиенту.
- **Никакой привязки identity → filesystem**.
- **Никаких миграционных файлов**: схема живёт одним файлом `schema.js` (уже 834 строки), миграции — идемпотентные `ALTER` в `runMigrations`.

### Насколько сложно добавить accounts
- **Средне**. Понятие владельца почти везде сводится к одной оси `book_id`. Все связанные таблицы (scenes, scene_assets, image_units, generation_tasks, chat_*, agent_*, character_*) уже переносят `book_id`, поэтому **workspace_id достаточно добавить на `books`** (и/или в `book_source`), а всё остальное наследуется через book.
- Главные «подводные камни»: (1) media-serving роуты строят path прямо из URL-параметров без lookup в PG — потребуется единый ownership-resolver; (2) disk-scan recovery (`recoverAllBooksFromDisk`, `collectRecentBooks`) читает всю директорию книг без фильтра — станет небезопасным при мульти-пользователях; (3) Redis-ключи, индексированные по `book_id`, станут cross-tenant, если не ввести workspace-scoping.

### Главные точки интеграции
1. **`books` (и `book_source`) → `workspace_id`** — единственная ось ownership.
2. **Единый middleware аутентификации** в цепочке `backend/src/backend.cjs:63-89` (helmet → rate-limit → cors → json → request-id).
3. **Единый ownership-resolver** для media-serving роутов (`generation-routes.cjs`).
4. **`GET /api/v1/books`** — первая точка, которая обязана стать workspace-scoped.
5. **Header/frontend**: `desktop-header__actions` и мобильный toolbar — место для user/workspace меню.

---

## 2. Current Architecture

Схема существующего потока (по `docs/01-overview/SYSTEM_OVERVIEW.md`, `ARCHITECTURE.md`, `proxy/conf/default.conf`):

```text
              Internet
                 │
        ┌────────┴────────┐
        │ nginx (proxy)   │  proxy/conf/default.conf
        │ Basic Auth      │  animastor.in = public (no auth)
        │ (app.*, кроме   │  app.animastor.in = Basic Auth (общий пароль)
        │  /library)      │  /api/ → backend:3000   /gpu/ → gpu-hub:5000
        └────────┬────────┘
                 │
   ┌─────────────┼──────────────────────────┐
   ▼             ▼                          ▼
Backend       GPU Hub (5000)            Frontend SPA (static)
(Express:3000)  gpu-hub/gpu-hub.js        frontends/app/dist
 backend/src     │                        (за Basic Auth nginx)
   │             ├── Redis queues animastor:queue:{type}
   │             │    animastor:running / processing
   │             ▼
   │          Workers (worker/worker/worker.cjs)
   │             └── ComfyUI (image/audio/video)
   │
   ├── PostgreSQL 16 (каноническое состояние, schema.js)
   ├── Redis 7 (operational state, AOF persist)
   ├── Filesystem
   │     data/books/<bookId>/        ← исходная книга (vbook multi-file)
   │     data/output/<buildId>/      ← артефакты (mp3/png/mp4)
   └── AI API (aicredits/OpenRouter) ← агенты и TTS
```

Ключевой факт: **приложение НЕ аутентифицирует пользователей**. Nginx Basic Auth — единственный барьер, общий для всех. Express-приложение открыто для любого запроса, дошедшего до него.

---

## 3. Current Database

Все таблицы описаны в `backend/src/storage/postgres/schema.js`. Схема создаётся **кодом** (никаких миграционных файлов; `runMigrations()` — идемпотентная серия `CREATE TABLE IF NOT EXISTS` + `ALTER ... ADD COLUMN IF NOT EXISTS`). Репозитории: `backend/src/storage/postgres/repositories/` (12 файлов).

### Таблицы

| Таблица | Роль | Ключ / примечание |
|---|---|---|
| `users` | **Дремлющая** — будущие аккаунты | `user_id UUID PK`, `email UNIQUE NOT NULL`, `password_hash`, `display_name`, `role`, `settings` (schema.js:10-20). **Не используется ни одним запросом в приложении.** |
| `books` | Реестр книг | `book_id TEXT PK`, **`user_id UUID REFERENCES users`** (schema.js:25), `title`, `author`, `language`, `visibility`, `tags`, `metadata`. **user_id тоже не используется.** |
| `book_snapshots` | Версии книги (diff) | FK `books(book_id) ON DELETE CASCADE`, `version`, `snapshot JSONB` |
| `scenes` | Метаданные сцен | PK `(book_id, chapter_id, scene_id)`, `scene_hash`, `build_id`, `status`, `content_version`, `audio_config_version`, `is_dirty`, `dirty_unit_ids` |
| `asset_states` | Per-layer состояние | PK `(book_id, chapter_id, scene_id, layer)`, `status`, `hash`, `version` |
| `cache_entries` | Детерминистичный кэш | `asset_key UNIQUE`, `file_path`, `content_hash`, `status`, индексы по book/scene/hash |
| `asset_dependencies` | Граф зависимостей | `(book_id, source_layer, target_layer)` |
| `generation_tasks` | История задач GPU | `task_id`, `book_id`, `scene_id`, `task_type`, `status`, `worker_id`, `retry_count` |
| `workers` | Реестр воркеров | `worker_id PK`, `worker_type`, `status` |
| `reconciliation_events` | Лог самовосстановления | `book_id`, `event_type` |
| `output_manifests` | Пер-build манифесты | `build_id`, `book_id`, `asset_type`, `UNIQUE(build_id, book_id, asset_type)` |
| `image_units` | Storyboard IU | `book_id`, `build_id`, `chapter_id`, `scene_id`, `unit_id`, тайминги |
| `storyboard_elements` | (future) | FK `books` |
| `audio_layers` | (future) | FK `books` |
| `scene_assets` | **Путь истины для asset-файлов** | `book_id/chapter_id/scene_id/asset_type`, `path`, `build_id`, `scene_hash`, `status`, версии, `UNIQUE(book_id, chapter_id, scene_id, asset_type, build_id)` |
| `ai_chat_sessions` | Плоские AI-сессии | `book_id`, `mode`, `messages JSONB` |
| `chat_sessions` | Группировка чатов | `session_id UUID PK`, **`user_id REFERENCES users`** (тоже дремлющий), `book_id` |
| `chat_messages` | Сообщения чата | `session_id FK`, `book_id`, `role`, `message` |
| `book_events` | Аудит-лог книги | `book_id`, **`actor`** (TEXT — единственное существующее «кто сделал», заполняется местами), `event_type`, `details JSONB` |
| `agent_sessions` | Сессии AI-импорта | `book_id`, `source_type`, `status` |
| `agent_steps` | Шаги пайплайна | FK `agent_sessions`, `step_type` (CHECK-список) |
| `agent_conversations` | AI-вызовы | FK `agent_sessions`/`agent_steps` |
| `agent_messages` | prompt/response | FK `agent_conversations` |
| `character_resolution_runs` | Coreference-ран | `book_id`, `run_type`, `character_registry_hash`, `source_hash` |
| `character_window_candidates` | Кандидаты | FK run, `character_id` |
| `sentence_resolutions` | Пословные резолюции | FK run, `scene_id` |
| `character_mentions` | Меншены | FK run, `character_id` |
| `character_aliases` | Индекс алиасов | PK `(book_id, alias_norm, character_id)` |
| `book_source` | **SHA256 файла → book_id** | `file_hash UNIQUE`, `book_id`, `source_type` (schema.js:750-767). Используется для dedup импорта и списка книг. |
| `book_generation_sessions` | Window-state импорта | `book_id`, `window_index`, `status` |
| `generation_cancellations` | Tombstone отмены | `book_id PK`, `created_by` |

### Карта связей (текущая)

```text
books (book_id PK, user_id — дремлющий)
  ├── book_snapshots            (book_id FK, CASCADE)
  ├── scenes                    (book_id в PK) ── scene_hash, build_id
  ├── asset_states              (book_id в PK)
  ├── cache_entries             (book_id + index)
  ├── asset_dependencies        (book_id)
  ├── generation_tasks          (book_id)
  ├── reconciliation_events     (book_id)
  ├── output_manifests          (book_id + build_id)
  ├── image_units               (book_id + build_id)
  ├── storyboard_elements       (book_id FK)
  ├── audio_layers              (book_id FK)
  ├── scene_assets              (book_id + build_id + scene_hash)
  ├── ai_chat_sessions          (book_id)
  ├── chat_sessions             (book_id, user_id — дремлющий)
  │     └── chat_messages       (session_id FK)
  ├── book_events               (book_id, actor)
  ├── agent_sessions            (book_id)
  │     ├── agent_steps         (session_id FK)
  │     │     └── agent_conversations → agent_messages
  ├── character_resolution_runs (book_id) → window_candidates / sentence_resolutions / character_mentions
  ├── character_aliases         (book_id)
  ├── book_source               (book_id, file_hash)
  ├── book_generation_sessions  (book_id)
  └── generation_cancellations  (book_id PK)
```

### Выводы для workspace-модели

- **Естественно получат `workspace_id`**: `books`, `book_source` (и, для чистоты, `agent_sessions`/`book_events` — но они наследуют через book_id). Достаточно ввести `workspace_id` на `books` + индекс; все нижележащие таблицы получают его транзитивно через `book_id`.
- **НЕ должны получать `user_id` напрямую**: `scenes`, `scene_assets`, `image_units`, `generation_tasks`, `cache_entries`, `asset_states` — их identity должен идти только через `book → workspace`. Прямой `user_id` здесь создал бы параллельную ownership-систему.
- `book_events.actor` — существующий «кто»-атрибут; при введении аккаунтов его можно связать с `user_id` (мягко, без ломания).
- `users` уже имеет несовместимую с концептом форму: `email NOT NULL` и нет `username`. При реализации потребуется миграция, а не использование «как есть».

---

## 4. BKN

**Важно:** в кодовой базе нет сущности с именем «BKN». Термин встречается только в `ACCOUNT_WORKSPACE_CONCEPT.md` (строки 265, 922). Ближайшее, что существует и выполняет роль «canonical book knowledge» — это **VBook multi-file формат** (тот же, что в `MiM.vbook` — ZIP с `manifest.json`, `book.json`, `chapters/*.json`).

### Что является canonical state

1. **Manifest + book.json на диске** — источник истины для идентичности книги:
   - `manifest.json` содержит `vbook_version`, `book_id`, **`build_id`**, `state`, `created_at` (`backend/src/book/lazy-book/draft.js:37-50`).
   - `book.json` — структура книги (title, author, language, chapters, defaults).
   - `chapters/*.json` — сцены/главы.
   - `generation-routes.cjs:34-47` прямо говорит: **«manifest.json is the single source of truth for build_id»**; клиентский build_id не доверяется.
2. **PostgreSQL** — каноническое состояние для: book_source (hash→book), scene_assets (asset registry), book_events (аудит), generation_tasks, agent_sessions, image_units, cache_entries.
3. **Redis** — операционное состояние генерации (per-asset state, очереди, lease, прогресс).

### Где связи книга ↔ сцены ↔ файлы ↔ generation state

- Книга → сцены: **filesystem** `book.json` + `chapters/*.json` (lazy-book) И **PG** `scenes` (через book_id). Синхронизация — `book-sync.js` по `scene_hash`.
- Сцена → артефакты: **PG** `scene_assets` (path, build_id, scene_hash) + **filesystem** `data/output/<buildId>/<bookId>_<chapterId>_<sceneId>.*`.
- Generation state: **Redis** per-asset state (`scene-state.js`), **PG** `scene_assets.status`, `generation_tasks`, `output_manifests`.

### Точка для workspace ownership

Естественная точка — **`books` + `book_source`**. Всё наследуется через `book_id`. Никакой параллельной ownership-системы рядом с BKN создавать не нужно: `books.workspace_id` покрывает все дочерние сущности, так как каждый идентификатор сцены/ассета уже включает `book_id`.

---

## 5. Filesystem

### Текущая структура

```text
data/books/
  <bookId>/                    ← bookId = <title_slug>_<Date.now()> (paths.js:26-31)
    manifest.json              ← book_id, build_id, state
    book.json                  ← структура (title, chapters)
    source.txt                 ← исходный текст
    characters.json, mentions.json, bible.json,
    locations.json, voices.json, cover.json
    chapters/*.json            ← сцены
data/output/
  <buildId>/                   ← buildId = build_<bookId> (draft.js:36)
    <bookId>_<chapterId>_<sceneId>.mp3        ← scene audio
    <bookId>_<chapterId>_<sceneId>.mp4        ← scene video (+ _gN.mp4 группы)
    <bookId>_<chapterId>_<sceneId>_NNNN.mp3   ← аудио-чанки
    <bookId>_<chapterId>_<sceneId>_iu<iuId>.png   ← изображения IU
    <bookId>_<chapterId>_<sceneId>_pr<iuId>.png   ← превью
```

Path-хелперы: `backend/src/storage/filesystem-store.js` (все имена файлов), `backend/src/book/lazy-book/paths.js` (пути книги).

### Идентификаторы в path

- `data/books/<bookId>/` — top-level папка книги.
- `data/output/<buildId>/` — top-level папка артефактов.
- Внутри: `bookId_chapterId_sceneId[...]` в имени файла. **workspace/user в path отсутствует.**

### Как определяется путь

- Книга: `getBookDir(bookId) = path.join(BOOKS_DIR, bookId)` — из `bookId` (URL param).
- Артефакты: `path.join(OUTPUT_DIR, buildId, filename)` — `buildId` берётся из manifest (`getEffectiveBuildId`, `generation-routes.cjs:34-47`), но **при недоступном manifest использует клиентский `req.query.build_id` как fallback**.

### Может ли frontend/worker влиять на path

- **Да, косвенно.** Media-serving роуты (`/api/v1/iu-image/:bookId/:chapterId/:sceneId/:iuId`, `/api/v1/scene/:bookId/:chapterId/:sceneId/audio|video|image|storyboard|status`, `/api/v1/preview/...`) строят путь **прямо из URL-параметров** без обращения к PG: `path.join(OUTPUT_DIR, buildId, `${bookId}_${chapterId}_${sceneId}_${iuId}.png`)` (`generation-routes.cjs:429`).
- **`bookId` генерируется из title** (`generateBookId`, paths.js:26-31) — title приходит с клиента, значит часть bookId пользователь-контролируема (но bookId уникализируется timestamp'ом).
- `/api/v1/chunk/:id/...` строит path из данных в Redis (`c.build_id`, `c.book_id`) — тоже без ownership-check.

### Recovery с диска

- `recoverAllBooksFromDisk` / `recoverChunksFromDisk` (`backend/src/helpers/redis-helpers.cjs`) — сканируют `data/books` и `data/output/<buildId>` и восстанавливают Redis-состояние.
- `reconciliation-engine.js` (цикл на старте + периодический) сверяет PG↔Redis↔disk.
- `book-sync.js` — синхронизирует JSON↔DB по `scene_hash`.
- `collectRecentBooks` (`recent-books-routes.cjs`) — **disk scan всей директории книг** как fallback для списка книг.

### Вывод для future `workspace_id → book_id → path`

- Физический layout менять **не обязательно**: достаточно того, что **backend всегда резолвит workspace через PG до построения пути**.
- Нужен единый helper `resolveBookPath(bookId)` / `resolveBuildDir(bookId)`, который перед path-строением проверяет ownership в PG.
- Опасный fallback `req.query.build_id` в `getEffectiveBuildId` при введении auth должен либо умереть, либо пройти через ownership-check.
- При желании глубокой изоляции (в будущем) — префикс `storage/workspaces/<workspace_id>/books/<book_id>/`, но это потребует миграции данных и восстановления (`recoverAllBooksFromDisk`). Рекомендуется **не делать на первом этапе** — ownership должен жить в PG, не в path.

---

## 6. Current Identity / Authentication

### Что существует

| Механизм | Где | Что защищает | Кто «пользователь» |
|---|---|---|---|
| **nginx Basic Auth** | `proxy/conf/default.conf:282-287` | Весь SPA `app.animastor.in` кроме `/library` | Единственный общий пароль (`.htpasswd`) — **не identity** |
| **GPU_HUB_API_KEY** (X-API-Key) | `gpu-hub/gpu-hub.js:33-41`, `backend/src/runtime/gpu-dispatcher.js:64-68` | POST `/task`, DELETE `/queue/clear` | Service-to-service (backend → hub) |
| **AI API keys** | `backend/src/services/ai-service.js`, `ai-caller.js` | Вызовы AI (aicredits/OpenRouter) | Сервисный ключ |
| `GPU_HUB_API_KEY` при `null` | `gpu-hub.js:34` | — | **«no key configured = open access»** |

### Чего НЕТ (подтверждено поиском)

- Нет сессий, cookies, JWT, Bearer, per-user token, OIDC, passport, bcrypt/argon2 зависимостей.
- Нет auth-эндпоинтов (нет `/login`, `/register`, `/logout`).
- Нет middleware auth в Express: цепочка `backend.cjs:63-89` = helmet → rate-limit → cors → json → request-id → логгер. Всё.
- Frontend `api/client.ts` не отправляет никаких auth-заголовков — полагается на Basic Auth браузера.
- Android: Basic Auth, вероятно, в OkHttp (проверить `frontends/android` — не исследовано в деталях, но отдельных токенов не найдено).
- `users`-таблица существует, но **мертва**.

### Где будет подключаться middleware

Естественная точка — сразу после `app.set('trust proxy')` / `helmet` в `backend/src/backend.cjs` (после строки 65), до rate-limit, либо отдельным `app.use('/api/', requireAuth)`.

---

## 7. IDs, Hashes and Build IDs

| Identifier | Meaning | Created by | Stored in | Security role |
|---|---|---|---|---|
| **`book_id`** | Идентичность книги (aggregate root) | Сервер: `title_slug + Date.now()` (`paths.js:26-31`); title приходит с клиента | `manifest.json.book_id`, `books.book_id PK`, dir `data/books/<bookId>/`, все таблицы | **Не auth**. Частично контролируется клиентом (title). |
| **`build_id`** | Идентичность сборки/папки артефактов | Сервер: `build_<bookId>` (`draft.js:36`) | `manifest.json.build_id`, `scenes.build_id`, `scene_assets.build_id`, `output_manifests`, dir `data/output/<buildId>/` | **Не auth**. Fallback на клиентский `req.query.build_id` при недоступном manifest. |
| **`chapter_id` / `scene_id` / `unit_id`** | Структура книги | Сервер: `prefix-<8hex>` (`paths.js:19-24`); frontend-превью `idgen.ts` (не авторитет) | JSON книги, `scenes`, `image_units`, имена файлов | Не auth. |
| **`scene_hash`** | Стабильный SHA256 содержимого сцены | Сервер: `scene-hash.js` (canonicalize → sha256) | `scenes.scene_hash`, `scene_assets.scene_hash` | **Dedup/инвалидация кэша, НЕ авторизация.** |
| **`content_hash` / `file_hash`** | SHA256 файла/артефакта | Сервер: crypto (`book_source-repo.js`, `cache_entries`) | `book_source.file_hash UNIQUE`, `cache_entries.content_hash` | **Dedup импорта, НЕ авторизация.** |
| **`job_id`** | Идентичность GPU-задачи | Сервер: `${assetId}:${type}` (`job-schema.js`) | Redis (`animastor:job:`, `running`, `queue`), payload hub | Не auth. |
| **`dispatch_id`** | Идентичность диспетчеризации (lease/dedup) | Сервер (dispatch-engine) | Redis `animastor:dispatch-lease:`, `animastor:job:<dispatch_id>:<job_id>`, `generation_tasks` | Не auth. |
| **`asset_key`** (cache_entries) | Детерминистичный ключ кэша | Сервер | `cache_entries.asset_key UNIQUE` | Не auth. |
| **`chunk id`** | Redis-ключ чанка сцены | Сервер | `animastor:chunk:<id>` | **Используется в URL `/api/v1/chunk/:id/*` — знание ID даёт доступ.** |
| **`request_id`** | Трассировка запроса | Сервер (`backend.cjs:81`) | лог | Нет. |
| **`user_id`** | (Дремлющий) | — | `users`, `books`, `chat_sessions` | Не используется. |

### Скрытое предположение «знаешь ID → получаешь ресурс»

**Да, существует**, и оно встроено в архитектуру: все media-serving и статусные роуты идентифицируют ресурс **только по ID в URL / Redis-ключе**, без какой-либо проверки. См. §12. Это фундаментально, потому что сейчас весь сервер — один «tenant».

---

## 8. Generation / GPU Hub

### Путь задачи

```text
Frontend (POST /api/v1/generate | /book/:id/regenerate)
  → backend routes (generation-routes.cjs)
  → dispatch-engine / scene-orchestrator (lease, quota, governance)
  → gpu-dispatcher.sendUnified (gpu-dispatcher.js:29-100)
       headers: x-api-key = GPU_HUB_API_KEY
  → POST gpu-hub /task (gpu-hub.js:297-382)   ← requireApiKey
       payload: job_id, params, build_id, book_id, chapter_id, scene_id, stage, dispatch_id
  → Redis queue animastor:queue:{audio|image|video}
  → Worker: beacon (регистрация) → GET /task/next (гpus-hub.js:388-472)
       [worker БЕЗ ключа — достаточно знать URL]
  → ComfyUI → результат (base64)
  → Worker POST /task/result (gpu-hub.js:478-585)
  → gpu-hub сохраняет animastor:result:<build>:<book>:<chapter>:<scene>:<type> + POST /gpu/task/result → backend
  → task-handler → orchestrator.handle*Completed → save asset (filesystem) + scene_assets (PG) + Redis state
```

### Где логично проверять authorization

- **Единственное правильное место — backend route boundary** (`backend.cjs` middleware + роуты). Workers и gpu-hub **не должны** решать, имеет ли человек право на книгу — они работают на доверенных ID (`book_id`, `job_id`, `dispatch_id`), полученных от backend. Это уже так: hub передаёт `book_id/chapter_id/scene_id` прозрачно и никогда не проверяет владение.
- Конкретные точки: middleware на `/api/`; ownership-check внутри роутов, строящих path; в `getEffectiveBuildId`.
- GPU Hub и worker получат преимущество автоматически: если backend не выдаст задачу на чужую книгу, hub/worker никогда её не увидят.

### Проблемы безопасности этой цепочки (см. §12)

- `/task/next`, `/task/result`, `/task/error`, `/beacon` на gpu-hub **не защищены ключом** — любой, кто знает URL, может зарегистрироваться воркером и забрать задачу (включая промпты и вложенные изображения).
- Результат передаётся base64 через публичный hub; TLS защищает канал, но не аутентифицирует воркера.

---

## 9. Redis

### Найденные ключи (~100 паттернов)

**Persistent-ish / semi-persistent операционное состояние (содержат book/scene identity):**
- `animastor:chunk:<id>` — состояние сцены (book_id, chapter_id, scene_id, build_id, флаги готовности)
- `animastor:asset-state:*`, `animastor:scene-state:*`, `animastor:iu-progress:*`, `animastor:iu-in-flight:*`, `animastor:iu-registry:*`
- `animastor:book:*`, `animastor:book-scenes:*`, `animastor:layer-config:*`, `animastor:gen-scope:*`, `animastor:vbook-scene-idx:*`
- `animastor:cancelled-workers:*`, `animastor:generation-progress:*`, `animastor:runtime:persistence:*`, `animastor:snapshot:*`, `animastor:scope:*`
- `animastor:event-journal:*` (TTL 7d)

**Transient operational state:**
- `animastor:dispatch-lease:*`, `animastor:dispatch-completed:*`, `animastor:dispatch-meta:*`
- `animastor:runtime:active-audio/image/video`, `animastor:runtime:metrics:*`, `animastor:runtime:quotas:*`, `animastor:runtime:retry:*`, `animastor:runtime:recovery:*`
- `animastor:queue:{audio,image,video}`, `animastor:running`, `animastor:processing`, `animastor:result:*`, `animastor:error:*`, `animastor:job:*`
- `animastor:worker:heartbeat:*`, `animastor:gpu-hub:workers`
- `animastor:audio-merge-lock:*`, `animastor:video-lock:*`, `animastor:scene-lock:*`, `animastor:cleanup-lock`, `animastor:regenerate-lock`, `animastor:video-dedup:*`, `animastor:audio-scene-lock:*`, `animastor:circuit:*`, `animastor:failure:*`, `animastor:retry-budget:*`, `animastor:fairness:*`, `animastor:error-processed:*`, `animastor:result-processed:*`, `animastor:priority:queue`, `animastor:force-dispatch:*`, `animastor:scene-heartbeat:*`, `animastor:scene-video:*`, `animastor:audio-orch:*`, `animastor:video-orch:*`, `animastor:drift:*`, `animastor:stuck-scenes`, `animastor:runtime:scheduler:*`, `animastor:lease:*`, `animastor:lease-heartbeat:*`, `animastor:runtime:total-*`, `animastor:mode:*`, `animastor:prompt-profiles:*`, `animastor:pending-purge*`, `animastor:video-merge-lock:*`, `animastor:audio-scene-failsafe:*`

### Выводы

- **Redis не должен быть источником истины для ownership.** На данный момент ownership в Redis не живёт — там только `book_id` в операционных ключах. Но `animastor:chunk:*` хранит полную scene-identity и используется для построения media-путей (`/api/v1/chunk/:id/*`); если эти ключи потеряны — есть disk recovery.
- **Обязательно остаётся в PostgreSQL** (при реализации accounts): users, workspaces, workspace_members, books.workspace_id, и все persistent-домены (book_source, scene_assets, generation_tasks, book_events, agent_sessions, image_units).
- **Нельзя допустить**, чтобы session/anonymous-identity жили только в Redis — при рестарте Redis пользователь потерял бы доступ к своей работе (прямо противоречит концепту: «PostgreSQL is source of truth for identity»).

---

## 10. Frontend Integration Points

Фронтенд: `frontends/app` (Preact, responsive: MobileShell/DesktopShell), публичный сайт `frontends/website` (auth не нужен), Android `frontends/android` (Kotlin, зеркалит Web).

### Места для user/workspace меню

- **Desktop header**: `frontends/app/src/app/AppShell.tsx:163` — `<div class="desktop-header__actions">` содержит AI chip + Settings button. Сюда ложится кнопка User/Workspace (концепт: `[ User / Workspace ] [ Settings ]`), рядом с Settings.
- **Mobile toolbar**: `AppShell.tsx:322-361` — `<header class="toolbar">` с AI chip + Settings. Сюда же — кнопка пользователя.
- Концепт явно разделяет: User/Workspace («кто я/какой workspace») vs Settings («как себя ведёт приложение») — не смешивать (концепт §19).

### API client / session

- `frontends/app/src/api/client.ts` — единственная точка всех запросов. `API_BASE = '/api/v1'` (относительный, hostname не зашит). Сейчас НЕ шлёт auth-заголовков. Здесь добавится проброс токена/cookie.
- Хранение client state: `localStorage` (`animastor_desktop_panels`), `sessionStorage` (`animastor_ai_bubble_dismissed`), Preact-сигналы в `frontends/app/src/state/*` (`generateStore.ts`, `playbackStore.ts`, `positionStore.ts`).
- **Будущая auth-session**: новый сигнал-store (по образцу `generateStore.ts`), персистент в localStorage. НО: по концепту браузер хранит только reconnect-credential, а не данные.

### Затронутые компоненты

- `AppShell.tsx` (header/toolbar), `api/client.ts` (auth-заголовки), `SettingsPage.tsx` (место для Account-под-настроек), `router.ts` (новые маршруты /login, /account), `FilePage.tsx` (список книг станет workspace-scoped), `generateStore.ts` (bookId-открытие — потребует resolve через workspace). Android-зеркала: `frontends/android` (сверка по `docs/08-mobile-web-migration/*`).

---

## 11. API Authorization Map

Все маршруты монтируются в `backend.cjs` (строки 156-171). Группы:

| Endpoint/group | File | Current access | Future ownership check | Notes |
|---|---|---|---|---|
| `GET /health`, `GET /metrics` | `backend.cjs` | public (nginx health) | нет | liveness |
| `GET /api/v1/books` | `recent-books-routes.cjs:121` | **любой** — все книги сервера | **да (обязательно)** | сейчас = «shared sandbox» |
| `GET /api/v1/book/:bookId` + `PUT/PATCH` | `core-routes.cjs` | любой с book_id | да | |
| `DELETE /api/v1/book/:bookId` | `core-routes.cjs:745` | любой с book_id | да | также чистит Redis |
| `POST /api/v1/book/load-vbook` | `import-routes.cjs:302` | любой | да (создание привязки к workspace) | bookId из bundle |
| `POST /api/v1/book/import-txt` (+ bootstrap, resume, next-window, trigger) | `import-routes.cjs` | любой | да | создаёт bookId из title |
| `POST /api/v1/generate` | `generation-routes.cjs:52` | любой с файлом | да | legacy full-book |
| `POST /api/v1/book/:bookId/regenerate`, `cancel-generation`, `generate-next` | `book/generation-routes.cjs` | любой с book_id | да | |
| `GET /api/v1/chunk/:id/*` (status, audio, image, video, storyboard) | `generation-routes.cjs:178,287,599,612,654` | **любой с chunk id** | да | path строится из Redis chunk |
| `GET /api/v1/scene/:bookId/:chapterId/:sceneId/(audio\|video\|image\|storyboard\|status)` | `generation-routes.cjs:756,771,906,923,942` | **любой с ID в URL** | да | **path строится из URL params без PG lookup** |
| `GET /api/v1/iu-image/...`, `/api/v1/preview/...` | `generation-routes.cjs:425,441` | **любой с ID** | да | прямой path.join из params |
| `POST /api/v1/worker/heartbeat`, `GET /worker/status`, `GET /worker/counts` | `generation-routes.cjs:458,473,483` | любой | да (урезать до workspace-скоупа) | heartbeat от worker |
| `GET /api/v1/book/:bookId/progress-stream` (SSE) | `generation-routes.cjs:544` | любой с book_id | да | |
| `/api/v1/book/:bookId/agent-status` | `agent-routes.cjs` | любой | да | |
| `/api/v1/book/:bookId/recover-placeholders` | `recovery-routes.cjs:20` | любой | да | |
| `/api/v1/book/:bookId/export/*`, `/download` | `export-routes.cjs` | любой с book_id | да | отдаёт `.vbook` zip |
| `/api/v1/book/:bookId/.../versions`, `/parse`, `/snapshot`, `/source`, `/cache` | `versions/parse/cache-routes.cjs` | любой | да | |
| `POST /api/v1/book/:bookId/characters\|locations\|voices` (entity CRUD) | `entity-crud-routes.cjs` | любой | да | |
| `/api/v1/ai/*`, `/api/v1/agent/*` | `ai-routes.cjs`, `debug-routes.cjs` | любой | да | AI-чат, сессии |
| `/api/v1/workflows/*`, `/api/v1/connectors/*`, `/api/v1/config/*` | `workflow/connector/config-routes.cjs` | любой | нет (app-level) | конфиг-роуты |
| `/gpu/task/result`, `/gpu/task/error` (backend, от gpu-hub) | в `generation-routes.cjs` | service (gpu-hub) | service | внутренние |
| gpu-hub `/task` POST, `/queue/clear` DELETE | `gpu-hub.js` | **X-API-Key** | service | уже авторизовано |
| gpu-hub `/task/next`, `/task/result`, `/task/error`, `/beacon`, `/health` | `gpu-hub.js` | **open** | worker-level | см. §12 |
| nginx `/library`, статика `animastor.in` | `default.conf` | public | нет | публичный контент |

---

## 12. Security Risks Found During Reconnaissance

Только фиксация; ничего не исправлено.

1. **Media-serving без ownership-check** — path строится прямо из URL-параметров: `/api/v1/scene/:bookId/:chapterId/:sceneId/audio|video|image`, `/api/v1/iu-image/:bookId/...`, `/api/v1/preview/...` (`generation-routes.cjs:429,756,906,923,942`). Нет обращения к PG, нет проверки прав.
2. **Chunk-роуты без ownership-check** — `/api/v1/chunk/:id/audio|image|video|storyboard|status` (`generation-routes.cjs:178-282,599-666`) — доступ по знанию Redis chunk id.
3. **`GET /api/v1/books` возвращает все книги сервера** любому клиенту (`recent-books-routes.cjs:121-133`), включая disk-scan всего `data/books`.
4. **`getEffectiveBuildId` fallback на клиентский `req.query.build_id`** при недоступном manifest (`generation-routes.cjs:34-47`) — клиент может повлиять на build-адресацию.
5. **Worker-endpoints GPU hub без аутентификации**: `/beacon`, `/task/next`, `/task/result`, `/task/error` (`gpu-hub.js`) — любой, знающий URL, может зарегистрироваться воркером, забрать задачи (промпты + вложенные изображения) или поститать результаты.
6. **`GPU_HUB_API_KEY` по умолчанию `null` = открытый `/task` и `/queue/clear`** (`gpu-hub.js:34`).
7. **Публичные и внутренние эндпоинты на одном Express-сервере**: `/health`, `/metrics`, `/gpu/*` не выделены в отдельный сервис; при ошибке конфигурации nginx всё доступно напрямую.
8. **Redis-ключи индексированы по `book_id` без workspace-скоупа** — при мульти-тенантности потребуется пересмотр, чтобы избежать cross-tenant утечек через угадывание book_id.
9. **bookId частично клиент-контролируем** (title → slug в `paths.js:26-31`) — сам по себе не критично, но при отсутствии auth это лёгкий коллизионный вектор.
10. **`users`-таблица и FK `books.user_id` существуют, но не используются** — риск «полуреализованной» security-модели, которую будущий код может принять за работающую.
11. **`book_events.actor`** — неструктурированный «кто», без привязки к identity.
12. **Basic Auth (общий пароль) не является identity** — вся защита приложения — один общий секрет в nginx.

---

## 13. Proposed Integration Points

### 13.1 Данные (PG)

```text
users            → наполнить (username, password_hash, email optional, recovery_key_hash)
workspaces       → новая таблица (id, name, owner_user_id, plan)
workspace_members→ новая таблица (workspace_id, user_id, role)
books            → + workspace_id  (миграция существующих книг в «legacy»/первый workspace)
book_source      → наследует через book_id (или + workspace_id для прямых запросов)
sessions/tokens  → новая таблица (или httpOnly cookie + server-side session в PG)
```

**НЕ добавлять user_id** в scenes/scene_assets/image_units/generation_tasks/cache_entries — только через `book → workspace`.

### 13.2 Backend

- **Auth middleware** в `backend.cjs` после helmet, перед роутами: resolver identity из cookie/token → `req.user`/`req.workspace`.
- **Ownership resolver** (`requireWorkspaceBook(bookId)`) — единственная точка перед: media-serving, chunk-роутами, экспортом, удалением, генерацией, SSE, списком книг.
- **`GET /api/v1/books`** → фильтр `WHERE workspace_id = $1`.
- **`getEffectiveBuildId`** — убрать client-fallback либо проверять ownership до использования.
- **Anonymous identity**: при первом запросе создавать анонимного user + temporary workspace; браузеру — reconnect-токен.

### 13.3 Generation / GPU Hub

- Оставить как есть: hub/worker работают на доверенных ID. Никаких ownership-проверок на hub.
- Защитить worker-эндпоинты hub (worker токен) — отдельно от accounts, но до мульти-пользователей желательно.
- В payload задачи уже есть `book_id`/`chapter_id`/`scene_id`/`stage`/`dispatch_id` — workspace_id можно добавить транзитивно (или не добавлять вовсе, т.к. backend уже проверил).

### 13.4 Filesystem

- **НЕ** переезжать на `workspaces/<id>/books/...` на первом этапе. Вместо этого: ownership живёт в PG; `resolveBookDir()` ходит в PG.
- Recovery (`recoverAllBooksFromDisk`, `collectRecentBooks`) — сканировать книги только workspace-скоупа (или вернуть list из PG и disk-scan оставить только как fallback под тем же фильтром).

### 13.5 Frontend

- Кнопка User/Workspace в `desktop-header__actions` + mobile toolbar.
- `api/client.ts` — проброс токена.
- Новый `authStore` (сигналы + localStorage) по образцу `generateStore`.
- Маршруты `/login`, `/register`, `/account` в `router.ts`.

---

## 14. Open Questions

1. Что делать с существующей дремлющей `users`-таблицей (email NOT NULL, нет username) — мигрировать или заменить с нуля?
2. Куда направить существующие книги (сейчас `books.user_id` пуст) при введении workspace — создавать «legacy»/системный workspace?
3. Анонимная сессия: cookie (httpOnly) vs токен в localStorage; ротация; срок жизни.
4. Как аутентифицировать Android (OkHttp Basic Auth сегодня) — переводить на токены?
5. Срок жизни анонимного workspace, лимиты storage/GPU — до реализации нужны цифры.
6. Как поступить с worker-эндпоинтами gpu-hub (`/task/next` и др.) — вводить ли worker-токены до accounts.
7. `visibility` в `books` (private/public/shared) — это будущий механизм шаринга; как он соотносится с `workspace_members`.
8. Публичная Library (`/library`) — остаётся вне accounts?
9. Как workspace-scope-индексировать Redis-ключи без полной миграции ключей?
10. Нужен ли `workspace_id` в `book_source` для прямых запросов или достаточно join через `book_id`.

---

## 15. Recommended Next Step

**Минимальный первый этап (соответствует Phase 1+2 концепта), без изменения существующих маршрутов:**

1. **Проектирование схемы** (не миграция!): документ с точными `ALTER`/`CREATE` для `users`, `workspaces`, `workspace_members`, `sessions`, `books.workspace_id` — с учётом текущего дремлющего `users`.
2. **Рефакторинг адресации**: ввести в backend единый ownership-resolver, но **пока с hardcoded «single workspace»** — так, чтобы media-serving и chunk-роуты перестали строить path напрямую из URL, не меняя поведение.
3. **Anonymous identity**: создать анонимного пользователя + temporary workspace при первом запросе + выдать reconnect-токен; привязать к нему все создаваемые книги.
4. **`GET /api/v1/books` → workspace-scoped** (первый видимый и безопасный шаг).
5. **UI**: кнопка User/Workspace в header (пока показывает «Anonymous / Temporary workspace» и заглушку «Keep my workspace»).

Этот шаг даёт работающий ownership-слой под капотом, сохраняет обратную совместимость всех текущих клиентов и не трогает генерацию/GPU Hub.

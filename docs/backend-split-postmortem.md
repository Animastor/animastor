# Backend Split Postmortem — 2026-06-10/11

## Что произошло

Ночью 10 июня 2026 была предпринята попытка разделить монолитный `backend.cjs` (6059 строк)
на модульные route-файлы. `backend.cjs` был урезан до 143 строк (точка входа),
а вся логика эндпоинтов вынесена в `backend/src/routes/` (8 файлов).

После применения изменений **перестал работать плеер**.
Пришлось откатиться до коммита `380a777` (Recovery01: June 9 working state).

---

## Root Cause Analysis

### Гипотеза 1: Битые require / экспорты
**Вероятность: высокая**

`backend.cjs` (143 строки) подключает роуты через `require('./routes/...')`.
Если хотя бы в одном файле роута:
- Неправильный `module.exports`
- Отсутствует `require()` для зависимости, которая раньше была глобальной в `backend.cjs`
- Используется переменная, определённая в `backend.cjs` (например, `redis`, `log`, `config`)

→ **весь сервер падает при старте** или конкретный эндпоинт отвечает 500/404.

#### Ключевой вопрос: как роуты получали доступ к зависимостям?

В монолите все эндпоинты регистрировались на глобальном `app`
и использовали `redis`, `config`, `stats` из замыкания.
При выносе в роуты нужно было решить, как передать эти зависимости.

**Вариант A:** Роут экспортирует функцию, которая принимает зависимости:
```javascript
module.exports = function(app, redis, config) {
    app.get('/api/v1/...', async (req, res) => { ... })
}
```
→ если `backend.cjs` не передал зависимости при вызове — роут падает с `TypeError: Cannot read properties of undefined`.

**Вариант B:** Роут использует `express.Router()`:
```javascript
const router = express.Router()
router.get('/...', async (req, res) => { ... })
module.exports = router
```
→ если роут использует `redis` из глобальной области (не импортирует сам), он падает.
→ если точка монтирования в `backend.cjs` не совпадает (например, `app.use(router)` вместо `app.use('/api/v1', router)`), все эндпоинты отвечают 404.

**Рекомендация:** Использовать Вариант B (express.Router) с явной передачей зависимостей через фабричную функцию. Детали — в Фазе 3.

### Гипотеза 2: Неполный список эндпоинтов
**Вероятность: средняя**

В routes могли быть перенесены не все эндпоинты из `backend.cjs`.
Клиент (плеер) вызывает `/api/v1/chunk/:id`, `/api/v1/chunk/:id/storyboard`,
а соответствующий роут отсутствует → 404 → плеер не может загрузить данные → зависание.

### Гипотеза 3: Изменение сигнатур ответа
**Вероятность: низкая**

При рефакторинге мог измениться формат JSON-ответа (поле переименовано,
тип изменён). Клиент не распознаёт ответ → ошибка парсинга → плеер встаёт.

### Гипотеза 4: Удаление ненужных файлов
**Вероятность: средняя**

Вместе со сплитом могли быть удалены файлы, которые всё ещё
требовались в runtime (helper-функции, конфигурации).

---

## Что было удалено (и откачено)

### Файлы, созданные при сплите:

```
backend/src/routes/
  ai-chat.cjs          — AI chat sessions CRUD
  book-crud.cjs        — Book metadata CRUD
  book-import.cjs      — vbook loading + TXT import
  chunks.cjs           — Chunk listing + generate-next
  generation.cjs       — Snapshot, diff, regenerate
  debug.cjs            — Debug endpoints
  gpu.cjs              — GPU hub communication
  workers.cjs          — Worker health/status
backend/src/routes/helpers/
  index.cjs            — Shared helpers
  redis-cache.cjs      — Redis cache wrappers
frontend/.../ScenePlayer.kt       — Extracted player state machine
frontend/.../SceneAudioPlayer.kt  — Extracted MediaPlayer wrapper
```

### Изменённый файл:

```
backend/src/backend.cjs  (6059 → 143 строк)
```

---

## План безопасного рефакторинга

### Принцип: Один шаг за раз, с тестом после каждого

#### Фаза 1: Helpers (безопасно, 0 риска)

Вынести чистые utility-функции из backend.cjs в отдельный файл.
Эти функции не имеют состояния, не зависят от `redis`, `app`, `req`/`res`.

Цель: `backend/src/helpers/utils.cjs`

```javascript
// Что выносится:
function log(...args) { ... }
function pad(n) { ... }
function parseChunkId(chunkId) { ... }
function safeBuildPath(buildId) { ... }
function splitTextIntoChunks(text, maxChars) { ... }
function splitDialogueIntoChunks(text, maxChars) { ... }
```

**Проверка:** сервер запускается, эндпоинты работают (те же функции, просто импортированы).

#### Фаза 2: Redis helpers (безопасно)

Вынести Redis-функции, которые не зависят от `app`.

Цель: `backend/src/helpers/redis-helpers.cjs`

```javascript
// Что выносится:
function saveChunk(id, data) { ... }
function getChunk(id) { ... }
function getAllChunks(bookId) { ... }
function getBookWindowStatus(bookId) { ... }
```

**Проверка:** те же, через import.

#### Фаза 3: Worker routes (первый роут)

Вынести эндпоинты `/api/v1/worker/*`.
Они изолированы от книг и чанков — минимальный риск.

```
POST /api/v1/worker/heartbeat
GET  /api/v1/worker/status
GET  /api/v1/worker/counts
```

**Паттерн подключения:**
```javascript
// backend.cjs
const workers = require('./routes/workers')(redis, config);
// workers — это express.Router()
app.use('/api/v1', workers);

// routes/workers.cjs
const express = require('express');
module.exports = function(redis, config) {
    const router = express.Router();
    router.post('/worker/heartbeat', async (req, res) => { ... });
    return router;
};
```

**Проверка:** worker heartbeat продолжает работать.

#### Фаза 4: Debug routes

Вынести отладочные эндпоинты.
Если сломаются — плеер не пострадает, только админка.

**Проверка:** плеер работает, основное API отвечает.

#### Фазы 5-8: Остальные роуты (по одному)

Порядок по возрастанию риска:

5. `chunks.cjs` — `/api/v1/chunk/:id`, `/api/v1/book/:bookId/chunks`
6. `book-crud.cjs` — `GET /api/v1/book/:bookId`
7. `ai-chat.cjs` — AI сессии (изолированы от книг)
8. `book-import.cjs` — `load-vbook`, `import-txt` (критично, последним)
9. `generation.cjs` — `snapshot`, `diff`, `regenerate`

**После каждого шага:** проверить, что плеер играет книгу от начала до конца.

---

## Критерии успеха

1. Сервер запускается без ошибок (`node backend/src/backend.cjs`)
2. `GET /api/v1/book/:bookId/chunks` возвращает корректные данные
3. `GET /api/v1/chunk/:id` возвращает `{ status: "ready", ... }`
4. `GET /api/v1/chunk/:id/storyboard` возвращает IU sequence
5. `GET /api/v1/chunk/:id/audio` отдаёт MP3
6. Плеер воспроизводит сцену от начала до конца без ошибок

---

## Что НЕ нужно делать (из опыта BIG_Work)

- ❌ Не удалять файлы, пока не убедились, что они не нужны
- ❌ Не выносить все роуты сразу — только по одному
- ❌ Не менять формат JSON-ответов при рефакторинге
- ❌ Не трогать `api/runtime.js` — он уже выделен и работает
- ❌ Не трогать фронтенд одновременно с бэкендом
- ❌ Не выносить код, который использует переменные из замыкания `backend.cjs`
  (`redis`, `app`, `stats`, `cleanupLockToken`), без явной передачи через параметры
- ❌ Не менять сигнатуру внутренних функций при рефакторинге — только перемещать код

---

## Связанные документы

- `docs/codebase-audit.md` — технический аудит
- `docs/architecture-issues.md` — архитектурные проблемы
- `docs/architectural-player-revision.md` — ревизия плеера
- `backups/2026-06-10_BIG_Work.tar.gz` — состояние со сплитом (для справки)
- `backups/2026-06-11_Recovery01.tar.gz` — recovery-точка

---

## Примечание: ScenePlayer.kt / SceneAudioPlayer.kt

Эти файлы были вынесены из PlayFragment при сплите и откачены вместе с бэкендом.
**Они НЕ были причиной поломки плеера** — плеер сломался на стороне бэкенда (404/500 от API).

Можно применить отдельно, после стабилизации бэкенда:
- `SceneAudioPlayer.kt` — безопасная обёртка над `MediaPlayer` (create, preload, chain)
- `ScenePlayer.kt` — state machine плеера (требует осторожной интеграции с PlayFragment)

# Backend Dead Code Cleanup Plan

> **Цель:** Поэтапная очистка неиспользуемого кода бэкенда с максимальной безопасностью.
> **Принцип:** Небольшие независимые этапы, каждый — отдельный Git commit с push.
> **Проверка после каждого этапа:** `npm test` + `npm run test:syntax`.

---

## Этап 1: Неиспользуемые CJS-файлы (helpers и сервисы)

**Scope:** `backend/src/helpers/`, `backend/src/services/` — файлы, которые не импортируются ниоткуда.

Кандидаты на удаление (после верификации отсутствия импортов):
- `backend/src/services/startup-recovery.js` — возможно, вытеснен reconciliation-engine
- `backend/src/services/encoding-detect.js` — проверить импорты
- `backend/src/services/knowledge-base.js` — проверить импорты
- `backend/src/services/source-coverage-audit.js` — проверить импорты
- `backend/src/helpers/utils.cjs` — активно используется
- `backend/src/helpers/redis-helpers.cjs` — активно используется

**Действие:** Найти все require/import этих файлов. Если импортов нет — удалить.

**Статус:** 🔲 Не начато

---

## Этап 2: Неиспользуемые функции в helpers/utils.cjs

**Scope:** `backend/src/helpers/utils.cjs`

Найти функции, которые экспортируются, но нигде не вызываются.

**Действие:** Поиск по grep, удаление неиспользуемых экспортов.

**Статус:** 🔲 Не начато

---

## Этап 3: Неиспользуемые runtime-модули

**Scope:** `backend/src/runtime/`

Модули, исключённые из `runtime/index.js`, но всё ещё на диске:
- `backend/src/runtime/job-schema.js` — проверить, используется ли напрямую
- `backend/src/runtime/retry-budget-manager.js` — проверить прямые require
- `backend/src/runtime/circuit-breaker.js` — проверить прямые require
- `backend/src/runtime/runtime-persistence.js` — исключён из экспорта

**Действие:** Проверить прямые require() из других файлов. Если не используется — удалить.

**Статус:** 🔲 Не начато

---

## Этап 4: Неиспользуемые модули storage

**Scope:** `backend/src/storage/`

- `backend/src/storage/manifest.js` — проверить импорты

**Действие:** Проверить require/import. Удалить если не используется.

**Статус:** 🔲 Не начато

---

## Этап 5: Неиспользуемые сервисы audio/video/image

**Scope:** `backend/src/audio/`, `backend/src/video/`, `backend/src/image/`

- `backend/src/audio/silence.js` — утилита для тишины
- `backend/src/audio/chunks.js` — работа с аудио-чанками
- `backend/src/video/video-merge.js` — мерж видео
- `backend/src/image/preview.js` — превью изображений
- `backend/src/image/character-utils.js` — утилиты персонажей
- `backend/src/image/registry.js` — реестр изображений

**Действие:** Проверить import/require. Удалить неиспользуемые.

**Статус:** 🔲 Не начато

---

## Этап 6: Неиспользуемые модули book/lazy-book

**Scope:** `backend/src/book/lazy-book/`

- `backend/src/book/lazy-book/status.js`
- `backend/src/book/lazy-book/appearance.js`
- `backend/src/book/lazy-book/draft.js`
- `backend/src/book/lazy-book/create.js`
- `backend/src/book/lazy-book/metadata.js`

**Действие:** Проверить импорты из `lazy-book/index.js` и других файлов. Удалить неиспользуемые.

**Статус:** 🔲 Не начато

---

## Этап 7: Неиспользуемые модули orchestration

**Scope:** `backend/src/orchestration/`

- `backend/src/orchestration/scene-callbacks.js`
- `backend/src/orchestration/scene-restoration.js`
- `backend/src/orchestration/scene-utils.js`

**Действие:** Проверить require/import. Удалить неиспользуемые.

**Статус:** 🔲 Не начато

---

## Этап 8: Неиспользуемые репозитории PostgreSQL

**Scope:** `backend/src/storage/postgres/repositories/`

- `backend/src/storage/postgres/repositories/events-repo.js`
- `backend/src/storage/postgres/repositories/cache-repo.js`
- `backend/src/storage/postgres/repositories/task-repo.js`
- `backend/src/storage/postgres/repositories/chat-repo.js`
- `backend/src/storage/postgres/repositories/chat-session-repo.js`

**Действие:** Проверить require/import из routes и других модулей. Удалить неиспользуемые.

**Статус:** 🔲 Не начато

---

## Этап 9: Неиспользуемые сервисы агента

**Scope:** `backend/src/services/agent/`

- `backend/src/services/agent/bootstrap.js`
- `backend/src/services/agent/text-utils.js`
- `backend/src/services/agent/image-utils.js`

**Действие:** Проверить require/import. Удалить неиспользуемые.

**Статус:** 🔲 Не начато

---

## Этап 10: Неиспользуемые workflow-модули

**Scope:** `backend/src/workflows/video/`, `backend/src/workflows/image/`, `backend/src/workflows/audio/`

**Действие:** Проверить импорты из `workflows/index.js` и connector-loader. Удалить неиспользуемые.

**Статус:** 🔲 Не начато

---

## Итоговый чеклист

| Этап | Область | Статус | Commit |
|------|---------|--------|--------|
| 1 | CJS helpers/services | 🔲 | |
| 2 | helpers/utils.cjs | 🔲 | |
| 3 | runtime modules | 🔲 | |
| 4 | storage modules | 🔲 | |
| 5 | audio/video/image services | 🔲 | |
| 6 | book/lazy-book modules | 🔲 | |
| 7 | orchestration modules | 🔲 | |
| 8 | postgres repositories | 🔲 | |
| 9 | agent services | 🔲 | |
| 10 | workflow modules | 🔲 | |

# Backend Dead Code Cleanup Plan

> **Цель:** Поэтапная очистка неиспользуемого кода бэкенда с максимальной безопасностью.
> **Принцип:** Небольшие независимые этапы, каждый — отдельный Git commit с push.
> **Проверка после каждого этапа:** `npm test` + `npm run test:syntax`.

---

## Этап 1 ✅ (завершён)

**Удалено:**
- `backend/src/services/startup-recovery.js` — 0 импортов, вытеснен reconciliation-engine
- `backend/src/storage/manifest.js` — 0 импортов, экспорт удалён из `storage/index.js`

**Проверено (оставлено):**
- `backend/src/services/encoding-detect.js` — жив, используется `txt-importer.js`
- `backend/src/services/knowledge-base.js` — жив, используется `agent-service.js`
- `backend/src/services/source-coverage-audit.js` — жив, используется `book/core-routes.cjs`

**Commit:** `5f07d34`

---

## Этап 2 ✅ (завершён)

**Удалено из `helpers/utils.cjs`:**
- `pad` — 0 вызовов
- `parseChunkId` — 0 вызовов
- `splitTextIntoChunks` — 0 вызовов (дублируется в `audio/segments.js`)
- `splitDialogueIntoChunks` — 0 вызовов (дублируется в `audio/segments.js`)
- `buildSegments` — 0 вызовов (дублируется в `audio/segments.js`)
- `findSceneRuntimeData` — 0 вызовов (дублируется в `book/index.js`)
- `resolveAssetPath` — приватная функция, не экспортировалась, 0 вызовов

**Оставлено в экспорте:** `log` и `collectScenes` (используется в `book-diff.cjs`)

**Обновлены деструктуризации в 12 файлах:** `backend.cjs`, `generation-routes.cjs`, `ai-routes.cjs`, `debug-routes.cjs`, `book/generation-routes.cjs`, `book/agent-routes.cjs`, `book/chunks-routes.cjs`, `book/core-routes.cjs`, `book/import-routes.cjs`, `book/recovery-routes.cjs`, `task-handler.cjs`, `audio-recovery.cjs`

**Commit:** `6c9a065`

---

## Этап 3: Неиспользуемые runtime-модули

**Проверка:** Все 4 кандидата (`job-schema.js`, `circuit-breaker.js`, `retry-budget-manager.js`, `runtime-persistence.js`) — живые, используются другими модулями. Ничего не удалено.

**Статус:** ✅ Пропущен (нет мёртвого кода)

---

## Этап 4: (объединён с Этапом 1 — manifest.js удалён)

---

## Этап 5: Неиспользуемые сервисы audio/video/image

**Проверка:** Все 6 кандидатов (`silence.js`, `chunks.js`, `video-merge.js`, `preview.js`, `character-utils.js`, `registry.js`) — живые, импортируются через `audio-service.js`, `image-service.js` или напрямую.

**Статус:** ✅ Пропущен (нет мёртвого кода)

---

## Этап 6: Неиспользуемые модули book/lazy-book

**Проверка:** Все 5 кандидатов — живые. `create.js` использует `appearance.js` и `metadata.js` внутренне. `status.js` и `draft.js` используются внешне через routes.

**Статус:** ✅ Пропущен (нет мёртвого кода)

---

## Этап 7: Неиспользуемые модули orchestration

**Проверка:** Все 3 кандидата — живые. `scene-callbacks.js` — ядро колбэков аудио/видео/изображений. `scene-utils.js` — утилиты логирования для всех файлов оркестрации. `scene-restoration.js` — восстановление чанков.

**Статус:** ✅ Пропущен (нет мёртвого кода)

---

## Этап 8: Неиспользуемые репозитории PostgreSQL

**Удалено:**
- `cache-repo.js` — 0 production references (бывший потребитель `manifest.js` удалён в Этапе 1, функции не вызывались)
- `chat-session-repo.js` — 0 production references (экспортировался только через barrel)

**Оставлено:**
- `events-repo.js` — жив, используется в `book-event-log.js`
- `task-repo.js` — мёртв в production, но используется в тестах (`book-sync.test.js`). Сохранён.
- `chat-repo.js` — жив, используется в `agent/bootstrap.js`

**Также исправлено:**
- `scene-callbacks.js` — удалены 3 вызова `storage.manifest.recordAsset()`, которые упали бы с runtime-ошибкой после удаления `manifest.js` в Этапе 1

**Commit:** `c6c992e`

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
| 1 | CJS helpers/services | ✅ | `5f07d34` |
| 2 | helpers/utils.cjs | ✅ | `6c9a065` |
| 3 | runtime modules | ✅ (пропущен — всё живо) | |
| 4 | storage modules (объединён с 1) | ✅ | `5f07d34` |
| 5 | audio/video/image services | ✅ (пропущен — всё живо) | |
| 6 | book/lazy-book modules | ✅ (пропущен — всё живо) | |
| 7 | orchestration modules | ✅ (пропущен — всё живо) | |
| 8 | postgres repositories | ✅ | `c6c992e` |
| 9 | agent services | 🔲 | |
| 10 | workflow modules | 🔲 | |

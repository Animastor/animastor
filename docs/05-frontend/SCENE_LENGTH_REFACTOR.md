# Scene Length & Video Chunking Refactoring

## Overview

Убрать жёсткую привязку сцены к 20–30 секундам.
Сцены формируются по смыслу (место, время, персонажи, логика), а не по длительности.
Видеочанки собираются по суммарной длительности IU, а не по количеству картинок.

## Motivation

- Сейчас AI тратит ретраи на искусственное дробление сцен длиннее 30с
- `selectWorkflowGroups` группирует IU по 4 штуки, игнорируя их `estimated_duration_sec`
- Это приводит к неестественно коротким сценам и лишним AI-вызовам
- TTS, изображения и видео уже работают независимо — длинная сцена не проблема

## Plan

### 1. Конфиги — `src/services/agent-prompts.js`
- `SCENE_TARGET_SEC`: 20 → 60 (целевая длительность сцены)
- `SCENE_MAX_SEC`: 30 → 120 (максимальная длительность сцены)
- `MAX_SCENES_PER_CHUNK`: 3 → 2 (меньше сцен, но длиннее)
- Поправить комментарии и расчёты (words/sec)

### 2. AI-правила — `ai/rules/scenes.md`
- Убрать раздел `DURATION LIMITS — HARD REQUIREMENTS`
- Убрать все упоминания `%SCENE_MAX_SEC%`, `%SCENE_TARGET_SEC%`, `%SCENE_MIN_SEC%`
- Заменить на мягкую рекомендацию: не больше ~2 минут
- Оставить только логические критерии сцены

### 3. AI Pipeline — `src/services/agent/pipeline-steps.js`
- `stepCreateScenes`: убрать duration-секции в `repairHint`
- Оставить только coverage-валидацию (source coverage)
- Убрать подстановки `SCENE_MAX_SEC`, `SCENE_TARGET_SEC`, `SCENE_MIN_SEC`

### 4. Pipeline Runner — `src/services/agent/pipeline-runner.js`
- Убрать `findOversized` / `findUndersized`
- Убрать `MAX_DURATION_RETRIES` и duration validation loop
- Убрать duration-retry логику после coverage
- Оставить coverage-only валидацию

### 5. Fallback — `src/services/agent/text-utils.js`
- `buildFallbackScenes`: обновить проверки под новые лимиты (120s max, 60s target)
- Убрать warning на single sentence > SCENE_MAX_SEC

### 6. Видеочанки — `src/workflows/video/video-workflows.js`
- Изменить `selectWorkflowGroups(unitCount)` → `selectWorkflowGroups(units, iuDurations)`
- Новый алгоритм: суммировать длительности IU, пока не наберётся ~20 секунд
- Выбрать workflow по количеству IU в группе (1–4)
- Если IU слишком длинный (больше 20с), поместить его одного в группу
- Обновить все вызовы `selectWorkflowGroups`:
  - `buildVideoWorkflows` — там уже есть `iuDurations`

### 7. Тесты — `tests/video-workflows.test.js`
- Обновить тесты `selectWorkflowGroups` — теперь принимает durations
- Добавить тесты для нового алгоритма с разными комбинациями длительностей

### 8. Тесты — `tests/scene-split.test.js`
- Обновить проверки `SCENE_MAX_SEC` и `MAX_SCENES_PER_CHUNK`
- Если нужно — добавить тест на длинную сцену

## File Change Summary

| File | Change |
|------|--------|
| `src/services/agent-prompts.js` | Update constants (TARGET 60, MAX 120, CHUNK 2) |
| `ai/rules/scenes.md` | Remove duration limits, keep logical criteria |
| `src/services/agent/pipeline-steps.js` | Remove duration repair hint |
| `src/services/agent/pipeline-runner.js` | Remove duration retry loop, unused imports |
| `src/services/agent/text-utils.js` | Falls back to updated constants — no code change needed |
| `src/workflows/video/video-workflows.js` | New `selectWorkflowGroups(units, iuDurations)` |
| `src/services/agent/bootstrap.js` | Fix missing `try {` syntax error (preëxisting) |
| `tests/video-workflows.test.js` | Rewrite tests for duration-aware algorithm |
| `tests/scene-split.test.js` | Update assertions |

## Order of Implementation

1. Конфиги (agent-prompts.js)
2. AI-правила (scenes.md)
3. Pipeline steps (pipeline-steps.js)
4. Pipeline runner (pipeline-runner.js)
5. Text utils (text-utils.js) — only doc updated, code unchanged
6. Видеочанки (video-workflows.js)
7. Тесты (video-workflows.test.js, scene-split.test.js)
8. Прогон тестов — 40/40 + 26/26 passed ✅

## Bootstrap Bugfix

Во время проверки синтаксиса всех изменённых файлов была найдена предсуществующая
синтаксическая ошибка в `src/services/agent/bootstrap.js`: у функции `bootstrapWithAgent`
отсутствовал `try {` перед телом try-блока — был только `} catch (err) {`.

```diff
-    // Read chunk_size from layer-config BEFORE getWindowText so the text budget matches
+    try {
+        // Read chunk_size from layer-config BEFORE getWindowText so the text budget matches
         const chunkSize = await _readChunkSize(redis, bookId);
```

## Verification

- ✅ `node -c` — синтаксис всех изменённых файлов валиден
- ✅ `video-workflows.test.js` — 40 passing
- ✅ `scene-split.test.js` — 26 passing
- ✅ Deadcode проверен: никаких висячих импортов или символов

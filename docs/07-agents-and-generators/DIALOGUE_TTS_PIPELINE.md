# Dialogue TTS Pipeline

## Цель

Автоматическая генерация многоголосой озвучки диалогов через TTS.  
Диалоговые сцены получают `voice='dialogue'` и маршрутятся в многоголосый Qwen3-TTS workflow.

## Pipeline (реальный порядок)

```
AI Pipeline (runPipeline):
1. stepAnalyzeStructure          — структура (bootstrap)
2. stepExtractCharacters         — персонажи без voice (single responsibility)
3. stepGenerateVoices            — голоса для диалоговых персонажей
   ↑ LLM только что извлекла персонажей — контекст свежий, полный текст в памяти
4. stepExtractLocations          — локации
5. stepCreateScenes + enrich     — сцены
6. stepCreateUnits               — юниты со speaker: { type: "dialogue", speaker: "berlioz", text: "..." }
7. stepCreateVisuals             — visual prompts
8. stepReconcilePassports        — чистка промптов
9. stepPolishStoryboard          — continuity

         ↓
create.js (сохранение в JSON):
  narration scene →  voice='narrator',  full_text=литературный текст
  dialogue scene  →  voice='dialogue', full_text=литературный текст (с «—»)
  (скрипт speaker:текст НЕ сохраняется, строится при генерации)

         ↓
generateSceneAudio() → buildSegments():
  dialogue:  собирает units[].speaker + units[].text в скрипт, чанкует
  narration: берёт audio.full_text, чанкует по предложениям

         ↓
ComfyUI / GPU Hub:
  dialogue  → tts-qwen-dialogue (Role Bank: character1 + character2)
  narration → tts-qwen-narrator (один голос)
```

## Ключевые архитектурные решения

### `audio.full_text` = литературный текст, не скрипт
- `full_text` хранит оригинальный текст с «—» (читабелен для человека)
- Скрипт `speaker: текст` строится **только в `buildSegments()`** из `units[].speaker`
- Единый источник истины: `units[]`, а не дублирование в `full_text`
- Редактирование units → скрипт перестраивается автоматически

### `stepGenerateVoices` — шаг №3 (после characters, до scenes)
- LLM только что извлекла персонажей — контекст свежий
- Полный текст ещё не разбит на сцены — лучший анализ диалоговых реплик
- Созданные голоса потом доступны всем downstream-шагам

### Narrator — программно, не AI
- Добавляется в `create.js` всегда первым:
  ```js
  const voices = { narrator: { instruction: narratorVoice } };
  ```
- Ни один AI-промпт не создаёт narrator

### `buildSegments()` — без fallback
- Строит TTS-скрипт ТОЛЬКО из `units[].speaker`
- Fallback удалён (нет старых vbook с другим форматом)
- Если dialogue-сцена не имеет units со speaker → `[]` (логируется warning)

## Статус

- [x] `speaker` добавлен в `SYSTEM_PROMPTS.units`
- [x] `stepCreateUnits()` сохраняет `speaker` из AI
- [x] `create.js` — литературный `full_text`, `voice='dialogue'`
- [x] `buildSegments()` — сборка скрипта из `units[].speaker`, fallback удалён
- [x] `stepGenerateVoices` — на позиции 3 (после characters)
- [x] Примеры (`ai/examples/`) согласованы
- [x] 473 теста проходят

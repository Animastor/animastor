# Migration: Hardcoded SYSTEM_PROMPTS → `ai/rules/`

## Цель

Перенести все 12 универсальных системных промптов из `backend/src/services/agent-prompts.js`
в отдельные `.md` файлы в `backend/ai/rules/`, чтобы:

- Править промпты без изменения JS кода
- Каждый промпт — отдельный файл, version-controlled независимо
- Единый source of truth для агентских инструкций
- Модельно-зависимые правила уже отделены (skills/)

## Статус

**✅ Миграция выполнена.**

`agent-prompts.js` загружает все 12 промптов из `backend/ai/rules/*.md` через `ai-loader.js`.
Плейсхолдеры заменяются через `.replace()` в `pipeline-steps.js`.

## Структура

```
backend/ai/rules/
├── structure.md                 # Анализ структуры (author, title, chapters)
├── characters.md                # Извлечение персонажей
├── locations.md                 # Извлечение локаций
├── scenes.md                    # Сплит текста на сцены + environment-override
├── units.md                     # Декомпозиция сцены на юниты
├── visuals.md                   # Создание visual prompt (image.prompt + video.action)
├── storyboard_polish.md         # Полировка сториборда (continuity, 180° rule)
├── voice_generation.md          # Генерация голосов персонажей
├── passport_reconciliation.md   # Сверка image.prompt с паспортами
├── video_action_reconciliation.md # Исправление video.action (temporal only)
├── video_action_polish.md       # Полировка video.action (gesture continuity + timing realism)
```

> 8 старых `-*.md` файлов (dead code) удалены.

## Что изменено в .md vs исходный JS

### 1. JS-выражения → плейсхолдеры

В `scenes.md` заменены:

| JS-выражение | Плейсхолдер |
|---|---|
| `${SCENE_MAX_SEC}` | `%SCENE_MAX_SEC%` |
| `${SCENE_TARGET_SEC}` | `%SCENE_TARGET_SEC%` |
| `${SCENE_MIN_SEC}` | `%SCENE_MIN_SEC%` |
| `${Math.round(SCENE_MAX_SEC / 0.3)}` | `%SCENE_MAX_WORDS%` |
| `${Math.round(SCENE_TARGET_SEC / 0.3)}` | `%SCENE_TARGET_WORDS%` |
| `${Math.round(SCENE_MIN_SEC / 0.3)}` | `%SCENE_MIN_WORDS%` |
| `%MAX_SCENES%` (уже был) | `%MAX_SCENES%` |

При миграции JS нужно добавить `.replace()` для новых плейсхолдеров.

### 2. Модельно-зависимые «кроты» удалены

| Файл | Удалено |
|---|---|
| `characters.md` | "IMPORTANT CRITICAL — appearance MUST be written in ENGLISH because it is used as input for an English-only video generation model (LTX 2.3)" |
| `voice_generation.md` | "Voice descriptions must be in ENGLISH (they feed into an English-only TTS model)" |

Эти правила должны жить в соответствующих скиллах:
- `skills/image/qwen-image.md` — на каком языке писать промпты
- `skills/audio/qwen-tts.md` — на каком языке писать voice instruction

### 3. video_action_reconciliation и video_action_polish

Уже почищены в рамках рефакторинга Prompt Profiles. В .md попали финальные версии
(без LTX-specific примеров, camera vocabulary, motion vocabulary — всё в
`skills/video/ltx-2.3.md`).

## Выполненные шаги

### ✅ Шаг 1: agent-prompts.js → загрузчик
`agent-prompts.js` переписан: конфигурация (константы) осталась inline, 12 SYSTEM_PROMPTS загружаются из `.md` через `ai-loader.js`.

### ✅ Шаг 2: Плейсхолдеры → .replace()
В `pipeline-steps.js` добавлены 6 `.replace()` для новых плейсхолдеров длительности сцен (`%SCENE_MAX_SEC%`, `%SCENE_TARGET_SEC%`, `%SCENE_MIN_SEC%`, `%SCENE_MAX_WORDS%`, `%SCENE_TARGET_WORDS%`, `%SCENE_MIN_WORDS%`).

### ✅ Шаг 3: Аудит .replace() в callers
Все плейсхолдеры во всех 12 .md файлах имеют соответствующий `.replace()` в JS:

| Плейсхолдер | Где заменяется | Файл |
|---|---|---|
| `%EXISTING_CHARACTERS%` | stepExtractLocations, stepCreateScenes | pipeline-steps.js |
| `%EXISTING_LOCATIONS%` | stepCreateScenes | pipeline-steps.js |
| `%BOOK_DEFAULT%` | stepCreateScenes | pipeline-steps.js |
| `%MAX_SCENES%` | stepCreateScenes | pipeline-steps.js |
| `%REFERENCE_EXAMPLES%` | stepCreateScenes | pipeline-steps.js |
| `%SCENE_TEXT%` | stepCreateUnits | pipeline-steps.js |
| `%CONTEXT%` | stepCreateVisuals | pipeline-steps.js |
| `%EXAMPLES%` | stepCreateVisuals | pipeline-steps.js |
| `%UNITS%` | stepCreateVisuals, passport, video steps | pipeline-steps.js |
| `%CHARACTERS%` | stepPolishStoryboard, stepPolishVideoActions | pipeline-steps.js |
| `%LOCATIONS%` | stepPolishStoryboard, stepPolishVideoActions | pipeline-steps.js |
| `%SCENES%` | stepPolishStoryboard, stepPolishVideoActions | pipeline-steps.js |
| `%SCENE_MAX_SEC%` | stepCreateScenes | pipeline-steps.js |
| `%SCENE_TARGET_SEC%` | stepCreateScenes | pipeline-steps.js |
| `%SCENE_MIN_SEC%` | stepCreateScenes | pipeline-steps.js |
| `%SCENE_MAX_WORDS%` | stepCreateScenes | pipeline-steps.js |
| `%SCENE_TARGET_WORDS%` | stepCreateScenes | pipeline-steps.js |
| `%SCENE_MIN_WORDS%` | stepCreateScenes | pipeline-steps.js |
| `%TEXT%` | stepGenerateVoices | pipeline-steps.js |

### Политика длины промптов (2026-08-05)

`%UNITS%`/`%SCENES%` в шагах реконсиляции/полировки больше не обрезаются агрессивно
(раньше `image.prompt` показывался модели только первыми 200/300/150 символами, а её
результат целиком заменял оригинал — невидимая часть тихо переписывалась):

- **`image.prompt` / `video.action`** — передаются целиком (JSON-строка юнита); значения
  длиннее `IMAGE_PROMPT_MAX_CHARS = 2000` исключаются из запроса к модели и **не
  перезаписываются** её результатом (guard в мерже) — legacy и случайные вставки защищены.
- **`text` юнита** — verbatim, до `UNIT_TEXT_MAX_CHARS = 500`.
- **`%SCENES%`** — полный текст сцены, до `SCENE_TEXT_MAX_CHARS = 2700` (сцена ≤ 120с
  ограничена дизайном, риска «простыни» нет).
- **Граница ввода:** `PATCH /book/.../scene` и `PUT /book` возвращают 400 при промпте
  > 2000 символов — «человек случайно вставил простыню и нажал Сохранить» ловится с
  понятным сообщением, а не молча внутри пайплайна.
- **`estimated_duration_sec` (2026-08-06)** — в каждую JSON-строку юнита
  (`unitRow`) добавлена длительность модуля: речевая эвристика
  `estimateSpeechDurationSec(unit.text)` (~0.3с/слово, мин 2с — та же, что у
  юнит-сплиттера и видеочанкинга; на момент polish-пасса юниты ещё не персистятся
  в `image_units`, поэтому реальный `estimated_duration_sec` из БД недоступен).
  Поле читают `video_action_polish.md` (чек «Timing realism»),
  `video_action_reconciliation.md` (секция «Timing») и `visuals.md` (мягкая
  рекомендация «Align the motion with it»); формат строк юнитов в
  `stepCreateVisuals` синхронизирован с `scripts/dryrun-visuals-iu.js`.

Константы: `backend/src/services/agent-prompts.js`.

### ✅ Шаг 4: Тесты
```
npm test → 578 passing (1s)
```

### ✅ Шаг 5: Удалены старые `-` файлы
Удалено 8 файлов: `-general.md`, `-naming.md`, `-edit_mode.md`, `-extraction_rules.md`, `-json_rules.md`, `-json_schema.md`, `-validation.md`, `-import_rules.md`.

## Rollback

`git checkout -- backend/src/services/agent-prompts.js` — вернёт старую версию с inline template literals.
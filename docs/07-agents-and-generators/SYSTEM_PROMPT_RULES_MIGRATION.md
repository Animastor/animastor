# Migration: Hardcoded SYSTEM_PROMPTS → `ai/rules/`

## Цель

Перенести все 12 универсальных системных промптов из `backend/src/services/agent-prompts.js`
в отдельные `.md` файлы в `backend/ai/rules/`, чтобы:

- Править промпты без изменения JS кода
- Каждый промпт — отдельный файл, version-controlled независимо
- Единый source of truth для агентских инструкций
- Модельно-зависимые правила уже отделены (skills/)

## Статус

**Подготовительная фаза выполнена.** 12 файлов созданы, очищены от модель-специфичного.
Файлы не подключены — production продолжает читать из `agent-prompts.js`.

## Структура

```
backend/ai/rules/
├── structure.md                 # Анализ структуры (author, title, chapters)
├── characters.md                # Извлечение персонажей
├── locations.md                 # Извлечение локаций
├── scenes.md                    # Сплит текста на сцены
├── enrich_scenes.md             # Обогащение атмосферы сцен
├── units.md                     # Декомпозиция сцены на юниты
├── visuals.md                   # Создание visual prompt (image.prompt + video.action)
├── storyboard_polish.md         # Полировка сториборда (continuity, 180° rule)
├── voice_generation.md          # Генерация голосов персонажей
├── passport_reconciliation.md   # Сверка image.prompt с паспортами
├── video_action_reconciliation.md # Исправление video.action (temporal only)
├── video_action_polish.md       # Полировка video.action (gesture continuity)
└── (8 старых файлов помечены - как мёртвый код)
```

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

## Порядок миграции

### Шаг 1: Замена agent-prompts.js на загрузчик

Новый `agent-prompts.js` вместо template literals читает `.md` через `ai-loader.js`:

```js
const aiLoader = require('./ai-loader');

const SYSTEM_PROMPTS = {};
const RULES = [
  'structure', 'characters', 'locations', 'scenes',
  'enrich_scenes', 'units', 'visuals', 'storyboard_polish',
  'voice_generation', 'passport_reconciliation',
  'video_action_reconciliation', 'video_action_polish',
];

for (const name of RULES) {
  SYSTEM_PROMPTS[name] = aiLoader.getRule(name) || '';
}
```

### Шаг 2: Замена плейсхолдеров на .replace()

В `pipeline-steps.js` (и других файлах, использующих SYSTEM_PROMPTS),
добавить `.replace()` для плейсхолдеров из `scenes.md`:

```js
prompt = prompt
  .replace('%SCENE_MAX_SEC%', SCENE_MAX_SEC)
  .replace('%SCENE_TARGET_SEC%', SCENE_TARGET_SEC)
  .replace('%SCENE_MIN_SEC%', SCENE_MIN_SEC)
  .replace('%SCENE_MAX_WORDS%', Math.round(SCENE_MAX_SEC / 0.3))
  .replace('%SCENE_TARGET_WORDS%', Math.round(SCENE_TARGET_SEC / 0.3))
  .replace('%SCENE_MIN_WORDS%', Math.round(SCENE_MIN_SEC / 0.3));
```

### Шаг 3: Проверить все .replace() в callers

Нужно убедиться, что каждый `%ПЛЕЙСХОЛДЕР%` во всех 12 .md файлах имеет
соответствующий `.replace()` в JS. Сейчас используются:

| Плейсхолдер | Где заменяется | Файл |
|---|---|---|
| `%EXISTING_CHARACTERS%` | stepExtractLocations, stepCreateScenes | pipeline-steps.js |
| `%EXISTING_LOCATIONS%` | stepCreateScenes | pipeline-steps.js |
| `%MAX_SCENES%` | stepCreateScenes | pipeline-steps.js |
| `%REFERENCE_EXAMPLES%` | stepCreateScenes | pipeline-steps.js |
| `%SCENE_TEXT%` | stepCreateUnits | pipeline-steps.js |
| `%CONTEXT%` | stepCreateVisuals | pipeline-steps.js |
| `%EXAMPLES%` | stepCreateVisuals | pipeline-steps.js |
| `%UNITS%` | stepCreateVisuals, passport, video steps | pipeline-steps.js |
| `%CHARACTERS%` | stepPolishStoryboard, stepPolishVideoActions | pipeline-steps.js |
| `%LOCATIONS%` | stepPolishStoryboard, stepPolishVideoActions | pipeline-steps.js |
| `%SCENES%` | stepPolishStoryboard, stepPolishVideoActions | pipeline-steps.js |
| `%SCENES_TO_ENRICH%` | stepEnrichScenes | pipeline-steps.js |
| `%SCENE_MAX_SEC%` (новый) | stepCreateScenes | pipeline-steps.js |
| `%SCENE_TARGET_SEC%` (новый) | stepCreateScenes | pipeline-steps.js |

### Шаг 4: Тесты

После замены прогнать `npm test`. Все 577 тестов должны проходить,
так как содержимое промптов не изменилось — только источник данных.

### Шаг 5: Удалить старые `-` файлы

После успешной миграции и проверки удалить `-general.md`, `-naming.md`,
`-camera_language.md` и остальные 13 помеченных файлов.

## Rollback

При проблемах — вернуть `agent-prompts.js` из git. Файлы в `ai/rules/`
никак не влияют на production, пока не подключён загрузчик.

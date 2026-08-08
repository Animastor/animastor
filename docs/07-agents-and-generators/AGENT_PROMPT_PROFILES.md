# Prompt Profiles — Architecture & Implementation Plan

## 1. Проблема

Сейчас все правила построения промптов зашиты в `backend/src/services/agent-prompts.js`
как константы `SYSTEM_PROMPTS`. Это создаёт несколько проблем:

- **LTX-specific знание** в `video_action_reconciliation` и `video_action_polish`
  (правила про reference image, temporal vs static) жёстко закодировано в JS.
- При добавлении новой модели (Veo, V1, Kling, Wan) нужно менять код агента.
- Нельзя иметь разные версии промптинга для одной модели (ltx-2.3 vs ltx-2.4).
- Знания о промптинге распределены между JS-строкой и документацией — нет единого источника истины.

## 2. Решение: Prompt Profiles

**Prompt Profile** — это набор правил промптинга для конкретной модели, хранящийся
в виде markdown-файла в `backend/ai/skills/`.

### Принцип

```
Workflow (ComfyUI JSON) → выбирает модель
       ↓
Connector (JSON) → содержит profile: "ltx-2.3"
       ↓
Skill-файл (backend/ai/skills/video/ltx-2.3.md) → правила промптинга
       ↓
Agent Pipeline — перед генерацией промпта читает соответствующий Skill
                  и использует его рекомендации
```

### Структура скиллов

```
backend/ai/skills/
├── video/
│   ├── default.md          # Универсальные правила motion-first (базлайн)
│   ├── ltx-2.3.md          # LTX 2.3 Image-to-Video prompting rules
│   ├── ltx-2.4.md          # (будущее) LTX 2.4 prompting rules
│   ├── veo.md              # (будущее) Veo prompting rules
│   └── kling.md            # (будущее) Kling prompting rules
├── image/
│   ├── default.md          # Дефолтный порядок композиции «от общего к частному»
│   ├── qwen-image.md       # Qwen Image prompting rules
│   ├── flux.md             # (будущее) Flux prompting rules
│   └── sdxl.md             # (будущее) SDXL prompting rules
├── audio/
│   ├── default.md          # Универсальный TTS-базлайн (voice-инструкции + текст)
│   ├── qwen-tts.md         # Qwen TTS prompting rules
│   └── fish-speech.md      # (будущее) Fish Speech prompting rules
├── (существующие общие скиллы)
│   ├── camera_language.md
│   ├── composition.md
│   ├── continuity.md
│   ├── directing.md
│   ├── entity_extraction.md
│   ├── lighting.md
│   ├── prompt_engineering.md
│   └── storyboard.md
```

### Типы профилей

| Тип | Назначение | Примеры |
|---|---|---|
| `videoProfile` | Правила для `video.action` | `ltx-2.3`, `veo`, `kling` |
| `imageProfile` | Правила для `image.prompt` | `qwen-image`, `flux` |
| `audioProfile` | Правила для `audio.*` | `qwen-tts`, `fish-speech` |

## 3. Изменения в Connector

Каждый connector (в `backend/ai/connectors/`) получает поле `profile`, указывающее,
какой профиль промптинга соответствует его workflow:

```json
{
  "connectorVersion": "1.0.0",
  "workflow": "video-ltx-1p",
  "type": "video",
  "profile": {
    "videoProfile": "ltx-2.3"
  },
  ...
}
```

### Mapping connector → profile

| Connector | type | profile |
|---|---|---|
| `conn-video-1p` | video | `{ "videoProfile": "ltx-2.3" }` |
| `conn-video-2p` | video | `{ "videoProfile": "ltx-2.3" }` |
| `conn-video-3p` | video | `{ "videoProfile": "ltx-2.3" }` |
| `conn-video-4p` | video | `{ "videoProfile": "ltx-2.3" }` |
| `conn-image-generation` | image | `{ "imageProfile": "qwen-image" }` |
| `conn-tts-dialogue` | audio | `{ "audioProfile": "qwen-tts" }` |
| `conn-tts-narration` | audio | `{ "audioProfile": "qwen-tts" }` |

## 4. Изменения в Agent Pipeline

### 4.1 Загрузка скилла

Перед шагами, которые генерируют промпты, агент проверяет активный профиль
и загружает соответствующий skill-файл через `ai-loader.js`:

```js
const aiLoader = require('../ai-loader');

function getPromptProfile(profileName, profileType) {
  // profileName = "ltx-2.3", profileType = "video"
  // Ищет: backend/ai/skills/video/ltx-2.3.md
  const skillKey = `${profileType}/${profileName}`;
  const skill = aiLoader.getSkill(skillKey);
  return skill || null;
}
```

### 4.2 Какие шаги используют профили

| Шаг пайплайна | Какой профиль | Что делает с скиллом |
|---|---|---|
| `stepCreateVisuals` | `imageProfile` + `videoProfile` | Добавляет skill в system prompt перед генерацией `image.prompt` и `video.action` |
| `stepReconcilePassports` | — | Не меняется (работа с паспортами, не с промптами) |
| `stepReconcileVideoActions` | `videoProfile` | Добавляет video skill в system prompt |
| `stepPolishVideoActions` | `videoProfile` | Добавляет video skill в system prompt |
| `stepPolishStoryboard` | `imageProfile` | Добавляет image skill в system prompt |
| `stepGenerateVoices` | `audioProfile` | Добавляет audio/TTS skill в system prompt (авторство voice-инструкций) |

### 4.3 Передача профиля в pipeline

Профиль передаётся через `options` в `runPipeline()`:

```js
const result = await runPipeline(sessionId, text, chars, locs, stepIndex, progress, sceneOffset, {
  ...options,
  promptProfiles: {
    videoProfile: "ltx-2.3",   // из активного коннектора
    imageProfile: "qwen-image",
    audioProfile: "qwen-tts"
  }
});
```

### 4.4 Assembly Profile — программная сборка промпта (дополнение)

**Skill** (LLM-профиль, markdown) и **Assembly Profile** (программный профиль, JSON) —
два разных артефакта, связанных одним ключом (`profile.imageProfile`/`videoProfile`):

- `ai/skills/{type}/{profile}.md` — как агент ПИШЕТ `image.prompt`/`video.action` (контент).
- `ai/profiles/{type}/{profile}.json` — как КОД собирает финальный промпт:
  порядок секций (`assembly.sections`), опционально подавленные секции
  (`assembly.suppressSections` — механизм для будущих профилей; сейчас не
  используется: qwen-image больше не подавляет style/lighting/mood/shot, wrapper
  всегда собирает их из структурированных полей и environment) и дефолты
  (`assembly.defaults` — quality, negativeBase).

> Разделение ответственности (2026-08): `visual.md` — что делает визуальный агент
> (общий уровень), скилл `{type}/{profile}.md` — как конкретная модель пишет ядро
> (`image.prompt` / `video.action`), профиль + wrapper — как технически собрать
> итоговый запрос. Агент пишет ТОЛЬКО ядро; shot/style/mood/lighting/atmosphere
> добавляются программно из структурированных полей и environment в порядке,
> заданном профилем.

Цепочка резолва (fallback):

```
ai/profiles/{type}/{profileName}.json  →  ai/profiles/{type}/default.json  →  встроенный дефолт
```

Встроенный дефолт = прежний зашитый порядок «от общего к частному» (обратная
совместимость). Резолвит `backend/src/image/assembly-profile.js`; `buildImagePrompt`
собирает секции по профилю. Для скиллов действует `skills/{type}/default.md` —
дефолтный порядок композиции вынесен из `visuals.md` в скилл и инжектится всегда
(фолбэк `'default'` в `stepCreateVisuals`, когда профиль не задан).

### 4.5 Assembly Profile — видео (дополнение)

Видео переведено на ту же схему. Финальный видео-промпт — это таймированный
сториборд, поэтому секции крупнее, чем у image:

```json
{
  "profile": "ltx-2.3",
  "type": "video",
  "workflow": "video-ltx-*",
  "skill": "video/ltx-2.3",
  "assembly": {
    "sections": ["characters", "storyboard", "renderInfo"],
    "defaults": {
      "negativeBase": "blurry, low quality, still frame, jitter, flicker, artifacts"
    }
  }
}
```

- `characters` — блок `Name: video_tokens` (якоря идентичности персонажей).
- `storyboard` — построчные таймированные сегменты `start–end s: описание`.
- `renderInfo` — футер `24fps; render mode`.

Профили: `ai/profiles/video/default.json` и `ai/profiles/video/ltx-2.3.json`
(выбирается через `connector.profile.videoProfile`). У LTX секции не подавляются
(`suppressSections` пуст) — его скилл управляет тем, КАК пишется `video.action`,
а не что исключать из обёртки. `buildVideoPrompt` собирает секции по профилю;
`negativeBase` берётся из `assembly.defaults`. Видео-скилл (`video/ltx-2.3` или
`video/default`) инжектится всегда — в `stepCreateVisuals`, `stepReconcileVideoActions`
и `stepPolishVideoActions` (фолбэк `'default'`), как и image-скилл.

### 4.6 Assembly Profile — аудио (дополнение)

Аудио переведено на ту же схему. У TTS нет «финального промпта», собираемого из
текстовых секций, поэтому профиль описывает assembly-юниты, которые производит
движок/агент, и несёт программные дефолты:

```json
{
  "profile": "qwen-tts",
  "type": "audio",
  "workflow": "tts-qwen-*",
  "skill": "audio/qwen-tts",
  "assembly": {
    "sections": ["voiceInstruction", "defaultInstruct"],
    "defaults": {
      "defaultInstruct": ""
    }
  }
}
```

- `voiceInstruction` — голосовая инструкция (1–3 предложения о тембре, тоне,
  темпе, акценте) — то, что пишет `stepGenerateVoices` и что потребляет
  Qwen3TTSVoiceDesign.
- `defaultInstruct` — дефолтная TTS-инструкция для диалогового воркфлоу
  (node 108 `default_instruct`). Программно берётся из `assembly.defaults` в
  `generation.js` (раньше был захардкожен `""`).

Профили: `ai/profiles/audio/default.json` и `ai/profiles/audio/qwen-tts.json`
(выбирается через `connector.profile.audioProfile`). Аудио-скилл (`audio/qwen-tts`
или `audio/default`) инжектится всегда в `stepGenerateVoices` (фолбэк `'default'`) —
раньше `qwen-tts.md` нигде не использовался.

## 5. Изменения во Frontend

### 5.1 Экран Настроек → Секция Prompt Profiles

На экране Settings добавляется секция **Prompt Profiles** после Workflow Manager
и до Cache/Storyboard.

Порядок: **Audio → Image → Video** (соответствует порядку генерации).

Каждая строка показывает:
- Иконка/лейбл типа
- Название активного профиля (определяется выбранным workflow)
- Статус: отображается read-only, так как профиль определяется workflow

### 5.2 Макет

```
┌──────────────────────────────────────┐
│  Prompt Profiles                     │
│                                      │
│  🎤 Audio Profile  →  qwen-tts      │
│  🖼️ Image Profile  →  qwen-image    │
│  🎬 Video Profile  →  ltx-2.3       │
│                                      │
│  (read-only — determined by workflow)│
└──────────────────────────────────────┘
```

## 6. Порядок реализации

### Фаза 1 — Документация и скилл-файлы
1. ✅ Этот документ
2. ✅ `backend/ai/skills/video/ltx-2.3.md` — из беседы с ChatGPT
3. ✅ `backend/ai/skills/image/qwen-image.md` — базовые правила для Qwen Image
4. ✅ `backend/ai/skills/audio/qwen-tts.md` — базовые правила для Qwen TTS

### Фаза 2 — Backend
5. ✅ `ai-loader.js`: поддержка поддиректорий в loadMdDir()
6. ✅ `prompt-profile-loader.js`: новый модуль для загрузки профилей
7. ✅ Добавить поле `profile` в connector JSONs
8. ✅ Модифицировать `pipeline-steps.js`: inject skill в system prompt
9. ✅ Модифицировать `pipeline-runner.js`: передача promptProfiles в options

### Фаза 3 — Frontend
10. ✅ Prompt Profiles секция на экране Settings
11. ✅ API endpoint `/api/workflows/prompt-profiles` для статуса профилей

## 7. Дальнейшее расширение

- **Ручной выбор профиля**: в будущем можно дать пользователю возможность
  переопределить профиль для каждого типа независимо от workflow.
- **Версионирование**: `ltx-2.3.md`, `ltx-2.4.md` — разные файлы = разные профили.
- **A/B тестирование**: можно добавить fallback-профиль для сравнения.
- **Кастомные профили**: пользовательские .md файлы в отдельной директории.

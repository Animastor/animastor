# Coreference Resolution — История упрощения

> **Текущий статус (июль 2026):** Coreference-шаг удалён из пайплайна.
> `coreference.js` — заглушка. `unit.participants` удалён.
> Единственный механизм: `inferCharactersFromPrompt()` сканирует `visual.prompt`
> на `character_id` и inject-ит паспорта.
> Документ сохранён для истории рефакторинга.

## Problem Statement

AI-агент генерации visual prompts иногда использует для описания персонажей не их `character_id`, а естественные языковые обороты:

- *"Продавщица налила им газировки"* вместо `booth_woman`
- *"Редактор обернулся"* вместо `berlioz`
- *"Поэт задумался"* вместо `bezdomny`

## Решение: LLM сам определяет участников

**Текущая архитектура (с июля 2026):**

```
Шаг 0: analyze_structure             — метаданные книги
Шаг 1: analyze_characters            — персонажи
Шаг 2: analyze_locations             — локации
Шаг 3: create_scenes                 — сцены (title + location.id + environment-override)
Шаг 4: create_units                  — IU (без participants — удалён)
Шаг 5: create_visual_prompts        — inferCharactersFromPrompt
```

`unit.participants` удалён из всей системы. Вместо этого `inferCharactersFromPrompt()`
сканирует `visual.prompt` на `character_id` и inject-ит паспорта. `coreference.js` — заглушка.

### Как это работает (тек. версия)

1. **`stepCreateVisuals()`** — AI пишет `visual.prompt` с character_id (не именами)
2. **`inferCharactersFromPrompt()`** — сканирует `visual.prompt` на `character_id` через regex
3. **`normalizeCharacterRefs()`** — заменяет имена на ID в visual prompt
4. **`buildCharacters()`** — inject-ит паспорта для найденных character_id

## Core Principle: Не угадывай

**Жёсткое правило:** если идентификация персонажа неочевидна из контекста — не привязывать к случайному персонажу.

## Интеграция с image-service.js

`image-service.js` — **потребитель**:

```javascript
// В buildCharacters:
// 1. inferCharactersFromPrompt() — сканирует visual.prompt на character_id
// 2. normalizeCharacterRefs() — заменяет алиасы на ID
```

## История упрощения

Изначально была реализована двухфазная архитектура (coarse + fine pass) с хранением resolution в 5 PostgreSQL таблицах. После анализа было решено упростить:

- **Убрано (июнь 2026):** stepCollectCharacterCandidates, stepResolveCharacterMentions,
  matchMentionsToUnits, БД таблицы, PROGRESS_STAGES для coreference
- **Убрано (июль 2026):** unit.participants, assignUnitParticipants, coreference-шаг,
  shouldInjectParticipantPassports, applyScenePairParticipantFallback, character_anchors
- **Оставлено:** normalizeCharacterRefs, buildSafeAliasIndex, isSafeCharacterAlias,
  inferCharactersFromPrompt

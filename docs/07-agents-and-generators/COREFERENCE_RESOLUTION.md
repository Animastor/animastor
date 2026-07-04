# Coreference Resolution — Simplified (LLM-Driven)

## Problem Statement

AI-агент генерации visual prompts иногда использует для описания персонажей не их `character_id`, а естественные языковые обороты:

- *"Продавщица налила им газировки"* вместо `booth_woman`
- *"Редактор обернулся"* вместо `berlioz`
- *"Поэт задумался"* вместо `bezdomny`

## Решение: LLM сам определяет участников

Вместо двухфазного coarse/fine пайплайна с regex, транслитерацией и БД — LLM возвращает `participants` для каждого unit'а напрямую при создании.

### Pipeline (упрощённый)

```
Шаг 0: analyze_structure             — метаданные книги
Шаг 1: analyze_characters            — персонажи
Шаг 2: analyze_locations             — локации
Шаг 3: create_scenes                 — сцены
Шаг 4: create_units + participants   — IU + участники (LLM сам определяет)
Шаг 5: assign_unit_participants      — валидация ID
Шаг 6: create_visual_prompts        — паспорта из unit.participants
```

Ключевое правило: visual prompts видят **unit-level participants**, а не только scene-level.

### Как это работает

1. **LLM создаёт юниты** — промпт `units` просит вернуть `participants: [character_id]` для каждого unit'а
2. **assignUnitParticipants валидирует** — проверяет что все character_id существуют в character registry, отсекает неизвестные
3. **applyScenePairParticipantFallback** — если LLM не вернула participants, но в тексте есть "первый"/"второй"/"литераторы" и в сцене ровно 2 участника — подставляет обоих
4. **buildCharacters в image-service.js** — `unit.participants` → primary source; `scene.participants` → secondary; `inferCharactersFromPrompt` → fallback (legacy, с логированием)

### Преимущества подхода

| Аспект | Было (coarse/fine + БД) | Стало (LLM-driven) |
|---|---|---|
| **Доп. LLM-вызовы** | 2 на сцену (~5000 токенов) | 0 |
| **БД таблицы** | 5 (resolution_runs, candidates, sentences, mentions, aliases) | 0 |
| **Regex/морфология** | normalizeForMatch, CYR_LATIN_MAP, computeHash | Только в image-service (normalizeCharacterRefs) |
| **Точность resolution** | Зависит от text-matching | LLM понимает контекст (pronouns, roles) |
| **Код** | ~400 строк в agent-service.js | ~20 строк |
| **Тесты** | 100 тестов | ~46 тестов |

## Сохранённые компоненты

Эти части остались, потому что решают реальные проблемы, которые LLM не покрывает:

### normalizeCharacterRefs (image-service.js)
Заменяет слова-алиасы ("Берлиоз", "Бездомный") на character_id в visual prompt. LLM часто пишет имена, а не ID — это чисто строковая замена, без LLM.

### buildSafeAliasIndex (image-service.js)
Строит безопасный индекс алиасов из mention-level данных: исключает generic-слова, pronouns, collision-ы.

### shouldInjectParticipantPassports (agent-service.js)
Умный guard для passport injection: если character_binding=false, проверяет не использует ли prompt generic-слова ("writers", "people") — если да, всё равно inject-ит.

### applyScenePairParticipantFallback (agent-service.js)
Когда в сцене ровно 2 участника и текст упоминает "первый"/"второй"/"литераторы" — подставляет обоих.

### isSafeCharacterAlias (image-service.js)
Фильтр: алиас должен быть ≥3 символов и не быть stopword'ом ("the", "man", "woman", "on", "она" и т.д.)

## Core Principle: Не угадывай

**Жёсткое правило:** если идентификация персонажа неочевидна из контекста — `unknown`, а не привязывай к случайному персонажу.

Одна ложная привязка = модель генерации изображения inject-нет паспорт НЕ того персонажа → визуал получит внешность продавщицы для персонажа, который ей не является.

## Безопасные алиасы

| Тип | Безопасно? | Пример |
|---|---|---|
| `name` | ✅ | "Берлиоз" → berlioz |
| `nickname` | ✅ | "Бездомный" → bezdomny |
| `profession` | ✅ (если ≤1 персонаж с этой ролью) | "редактор" → berlioz |
| `pronoun` | ❌ (никогда) | "он", "она" |
| `unknown` | ❌ | — |

## Интеграция с image-service.js

`image-service.js` — **потребитель**, не resolver:

```javascript
// В buildCharacters:
// 1. Primary: unit.participants (из LLM)
// 2. Secondary: scene.participants
// 3. Fallback: inferCharactersFromPrompt() (legacy, с логированием)
```

## История упрощения

Изначально была реализована двухфазная архитектура (coarse + fine pass) с хранением resolution в 5 PostgreSQL таблицах. После анализа было решено упростить:

- **Убрано:** stepCollectCharacterCandidates, stepResolveCharacterMentions, matchMentionsToUnits, normalizeForMatch, computeHash, CYR_LATIN_MAP (дубликат), БД таблицы, PROGRESS_STAGES для coreference
- **Добавлено:** participants в промпт units, assignUnitParticipants как валидатор
- **Оставлено:** normalizeCharacterRefs, buildSafeAliasIndex, shouldInjectParticipantPassports, applyScenePairParticipantFallback, isSafeCharacterAlias

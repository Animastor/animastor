# Coreference Resolution — TODO (v2, по архитектурному ревью)

## Context

Sentence-level character resolution — новый этап AI-пайплайна. Основан на двухфазной архитектуре:

1. **Coarse pass (~4000 symbols)** — дешёвый сбор кандидатов
2. **Fine pass (~1500 symbols)** — дорогая mention-level разметка

Хранение resolution — **только PostgreSQL**. JSON книги остаётся творческим payload.

**Ключевое правило:** Никогда не угадывать. Generic-алиасы ("мужчина", "женщина", "он", "она") не попадают в alias index.

## P0 — Schema

- [ ] Создать таблицы в `backend/src/storage/postgres/schema.js`:
  - `character_resolution_runs` — run-level tracking + версионирование
  - `character_window_candidates` — coarse candidate collection
  - `sentence_resolutions` — sentence-level (для scene metadata)
  - `character_mentions` — mention-level (основная, для unit participants)
  - `character_aliases` — safe alias index
- [ ] Добавить `'resolve_characters'` в `agent_steps.step_type` CHECK constraint
  - `'collect_character_candidates'` (coarse)
  - `'resolve_character_mentions'` (fine)
- [ ] Обновить purge/reconcile — удалять resolution rows при удалении сцен/книги
- [ ] Добавить индексы для поиска по source span

## P1 — Agent Prompts

- [ ] Создать `SYSTEM_PROMPTS.collect_character_candidates` в `agent-prompts.js`:
  - Широкий контекст ~4000 символов
  - Выход: candidate characters + aliases_seen + unknown_roles
  - Дешёвый вызов (не требует mention-level точности)
- [ ] Создать `SYSTEM_PROMPTS.resolve_character_mentions` в `agent-prompts.js`:
  - Точный контекст ~1500 символов + surrounding context
  - Правило "не угадывай"
  - Never return "unknown" as character_id — use null
  - Include evidence for non-name mentions
  - Pronoun resolution only with explicit antecedent
  - Выход: mention-level данные (text, character_id, type, role, confidence, evidence)
- [ ] Добавить `PROGRESS_STAGES` для новых шагов (русские сообщения)

## P2 — Agent Service

- [ ] Создать `stepCollectCharacterCandidates(sessionId, bookId, { analysisWindowText, analysisWindowStart, analysisWindowEnd, characters, chapterId, windowIndex })`:
  - Вызвать AI с coarse prompt
  - Сохранить в `character_window_candidates`
  - Вернуть candidate set для fine resolver
- [ ] Создать `stepResolveCharacterMentions(sessionId, bookId, { generationSpanText, generationSpanStart, generationSpanEnd, surroundingContext, candidateCharacters, chapterId, windowIndex })`:
  - Разбить generation span на предложения (deterministic splitter)
  - Сформировать окна по 5 предложений (2 до + текущее + 2 после)
  - Вызвать AI с fine prompt
  - Распарсить ответ
  - Сохранить в `sentence_resolutions` + `character_mentions`
- [ ] Добавить шаги в `runPipeline()` между `create_scenes` и `create_units`:
  - `collect_character_candidates` до `create_scenes` (на analysis window)
  - `resolve_character_mentions` после `create_scenes` (на generation span)

## P3 — Assign Unit Participants

- [ ] Создать `assignUnitParticipants(bookId, chapterId, sceneId, units)`:
  - Читает `character_mentions` по source span
  - Для каждого unit: пересечение `unit.source_start..unit.source_end` с mention spans
  - Собирает уникальные character_id
  - Возвращает `{ unitId: [character_ids] }`
- [ ] Интегрировать в pipeline: после `create_units`, до `create_visual_prompts`

## P4 — Safe Alias Index

- [ ] Создать `buildSafeAliasIndex(characterMentions)` в `image-service.js`:
  - Iterate by mention, not by sentence
  - Исключить: pronouns, unknown, generic words
  - Collision detection: same alias_norm → multiple character_ids → remove
  - Вернуть `{ alias_norm: character_id }`
- [ ] Интегрировать в `inferCharactersFromPrompt()` — новая стратегия (матчинг по safe aliases)
- [ ] Интегрировать в `normalizeCharacterRefs()` — замена safe aliases на character_id

## P5 — Image Service Integration

- [ ] `buildCharacters(scenePayload, unit, chapter, book)`:
  - Primary: `unit.participants` (из assignUnitParticipants)
  - Secondary: `scene.participants`
  - Fallback: legacy `inferCharactersFromPrompt()` (с логированием)
- [ ] `inferCharactersFromPrompt()`:
  - Оставить как fallback (legacy)
  - Не считать canonical
  - Логировать, когда сработал
- [ ] `normalizeCharacterRefs()`:
  - Использовать safe aliases из БД
  - Не заменять generic/pronouns
  - Не делать fuzzy replacement без collision check

## P6 — Storage & Cache

- [ ] **Не** хранить `sentence_map` в `chapters/*.json`
- [ ] Хранить resolution в PostgreSQL (таблицы из P0)
- [ ] Redis — только как cache с TTL/version key
- [ ] Обновить cleanup-service для resolution rows

## P7 — Tests

- [ ] Coarse candidate pass validation
- [ ] Fine resolver output validation (mentions, types, confidence)
- [ ] Unit participant assignment by source spans
- [ ] Alias collision across the whole book
- [ ] Stale resolution after character registry hash changes
- [ ] Scene deletion purges resolution rows
- [ ] Fallback image inference does not override DB participants
- [ ] Sentence splitter tests (dialogue punctuation, quotes, ellipsis, Cyrillic)

## Recommended Implementation Order

1. [ ] P0 — Schema: все 5 таблиц + индексы
2. [ ] P1 — Prompts: coarse + fine
3. [ ] P2 — Agent Service: два шага
4. [ ] P3 — Unit Participants: assignUnitParticipants
5. [ ] P4 — Safe Alias Index: buildSafeAliasIndex
6. [ ] P5 — Image Integration: buildCharacters + normalizeCharacterRefs
7. [ ] P6 — Storage: Redis cache + cleanup
8. [ ] P7 — Tests: все 8 групп

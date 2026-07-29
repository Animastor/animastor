# Unit Split Post-Step — splitLongUnits

## Задача

После того как AI создал Imagination Units (шаг `stepCreateUnits`), **проверить длительность каждого юнита** и, если какой-то юнит превышает ~20 секунд по аудио, **разделить его на несколько логических юнитов**.

## Мотивация

- AI создаёт юниты по смыслу («один акт воображения»), не думая о секундах — это правильно.
- Но длинный unit (30-40 секунд звучания) попадёт в один видеочанк целиком, так как `selectWorkflowGroups` не может разбить один unit.
- Решение: пост-шаг, который измеряет `estimated_duration_sec` каждого юнита и, при превышении лимита, reprompt AI с просьбой разделить.

## Алгоритм

```
Units from AI
  ↓
Для каждого unit: estimateSpeechDurationSec(unit.text)
  ↓
Если все ≤ 20s → OK, возвращаем units
  ↓
Если есть unit > 20s → AI reprompt:
  "Этот юнит содержит несколько актов воображения.
   Раздели его на отдельные юниты, каждый — один визуальный кадр."
  ↓
Проверить длительность снова
  ↓
Если всё ещё > 20s → второй reprompt
  ↓
Если всё ещё > 20s → emergency fallback:
  1. Split по предложениям (. ! ?)
  2. Split по запятым (, ; —)
  3. Split по словам (пополам)
  ↓
Вернуть итоговый массив units
```

## Разделение ответственности

| Компонент | Задача |
|---|---|
| AI (unit_splitter.md) | Смысловое разделение: один акт воображения → несколько |
| Код (unit-splitter.js) | Измерение, проверка, retry, fallback |
| Pipeline (pipeline-runner.js) | Вызов splitLongUnits между `stepCreateUnits` и `stepCreateVisuals` |

## Файлы

- `backend/ai/rules/unit_splitter.md` — AI prompt для разделения
- `backend/src/services/agent/unit-splitter.js` — реализация
- `backend/src/services/agent-prompts.js` — регистрация prompt (RULES)
- `backend/src/services/agent/pipeline-runner.js` — точка вызова

## Константы

- `MAX_UNIT_DURATION_SEC = 20` — максимальная длительность одного unit (в секундах)
- `MAX_UNIT_SPLIT_RETRIES = 2` — сколько раз пробовать AI reprompt

## Emergency fallback (chain)

Если AI не смог разделить unit (2 retries):

1. **Sentence-split**: разбить по `[.!?]+` с пробелом после. Каждое предложение → отдельный unit. Если предложение > 20s → не дробить, оставить как есть (крайне редкий случай).
2. **Comma-split**: разбить по `[,;—]+` (с опциональным пробелом после). Em-dash часто без пробела. Каждый сегмент → unit.
3. **Word-count split**: разбить по `\s+` на две равные половины по словам.

## Интеграция в pipeline

`splitLongUnits` вызывается в `pipeline-runner.js` **после** `stepCreateUnits` и **до** `stepCreateVisuals`:

```javascript
const units = await pipelineSteps.stepCreateUnits(sessionId, scene, ...);
const splitUnits = await splitLongUnits(sessionId, scene, units, ...);
const visualUnits = await pipelineSteps.stepCreateVisuals(sessionId, scene, splitUnits, ...);
```

## Результаты тестирования

- **19 тестов**, все проходят ✅
- `getUnitDurationSec` — 3 теста
- `findLongUnits` — 3 теста
- `splitBySentences` — 2 теста
- `splitByCommas` — 4 теста (запятые, точки с запятой, em-dash, без разделителей)
- `splitByWordCount` — 2 теста
- `emergencySplit` — 2 теста (narration, dialogue audio preservation)
- `splitLongUnits` (no AI) — 3 теста (short units, empty, null)

# Import UI — TODO

## Проблема

При импорте TXT пользователь видит в лучшем случае непонятные сообщения
(«Создаю юниты для сцены 5...»), в худшем — сырую ошибку бэкенда:
`✗ Ошибка: Scene coverage failed after fallback: scene_text_not_found`.

Ничего из этого не помогает понять:
- Сколько ещё ждать?
- Что пошло не так?
- Что делать?

## Текущая архитектура (as-is)

```
[Backend] -> POST /bootstrap -> { error: "raw message" }
                ↓
[Frontend] polls /agent-status раз в 2 сек
                ↓
           progress_msg показывается как есть (русские строки)
                ↓
           при ошибке — сырой текст ошибки в statusText
```

Проблема:
1. `error.message` из бэкенда летит прямо в UI (Repository.kt → GenerateViewModel)
2. Фронт парсит structured progress с хардкодом `windowSize = 3`
3. После первой пачки сцен нет явного прогресса по окнам
4. Нет UI для ретрая упавшего импорта
5. SSE stream (`/progress-stream`) не используется во время импорта

## Что нужно сделать

### 1. Backend: человекочитаемые ошибки импорта

**Где:** `agent-service.js` `runPipeline()` и `bootstrapWithAgent()` / `bootstrapNextWindow()`

**Что:** Заменить сырые `throw new Error(...)` на структурированные ошибки
с кодами, чтобы фронт мог показать понятное сообщение + кнопку действия.

```
Текущий бросок:
  throw new Error(\`Scene coverage failed after fallback: \${coverage.reason}\`);

Нужно:
  throw new ImportError('COVERAGE_FAILED', {
    message: 'Текст не удалось разбить на сцены — некоторые фрагменты не найдены в исходнике',
    detail: { reason: coverage.reason, gap_chars: coverage.gap_chars },
    retryable: false,   // можно ли перезапустить окно
    suggest: 'Проверьте исходный TXT: возможно, есть нестандартные символы (NBSP, неразрывные пробелы)',
  });
```

Аналогично для других ошибок импорта:

| Код | Когда | Сообщение пользователю | Retryable |
|---|---|---|---|
| `AI_FAILED` | Все попытки AI исчерпаны | «AI-обработчик временно недоступен. Попробуйте позже или укажите другой API-ключ» | true |
| `AI_EMPTY_RESPONSE` | AI вернул 0 сцен | «Модель не смогла разобрать текст. Возможно, формат не поддерживается» | false |
| `COVERAGE_FAILED` | Coverage не сошёлся даже после fallback | «Техническая ошибка разбиения текста на сцены» | false |
| `BOOK_NOT_FOUND` | Книга не найдена на диске | «Файл книги не найден — возможно, был удалён» | false |
| `UNKNOWN` | Всё остальное | «Неизвестная ошибка импорта» | true |

**Роут agent-status** (`GET /:bookId/agent-status`) должен возвращать
`last_error: { code, message, detail, retryable }`, чтобы фронт мог
показать и кнопку ретрая.

### 2. Backend: прогресс по окнам

**Где:** `GET /:bookId/agent-status` и `bootstrapNextWindow()`

**Что:** Вернуть в `agent-status` поля для UI прогресса:

```json
{
  "active": true,
  "window_index": 2,
  "total_windows_estimated": 5,
  "scenes_this_window": 4,
  "scenes_total": 12,
  "progress_msg": "Создаю юниты для сцены 3 окна 2..."
}
```

- `total_windows_estimated` — `Math.ceil(remainingChars / SCENE_CHUNK_SIZE)`.
  Не точное, но даёт пользователю ощущение прогресса.
- `scenes_this_window` — сколько сцен уже создано в текущем окне.
- `scenes_total` — всего сцен во всех окнах.

### 3. Frontend: структурированная ошибка

**Где:** `Repository.kt`, `GenerateViewModel.kt`

**Что:**

```kotlin
data class ImportError(
    val code: String,
    val message: String,
    val retryable: Boolean,
    val suggest: String? = null
)
```

- В `Repository.kt` парсить `last_error` из ответа, а не только `error` string.
- В `GenerateViewModel.uiState` завести `importError: ImportError?`.
- В `FileFragment.kt` показывать:
  - `message` в красной плашке
  - Если `retryable` → кнопка «Повторить»
  - Если `suggest` → серая подсказка под сообщением

### 4. Frontend: progress-bar на время импорта

**Где:** `GenerateViewModel.kt`, `FileFragment.kt`

**Что:**

Текущий UI:
```
⟳ Анализирую структуру документа...
⟳ Извлекаю персонажей...
⟳ Создаю сцены...         <-- пользователь видит только это
```

Нужно:
```
[████████░░░░░░░░░░░░] 45%   <-- progress bar
Окно 2 из ~5 · Сцена 3 из 8
⟳ Создаю юниты для сцены 3...
```

- **progress bar** = `scenes_total / max(1, scenes_total + remaining_estimated)`
  или просто пульсирующий индикатор, если total_windows_estimated неизвестен.
- **текст** = «Окно N из ~M · Сцена K из этого окна»
- **subtext** = последний `progress_msg`

### 5. Frontend: отображение multi-window импорта

**Где:** `GenerateViewModel.kt`, `pollAgentProgress()`

**Что:** Сейчас polling проверяет `status.active`. Между окнами есть пауза
(бэкенд обрабатывает окно → `paused` → фронт замечает `active: false` →
через 3 цикла считает импорт завершённым). Надо:

- Не завершать импорт при `active: false`, если остались окна.
- Использовать `total_windows_estimated` и `window_index`:
  - `window_index < total_windows_estimated - 1` → still importing.
  - Иначе проверять `has_more` из ответа.

### 6. Frontend: повтор упавшего окна

**Где:** `FileFragment.kt`, `GenerateViewModel.kt`

**Что:** Если `last_error.retryable == true`, показать кнопку «Повторить окно»,
которая дёргает `POST /:bookId/bootstrap-next-window` или
`POST /:bookId/resume-bootstrap` (зависит от window_index).

Для этого бэкенду нужен роут ретрая последнего окна (или доработка
`resume-bootstrap`). Текущий `resume-bootstrap` не восстанавливает
позицию — он начинает с нуля, если нет сохранённой сессии.

### 7. Фронт: SSE для live-прогресса импорта

**Где:** `GenerateViewModel.kt`, `ProgressStream.kt`

**Что:** После того как бэкенд опубликует события прогресса для окон,
подписаться на `/progress-stream` не только для GPU-генерации, но и
для импорта. Это избавит от polling с 2-секундной задержкой.

События (новые, нужно добавить в `progress-pubsub.cjs`):
```json
{ "type": "import_progress", "window_index": 1, "total_scenes": 4, "stage": "creating_scenes" }
{ "type": "import_window_complete", "window_index": 1, "scenes_added": 4 }
{ "type": "import_error", "code": "COVERAGE_FAILED", "message": "..." }
```

## Приоритет

1. **(P0) Backend: человекочитаемые ошибки** — без этого пользователь
   всегда видит «Scene coverage failed after fallback». Минимальное
   изменение — map error message в `book-routes.cjs`.

2. **(P0) Backend: починить fallback coverage** — `buildFallbackScenes`
   меняет whitespace (параграфы → пробелы), из-за чего `scene_text_not_found`.
   См. #fix-fallback-whitespace ниже.

3. **(P1) Frontend: структурированная ошибка + кнопка ретрая** — даёт
   пользователю возможность перезапустить импорт без полного удаления книги.

4. **(P1) Frontend: progress-bar окон** — пользователь видит «3/5 окон».

5. **(P2) SSE для импорта** — замена polling на стрим.

## #fix-fallback-whitespace

Корень `scene_text_not_found` после fallback:

```
splitIntoSentences()            → вырезает куски с .trim(), теряет \n\n
buildFallbackScenes()           → g.join(' ') — склеивает через пробел
computeSceneCoverage()          → ищет точное вхождение — не находит
```

Варианты:

**A) (Recommended) Сохранять оригинальные позиции в sourceText:**
Вместо того чтобы собирать текст заново, запоминать `source_start`/`source_end`
для каждого предложения, и для каждой сцены брать оригинальный подстрочный
срез из sourceText.

```js
function buildFallbackScenes(sceneText) {
    const sentences = splitIntoSentencesWithOffsets(sceneText);
    // ... группировка ...
    return groups.map(g => {
        const start = g[0].start;
        const end = g[g.length - 1].end;
        return {
            text: sceneText.slice(start, end),  // verbatim из source
            source_start: start,
            source_end: end,
            // ...
        };
    });
}
```

**B) Нормализовать coverage:**
В `computeSceneCoverage()` перед сравнением схлопывать множественные
пробелы/переводы строк в единый пробел. Покроет проблему, но менее
надёжно (другие расхождения не поймает).

**C) Нормализовать fallback:**
В `buildFallbackScenes()` не `.trim()` предложения, а сохранять
оригинальные позиции. По сути то же, что А, но сложнее.

## Файлы для изменения

| Файл | Что менять |
|---|---|
| `backend/src/services/agent-service.js` | #fix-fallback-whitespace; структурированные ошибки (или утилита для них) |
| `backend/src/services/source-coverage.js` | Возможно — нормализация whitespace для fallback |
| `backend/src/routes/book-routes.cjs` | Перехват ошибок импорта → структурированный JSON с code/message/retryable |
| `frontend/.../Repository.kt` | Парсинг `last_error`; ImportError data class |
| `frontend/.../GenerateViewModel.kt` | `importError` в uiState; корректный polling multi-window |
| `frontend/.../FileFragment.kt` | Показ ошибки + кнопка ретрая + progress bar |
| `frontend/.../BookModels.kt` | Data class для `AgentStatusResponse` (добавить поля окон) |

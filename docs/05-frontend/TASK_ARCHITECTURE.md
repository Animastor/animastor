# Task Architecture (Progress Panel)

> **Дата:** 2026-07-26
> **Контекст:** После переработки ChatGPT 5.5 (F15 parallel generation) и последующего рефакторинга терминологии worker→task.

---

## 1. Терминология

| Термин | Что это |
|---|---|
| **Task** | Одно задание генерации, созданное пользователем. Имеет тип (`audio`/`image`/`video`), scope, список целей (сцен). |
| **TaskRow** | Одна строка в UI-панели прогресса. Один task может породить одну или несколько строк (см. scope). |
| **GPU Worker** | Удалённый процесс на GPU Hub, выполняющий работу. Не путать с UI-строками. |
| **Scope** | Область генерации: `current_scene`, `current_chapter`, `from_current_scene`, `whole_book`. |

---

## 2. Жизненный цикл Task

```
Пользователь выбирает scope и тип
         │
         ▼
  Frontend: startGeneration()
         │
         ▼
  Backend: /regenerate → generation-routes.cjs
         │  проверяет dirty_scenes, добавляет cover если надо
         ▼
  Backend: generation-progress.js → createTasks()
         │  создаёт task на каждый тип × scope
         │  task имеет task_id, type, scope, targets[сцены]
         ▼
  Backend: scheduler + dispatch-engine → GPU Hub
         │  выполняют работу, обновляют asset states
         ▼
  Backend: progress-panel.cjs → buildTaskRows()
         │  читает tasks из redis, считает ready/total
         │  возвращает массив TaskRow (JSON)
         ▼
  Frontend: computeProgressRows()
         │  строит UI-строки с прогрессом, таймерами, expiry
         ▼
  Frontend: renderTaskRowsToSections()
         │  рендерит строки в контейнеры по типу
```

---

## 3. Scope → Количество строк

Главное правило: **одно задание — одна строка**, кроме случая, когда пользователь явно выбрал конкретную сцену.

| Scope | Поведение | Пример |
|---|---|---|
| `current_scene` | **Per-target**: каждая цель → отдельная строка | Image для scene5 + cover → 2 строки Image |
| `current_chapter` | **Агрегированное**: одна строка на тип | Audio для chapter3 (5 сцен) → 1 строка Audio |
| `from_current_scene` | **Агрегированное**: одна строка на тип | Те же 5 сцен → 1 строка |
| `whole_book` | **Агрегированное**: одна строка на тип | 20 сцен → 1 строка Image |

### Почему?

- **current_scene**: если cover добавляется в dirty, это **другая сцена**. У неё свой прогресс, свой таймер. Показывать оба в одной строке неправильно.
- **whole_book / chapter / from_current**: это **одно задание** с множеством целей. Пользователь хочет видеть общий прогресс задания, а не 20 отдельных строк.

Реализовано в `backend/src/routes/book/progress-panel.cjs` — `buildTaskRows()`:

```javascript
if (task.scope === 'current_scene') {
    // per-target expansion
    for (const target of targets) {
        // считаем ready/total для ОДНОЙ сцены
        result.push({ task_id, type, scene_id, ready, total, ... })
    }
    return result
} else {
    // aggregated: один воркер на все цели
    return [{ task_id, type, ready, total, ... }]
}
```

---

## 4. Per-Task Timer (Frontend)

Каждая строка (TaskRow) имеет свой таймер:

```
Map<String, Long> taskFrozenElapsed   // taskKey → замороженные секунды
Map<String, Long> taskCompletedAt     // taskKey → время 100%
```

### Механика

1. **Task активен**: таймер живёт от `timerStartedAt` (глобальный старт сессии)
2. **Task достиг 100%**:
   - `taskCompletedAt[taskKey] = now` — запоминаем момент завершения
   - `taskFrozenElapsed.getOrPut(taskKey) { ... }` — замораживаем время на этом моменте
3. **Task отображается 10 секунд** после своего 100%
4. **Через 10 секунд** после 100%:
   - `rows.removeAll { row.done && (now - taskCompletedAt) >= 10s }`
   - Строка исчезает независимо от других строк
5. **Когда все строки исчезли** → `applyGenerationResults()`, финализация

### Почему независимый expiry?

- Audio закончился раньше Image → Audio строка исчезает через 10с, Image продолжает висеть
- Если одна генерация зависла, завершённые не висят бесконечно
- Пользователь не ждёт завершения всех заданий, чтобы увидеть Done

---

## 5. Модели данных (Frontend)

```kotlin
// Одна строка прогресса
data class TaskRow(
    val taskId: String?,
    val type: String,          // "audio" | "image" | "video" | "vbook"
    val label: String,         // локализованное название
    val scope: String,
    val chapterId: String?,
    val sceneId: String?,      // для per-scene строк
    val ready: Int,
    val total: Int,
    val percent: Int,
    val done: Boolean,
    val countText: String?,
    val indeterminate: Boolean, // spinner (VBook analyzing)
    val cancelled: Boolean,
    val elapsedSeconds: Long    // frozen для done, live для active
)

// Состояние панели прогресса
sealed class ProgressPanelState {
    data class Rows(val rows: List<TaskRow>)  // одна или несколько строк
    object DoneRow                              // все Done (legacy, не используется)
    object Hidden                               // нет активных задач
}

// Локализованные подписи
data class TaskLabels(
    val cover: String,
    val audio: String,
    val image: String,
    val video: String,
    val generationDone: String,
    val vbookLabel: String,
    val vbookAnalyzing: String,
    val vbookScenesFormat: (Int, Int) -> String
)
```

---

## 6. Backend (progress-panel.cjs)

**Endpoint:** `GET /api/v1/book/:bookId/progress-panel`

Ответ — массив task-строк:

```json
{
  "workers": [
    {
      "task_id": "generation-image-1712345678901-a1b2c3d4",
      "type": "image",
      "scope": "current_scene",
      "chapter_id": "ch01",
      "scene_id": "scene_cover",
      "target_count": 1,
      "ready": 5,
      "total": 5,
      "percent": 100,
      "done": true,
      "visible": true,
      "indeterminate": false,
      "cancelled": false
    },
    {
      "task_id": "generation-image-1712345678901-a1b2c3d4",
      "type": "image",
      "scope": "current_scene",
      "chapter_id": "ch01",
      "scene_id": "scene_005",
      "target_count": 1,
      "ready": 3,
      "total": 5,
      "percent": 60,
      "done": false,
      "visible": true,
      "indeterminate": false,
      "cancelled": false
    }
  ]
}
```

**Важно:** поле `workers` в JSON ответе осталось для обратной совместимости. На фронтенде эти объекты называются `ProgressWorker` в API-моделях, но отображаются как `TaskRow`.

---

## 7. Файлы

| Файл | Роль |
|---|---|
| `backend/src/services/generation-progress.js` | Создаёт задачи, хранит в Redis, отслеживает статус |
| `backend/src/routes/book/progress-panel.cjs` | Строит ответ для /progress-panel, агрегирует или расширяет per-target |
| `frontend/.../GenerateViewModel.kt` | `computeProgressRows()`, таймеры, expiry, `TaskRow` model |
| `frontend/.../GenerateFragment.kt` | `renderTaskRowsToSections()`, рендер, кнопки Stop |
| `frontend/.../SettingsFragment.kt` | `resetProgressState()` при очистке кэша |

---

## 8. История переименований

Было (от ChatGPT 5.5) | Стало | Причина
---|---|---
`WorkerUi` | `TaskRow` | Путаница с GPU Worker
`computeWorkers()` | `computeProgressRows()` | Функция не вычисляет воркеров
`workerReadyFloor` | `taskReadyFloor` | Относится к заданию, не к воркеру
`workerCompletedAt` | `taskCompletedAt` | -"-
`workerFrozenElapsed` | `taskFrozenElapsed` | -"-
`COMPLETED_WORKER_DISPLAY_MS` | `COMPLETED_TASK_DISPLAY_MS` | -"-
`gpuProgressDoneAt` | *(удалён)* | Мёртвая переменная
`resetWorkerState()` | `resetProgressState()` | Сбрасывает состояние прогресса
`cancelWorker()` | `cancelTask()` | Отменяет задание, не воркер
`WorkerLabels` | `TaskLabels` | Лейблы для строк, не для воркеров
`ProgressPanelState.Workers` | `ProgressPanelState.Rows` | Список строк, не воркеров
`buildWorker()` (backend) | `buildTaskRows()` | Строит строки, не воркеров
`renderWorkersToSections()` | `renderTaskRowsToSections()` | Рендерит строки
`setupWorkerStopButton()` | `setupTaskStopButton()` | Кнопка отмены задания
`scopedWorkerLabel()` | `scopedTaskLabel()` | Лейбл для задания

# Архитектурные проблемы — Анимастор

## 1. Продолжение работы с большой книгой

### Проблема
Если пользователь импортировал большой TXT, сделал 2 окна (сгенерировал 6 сцен), закрыл приложение и пришёл на следующий день — нет способа продолжить с того же места.

### Сценарии отказа

**TXT → vbook → открыть vbook**
1. Импорт TXT → bookId = A
2. Скачать vbook → bookId = A (внутри файла)
3. Открыть vbook → `loadBookFromFile()` → может создать НОВЫЙ bookId = B
4. PG-сессии bookId = A, нового bookId = B нет
5. Исходный TXT отсутствует

**TXT → закрыть → тот же TXT**
1. Импорт TXT → bookId = A
2. Закрыть приложение
3. Снова импортировать тот же TXT → bookId = C (новый!)
4. PG-сессии bookId = A потеряны

### Корень
- `bookId` генерируется случайно (timestamp + random)
- Нет дедупликации по содержимому файла
- vbook не сохраняет связь с исходным TXT
- `book_generation_sessions` привязаны к `bookId`, который не восстанавливается

### Статус: ✅ Частично реализовано (2026-06)
- **Таблица `book_source`** в PG: `file_hash → book_id` с репозиторием
- **Дедупликация TXT**: SHA256 при импорте, проверка `book_source`, возврат существующего bookId
- **source_file_hash** в manifest.json при создании книги (lazy-book.js)
- **vbook download**: включает source.txt, manifest с book_id + source_file_hash
- **load-vbook**: регистрирует source_file_hash в book_source
- **completion_status**: отслеживание in_progress/completed в книжных сессиях

### Остаётся
- vbook с другого сервера: PG-сессии не переносятся (cross-server sharing)

---

## 2. Триггер следующего окна — не работает для vbook

### Проблема
`trigger-next-window` спроектирован только для TXT-импорта. Для vbook:
- Нет `book_generation_sessions` → `getHighestCompletedWindow()` = -1
- Нет исходного текста → `lazyBook.loadDraftBook(bookId)` = null
- Нет глав для парсинга → `all_done: true`

### Текущее состояние
- PlayFragment: ✅ триггер есть (через `checkEndOfWindowAndTrigger`)
- EditFragment: ✅ триггер есть (через `checkEndOfWindowAndTrigger`)
- NavigateFragment: ✅ триггер есть (через `checkEndOfWindowAndTrigger`)
- Бэкенд: `trigger-next-window` эндпоинт есть, только для TXT

### Статус: ✅ Работает
- trigger-next-window разрешён для BOOTSTRAPPED + ACTIVE состояний
- vbook должен быть импортирован как TXT для оконной генерации
- Если vbook скачан с того же сервера → source.txt в архиве → генерация продолжается

---

## 3. Отсутствие связки TXT → vbook → продолжение

### Проблема
При скачивании vbook теряется:
1. Ссылка на исходный TXT (source_text)
2. Состояние оконной генерации (book_generation_sessions)
3. bookId (может измениться при повторной загрузке)

### Статус: ✅ Частично решено
- manifest.json содержит `book_id` + `source_file_hash` + source.txt
- vbook download включает ВСЕ файлы книги, включая source.txt
- load-vbook восстанавливает bookId из manifest
- При наличии source.txt → trigger-next-window работает

### Остаётся
- cross-server: vbook не переносит PG-сессии
- Нужен механизм: при открытии vbook без source.txt → предложить загрузить TXT

---

## 4. Дедупликация TXT-импорта

### Проблема
Повторный импорт того же TXT-файла создаёт новую книгу с нуля.

### Статус: ✅ Реализовано (2026-06)
- Таблица `book_source` в PG: `file_hash → book_id`
- repo: `book-source-repo.js` (registerSource, findByHash, findCandidateBySize, deleteByBookId)
- При `import-txt`:
  1. Быстрая проверка по имени + размеру
  2. При совпадении → SHA256 верификация
  3. Если книга существует → возвращаем `book_id` + `dedup: true`
  4. Если книга удалена → чистим ссылку, создаём новую
- При `createDraftBook`: `source_file_hash` в manifest.json
- `source_file_hash` используется и при load-vbook для связи

---

## 5. Стартап-резюме оконной генерации

### Статус: ✅ Реализовано
`startup-resume.js` восстанавливает незавершённые PG-сессии при перезапуске сервера:
- Находит `generating/pending/queued` сессии
- Сбрасывает `generating` → `pending`
- Перезапускает фоновую генерацию

### Остаётся
- Не восстанавливается позиция пользователя (глава/сцена/модуль)
- `chunkQueue` на фронтенде пуст — нужно перезагрузить книгу

---

## 6. Позиция глава/сцена/модуль

### Статус: ✅ Реализовано
`PositionManager` в `GenerateViewModel` — единый источник истины.
Все экраны читают из `positionManager.current` (StateFlow).
Верхняя панель (`include_position_bar.xml`) обновляется каждым фрагментом из PositionManager.

### Не реализовано
- Сохранение позиции в PG для восстановления после перезапуска
- При старте: восстановить последнюю позицию пользователя

---

## 7. Технический долг

### Frontend APK
- `adapterPosition` deprecated в NavigateFragment → мигрировать на `bindingAdapterPosition`

### Backend
- `gen-session-repo.js` требует полного тестирования
- `startup-resume.js` — не было теста на реальном сценарии перезапуска

### Триггер
- `checkEndOfWindowAndTrigger` добавлен во все фрагменты, но:
  - Нет throttling (может вызвать API несколько раз при быстрой навигации)
  - Backend дедуплицирует через PG, но лишние HTTP-вызовы — это шум
  - `triggerNextWindow` теперь `private` — правильная инкапсуляция

---

## 8. Статус книги (completion)

### Статус: ✅ Реализовано (2026-06)
- `completion_status` колонка в `book_generation_sessions`
- `setBookCompletionStatus(bookId, 'in_progress'|'completed')`
- `getBookCompletionStatus(bookId)` — читает с последнего окна
- Bootstrap: сразу после первого окна → `in_progress`
- Background gen: после обработки всего текста → `completed`
- `/api/v1/book/{bookId}/status` возвращает `completion_status`
- Файл: `backend/src/config/book-architecture.js` (константы)

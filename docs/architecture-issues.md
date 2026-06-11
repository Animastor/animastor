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

### Решение
- Таблица `book_source` в PG: `file_hash → book_id`
- При импорте TXT: SHA256 файла → проверка существующей книги
- При открытии vbook: восстановление bookId изнутри файла + проверка PG
- Если книга не закончена → continue; если закончена → новая

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
- Бэкенд: `trigger-next-window` эндпоинт есть, но только для TXT

### Решение
- Для vbook: триггер не нужен — книга уже полностью загружена
- Для TXT: триггер работает, но нужна привязка к book_source (см. п.1)

---

## 3. Отсутствие связки TXT → vbook → продолжение

### Проблема
При скачивании vbook теряется:
1. Ссылка на исходный TXT (source_text)
2. Состояние оконной генерации (book_generation_sessions)
3. bookId (может измениться при повторной загрузке)

### Решение
- В manifest.json vbook хранить: `original_book_id`, `source_file_hash`
- При открытии vbook: восстановить bookId, проверить PG-сессии
- Если есть исходный TXT на сервере → продолжать генерацию окон

---

## 4. Дедупликация TXT-импорта

### Проблема
Повторный импорт того же TXT-файла создаёт новую книгу с нуля.

### Решение
1. Вычислить SHA256 содержимого файла
2. Таблица `book_source`:
   ```sql
   CREATE TABLE book_source (
       file_hash    TEXT PRIMARY KEY,  -- SHA256
       book_id      TEXT NOT NULL,
       source_type  TEXT NOT NULL,     -- 'txt_file', 'ai_text'
       filename     TEXT,
       created_at   BIGINT NOT NULL
   );
   ```
3. При `POST /import-txt`:
   - Проверить `book_source` по хешу
   - Если книга существует и не закончена → вернуть существующий `bookId`
   - Если книга закончена → создать новую
4. При `GET /book/{bookId}/status`:
   - Показать информацию о source-связи
   - Показать `parsedChapters / totalChapters`

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
- `psql` не установлен в контейнере → сложно диагностировать PG вручную
- `gen-session-repo.js` требует полного тестирования
- `startup-resume.js` — не было теста на реальном сценарии перезапуска

### Триггер
- `checkEndOfWindowAndTrigger` добавлен во все фрагменты, но:
  - Нет throttling (может вызвать API несколько раз при быстрой навигации)
  - Backend дедуплицирует через PG, но лишние HTTP-вызовы — это шум
  - `triggerNextWindow` теперь `private` — правильная инкапсуляция

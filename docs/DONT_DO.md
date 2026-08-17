# ⛔ Изменения, которые НЕЛЬЗЯ делать

Этот файл содержит перечень изменений, которые в прошлом вызывали критические регрессии в плеере, очереди воспроизведения или событийной модели. **Ни в коем случае не повторять.**

## Плеер (PlayFragment.kt)

### 1. Stall/retry механизм для IU изображений
**Запрещено:** Добавлять логику stall/retry в цикл IU cycling, которая приостанавливает аудио при отсутствии изображения и ждёт его загрузки.

- `4c25fad` — IU stall/retry: аудио ждёт картинку
- `9d1f7f6` — stall hang fix
- Причина: блокирует цикл воспроизведения, вызывает зависания плеера

### 2. Sliding window preload
**Запрещено:** Полностью перерабатывать механизм предзагрузки окон (sliding window).

- `663e598` — sliding window preload
- Причина: переработанный preload ломает последовательное воспроизведение очереди

### 3. Сложная логика при отсутствии IU изображения
**Запрещено:** Добавлять условные проверки `nextIu.bitmap == null || nextIu.status != IuStatus.READY` в цикл IU cycling с пропуском IU.

- `c80e53f` — keep previous image when IU is not generated
- Причина: приводит к неконсистентному состоянию индекса IU и зависанию на одном кадре

### 4. Двойной вызов switchToPlayTab() (NavigationEvent)
**Запрещено:** Добавлять `setupNavigationEventObserver()` в MainActivity, который вызывает `switchToPlayTab()`, если FileFragment уже делает то же самое через `navigationEvent.collect` или `uiState.collect`.

- `ddc4f1b` (revert) — NavigationEvent ломал плеер
- Причина: `FragmentTransaction.commit()` — асинхронный. Когда `switchToPlayTab()` вызывается дважды подряд, создаются **два** PlayFragment, которые конфликтуют. Только FileFragment должен обрабатывать навигацию.

**Правильный подход:** NavigationEvent должен собираться только в FileFragment, НЕ в MainActivity. MainActivity НЕ должен иметь `setupNavigationEventObserver()`.

## Кэширование

### 5. Удаление clearCache в preparePlayback
**Запрещено:** Убирать вызов `_repository.clearCache()` в `preparePlayback()`.

- `be49b84` — remove aggressive clearCache
- Причина: приводит к показу устаревших/чужих изображений при переходе между книгами

## Изменения в подходах

### 6. Удаление функций без проверки всех референсов
**Запрещено:** Удалять экспортированные функции, не проверив все места их вызова через code search.

- `ff1809e` — удалены `unregisterAudio/Image/Video`, `saveBookJson`, `deleteBookJson`, `getBookContentHash`
- Причина: функции могут вызываться из динамического require или через prototype chain

### 7. Изменение типа поля data class с `var` на `val`
**Запрещено:** Менять `var` на `val` в data class, если поле может обновляться из другого места (например, `IuImageItem.bitmap`).

- `ffd420b` — revert включал изменение `var bitmap` → `val bitmap` в `IuImageItem`
- Причина: field может обновляться in-place из stall-retry механизма

### 8. helmet/rate-limit без тестирования совместимости с Android WebView
**Запрещено:** Добавлять helmet middleware без проверки, что security-заголовки (Content-Type, CSP) совместимы с фронтендом.

- `d6ac6c1` — добавлены helmet и express-rate-limit
- Причина: helmet может блокировать заголовки, ожидаемые Android-клиентом

### 9. graceful-shutdown с redis.quit() без проверки активных операций
**Запрещено:** Вызывать `redis.quit()` в graceful-shutdown без гарантии, что нет активных операций.

- `d6ac6c1` — graceful-shutdown с redis.quit()
- Причина: может прерывать активные генерации и приводить к потере данных

### 10. Изменение уровня HTTP логгирования с BODY на HEADERS
**Запрещено:** Менять `HttpLoggingInterceptor.Level.BODY` на `LEVEL.HEADERS` в RetrofitClient.kt.

- Шаг 1.2 — BODY → HEADERS
- Причина: после этого изменения плеер перестал воспроизводить очередь (не установлена прямая связь, но откат исправил проблему)

### 11. Возврат зависимости Player от `video_start_ms`
**Запрещено:** Заставлять Player (Android `PlayFragment.kt` / Web `playbackStore.ts`) читать, вычислять или потреблять `video_start_ms`.

- Контракт (audio master timeline): **Audio = semantic master timeline (`start_ms`), Storyboard = selected unit, Video = visual follower** — Player живёт только на `start_ms`. `video_start_ms` считается в backend (`backend/src/video/video-timeline.js`) как best-effort и используется ТОЛЬКО в Final Assembly (точные границы при экспорте).
- Не вводить `videoStartMs` в `IuImageItem`/`IuItem`/`StoryboardIu`/`RawIu` и в состояние Player.
- Даже если в конкретном LTX-тесте (8N+1) снова проявится рассинхрон границ — править выравнивание в подготовке/assembly видео, а не добавлять вторую временную модель в Player.
- Причина: вторая временная шкала создавала второй таймлайн и рассогласование; убрано в рамках рефактора audio master timeline.

## Проверка перед любым изменением

Перед тем как вносить любое изменение в файлы плеера (PlayFragment.kt, PlaybackViewModel.kt, Repository.kt), необходимо:

1. ✅ Проверить через code search, не используется ли удаляемый код
2. ✅ Собрать APK (`./gradlew assembleDebug`)
3. ✅ Проверить, что плеер открывается
4. ✅ Проверить, что воспроизведение очереди работает
5. ✅ Проверить, что пауза/возобновление работают
6. ✅ Проверить, что переход между сценами работает

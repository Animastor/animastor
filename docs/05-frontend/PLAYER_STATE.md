# Состояние плеера после регенерации

## Проблема

После завершения GPU-генерации контент книги обновляется, но плеер остаётся в старом состоянии. Если просто перезапустить плеер (`preparePlayback` → `SCENE_READY`), пользователь теряет позицию, текущую фазу (был на паузе — сбрасывается), а UI дёргается.

## Решение: Soft Refresh

Концепция: **«Генерация не управляет плеером. Генерация обновляет контент.»**

После завершения генерации не вызывается полный сброс плеера. Вместо этого:

1. `GenerateViewModel` эмитит `PlaybackPreparation` с флагом `softRefresh = true`
2. `MainActivity` вызывает `PlaybackViewModel.refreshContent()` вместо `preparePlayback()`
3. Плеер остаётся в текущей фазе (PAUSED → PAUSED, PLAYING → PLAYING)
4. Устанавливается флаг `needsContentRefresh = true`
5. При следующем нажатии Play — рефетч свежего контента для текущей сцены

## Архитектура

```
GenerateViewModel.onGenerationComplete()
  │
  ├─ loadCoverBitmap(coverId)         ← с ретраем (5 попыток, ~17s backoff)
  │
  └─ _playbackPrepared.tryEmit(
       PlaybackPreparation(
         bookId, buildId, chunkIds, positions,
         coverImage = cover,            ← обложка для fallback-фона
         softRefresh = true             ← ФЛАГ мягкого обновления
       )
     )
       │
       ▼
MainActivity.setupPlaybackCoordination()
  │
  ├─ softRefresh == true
  │   └─ playbackViewModel.refreshContent(...)
  │       ├─ очищает preloadCache
  │       ├─ обновляет chunkQueue, buildId, positions
  │       ├─ _repository.clearCache()   ← безусловно (buildId меняется)
  │       │
  │       ├─ PAUSED / PLAYING:
  │       │   ├─ needsContentRefresh = true
  │       │   └─ return (фаза не меняется)
  │       │
  │       └─ IDLE / SCENE_READY:
  │           └─ full reset (как preparePlayback)
  │
  └─ setCoverImage(cover)              ← всегда, если cover != null
```

## Механизмы

### 1. `needsContentRefresh`

Флаг в `PlaybackViewModel`. Устанавливается `refreshContent()` когда плеер был в PAUSED или PLAYING.

При следующем `resumePlayback()` (нажатие Play):
- Флаг сбрасывается (`needsContentRefresh = false`)
- Вместо простого `PLAYING` запускается корутина:
  - `_uiState.update { phase = DOWNLOADING }`
  - `playNext()` → `fetchSceneData(id)` → рефетч аудио/изображений
  - `emitChunk()` → PLAYING со свежим контентом

```kotlin
fun resumePlayback() {
    if (needsContentRefresh) {
        needsContentRefresh = false
        viewModelScope.launch {
            _uiState.update { it.copy(phase = PlayerPhase.DOWNLOADING) }
            playNext()
        }
        return
    }
    _uiState.update { it.copy(phase = PlayerPhase.PLAYING) }
}
```

### 2. Очистка плеера в PlayFragment

При `needsContentRefresh == true` фрагмент освобождает старые плееры ДО рефетча:

```kotlin
if (playbackViewModel.needsContentRefresh) {
    currentPlayer?.release()    // ← старый MediaPlayer с placeholder
    nextPlayer?.release()
    videoPlayer?.release()
    currentPlayer = null
    isPaused = false
    playbackViewModel.resumePlayback()  // ← рефетч нового аудио
    return
}
```

Без этого старый `MediaPlayer` начинал играть сразу (`currentPlayer?.start()`), а новое аудио цеплялось как `nextPlayer` — пользователь слышал старый placeholder.

### 3. Обложка (cover) как fallback-фон

После генерации `onGenerationComplete()` загружает обложку через `loadCoverBitmap()` с ретраем:

```kotlin
var cover: Bitmap? = null
if (coverId != null && imageEnabled) {
    cover = loadCoverBitmap(coverId)
    if (cover == null) {
        for (retry in 1..5) {  // ~17s total backoff
            delay((1000L shl minOf(retry, 3)).coerceAtMost(5000))
            cover = loadCoverBitmap(coverId)
            if (cover != null) break
        }
    }
}
```

`MainActivity` всегда вызывает `setCoverImage(cover)` если `cover != null`. В PlayFragment state collector:

```kotlin
if (state.coverImage != null) {
    b.curtainsImage.visibility = View.GONE
    b.coverImage.setImageBitmap(state.coverImage)
    b.coverImage.visibility = View.VISIBLE
    hasDisplayedCover = true
}
```

После установки обложки шторы театра (`curtainsImage`) больше никогда не показываются для этой книги.

### 4. buildId и инвалидация кэша

`buildId` — идентификатор версии контента на бэкенде. Используется в ключах кэша:

```
cacheKey = "audio_${id}_${buildId}"
diskKey  = "${buildId}_$id"
```

После регенерации `startGeneration()` сохраняет новый `build_id` из ответа `/regenerate`:

```kotlin
if (res.build_id != null) {
    persistBuildId(res.build_id)  // ← buildId обновлён
}
```

Изменение `buildId` делает старые кэш-ключи невалидными — `getChunkAudio()` получает cache miss и загружает свежие данные с бэкенда.

Дополнительно `refreshContent()` всегда вызывает `_repository.clearCache()` как страховку.

### 5. Очистка кэша

| Где | Когда | Что чистит |
|-----|-------|-----------|
| `startGeneration()` | Старт генерации | `_repository.clearCache()` |
| `refreshContent()` | Завершение генерации | `_repository.clearCache()` (безусловно) |
| `preparePlayback()` | Новая книга / смена buildId | `_repository.clearCache()` (условно, при смене buildId) |

## Сценарии

### Сценарий A: Пользователь на паузе → генерация → Play

1. Плеер PAUSED на сцене 5
2. Запущена генерация (Audio + Image)
3. Генерация завершается → `onGenerationComplete()`
4. `refreshContent()`:
   - Очищает кэш
   - Обновляет `chunkQueue`, `buildId`
   - `needsContentRefresh = true`
   - Фаза остаётся **PAUSED**
5. `setCoverImage(cover)` → UI обновляет обложку, шторы убраны
6. Пользователь жмёт Play
7. `resumePlayback()` → `needsContentRefresh == true`
   - Фрагмент освобождает старый MediaPlayer
   - `playNext()` → DOWNLOADING → `fetchSceneData(5)` → свежее аудио
   - `emitChunk()` → PLAYING → новый MediaPlayer играет сцену 5
8. **Результат:** позиция сохранена, обложка на месте, новое аудио играет

### Сценарий B: Пользователь играет → генерация → окончание текущей сцены

1. Плеер PLAYING на сцене 5
2. Генерация завершается → `refreshContent()`
3. `needsContentRefresh = true`, фаза остаётся **PLAYING**
4. Текущий MediaPlayer доигрывает сцену 5 (старое аудио)
5. `onAudioCompleted()` → `playNext(6)` → `fetchSceneData(6)` → свежее аудио для сцены 6
6. Сцена 6 играет с новым контентом
7. **Результат:** текущая сцена доигрывается, следующие сцены — свежие

### Сценарий C: Новая книга (без генерации)

1. `generateFromFile()` / `loadBookFromFile()`
2. `softRefresh = false` (по умолчанию)
3. `MainActivity` вызывает `preparePlayback()`:
   - `chunkQueue.clear()`, `currentIndex = 0`
   - `_uiState.update { phase = SCENE_READY }`
   - Если buildId изменился → `_repository.clearCache()`
4. `setCoverImage(cover)` → обложка, шторы убраны
5. **Результат:** полный сброс, плеер готов к воспроизведению

## Удалённые/мёртвые механизмы

- **`coverUpdated` channel** — был объявлен в `GenerateViewModel` но `_coverUpdated.tryEmit()` никогда не вызывался. Удалён. Обложка теперь передаётся исключительно через `PlaybackPreparation.coverImage`.

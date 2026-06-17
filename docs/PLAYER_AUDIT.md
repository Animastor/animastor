# Аудит плеера: архитектура, сетевая предзагрузка и кэширование

Дата: 17 июня 2026

---

## 1. Архитектура воспроизведения

### 1.1. Жизненный цикл плеера

```
[MainActivity]
    │
    ├── GenerateViewModel ────── play() ──► Backend API ──► Chunks
    │                                                  │
    └── PlaybackViewModel ◄── playbackPrepared ────────┘
              │
              │ preparePlayback(bookId, buildId, chunkIds, positions)
              │
              ▼
         [PLAYER.IDLE] ──► [PLAYER.SCENE_READY]
                                  │
                      playSceneQueue()
                                  │
                                  ▼
                            [PLAYER.DOWNLOADING]
                                  │
                         fetchSceneData(id) ←─── Repository
                                  │
                                  ▼
                            [PLAYER.PLAYING]
                                  │
                         ┌────────┴────────┐
                         ▼                  ▼
                  handleChunk()      handleSilentChunk()
                   (audio + IU)        (IU only, timer)
                         │
                    startIuCycling()
                         │
                   onAudioCompleted()
                         │
                    currentIndex++
                         │
                    playNext() ──► loop
                         │
                    [SCENE_READY] (end of queue)
```

### 1.2. Ключевые компоненты

| Компонент | Файл | Роль |
|-----------|------|------|
| **MainActivity** | `MainActivity.kt` | Координатор. Слушает `GenerateViewModel.playbackPrepared` и вызывает `PlaybackViewModel.preparePlayback()` |
| **PlaybackViewModel** | `PlaybackViewModel.kt` | Управляет очередью, предзагрузкой, состоянием плеера |
| **PlayFragment** | `PlayFragment.kt` | UI плеера: MediaPlayer, IU cycling, SurfaceView для видео |
| **GenerateViewModel** | `GenerateViewModel.kt` | Генерация контента, импорт, сигнал `playbackPrepared` |
| **Repository** | `Repository.kt` | Слой данных: HTTP вызовы + LruCache + SimpleDiskCache |
| **SimpleDiskCache** | `util/SimpleDiskCache.kt` | Дисковый кэш с типами audio/video/image/preview/iu |
| **MediaDecoder** | `util/MediaDecoder.kt` | Декодирует `ByteArray` в `Bitmap` |
| **BackendApi** | `repository/BackendApi.kt` | Retrofit-интерфейс со всеми API эндпоинтами |

### 1.3. Формирование очереди воспроизведения

Очередь формируется в `PlaybackViewModel.chunkQueue` — это `MutableList<String>` (список chunk_id).

**Путь формирования:**
1. `GenerateViewModel` получает `chunkIds` из ответа `/api/v1/generate` или `/api/v1/book/{bookId}/chunks`
2. Эмитит `PlaybackPreparation(bookId, buildId, chunkIds, positions)` через `playbackPrepared`
3. `MainActivity` подхватывает и вызывает `PlaybackViewModel.preparePlayback(bookId, buildId, chunkIds, chunkPositions)`
4. `preparePlayback` очищает кэш (`_repository.clearCache()`), сохраняет chunkIds в `chunkQueue`, устанавливает `phase = SCENE_READY`

**А также через `ensureInitialized()`:** если плеер ещё не инициализирован, загружает чанки через `/api/v1/book/{bookId}/chunks` и вызывает `preparePlayback`.

### 1.4. Переход между элементами очереди

Переход реализован через **`playNext()`** + **`onAudioCompleted()`**:

1. **`playNext()`** (PlaybackViewModel):
   - Берёт `chunkQueue[currentIndex]`
   - Сначала проверяет `preloadCache` — если есть, использует готовые данные
   - Если нет — запускает `fetchSceneData(id)` в корутине
   - Вызывает `emitChunk(audio, video, iuSequence)` — устанавливает phase = PLAYING

2. **PlayFragment** реагирует на phase = PLAYING:
   - В `observeState()` при `state.chunkSequence > lastProcessedChunkSequence` вызывает `handleChunk()` или `handleSilentChunk()`
   - `handleChunk()` создаёт/цепит MediaPlayer, запускает IU cycling

3. **Завершение трека:**
   - MediaPlayer `setOnCompletionListener` → `onTrackEnd()` в PlayFragment
   - `onTrackEnd()` переключает `currentPlayer = nextPlayer`, вызывает `playbackViewModel.onAudioCompleted()`
   - `onAudioCompleted()` инкрементит `currentIndex++`, вызывает `playNext()`

4. **Двойной механизм перехода:**
   - `setNextMediaPlayer(nextPlayer)` — для бесшовного перехода между двумя подготовленными MediaPlayer
   - `onTrackEnd()` + `onAudioCompleted()` — для случая, когда `setNextMediaPlayer` не сработал

### 1.5. Текстовая схема потока данных

```
                ┌──────────────┐
                │   Backend    │
                │  (Docker)    │
                └──────┬───────┘
                       │ HTTP (JSON + streaming)
                       ▼
              ┌─────────────────┐
              │  RetrofitClient  │ OkHttp + HttpLoggingInterceptor
              │  (BackendApi)    │ connectTimeout=30s, readTimeout=15min
              └────────┬────────┘
                       │
                       ▼
              ┌─────────────────┐
              │   Repository    │
              │  ┌───────────┐  │
              │  │ LruCache  │  │ 50MB in-memory
              │  │ (mem)     │  │
              │  ├───────────┤  │
              │  │DiskCache  │  │ 256MB on disk
              │  │(SD card)  │  │
              │  └───────────┘  │
              └────────┬────────┘
                       │
              ┌────────┴────────┐
              ▼                  ▼
     PlaybackViewModel     GenerateViewModel
     ┌───────────────┐     ┌───────────────┐
     │ preloadCache   │     │ playbackPrepared│
     │ chunkQueue     │     │ (SharedFlow)  │
     │ preloadAhead() │     └───────┬───────┘
     └───────┬───────┘             │
             │                     ▼
             ▼              ┌──────────────┐
      ┌─────────────┐       │ MainActivity │
      │ PlayFragment │◄─────│  coordinator  │
      │ MediaPlayer  │      └──────────────┘
      │ IU cycling   │
      │ Video overlay│
      └──────────────┘
```

---

## 2. Сетевая предзагрузка (САМЫЙ ВАЖНЫЙ ПУНКТ)

### 2.1. Текущая реализация

Предзагрузка реализована в `PlaybackViewModel.preloadAhead()`:

```kotlin
private const val PRELOAD_AHEAD = 3  // предзагрузка на 3 сцены вперёд
private val preloadCache = mutableMapOf<String, PreloadedScene>()
```

**Как работает:**
1. После `playSceneQueue()` или `playNext()` вызывается `preloadAhead()`
2. Для каждого `offset` от 1 до `PRELOAD_AHEAD` (3 сцены):
   - Вычисляет `idx = currentIndex + offset`
   - Если `preloadCache` уже содержит chunk_id — пропускает
   - Иначе запускает `fetchSceneData(id)` в той же корутине
   - Сохраняет результат в `preloadCache[id]`
3. Когда `playNext()` получает запрошенный chunk, он сначала проверяет `preloadCache`
4. Если кэш есть — использует готовые данные без сетевого запроса
5. Если нет — синхронно грузит через `fetchSceneData()`

**Проблема с последовательностью:**
- `preloadAhead()` использует **одну корутину** для ВСЕХ предзагрузок (цикл `for`)
- Предзагрузки запускаются последовательно: сначала offset=1, потом offset=2, потом offset=3
- Это означает, что adj(следующая сцена будет загружена только после offset=1)
- Если сцена с offset=1 большая (аудио + IU изображения), загрузка offset=2 начнётся только после её завершения

### 2.2. Что загружается

`fetchSceneData(id)` загружает **три компонента параллельно** через `async`:

```kotlin
val audioDeferred = async { 
    if (chunk?.audio_ready == true) repository.getChunkAudio(id) 
    else byteArrayOf()
}
val videoDeferred = async { 
    if (chunk?.video_ready == true) repository.getChunkVideo(id) 
    else null 
}
val iuDeferred = async { 
    fetchIuSequence(id)  // storyboard + IU изображения
}
```

**IU изображения** загружаются последовательно внутри `fetchIuSequence()`:
```kotlin
storyboard.ius.map { iu ->
    repository.getIuImage(bkId, chId, scId, iu.unit_id, bldId)  // каждый вызов — отдельный HTTP запрос
}
```

### 2.3. HTTP Range Requests

**НЕ ИСПОЛЬЗУЮТСЯ.** Все медиа-эндпоинты помечены `@Streaming`:
- `GET /chunk/{id}/audio` — загружает весь MP3 файл целиком
- `GET /chunk/{id}/image` — загружает всё PNG изображение
- `GET /chunk/{id}/video` — загружает весь MP4 файл
- `GET /iu-image/{book}/{ch}/{sc}/{iu}` — загружает каждое IU изображение отдельным запросом

Никакие `Range: bytes=...` заголовки не используются. Это означает:
- Аудиофайл загружается **полностью** перед началом воспроизведения
- Видеофайл загружается **полностью** перед началом показа
- Каждое IU изображение — отдельный полный HTTP запрос

### 2.4. Локальное сохранение

Да, загруженные данные сохраняются:

**1. In-memory cache (LruCache):**
- `Repository` содержит `LruCache<String, ByteArray>(50 * 1024 * 1024)` — 50MB
- Ключи: `"audio_$chunkId"`, `"image_$chunkId"`, `"video_$chunkId"`, `"iu_${book}_${ch}_${sc}_${iu}"`
- Хранит сырые байты в памяти

**2. SimpleDiskCache (диск):**
- Путь: `app.cacheDir/media-cache/{audio,video,image,preview,iu}/`
- Лимит: 256MB
- При достижении лимита удаляет самые старые файлы (LRU)
- Типы: audio (mp3), video (mp4), image (png), preview (png), iu (png)

**3. Временные файлы для MediaPlayer (PlayFragment):**
- Аудио: `cacheDir/chunk-{timestamp}.mp3` или через `repository.cacheAudioFile()`
- Видео: `cacheDir/video-{timestamp}.mp4` или через `repository.cacheVideoFile()`

### 2.5. Узкие места и паузы между треками

**Проблема 1: Последовательная загрузка IU изображений**
В `fetchIuSequence()` все IU изображения для сцены загружаются последовательно, каждое отдельным HTTP запросом. Для сцены с 10 IU — это 10 последовательных HTTP round-trips. При сетевой задержке 100-200ms это добавляет 1-2 секунды на сцену.

**Проблема 2: Нет частичной загрузки аудио**
Аудио загружается полностью через `repository.getChunkAudio()` → `body.bytes()`. До начала воспроизведения нужно дождаться полной загрузки. Для сцены с 30-секундным аудио (~500KB MP3) при медленной сети это может быть 5-10 секунд ожидания.

**Проблема 3: preloadAhead() работает в одной корутине**
```kotlin
for (offset in start..PRELOAD_AHEAD) {
    val data = fetchSceneData(id)  // последовательно
    preloadCache[id] = data
}
```
Это значит, что загрузка сцены+3 начинается только после полной загрузки сцены+1. Нет параллельной предзагрузки нескольких сцен.

**Проблема 4: Двойное кэширование с разными стратегиями**
- `LruCache` (50MB) — эвикция по размеру, без учёта давности использования
- `SimpleDiskCache` (256MB) — эвикция по дате последней модификации (LRU)
- Между ними нет синхронизации: данные могут быть в диске, но не в памяти, и наоборот

**Проблема 5: MediaPlayer требует полный файл**
`MediaPlayer.setDataSource(file.absolutePath)` требует наличия полного аудиофайла на диске. Нет стримингового воспроизведения. Это значит:
- Файл должен быть полностью записан на диск перед началом воспроизведения
- Для перехода к следующей сцене, её аудиофайл тоже должен быть полностью на диске

---

## 3. Кэширование на Android

### 3.1. Где хранятся настройки пользователя

**SharedPreferences:**
- `animastor` (стандартный XML shared preferences)
- Хранятся: `bookId`, `buildId` (для восстановления после перезапуска)

### 3.2. Многоуровневое кэширование

```
Запрос данных
     │
     ▼
┌─────────────┐
│  LruCache   │  ← 50MB в памяти (первичный)
│  (mem)      │
└──────┬──────┘
       │ miss
       ▼
┌─────────────┐
│ SimpleDisk  │  ← 256MB на диске (вторичный)
│ Cache       │   LRU эвикция
└──────┬──────┘
       │ miss
       ▼
┌─────────────┐
│   Backend   │  ← HTTP запрос через Retrofit
│   API       │
└─────────────┘
```

**Данные, которые кэшируются:**

| Тип | In-memory (LruCache) | Disk (SimpleDiskCache) | Стратегия инвалидации |
|-----|---------------------|----------------------|----------------------|
| Аудио чанка | `audio_$id` | `audio/` (mp3) | LruCache: по заполнению 50MB. Disk: LRU при 256MB |
| Изображение чанка | `image_$id` | `image/` (png) | Аналогично |
| Видео чанка | `video_$id` | `video/` (mp4) | Аналогично |
| IU изображение | `iu_${b}_${ch}_${sc}_${iu}` | `iu/` (png) | Аналогично |
| Preview изображение | `pr_${b}_${ch}_${sc}_${iu}` | `preview/` (png) | Аналогично |
| Storyboard (IU метаданные) | НЕ кэшируется | НЕ кэшируется | Всегда запрос к серверу |

**Данные, которые НЕ кэшируются и загружаются повторно:**
1. `getChunkStoryboard(id)` — каждый раз GET запрос
2. `getAllChunks(bookId)` — каждый раз GET запрос
3. `getBook(bookId)` — каждый раз GET запрос
4. `getChunk(id)` — каждый раз GET запрос (проверка `audio_ready`, `image_ready`, `video_ready`)

### 3.3. Инвалидация кэша

**Когда кэш очищается:**
1. **`preparePlayback()`** — вызывает `_repository.clearCache()` → очищает LruCache + SimpleDiskCache
   - Это происходит при каждом новом проигрывании
   - Проблема: даже если данные не изменились, кэш полностью сбрасывается
2. **`clearCache()` в Repository** — `cache.evictAll()` + `diskCache?.evictAll()`
3. **`trim()` в SimpleDiskCache** — автоматически при превышении 256MB удаляются самые старые файлы
4. **LruCache** — автоматическая эвикция по достижении 50MB (алгоритм LRU встроенный в Android)

### 3.4. Критические проблемы кэширования

**Проблема А: Полная очистка кэша при preparePlayback**
```kotlin
fun preparePlayback(...) {
    _repository.clearCache()  // ← удаляет ВСЕ кэшированные IU изображения, аудио, видео
    preloadCache.clear()      // ← очищает предзагруженные данные
```
При повторном открытии той же книги все IU изображения будут загружены заново.

**Проблема Б: Storyboard не кэшируется**
`getChunkStoryboard(id)` запрашивается:
- В `ensureInitialized()` для всех чанков
- В `playSceneQueue()` через `loadCoverIntoState()`
- В `fetchIuSequence()` для каждого чанка при предзагрузке

Storyboard содержит IU метаданные (длительности, тексты) — они не меняются, но загружаются каждый раз.

**Проблема В: getChunk() запрашивается многократно**
В `fetchSceneData()`:
```kotlin
val chunk = runCatching { _repository.getChunk(id) }.getOrNull()  // ← 1-й запрос
// ...
if (chunk?.audio_ready == true) {
    val audio = repository.getChunkAudio(id)  // ← 2-й запрос (streaming)
}
if (chunk?.video_ready == true) {
    val video = repository.getChunkVideo(id)  // ← 3-й запрос (streaming)
}
```
При этом `getChunk(id)` возвращает `ChunkResponse` (JSON) — эта информация **не кэшируется**.

---

## 4. Анализ эффективности

### 4.1. Что реализовано хорошо

1. **Параллельная загрузка аудио/видео/IU** — внутри `fetchSceneData()` используется `async` для параллельной загрузки трёх компонентов
2. **Двухуровневое кэширование** — in-memory (LruCache) + disk (SimpleDiskCache)
3. **Предзагрузка на 3 сцены вперёд** — `PRELOAD_AHEAD = 3` даёт запас
4. **Бесшовный переход через setNextMediaPlayer** — Android MediaPlayer поддерживает предварительную цепочку
5. **Timer-based IU cycling для silent сцен** — когда аудио нет, IU переключаются по таймеру
6. **Чистое разделение GenerateVM и PlaybackVM** — плеер не зависит от генерации

### 4.2. Что реализовано неэффективно

1. **Последовательная загрузка IU изображений** — каждое IU изображение = отдельный HTTP запрос, все последовательно
2. **Полная загрузка аудио перед воспроизведением** — нет streaming/progressive download
3. **Одна корутина на всю предзагрузку** — `preloadAhead()` загружает сцены по одной, а не параллельно
4. **Полная очистка кэша при preparePlayback** — сбрасывает все кэшированные данные
5. **Storyboard не кэшируется** — IU метаданные загружаются повторно
6. **HTTP logging Level.BODY** — логирует в base64 все медиа-файлы, создавая гигантские строки и нагрузку на GC

### 4.3. Потенциальные источники лагов

| Источник | Описание | Степень |
|----------|----------|---------|
| **Последовательные HTTP запросы IU** | Для сцены с 10 IU = 10 последовательных round-trips | **Высокая** |
| **PreloadAhead в одной корутине** | Сцена+2 ждёт полной загрузки сцены+1 | **Средняя** |
| **Нет стриминга аудио** | Полная загрузка MP3 перед стартом | **Средняя** |
| **Storyboard не кэшируется** | Повторные запросы метаданных | **Низкая** |
| **Level.BODY логгирование** | Конвертация бинарных данных в строку, нагрузка на GC | **Средняя** (доказано эмпирически) |
| **clearCache при preparePlayback** | Сброс всех кэшированных IU изображений | **Средняя** |

### 4.4. Рекомендуемые улучшения (в порядке приоритета)

1. **Paralleльная предзагрузка сцен** — запускать `fetchSceneData()` для offset=1,2,3 параллельно, а не последовательно
2. **Кэширование storyboard** — добавить `IuItem` данные в LruCache/DiskCache, они не меняются
3. **Частичная загрузка аудио** — использовать `Range: bytes=0-...` для начала воспроизведения до полной загрузки
4. **Параллельная загрузка IU изображений** — для всех IU сцены запускать `async { fetchIuImage() }` параллельно
5. **Избранная инвалидация кэша** — не чистить весь кэш при preparePlayback, только если buildId изменился
6. **Level.HEADERS** — включить для production (но нужно понять, почему ломает)

---

*Аудит проведён без внесения изменений в код. Основан на анализе файлов: PlayFragment.kt, PlaybackViewModel.kt, Repository.kt, BackendApi.kt, RetrofitClient.kt, SimpleDiskCache.kt, MediaDecoder.kt, GenerateViewModel.kt, ChunkResponse.kt, StoryboardResponse.kt.*

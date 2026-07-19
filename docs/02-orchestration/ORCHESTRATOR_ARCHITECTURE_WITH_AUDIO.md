# Orchestrator Architecture — Unified State Machine

> **Цель:** Единый фасад `orchestrator.js`, владеющий всеми lifecycle-состояниями
> генерации: per-asset states (READY/PENDING/GENERATING/DIRTY/FAILED) и
> audio-orch states (PLACEHOLDER_READY/GENERATING/WAITING_CHUNKS/MERGING/DONE/FAILED).
> Никакой модуль не пишет состояние напрямую — только через фасад.

---

## 1. Проблема: два независимых state machine

### Asset State Machine (старая, `state.js`)
```
   startScene()      setSceneGenerating()    completeStage()
NEW ──────────→ PENDING ───────────────→ GENERATING ────────→ READY
                                      ↘ FAILED ──→ PENDING (re-dispatch)
                                        setSceneGenerating()
                                  DIRTY ────────────→ PENDING (regenerate)
```

- Хранится в `animastor:scene-assets-state:{bookId}:{chapterId}:{sceneId}`
- Одно поле `audio` из набора `{NEW, PENDING, GENERATING, READY, FAILED, DIRTY, PLACEHOLDER}`
- Пишется через `state.setAssetState()` — **прямой вызов, не через фасад**

### Audio-Orch State Machine (новая, `audio-orchestrator.js`)
```
        initPlaceholderReady()  setGenerating()  setWaitingChunks()
NEW ─────────────────────→ PLACEHOLDER_READY ──────────→ GENERATING ──────────→
                                              executeAudioDispatch()

WAITING_CHUNKS ──→ MERGING ──→ DONE
                    completeChunk()
                  ↘ FAILED
                    failWaitingScene() / watchdog

FAILED ──→ GENERATING (scheduler re-dispatch)
FAILED ──→ WAITING_CHUNKS (completeChunk, late chunk recovery)
```

- Хранится в `animastor:audio-orch:{bookId}:{chapterId}:{sceneId}`
- Детальные фазы: `NEW, PLACEHOLDER_READY, GENERATING, WAITING_CHUNKS, MERGING, DONE, FAILED`
- Знает про чанки: `expected_count, chunks_received, last_chunk_at, started_at`
- Пишется через `audioOrch.transitionState()` — **напрямую, не через фасад**

### Следствие: рассинхронизация

| Сценарий | Asset state | Audio-orch | Кто прав? |
|---|---|---|---|
| Штатное завершение | READY | DONE | Оба ✅ |
| Watchdog сбросил | PENDING | FAILED | Рассинхрон ❌ |
| Re-dispatch после DONE | GENERATING | DONE | Рассинхрон ❌ |
| Stale recovery убил DONE | GENERATING | PLACEHOLDER_READY | Audio-orch заново ❌ |

---

## 2. Решение: единый фасад orchestrator.js

`orchestrator.js` становится **единственным модулем**, который пишет оба state machine.
Все вызовы `state.setAssetState()` и `audioOrch.*()` проходят через фасад.

```
                    ┌─────────────────────────┐
                    │     orchestrator.js     │
                    │   (единый фасад)        │
                    │                         │
                    │  setSceneGenerating()   │
                    │  setScenePending()      │
                    │  completeStage()        │
                    │  failStage()            │
                    │  markDirtyScene()       │
                    │  resetScenes()          │
                    └──────┬──────────┬───────┘
                           │          │
                    ┌──────┘          └──────┐
                    ▼                       ▼
           ┌──────────────┐      ┌──────────────────┐
           │   state.js   │      │ audio-orchestrator│
           │ (asset state)│      │  (audio-orch)     │
           │              │      │                   │
           │ NEW, PENDING │      │ PLACEHOLDER_READY │
           │ GENERATING   │      │ GENERATING        │
           │ READY        │      │ WAITING_CHUNKS    │
           │ FAILED       │      │ MERGING           │
           │ DIRTY        │      │ DONE/FAILED       │
           └──────────────┘      └───────────────────┘
```

### Контракт: инварианты

Каждая команда фасада гарантирует:

```
setSceneGenerating(audio):
  asset.audio = GENERATING
  if audio-orch exists AND NOT DONE → audio-orch = GENERATING (transitionState)
  if audio-orch is DONE → return { skipped: true, reason: 'already_done' }

completeStage(audio):
  1. verifyDispatchIdentity
  2. handler (handleAudioCompleted)
  3. version gate (PG)
  4. if ok: asset.audio = READY  AND  audio-orch = DONE  (синхронно)
  5. if stale: asset.audio = DIRTY  AND  audio-orch → reset (deleteState или FAILED)
  6. finalizeDispatch (success/failure)

failStage(audio):
  1. verifyDispatchIdentity
  2. validateAssetTransition(current → FAILED)
  3. if ok: asset.audio = FAILED  AND  audio-orch = FAILED (синхронно)
  4. if redispatch: asset.audio = PENDING
  5. finalizeDispatch (failure)

markDirtyScene(audio):
  if audio-orch DONE → deleteState (clean slate for regeneration)
  asset.audio = DIRTY
  PG: markStale

setScenePending(audio):
  if audio-orch DONE → deleteState (clean slate)
  asset.audio = PENDING
```

### Инвариант (всегда true)

```
audio-orch.phase == DONE   ⇔   asset.audio == READY
audio-orch.phase == FAILED   ⇒   asset.audio == FAILED или PENDING
audio-orch.phase ∈ {WAITING_CHUNKS, MERGING}   ⇒   asset.audio == GENERATING
```

Проверяется в `reconcileCycle` → `checkAudioOrchInvariants()`.

---

## 3. Call flows

### 3.1 Штатная генерация аудио

```
Scheduler tick
  → attemptDispatch()
    → shouldScheduleAssets(): asset=PENDING → stages=['audio']
    → dispatchStage('audio')
      → acquireLease()
      → acquireQuota()
      → scene-orchestrator.executeAudioDispatch()
        ┌─ orchestrator.setSceneGenerating('audio')
        │   → asset.audio = GENERATING
        │   → audioOrch.setGenerating()        # PLACEHOLDER_READY → GENERATING
        │     (или initPlaceholderReady если нет state)
        ├─ audioOrch.setWaitingChunks()
        ├─ audio.generateSceneAudio() → GPU hub (9 chunks)
        └─ return { dispatched: true }

Chunk 0001 arrives
  → /gpu/task/result
    → handleTaskResult()
      → save file to disk
      → orchestrator передаётся в audioOrch.completeChunk()
        → audioOrch WAITING_CHUNKS (chunks_received=1)

... (chunks 0002-0008)

Chunk 0009 arrives
  → audioOrch.completeChunk()
    → WAITING_CHUNKS → MERGING (all 9 chunks present)
    → ffmpeg merge → merged MP3
    → MERGING → DONE
    → orchestrator.completeStage('audio')
      → handleAudioCompleted()
      → version gate (PG)
      → asset.audio = READY  (синхронно с audio-orch DONE)
      → finalizeDispatch(success)
    → publishProgress (SSE)
```

### 3.2 Re-dispatch после watchdog

```
Watchdog (reconcileCycle → checkStalledAudioScenes)
  → audioOrch state: WAITING_CHUNKS, last_chunk_at + 5min < now
  → audioOrch.failWaitingScene()
    └─ orchestrator.failStage('audio')
      → asset.audio = FAILED
      → audio-orch = FAILED (синхронно)
      → asset.audio = PENDING (re-dispatch)
      → finalizeDispatch(failure)

Scheduler tick (next)
  → asset.audio = PENDING → stages=['audio']
  → dispatchStage('audio')
    └─ orchestrator.setSceneGenerating('audio')
      → audio-orch FAILED → GENERATING (valid transition!)
      ... генерация заново
```

### 3.3 Regenerate (dirty scene)

```
User edits text, clicks "Generate"
  → /api/v1/regenerate
    → orchestrator.resetScenes()
      → clearLeases, clear queues
      └─ orchestrator.markDirtyScene('audio')
        → audio-orch DONE? → deleteState (clean slate)
        → asset.audio = DIRTY
    → scheduler.addSceneToActiveIndex()

Scheduler tick
  → asset.audio = DIRTY → stages=['audio']
  → dispatchStage('audio')
    → orchestrator.setSceneGenerating('audio')
      → audio-orch: no state → initPlaceholderReady
      → asset.audio = GENERATING
      → audioOrch.setGenerating()
      → dispatch to GPU
```

### 3.4 Stale recovery (WAITING_CHUNKS → reset)

```
После рестарта или сбоя:
  → audio-orch в WAITING_CHUNKS (от предыдущей незавершённой генерации)
  → Scheduler видит asset.audio = GENERATING (остался от прошлого раза)
  → dispatchStage('audio')
    → orchestrator.setSceneGenerating('audio')
      → setGenerating() → FAILS (WAITING_CHUNKS → GENERATING invalid)
      → stale-phase recovery:
        → deleteState (только если WAITING_CHUNKS/GENERATING/FAILED)
        → initPlaceholderReady
        → setGenerating ✅
      → dispatch to GPU (свежая генерация)
```

---

## 4. Команды фасада — полный API

| Команда | asset state | audio-orch | Вызывается из |
|---|---|---|---|
| `setScenePending` | → PENDING | если DONE → deleteState | scene-window, scheduler |
| `setSceneGenerating` | → GENERATING | если DONE → skip; иначе → GENERATING | scene-orchestrator |
| `setScenePlaceholder` | → PLACEHOLDER | — | scene-window |
| `completeStage` | → READY | → DONE | audioOrch.completeChunk, task-handler |
| `failStage` | → FAILED → PENDING | → FAILED | /gpu/task/error, watchdog, recovery |
| `markDirtyScene` | → DIRTY | если DONE → deleteState | reconciliation, resetScenes |
| `setSceneAllReady` | все → READY | all → DONE | scene-window (cache hit) |
| `resetScenes` | все → DIRTY | все → deleteState/FAILED | /regenerate |

---

## 5. Модули, которые НЕ пишут состояние напрямую

После рефакторинга следующие модули НЕ вызывают `state.setAssetState()` или `audioOrch.*()` напрямую — только через фасад:

| Модуль | Сейчас | После |
|---|---|---|
| `scene-orchestrator.js` | `setSceneGenerating` вручную + `audioOrch.*()` | через `orchestrator.*()` |
| `task-handler.cjs` | `audioOrch.completeChunk()` напрямую | через `orchestrator.*()` обёртку |
| `reconciliation-engine.js` | `audioOrch.*()` напрямую (scan, failWaitingScene) | через `orchestrator.*()` |
| `scene-callbacks.js` | `state.setAssetState()` напрямую | через `orchestrator.*()` |
| `scene-window.js` | `state.setAssetState()` напрямую | через `orchestrator.*()` |

---

## 6. Исключения: только чтение

`state.getAssetState()` и `audioOrch.getState()` остаются прямыми — это read-only операции.
Любой модуль может читать оба state machine, но **писать** — только через фасад.

---

## 7. Redis key layout

```
# Asset states (per-scene, per-asset)
animastor:scene-assets-state:{bookId}:{chapterId}:{sceneId}
  → { audio: "READY", image: "READY", video: "PENDING" }

# Audio-orch state (per-scene, audio-specific)
animastor:audio-orch:{bookId}:{chapterId}:{sceneId}
  → { phase: "DONE", expected_count: 9, chunks_received: 9,
      last_chunk_at: 1743212345, started_at: 1743212300,
      build_id: "build_abc123" }

# Dispatch metadata (per-scene, per-stage)
animastor:dispatch-meta:{bookId}:{chapterId}:{sceneId}:audio
  → { dispatch_id: "dispatch-xxx", stage: "audio",
      started_at: 1743212300, lease_key: "...", lease_token: "..." }

# Dispatch lease
animastor:dispatch-lease:{bookId}:{chapterId}:{sceneId}:audio
  → "dispatch-xxx-token"
```

---

## 8. Валидация и тестирование

### Тестируемые инварианты

```js
// После completeStage('audio')
assert.equal(assetState.audio, 'READY');
assert.equal(audioOrchState.phase, 'DONE');

// После failStage('audio')
assert.equal(assetState.audio, 'PENDING');  // с redispatch=true
assert.equal(audioOrchState.phase, 'FAILED');

// После markDirtyScene('audio')
assert.equal(assetState.audio, 'DIRTY');
assert.equal(audioOrchState, null);  // удалён

// После setSceneGenerating('audio') при DONE
assert.equal(result.skipped, true);
assert.equal(assetState.audio, 'READY');  // не изменился
assert.equal(audioOrchState.phase, 'DONE');  // не тронут
```

### Тестовые сценарии

1. Штатная генерация: PLACEHOLDER_READY → ... → DONE + READY
2. Watchdog: WAITING_CHUNKS → FAILED → PENDING
3. Re-dispatch: FAILED → GENERATING → ... → DONE
4. Regenerate: DONE → deleteState → DIRTY → PENDING → ... → DONE
5. Stale recovery (WAITING_CHUNKS): → deleteState → PLACEHOLDER_READY → ... → DONE
6. Stale recovery (DONE): guard → return already_done (без deleteState!)
7. CompleteStage version gate fail: → DIRTY (не READY)

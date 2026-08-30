# Gap Analysis: "Animastor: Near Horizons" vs Current Code

> Companion to the vision document [`../Animastor_Близкие_горизонты.md`](../Animastor_Близкие_горизонты.md).
> Task: compare each vision section with actual code and show what already
> works, what's partial, and what hasn't started. Language — Russian (vision text
> was not translated).
>
> Snapshot date: August 18, 2026.

## Status Legend

| Status | Meaning |
|---|---|
| ✅ | Implemented and working (in production) |
| 🔶 | Partial: foundation exists, key detail missing |
| ⛔ | Not started / missing |

---

## 1. Summary Table by Document Sections

| § | Идея | Статус | Где в коде / комментарий |
|---|---|---|---|
| 1 | Cloud = control plane, Worker = вычислитель | ✅ | `backend/` (оркестрация) + `gpu-hub/` (диспетчер) + `worker/` (исполнители) |
| 2 | Горизонт 1: Cloud + собственные GPU пользователей | ✅ | `gpu-hub/gpu-hub.js`, `worker/worker/worker.cjs`, `worker/start-worker.sh` (image/audio/video), прод: GPU-инстанс E2E (L40S, LTX 2.3) |
| 3 | Горизонт 2: полностью локальный Animastor | ⛔ | Нет локальной сборки; всё работает как cloud + удалённые воркеры |
| 4 | Единая архитектура Worker, capabilities | 🔶 | Beacon передаёт `id/type/gpu/vram/version/image_tag/protocol_version`; **списка моделей нет** → маршрутизация только по `type` |
| 5 | Heartbeat, исходящее соединение, jobs/progress/result | ✅ | Worker сам ходит на `HUB_URL` (outbound, без входящих портов); beacon 10 с; heartbeat-refresh 15 с (TTL 30 с); `animastor:queue:*`, `running`, `processing`, result/error-keys с ретраями. **Per-worker токенов нет** — только опциональный `GPU_HUB_API_KEY` |
| 6 | Bring Your Own Model | 🔶 | Воркер выполняет произвольные ComfyUI-воркфлоу — модели «приносит» машина (LTX 2.3, qwen-tts, qwen-image и т.д.). Но **выбора воркера по моделям нет** |
| 7 | Community Compute («торрент-модель» GPU) | ⛔ | Отсутствует полностью |
| 8 | Модель contribution (GPU-hours, уровни) | ⛔ | Отсутствует |
| 9 | Безопасность community workers (sandbox) | ⛔ | Воркеры доверенные (командные); изоляции для чужих машин нет |
| 10 | Автоочистка данных + GC | 🔶 | Hub чистит Redis-состояние (running/processing/dedup, timeouts, `queue/clear`), но **файлы на воркере остаются** (`ComfyUI/input`, `output`); TTL-GC временных job-директорий нет |
| 11 | Community flywheel | ⛔ | Не применимо до §7 |
| 12 | Маркетинговый эффект | ⛔ | Не применимо |
| 13 | Горизонт 3: managed-сервис | ⛔ | Не применимо |
| 14 | Монетизация (Free/BYOG, Community, Managed) | ⛔ | Коммерческой модели нет |
| 15 | Что заложить уже сейчас | ✅ | Принцип соблюдён: worker независим от места запуска, протокол версионируется, dispatch-lease + re-dispatch |
| 16 | Главный стратегический принцип | 🔶 | Архитектурно фундамент стоит (оркестрация над разнородными inference-системами), но model-aware выбора ресурсов ещё нет |
| 17 | Приоритет (9 пунктов) | 🔶 | Пункты 1–4 (частично 6) реализованы; 5, 7–9 — нет (см. ниже) |

---

## 2. What's Already Implemented — Details with Paths

### §1, §2, §5 — контрольная плоскость отделена от вычислений ✅

Реальная схема проде (документ рисовал её как цель):

```text
backend (control plane: оркестрация, очереди, dispatch-lease, re-dispatch)
    ↓ POST /gpu/task (dispatch_id, build_id, book/chapter/scene/stage, timeout_ms)
gpu-hub (тупой транспорт: очереди по типам, dedup, timeout'ы, error-delivery)
    ↓ animastor:queue:{image|audio|video}
worker.cjs (ComfyUI + Node.js) — outbound polling /task/next
```

Ключевые файлы:

- `gpu-hub/gpu-hub.js` — реестр воркеров в Redis (`animastor:gpu-hub:workers`, TTL 15 мин), beacon, очереди, dedup (`animastor:job:{dispatch_id}:{job_id}`), timeouts (per-job + per-GPU), доставка ошибок на backend с ретраями и фолбэком в Redis (`animastor:error:{job_id}`).
- `worker/worker/worker.cjs` — beacon каждые 10 с, поллинг задач, загрузка ассетов в `ComfyUI/input`, запуск воркфлоу, ожидание результата (per-job `timeout_ms` с fallback 10 мин / 2 ч для видео), OOM-safe чтение результата с диска, отправка результата/ошибки.
- `backend/src/runtime/` — `gpu-dispatcher.js` (POST `/task`), `dispatch-engine.js` (lease, re-dispatch), `reconciliation-engine.js` (watchdog), `worker-health.js`, `job-schema.js` (единый контракт job_id, `PROTOCOL_VERSION = 2`).
- `backend/src/routes/generation-routes.cjs` — `/api/v1/worker/heartbeat`, `/status`, `/counts` (панель воркеров).
- `backend/src/routes/book/generation-routes.cjs` — `/cancel-worker` (per task/type, чистка lease и hub-очередей).

### §4 — capabilities: фундамент есть, моделей нет 🔶

Воркер заявляет о себе так (уже близко к схеме из документа):

```text
id, type (image|audio|video), gpu (имя), vram, version, image_tag, protocol_version
```

Hub проверяет `worker_type_mismatch` и `protocol_version_mismatch`. Но в документе
capabilities богаче: **модели по типам + cpu/ram/status**. Этого нет → сервер не
может выбрать воркера «у которого есть LTX 2.3».

### §6 — BYOM: де-факто есть, де-юре нет 🔶

Задача приходит как полный ComfyUI-воркфлоу (`task.params`), а модели лежат на
машине воркера (`~/ComfyUI/models`: LTX 2.3 GGUF, gemma-3, qwen-tts, qwen-image).
То есть «принеси свою модель» уже работает на уровне железа, но система не знает
о моделях воркера и не может маршрутизировать по ним. Плюс отсутствует UI
«Connect your GPU» — подключить свой GPU может только технически грамотный
пользователь через скрипты.

### §10 — очистка: половина сделана 🔶

Сделано: hub чистит всё Redis-состояние — `running`, `processing`, dedup-ключи,
result/error-ключи по TTL (1 ч), `/queue/clear` (полный или по book/dispatch).
Не сделано: **на стороне воркера** входные картинки и выходные файлы остаются в
`ComfyUI/input` и `ComfyUI/output`; GC «временная job-директория старше TTL
удаляется» отсутствует.

---

## 3. Gaps — What's Needed to Approach the Vision

По приоритету самого документа (§17):

| # | Пункт приоритета | Статус | Что нужно |
|---|---|---|---|
| 1 | Стабильный Cloud + Worker protocol | ✅ | — |
| 2 | Независимые workers с capabilities | 🔶 | Расширить beacon: `models` (по типам), `cpu/ram`; хранить в реестре hub |
| 3 | Heartbeat / registration / jobs / progress / result | ✅ | — |
| 4 | Локальный worker пользователя | ✅ | (нужен только UX-онбординг «Connect your GPU») |
| 5 | Выбор worker по capability/model | ⛔ | Маршрутизация в backend/hub по моделям, а не только по `type` |
| 6 | Безопасная temp-область + автоочистка | 🔶 | Удаление входных/выходных файлов job на воркере + TTL-GC; (для чужих машин — sandbox, см. §9) |
| 7 | Community compute | ⛔ | После §2-фундамента; требует per-worker токенов (§5) и изоляции (§9) |
| 8 | Полностью локальная сборка | ⛔ | Та же архитектура, control plane локально |
| 9 | Managed services и монетизация | ⛔ | После community |

Дополнительно из документа:

- **Per-worker токены** (§5): сейчас auth — опциональный общий `GPU_HUB_API_KEY`
  только на `/task*`; beacon открыт. Без индивидуальных токенов community compute
  невозможен.
- **Sandbox/изоляция** (§9): воркеры доверенные; «пользователь даёт вычислитель,
  а не доступ к машине» не реализовано и не требуется, пока воркеры только
  командные.

---

## 4. Conclusions and Recommendations

**Первый горизонт документа — это не план, а уже работающая архитектура.**
Фундамент, который документ просит «заложить сейчас» (§15, §17), заложен:
контрольная плоскость отделена, воркер независим от места запуска, протокол
версионируется, dispatch/lease/re-dispatch работают.

Три шага, дающие максимум приближения к видению при минимуме усилий:

1. **Capabilities + model-aware роутинг** (§4, §6, §17.2/17.5) — расширить beacon
   списком моделей, выбирать воркера по модели. Это превращает «BYOM де-факто»
   в «BYOM де-юре» и открывает §2-модель «у кого какое железо».
2. **Очистка на стороне воркера** (§10) — дёшево, закрывает накопление мусора на
   чужих машинах уже сегодня.
3. **Per-worker токены** (§5) — обязательный фундамент перед любым community
   compute; без них §7–§9 нереализуемы.

Community compute и полностью локальная сборка — следующие горизонты, их не
стоит начинать, пока не появился хотя бы один внешний (недоверенный) воркер.

---

## 5. Related Files

- Видение: `docs/Animastor_Близкие_горизонты.md`
- Архитектура: `ARCHITECTURE.md` (корень репо), `docs/01-overview/SYSTEM_MAP.md`
- Код: `gpu-hub/gpu-hub.js`, `worker/worker/worker.cjs`, `backend/src/runtime/{gpu-dispatcher,dispatch-engine,reconciliation-engine,worker-health,job-schema}.js`
- Заметки с GPU-инстанса: `worker/new/SYSTEM.md`, `worker/new/MEMORY.md`

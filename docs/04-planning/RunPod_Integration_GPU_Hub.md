# RunPod Integration --- GPU Hub

> Planning document. Not a current implementation task.
>
> Goal: prepare for future integration of Animastor GPU Hub with the new RunPod
> REST API v2 and MCP, without tying RunPod directly to the core backend.

## 1. Concept

RunPod is considered as one of the external GPU infrastructure providers.

In Animastor, the integration point should be the **GPU Hub**, not the main backend.

Target architecture:

``` text
Animastor Backend
       │
       │ jobs / orchestration
       ▼
   GPU Hub
       │
       │ infrastructure management
       ▼
 Provider Adapter
       │
       ├── RunPod REST API v2
       ├── RunPod MCP (для agent-assisted operations)
       └── в будущем другие GPU providers
       │
       ▼
 RunPod Pods / Serverless / Workers
```

Backend продолжает отвечать за генерационную логику и orchestration
задач.

GPU Hub отвечает за физическую инфраструктуру worker'ов: - обнаружение
worker'ов; - состояние worker'ов; - provisioning; - lifecycle; -
health; - подключение/отключение GPU; - передачу задач worker'ам; -
реакцию на отказ инфраструктуры.

## 2. Why Not Integrate RunPod Directly into Backend

This is a fundamental architectural decision.

Backend should not know: which RunPod API is used; which datacenter the GPU is in;
which Pod was created; how provisioning works; how capacity is checked;
how the worker is started; how the Pod is deleted.

Backend should tell GPU Hub at approximately this level:

``` text
Мне нужен worker типа video/image/audio
с такими требованиями.
```

GPU Hub уже решает, где и как получить вычислительный ресурс.

Так мы сохраняем независимость core backend от конкретного
GPU-провайдера.

## 3. What to Use from RunPod

Основной будущий интерфейс:

**RunPod REST API v2**

Он является главным программным API для интеграции.

Дополнительный интерфейс:

**RunPod MCP Server**

MCP особенно интересен для agent-assisted infrastructure management: -
изучение возможностей RunPod агентом; - диагностика; - discovery; -
операции, которые удобно выполнять через AI agent; - помощь
разработчику/оператору при работе с инфраструктурой.

MCP не должен автоматически становиться runtime-зависимостью GPU Hub.

Для production runtime предпочтителен явный REST API v2 через
собственный adapter.

## 4. Where the Agent Should Learn About RunPod

Перед началом реализации агент должен прочитать официальные источники
RunPod.

### Обязательные источники

1.  **RunPod REST API v2 specification**

    `https://api.runpod.io/v2`

    Использовать как основной источник истины по endpoint'ам, схемам
    запросов/ответов и доступным операциям.

2.  **RunPod REST API v2 migration guide**

    Использовать для понимания:

    -   структуры v2;
    -   breaking changes;
    -   соответствий старых API;
    -   новых возможностей.

3.  **RunPod MCP documentation**

    Изучить MCP отдельно от REST API:

    -   какие tools доступны;
    -   какие операции read-only;
    -   какие операции изменяют инфраструктуру;
    -   какие операции destructive;
    -   какие данные MCP предоставляет агенту.

4.  **RunPod API / infrastructure documentation**

    Дополнительно изучить:

    -   Pods;
    -   Serverless;
    -   GPU availability;
    -   datacenters;
    -   runtime metrics;
    -   worker health;
    -   templates/images;
    -   storage;
    -   pricing/usage.

### Правило для агента

Не угадывать API RunPod по памяти.

Перед реализацией: 1. открыть актуальную v2 specification; 2. открыть
migration guide; 3. проверить нужные endpoint'ы; 4. сверить
request/response schemas; 5. только после этого писать adapter.

## 5. RunPod Timelines and Constraints

На момент создания документа RunPod объявил:

-   REST API v1 прекращает обслуживание **15 ноября 2026**;
-   GraphQL должен быть отключён в **начале 2027 года**;
-   начиная с **17 сентября 2026** для старых API вводятся rate limits;
-   в ноябре 2026 ожидаются короткие brown-out проверки REST v1.

Поэтому новую интеграцию строить сразу на **REST API v2**.

Не закладывать новый код на v1 или GraphQL.

## 6. What's Particularly Useful for GPU Hub

### 6.1 GPU availability

GPU Hub сможет перед provisioning узнать: - какие GPU доступны; - в
каких datacenter; - где есть capacity; - какие варианты подходят под
требования worker'а.

Это позволит перейти от:

``` text
попробовали создать Pod → не получилось → повторили
```

к:

``` text
discovery → выбор подходящего ресурса → provisioning
```

### 6.2 Datacenter selection

GPU Hub потенциально сможет выбирать datacenter по политике:

``` text
GPU requirements
      ↓
available datacenters
      ↓
capacity
      ↓
cost
      ↓
latency / geography
      ↓
selected provider resource
```

Конкретная политика будет определена позднее.

### 6.3 Runtime visibility

RunPod v2 предоставляет больше информации о runtime Pod'ов и Serverless
worker'ов.

Это можно использовать как дополнительный источник истины для GPU Hub.

Важно:

**RunPod health не должен автоматически заменять наш собственный worker
heartbeat.**

У Animastor должен оставаться собственный application-level health
protocol.

То есть:

``` text
RunPod says: Pod alive
+
Animastor says: Worker alive and responding
=
worker considered healthy
```

### 6.4 Worker-level health

RunPod предоставляет более подробную visibility по Serverless workers.

Это может позволить GPU Hub различать:

``` text
GPU resource alive
Pod alive
worker process alive
worker actually serving Animastor
```

Это значительно лучше простого SSH-пинга.

## 7. Future Provider Adapter

Не помещать RunPod API непосредственно в `gpu-hub.js`.

Предполагаемая архитектура:

``` text
gpu-hub/
    providers/
        runpod/
            client.js
            pods.js
            serverless.js
            availability.js
            health.js
            README.md
        ...
    provider-manager.js
```

Названия файлов предварительные.

Главная идея --- изолировать provider-specific API.

Например:

``` js
provider.findCapacity(requirements)
provider.createWorker(spec)
provider.getWorkerStatus(id)
provider.stopWorker(id)
provider.deleteWorker(id)
provider.getMetrics(id)
```

GPU Hub работает с абстракцией.

RunPod adapter переводит эту абстракцию в REST API v2.

## 8. RunPod Pod vs Serverless

До реализации отдельно исследовать два режима.

### Pods

Подходят, если нам нужен: - долгоживущий worker; - полный контроль
окружения; - постоянное подключение GPU Hub; - собственный worker
process; - предсказуемый lifecycle.

### Serverless

Исследовать для: - burst workloads; - коротких задач; - автоматического
scaling; - worker pools; - ситуаций, где постоянный Pod невыгоден.

Не принимать решение заранее.

Для каждого типа генерации отдельно сравнить:

``` text
Audio
Image
Video / LTX
```

по: - startup time; - cold start; - стоимости; - доступности GPU; -
времени генерации; - persistence; - возможности использовать
существующие Animastor workers.

## 9. Our Own Worker Contract Remains Primary

RunPod не должен диктовать внутренний протокол Animastor worker'а.

Сейчас GPU Hub уже имеет собственный protocol/version mechanism, worker
registry и heartbeat.

Будущая интеграция должна выглядеть так:

``` text
RunPod
  ↓
Pod
  ↓
Animastor Worker
  ↓
GPU Hub protocol
```

А не:

``` text
Animastor Backend
  ↓
RunPod-specific worker protocol
```

Это сохраняет переносимость.

## 10. Future Worker Lifecycle

Целевой сценарий:

``` text
1. Backend / system requests worker
2. GPU Hub evaluates requirements
3. GPU Hub checks provider capacity
4. GPU Hub selects provider resource
5. RunPod adapter provisions resource
6. Worker starts
7. Worker registers with GPU Hub
8. Worker passes health checks
9. GPU Hub marks worker READY
10. Backend can dispatch jobs
```

При остановке:

``` text
worker becomes IDLE
        ↓
idle policy
        ↓
stop / suspend / destroy
        ↓
provider resource released
```

Политика idle timeout будет определена отдельно.

## 11. Recovery

Очень важно не смешивать:

### Infrastructure recovery

Решает GPU Hub:

``` text
Pod dead
worker unreachable
provider capacity failure
network failure
```

### Job recovery

Решает Backend:

``` text
job failed
retry
re-dispatch
build consistency
result deduplication
```

Текущая архитектура уже придерживается этой границы.

Будущая RunPod-интеграция не должна ломать её.

## 12. Redis and RunPod

Redis остаётся внутренним state/coordination layer GPU Hub.

RunPod является внешним infrastructure provider.

Не делать Redis зависимым от RunPod API.

Пример:

``` text
Redis:
  worker registry
  heartbeats
  queues
  provider resource mapping
  lifecycle state
```

Дополнительно можно хранить mapping:

``` text
Animastor worker ID
        ↕
RunPod Pod ID
        ↕
RunPod datacenter
        ↕
GPU type
```

Но provider-specific metadata должна быть изолирована.

## 13. Security

API credentials RunPod не должны попадать: - в frontend; - в worker
request; - в git; - в обычные логи; - в job payload.

Они должны находиться в server-side environment/secrets.

Для будущего adapter предусмотреть: - API key; - отдельный provider
credential; - минимально необходимые permissions; - безопасное
логирование; - отсутствие secret values в error messages.

## 14. MCP и coding agents

MCP особенно полезен на этапе разработки и эксплуатации.

Например, агент сможет исследовать:

``` text
Какие GPU доступны?
Какие Pods сейчас работают?
Почему Pod не стартует?
Какие datacenters имеют capacity?
Какие worker resources сейчас существуют?
```

Но destructive operations должны выполняться осторожно.

Правило:

> Сначала read-only discovery → затем анализ → затем явно определённая
> write operation.

Не давать coding agent'у без необходимости возможность самостоятельно
уничтожать production resources.

## 15. Этапы работы

### Phase 0 --- Research

Изучить: - REST API v2; - migration guide; - MCP; - Pods; -
Serverless; - availability; - datacenters; - metrics; - pricing; -
lifecycle.

Результат: отдельная техническая заметка с актуальными endpoint'ами.

### Phase 1 --- GPU Hub Provider Interface

Не подключая RunPod, определить абстракцию provider:

``` text
capacity
provision
status
health
stop
destroy
metrics
```

### Phase 2 --- RunPod Adapter

Реализовать adapter исключительно через REST API v2.

### Phase 3 --- Discovery

Добавить:

``` text
GPU requirements
        ↓
RunPod availability
        ↓
candidate resources
        ↓
selection
```

### Phase 4 --- Provisioning

Автоматически: - создать Pod / Serverless resource; - дождаться
готовности; - запустить Animastor worker; - дождаться beacon; -
перевести worker в READY.

### Phase 5 --- Lifecycle

Добавить: - idle detection; - stop; - restart; - destroy; - recovery.

### Phase 6 --- Observability

Связать: - RunPod runtime metrics; - GPU Hub heartbeat; - worker
status; - job status.

### Phase 7 --- Optimization

После рабочего варианта добавить: - cost-aware selection; - datacenter
selection; - GPU preference; - capacity-aware scheduling; - разные
политики для Audio/Image/Video.

## 16. Что НЕ делать сейчас

Пока не требуется:

-   мигрировать существующий код на RunPod;
-   менять backend orchestration;
-   переписывать GPU worker protocol;
-   добавлять RunPod credentials;
-   делать provisioning;
-   внедрять Serverless;
-   подключать MCP в production;
-   усложнять текущий GPU Hub.

Сначала закончить текущую архитектуру и подготовить provider
abstraction.

## 17. Критерий готовности будущей интеграции

Интеграция считается архитектурно успешной, если Animastor сможет
сказать:

``` text
Мне нужен worker:
  type = video
  GPU = suitable for LTX
  VRAM >= X
  policy = cheapest/fastest/nearest
```

а GPU Hub самостоятельно:

``` text
1. ищет capacity;
2. выбирает resource;
3. создаёт resource;
4. запускает worker;
5. ждёт регистрацию;
6. проверяет health;
7. отдаёт worker в обычный Animastor workflow.
```

При этом Backend не знает, был worker создан: - вручную; - на RunPod; -
на другом cloud provider; - на собственной GPU-машине.

## 18. Архитектурный принцип

> **RunPod --- provider. GPU Hub --- infrastructure orchestrator.
> Backend --- application/job orchestrator. Worker --- execution
> layer.**

Это основное правило будущей интеграции.

------------------------------------------------------------------------

## Источники для будущего исследования

-   RunPod REST API v2: `https://api.runpod.io/v2`
-   RunPod REST API v2 migration guide --- официальный migration guide
    RunPod
-   RunPod MCP Server --- официальная документация RunPod
-   RunPod API / Pods / Serverless / GPU availability documentation

## Связь с текущим Animastor

Текущий GPU Hub уже находится в:

``` text
gpu-hub/
```

и содержит: - worker registry; - Redis-backed state; - heartbeat; - task
queues; - protocol version; - timeout handling; - error delivery обратно
в backend.

Будущая RunPod-интеграция должна развивать этот слой, а не обходить его.

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
       ├── RunPod MCP (for agent-assisted operations)
       └── future other GPU providers
       │
       ▼
 RunPod Pods / Serverless / Workers
```

Backend continues to handle generation logic and task orchestration.

GPU Hub handles physical worker infrastructure: - worker
discovery; - worker state; - provisioning; - lifecycle; -
health; - GPU connection/disconnection; - task delivery to workers; -
infrastructure failure response.

## 2. Why Not Integrate RunPod Directly into Backend

This is a fundamental architectural decision.

Backend should not know: which RunPod API is used; which datacenter the GPU is in;
which Pod was created; how provisioning works; how capacity is checked;
how the worker is started; how the Pod is deleted.

Backend should tell GPU Hub at approximately this level:

``` text
I need a worker of type video/image/audio
with these requirements.
```

GPU Hub already decides where and how to get compute resources.

This preserves core backend independence from specific
GPU providers.

## 3. What to Use from RunPod

Primary future interface:

**RunPod REST API v2**

This is the main software API for integration.

Additional interface:

**RunPod MCP Server**

MCP is particularly interesting for agent-assisted infrastructure management: -
exploring RunPod capabilities via agent; - diagnostics; - discovery; -
operations convenient to perform through AI agent; - assisting
developer/operator with infrastructure work.

MCP should not automatically become GPU Hub runtime dependency.

For production runtime, explicit REST API v2 via
custom adapter preferred.

## 4. Where the Agent Should Learn About RunPod

Before starting implementation, the agent should read the official RunPod sources.

### Required sources

1.  **RunPod REST API v2 specification**

    `https://api.runpod.io/v2`

    Use as primary source of truth for endpoints, request/response
    schemas, and available operations.

2.  **RunPod REST API v2 migration guide**

    Use for understanding:

    -   v2 structure;
    -   breaking changes;
    -   legacy API mappings;
    -   new capabilities.

3.  **RunPod MCP documentation**

    Study MCP separately from REST API:

    -   available tools;
    -   read-only operations;
    -   infrastructure-changing operations;
    -   destructive operations;
    -   data MCP provides to agent.

4.  **RunPod API / infrastructure documentation**

    Additional study:

    -   Pods;
    -   Serverless;
    -   GPU availability;
    -   datacenters;
    -   runtime metrics;
    -   worker health;
    -   templates/images;
    -   storage;
    -   pricing/usage.

### Agent rule

Don't guess RunPod API from memory.

Before implementation: 1. open current v2 specification; 2. open
migration guide; 3. check needed endpoints; 4. verify
request/response schemas; 5. only then write adapter.

## 5. RunPod Timelines and Constraints

At document creation time RunPod announced:

-   REST API v1 sunset **November 15, 2026**;
-   GraphQL to be disabled in **early 2027**;
-   starting **September 17, 2026** rate limits introduced for legacy APIs;
-   November 2026 expected short brown-out checks for REST v1.

Therefore build new integration directly on **REST API v2**.

Don't introduce new code on v1 or GraphQL.

## 6. What's Particularly Useful for GPU Hub

### 6.1 GPU availability

GPU Hub can before provisioning discover: - which GPUs available; - in
which datacenters; - where capacity exists; - which options match
worker requirements.

This enables transition from:

``` text
tried to create Pod → failed → retried
```

to:

``` text
discovery → select suitable resource → provisioning
```

### 6.2 Datacenter selection

GPU Hub can potentially select datacenter by policy:

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

Specific policy to be defined later.

### 6.3 Runtime visibility

RunPod v2 provides more information about Pod and Serverless
worker runtime.

This can serve as additional source of truth for GPU Hub.

Important:

**RunPod health must not automatically replace our own worker
heartbeat.**

Animastor must maintain its own application-level health
protocol.

That is:

``` text
RunPod says: Pod alive
+
Animastor says: Worker alive and responding
=
worker considered healthy
```

### 6.4 Worker-level health

RunPod provides more detailed visibility into Serverless workers.

This may allow GPU Hub to distinguish:

``` text
GPU resource alive
Pod alive
worker process alive
worker actually serving Animastor
```

This is significantly better than simple SSH pinging.

## 7. Future Provider Adapter

Do not place RunPod API directly in `gpu-hub.js`.

Proposed architecture:

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

File names are preliminary.

The main idea is to isolate provider-specific API.

Example:

``` js
provider.findCapacity(requirements)
provider.createWorker(spec)
provider.getWorkerStatus(id)
provider.stopWorker(id)
provider.deleteWorker(id)
provider.getMetrics(id)
```

GPU Hub works with the abstraction.

RunPod adapter translates this abstraction to REST API v2.

## 8. RunPod Pod vs Serverless

Before implementation, research both modes separately.

### Pods

Suitable when we need: - long-lived worker; - full environment
control; - persistent GPU Hub connection; - own worker
process; - predictable lifecycle.

### Serverless

Research for: - burst workloads; - short tasks; - automatic
scaling; - worker pools; - situations where a persistent Pod is not cost-effective.

Do not decide in advance.

Compare separately for each generation type:

``` text
Audio
Image
Video / LTX
```

by: - startup time; - cold start; - cost; - GPU availability; -
generation time; - persistence; - ability to use
existing Animastor workers.

## 9. Our Own Worker Contract Remains Primary

RunPod must not dictate Animastor's internal worker protocol.

Currently GPU Hub already has its own protocol/version mechanism, worker
registry and heartbeat.

Future integration should look like this:

``` text
RunPod
  ↓
Pod
  ↓
Animastor Worker
  ↓
GPU Hub protocol
```

Not:

``` text
Animastor Backend
  ↓
RunPod-specific worker protocol
```

This preserves portability.

## 10. Future Worker Lifecycle

Target scenario:

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

On shutdown:

``` text
worker becomes IDLE
        ↓
idle policy
        ↓
stop / suspend / destroy
        ↓
provider resource released
```

Idle timeout policy will be defined separately.

## 11. Recovery

It is very important not to mix:

### Infrastructure recovery

Handled by GPU Hub:

``` text
Pod dead
worker unreachable
provider capacity failure
network failure
```

### Job recovery

Handled by Backend:

``` text
job failed
retry
re-dispatch
build consistency
result deduplication
```

The current architecture already adheres to this boundary.

The future RunPod integration must not break it.

## 12. Redis and RunPod

Redis remains the internal state/coordination layer of GPU Hub.

RunPod is an external infrastructure provider.

Do not make Redis dependent on the RunPod API.

Example:

``` text
Redis:
  worker registry
  heartbeats
  queues
  provider resource mapping
  lifecycle state
```

Additionally, a mapping can be stored:

``` text
Animastor worker ID
        ↕
RunPod Pod ID
        ↕
RunPod datacenter
        ↕
GPU type
```

But provider-specific metadata must be isolated.

## 13. Security

RunPod API credentials must not end up: - in the frontend; - in worker
requests; - in git; - in regular logs; - in job payloads.

They must reside in server-side environment/secrets.

For the future adapter, account for: - API key; - separate provider
credential; - minimal required permissions; - safe
logging; - no secret values in error messages.

## 14. MCP and coding agents

MCP is especially useful during development and operations.

For example, the agent could explore:

``` text
What GPUs are available?
What Pods are currently running?
Why is a Pod not starting?
What datacenters have capacity?
What worker resources exist currently?
```

But destructive operations must be performed carefully.

Rule:

> First read-only discovery → then analysis → then explicitly defined
> write operation.

Do not give the coding agent the ability to independently
destroy production resources unless necessary.

## 15. Work phases

### Phase 0 --- Research

Study: - REST API v2; - migration guide; - MCP; - Pods; -
Serverless; - availability; - datacenters; - metrics; - pricing; -
lifecycle.

Result: a separate technical note with current endpoints.

### Phase 1 --- GPU Hub Provider Interface

Without connecting RunPod, define the provider abstraction:

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

Implement adapter exclusively via REST API v2.

### Phase 3 --- Discovery

Add:

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

Automatically: - create Pod / Serverless resource; - wait for
readiness; - start Animastor worker; - wait for beacon; -
transition worker to READY.

### Phase 5 --- Lifecycle

Add: - idle detection; - stop; - restart; - destroy; - recovery.

### Phase 6 --- Observability

Connect: - RunPod runtime metrics; - GPU Hub heartbeat; - worker
status; - job status.

### Phase 7 --- Optimization

After working variant, add: - cost-aware selection; - datacenter
selection; - GPU preference; - capacity-aware scheduling; - different
policies for Audio/Image/Video.

## 16. What NOT to do now

Not yet required:

-   migrate existing code to RunPod;
-   change backend orchestration;
-   rewrite GPU worker protocol;
-   add RunPod credentials;
-   do provisioning;
-   implement Serverless;
-   connect MCP in production;
-   complicate the current GPU Hub.

First finish the current architecture and prepare the provider
abstraction.

## 17. Integration readiness criteria

The integration is considered architecturally successful if Animastor can
say:

``` text
I need a worker:
  type = video
  GPU = suitable for LTX
  VRAM >= X
  policy = cheapest/fastest/nearest
```

and GPU Hub independently:

``` text
1. finds capacity;
2. selects resource;
3. creates resource;
4. starts worker;
5. waits for registration;
6. checks health;
7. serves worker into normal Animastor workflow.
```

Meanwhile Backend does not know whether the worker was created: - manually; - on RunPod; -
on another cloud provider; - on a dedicated GPU machine.

## 18. Architectural principle

> **RunPod — provider. GPU Hub — infrastructure orchestrator.
> Backend — application/job orchestrator. Worker — execution
> layer.**

This is the core rule of future integration.

------------------------------------------------------------------------

## Sources for future research

-   RunPod REST API v2: `https://api.runpod.io/v2`
-   RunPod REST API v2 migration guide — official RunPod migration guide
-   RunPod MCP Server — official RunPod documentation
-   RunPod API / Pods / Serverless / GPU availability documentation

## Connection to current Animastor

The current GPU Hub is already located in:

``` text
gpu-hub/
```

and contains: - worker registry; - Redis-backed state; - heartbeat; - task
queues; - protocol version; - timeout handling; - error delivery back
to backend.

The future RunPod integration should develop this layer, not bypass it.

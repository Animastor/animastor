# Animastor Near Horizons

## 1. General Idea

Animastor can develop not only as a cloud service but as a distributed system where the cloud portion handles project management and queues, while computation is performed by independent workers.

The key principle:

> **Animastor Cloud — orchestration/control plane. Worker — compute executor.**

Workers can be located anywhere:
- on the user's computer;
- on a home server;
- on a personal VPS;
- on RunPod or another GPU service;
- on Animastor infrastructure.

This enables a gradual transition from a fully cloud product to hybrid and fully local models without fundamental architecture changes.

---

## 2. First Horizon — Animastor Cloud + Personal Workers

A user logs into Animastor Cloud and can connect their own compute resources.

For example:

```text
Animastor Cloud
    │
    ├── Audio Worker → user's computer
    ├── Image Worker → user's computer
    ├── Video Worker → RunPod
    └── LLM Worker → local computer / server
```

The user chooses which resources to run locally and which to get from the cloud.

### Examples

**Powerful home computer:**
- Audio — local;
- Image — local;
- Video — cloud GPU;
- LLM — local.

**Mid-range computer:**
- Audio — local;
- Image — cloud;
- Video — cloud;
- LLM — local or cloud.

**Low-end computer:**
- everything through cloud workers.

This way, Animastor does not impose a single usage model.

---

## 3. Second Horizon — Fully Local Animastor

The next option is the user installs Animastor entirely on their own computer or server.

```text
Animastor Local
    │
    ├── DB
    ├── API
    ├── UI
    └── Workers
         ├── Audio
         ├── Image
         ├── Video
         └── LLM
```

If needed, individual workers can remain external:

```text
Animastor Local
    │
    ├── Audio → local
    ├── Image → local
    ├── LLM → local
    └── Video → external GPU
```

The local version should not be a separate concept.

Ideally, it is the same Animastor architecture, with the control plane also running locally.

---

## 4. Unified Worker Architecture

Workers should be considered as independent compute agents from the start.

Upon connection, a worker reports its capabilities to the server.

Conceptual description example:

```text
worker_id
version

capabilities:
  audio:
    models:
      - ...
  image:
    models:
      - ...
  video:
    models:
      - ...
  llm:
    models:
      - ...

hardware:
  gpu
  vram
  cpu
  ram

status:
  idle
  busy
  offline
```

Animastor should not need to know where a worker is physically located.

The server assigns a task:

```text
video_generation
model = LTX
```

and searches for a worker capable of executing it.

---

## 5. Heartbeat and Connection

Workers should establish an outgoing secure connection to Animastor Cloud independently.

Preferred model:

```text
Worker ───── outbound connection ─────> Animastor Cloud
                                          │
                                          │ jobs
                                          ▼
                                        Worker
```

The user does not need to open incoming ports on their computer.

Upon registration, a worker receives a token and then:
- sends heartbeats;
- reports capabilities;
- receives jobs;
- sends progress;
- delivers results;
- reports status.

---

## 6. Bring Your Own Model

One of Animastor's potentially strongest features:

> Users can bring not only their own GPU but also their own models.

For example:

```text
Audio Worker
    ├── Qwen TTS
    ├── F5-TTS
    └── other models

Image Worker
    ├── ComfyUI
    ├── Flux
    └── other models

Video Worker
    └── LTX

LLM Worker
    ├── Qwen
    ├── DeepSeek
    └── local models
```

In this case, Animastor acts as an orchestration layer over diverse inference systems.

---

## 7. Community Compute — "Torrent Model" for GPU

A separate potentially powerful idea is voluntary compute time sharing.

A user can enable:

> **Share my GPU**

and allow other users to use their worker for a specified time period.

For example:

```text
User A
RTX 3060 / 12 GB
Share GPU → 2 hours
```

During this time, the worker executes community jobs.

Afterward, the user can themselves use shared compute from other participants.

This is reminiscent of the torrent model, except instead of file sharing, compute time is exchanged.

---

## 8. Possible Contribution Model

User contributions can be tracked:

```text
You shared:        10 GPU-hours
Received from network:  7 GPU-hours
Balance:           +3 GPU-hours
```

Strict financial exchange is not required.

A softer community contribution model is possible:

- Contributor;
- Community Worker;
- Community Host;
- other levels.

Statistics can be displayed:

> You contributed 37 GPU-hours to Animastor Community.

This creates a sense of real contribution to shared infrastructure.

---

## 9. Community Worker Security

Community workers should be as restricted as possible.

The core principle:

> The user provides a compute resource, not access to their entire computer.

Sandbox/containers and minimal privileges are preferred.

Workers should only have access to:
- their working directory;
- GPU;
- required inference processes;
- required network.

Workers should NOT have access to:
- the user's home directory;
- user documents;
- SSH keys;
- arbitrary system commands;
- other computer data.

---

## 10. Automatic Data Cleanup

Community workers should be effectively stateless with respect to user content.

Job lifecycle:

```text
JOB
 ↓
download inputs
 ↓
generate
 ↓
upload result
 ↓
verify upload
 ↓
delete temporary data
 ↓
```

After completion, the following must be deleted:
- source images;
- reference images;
- intermediate images;
- temporary audio/video;
- temporary files;
- the specific job's working directory.

A garbage collector is also needed.

For example:

> Any temporary job directory older than a given TTL is automatically deleted.

This protects the user from accumulating junk even after a crash or unexpected worker shutdown.

---

## 11. Potential Community Flywheel

The distributed model can create a network effect:

```text
                 Animastor
                    │
           ┌────────┴────────┐
           │                 │
       Cloud GPU        Community GPU
           │                 │
           └────────┬────────┘
                    │
                  Users
                    │
           ┌────────┴────────┐
           │                 │
       contribute         consume
           │                 │
           └────────┬─────────┘
                    │
              more workers
                    │
              more capacity
                    │
               more users
```

The more users participate, the more potential community compute capacity.

---

## 12. Potential Marketing Effect

The free distributed model can potentially become a source of organic promotion.

Possible topics for YouTube and community:

- "How to use Animastor for free"
- "How to connect your GPU to Animastor"
- "Animastor on RTX 3060"
- "Animastor + RunPod"
- "How to run LTX through your own GPU"
- "Animastor + local LLM"
- "Animastor + ComfyUI"

A particularly interesting audience could be the ComfyUI / local AI community — people who already know how to work with Docker, CUDA, local models, and GPUs.

In this case, Animastor becomes not just an AI service but a system for building your own visual book AI factory.

---

## 13. Third Horizon — Ready Managed Service

After the BYOG/community model is established, a fully ready option can be offered.

The user configures nothing:

> Pressed Generate — everything worked.

Animastor provides:
- ready workers;
- GPU;
- models;
- API;
- storage;
- automatic configuration;
- monitoring;
- maintenance.

The user pays for convenience.

---

## 14. Possible Monetization

Several models can be roughly distinguished.

### Free / BYOG

The user brings:
- their own GPU;
- their own models;
- their own API;
- their own external GPUs.

Animastor provides orchestration and the product itself.

### Community

The user voluntarily shares compute time and gains access to community compute.

### Managed

Animastor provides ready compute resources.

This is where the primary commercial model appears.

Principle:

> A user who wants to figure things out themselves can use the system essentially for free. A user who wants to "press a button and get a result" pays for convenience and infrastructure.

---

## 15. What to Build Right Now

It is not necessary to implement the entire distributed system in beta.

But the current architecture should not close this path.

The key principle:

> **A worker must be independent of where it runs.**

Today:

```text
Animastor VPS
    ↓
Animastor Audio Worker
```

Tomorrow:

```text
Animastor Cloud
    ↓
User Audio Worker
```

Later:

```text
Animastor Cloud
    ├── Audio → user's PC
    ├── Image → user's PC
    ├── Video → RunPod
    └── LLM → local server
```

And even later:

```text
Animastor Local
    ├── local workers
    └── external workers when needed
```

---

## 16. Key Strategic Principle

Animastor has the potential to become more than just an app for generating visual books.

The broader concept:

> **Animastor — orchestration platform for distributed visual content generation.**

The user can choose:
- their own hardware;
- their own models;
- their own API;
- community compute;
- cloud GPUs;
- Animastor's ready infrastructure;
- any combination of these.

The application itself remains unified.

---

## 17. Priority

During the beta phase, it is not advisable to try to implement everything at once.

Priority:

1. Stable Cloud + Worker protocol.
2. Independent workers with capabilities.
3. Heartbeat / registration / jobs / progress / result.
4. User's local worker.
5. Ability to select worker by capability/model.
6. Secure temporary file area and automatic cleanup.
7. After that — community compute.
8. Then — fully local build.
9. Then — managed services and monetization.

The main task now is **not to build the entire future network, but to build the right foundation on which it can emerge.**

# Project Structure: Animastor

```bash
/home/sureg/animastor/
├── README.md                                    # Project documentation
├── docker-compose.yml                           # Service orchestration (postgres, redis, backend, gpu-hub, nginx)
│                                                 # Redis: persisted via volume redis-data:/data
│                                                 # GPU_TIMEOUT: 10 min
├── build-apk.sh                                 # Android APK build
├── backend-rebuild.sh                           # Backend rebuild
├── front-backend-rebuild.sh                     # Frontend + backend rebuild
├── apk-build.sh                                 # Alternative APK build
├── data/
│   ├── books/                                   # Books on disk (multi-file format v2.2)
│   │   └── <bookId>/
│   │       ├── manifest.json                    #   metadata
│   │       ├── book.json                        #   structure (chapters_order)
│   │       ├── bible.json                       #   bible (country, epoch)
│   │       ├── characters.json                  #   characters
│   │       ├── locations.json                   #   locations (separate from bible)
│   │       ├── voices.json                      #   character voices (separate from bible)
│   │       └── chapters/
│   │           ├── ch-cover.json                #   cover (always first)
│   │           ├── ch-prologue.json             #   prologue (optional)
│   │           ├── ch-00000001.json             #   chapters
│   │           └── ...
│   ├── output/<buildId>/                        # Generated files (MP3, PNG, MP4)
│
├── backend/
│   ├── Dockerfile
│   ├── package.json
│   ├── ai/                                      # AI system configuration
│   │   ├── ai-assistant-profile.md              # AI assistant profile (chat)
│   │   ├── workflows/                           # ComfyUI templates (.json)
│   │   │   └── img-qwen-image, tts-qwen-*, video-ltx-1p..4p
│   │   ├── connectors/                          # Declarative task descriptions
│   │   │   └── conn-*.json
│   │   ├── profiles/                            # Software prompt assembly profiles
│   │   │   └── image/{default,qwen-image}.json
│   │   ├── examples/                            # JSON examples for few-shot
│   │   │   ├── book_example.json
│   │   │   ├── character_example.json
│   │   │   ├── cover_example.json
│   │   │   ├── import_example.json
│   │   │   ├── location_example.json
│   │   │   └── scene_example.json
│   │   ├── rules/                               # Rules (md, SYSTEM_PROMPTS)
│   │   └── skills/                              # Model prompting skills (md)
│   ├── scripts/
│   │   ├── audit-scenes.js                      # Scene duration/coverage audit
│   │   ├── dryrun-visuals-iu.js                 # Visual dry run
│   │   └── import-iu-json.mjs                   # IU JSON import
│   ├── src/
│   │   ├── backend.cjs                          # [ENTRY] Entry point, DI, route mounting
│   │   ├── startup-resume.js                    # Interrupted session recovery
│   │   ├── dependency-graph.js                  # Dependency graph
│   │   ├── config/
│   │   │   └── runtime-config.js                # Centralized configuration
│   │   ├── routes/
│   │   │   ├── book/                            # [DECOMPOSED] Book routes
│   │   │   │   ├── agent-routes.cjs             #   AI agent (bootstrap, next-window, status)
│   │   │   │   ├── chunks-routes.cjs            #   Chunks
│   │   │   │   ├── core-routes.cjs              #   Book CRUD
│   │   │   │   ├── generation-routes.cjs        #   Generation
│   │   │   │   ├── import-routes.cjs            #   Import
│   │   │   │   └── recovery-routes.cjs          #   Recovery
│   │   │   ├── ai-routes.cjs                    # AI chat
│   │   │   ├── auth-routes.cjs                  # Authentication (register/login/logout/me)
│   │   │   ├── worker-routes.cjs                # Private GPU workers (create/list/rotate/revoke)
│   │   │   ├── admin-routes.cjs                 # Admin: system AI kill switch + provider
│   │   │   ├── settings-ai-routes.cjs           # Workspace AI provider (CRUD + test)
│   │   │   ├── config-routes.cjs                # Client limits (image_prompt_max_chars)
│   │   │   ├── generation-routes.cjs            # Generation (shared endpoints)
│   │   │   ├── debug-routes.cjs                 # Debug
│   │   │   ├── connector-routes.cjs             # Connectors
│   │   │   └── workflow-routes.cjs              # Workflow
│   │   ├── services/
│   │   │   ├── agent/                           # [DECOMPOSED] AI pipeline
│   │   │   │   ├── bootstrap.js                 #   First window
│   │   │   │   ├── pipeline-runner.js           #   Pipeline runner
│   │   │   │   ├── pipeline-steps.js            #   Steps 0–5
│   │   │   │   ├── coreference.js               #   Stub (removed from pipeline)
│   │   │   │   ├── ai-caller.js                 #   AI caller with retries
│   │   │   │   ├── text-utils.js                #   Text utilities
│   │   │   │   └── visual-utils.js              #   Visual utilities
│   │   │   ├── agent-service.js                 # [BARREL] Export + window-generator
│   │   │   ├── agent-prompts.js                 # System prompts (all steps)
│   │   │   ├── ai-service.js                    # AI API client
│   │   │   ├── ai-loader.js                     # Knowledge base loader (TTL 1 min)
│   │   │   ├── audio-recovery.cjs               # Audio recovery (per-scene, on-demand)
│   │   │   ├── book-diff.cjs                    # Book diff + dirty scene marking
│   │   │   ├── book-event-log.js                # PG book event log
│   │   │   ├── book-source.js                   # Canonical scene index
│   │   │   ├── book-sync.js                     # JSON ↔ DB sync
│   │   │   ├── chat-engine.cjs                  # AI chat (tool-based)
│   │   │   ├── cleanup-service.cjs              # Periodic cleanup
│   │   │   ├── encoding-detect.js               # Encoding detection
│   │   │   ├── gen-scope.js                     # Generation scope
│   │   │   ├── knowledge-base.js                # ai/ file loader
│   │   │   ├── layer-config.js                  # Generation profiles (5)
│   │   │   ├── placeholder-audio.js             # MP3 placeholders
│   │   │   ├── audio-orchestrator.js            # Phase machine for audio merge
│   │   │   ├── video-orchestrator.js            # Phase machine for video merge
│   │   │   ├── entity-cleanup.cjs               # Deep cleanup on scene/unit deletion
│   │   │   ├── worker-auth.js                   # Worker credential model (FAIL CLOSED)
│   │   │   ├── workspace-ai-provider.js         # Per-workspace encrypted AI provider
│   │   │   ├── system-ai.js                     # AI kill switch + system provider (admin)
│   │   │   ├── progress-pubsub.cjs              # Redis pub/sub for real-time SSE progress
│   │   │   ├── generation-progress.js           # Independent generation task registry
│   │   │   ├── prompt-profile-loader.js         # Model-specific prompt profiles
│   │   │   ├── profile-override.js              # User-selected prompt profile (Redis)
│   │   │   ├── url-safety.js                    # SSRF guard for workspace endpoints
│   │   │   ├── language-detector.js             # Text language detection
│   │   │   ├── structure-detector.js            # Text structure detection
│   │   │   ├── agent-session.js                 # Agent session management
│   │   │   └── workflow-manager.js              # Workflow manager
│   │   ├── audio/                               # [DECOMPOSED] Audio subsystem
│   │   │   ├── index.js
│   │   │   └── audio-service.js
│   │   ├── image/                               # [DECOMPOSED] Images
│   │   │   ├── index.js
│   │   │   ├── image-service.js
│   │   │   ├── prompt-builder.js                #   Visual prompt assembly (by profile)
│   │   │   ├── assembly-profile.js              #   Software profile resolver
│   │   │   ├── connector-utils.js               #   ComfyUI workflow injection
│   │   │   ├── iu-processor.js                  #   IU processing
│   │   ├── video/                               # [DECOMPOSED] Video
│   │   │   ├── index.js
│   │   │   ├── video-service.js
│   │   │   └── video-merge.js
│   │   ├── book/                                # [DECOMPOSED] Books
│   │   │   ├── index.js
│   │   │   └── lazy-book/
│   │   │       ├── index.js                     #   [CORE] Load/save
│   │   │       ├── create.js                    #   Book creation
│   │   │       ├── parse.js                     #   Parsing
│   │   │       ├── appearance.js                #   Appearance description splitting
│   │   │       ├── chapter-utils.js             #   Chapter utilities
│   │   │       ├── metadata.js                  #   Metadata
│   │   │       └── scene-utils.js               #   Scene utilities
│   │   ├── orchestration/
│   │   │   ├── index.js
│   │   │   ├── orchestrator.js                  # [CORE] Facade (11 commands, M5)
│   │   │   ├── scene-orchestrator.js            # [CORE] Executor (layer-aware)
│   │   │   ├── scene-callbacks.js               #   Completion callbacks
│   │   │   ├── scene-restoration.js             #   Scene restoration
│   │   │   ├── scene-utils.js                   #   Utilities
│   │   │   └── event-journal.js                 #   Redis event journal
│   │   ├── runtime/                             # [SLIM v2.1, 21 modules]
│   │   │   ├── index.js                         # [CORE] Export (11 modules)
│   │   │   ├── runtime-loop.js                  # Heartbeat (5s)
│   │   │   ├── runtime-scheduler.js             # [CORE] Scheduler (per-asset)
│   │   │   ├── dispatch-engine.js               # [CORE] Dispatcher (lease/quota/CB)
│   │   │   ├── scene-window.js                  # [CORE] Window manager
│   │   │   ├── active-scenes-index.js           # Redis index
│   │   │   ├── lease-manager.js                 # Dispatch lease
│   │   │   ├── gpu-dispatcher.js                # GPU Hub HTTP client
│   │   │   ├── worker-health.js                 # Worker monitoring
│   │   │   ├── reconciliation-engine.js         # Stuck scene reconciliation
│   │   │   ├── counter-reconciliation.js        # Backpressure reconciliation
│   │   │   ├── retry-manager.js                 # Retries
│   │   │   ├── retention-manager.js             # Retention
│   │   │   ├── failure-taxonomy.js              # Failure taxonomy
│   │   │   ├── circuit-breaker.js               # [LIVE] Circuit breaker
│   │   │   ├── fairness-engine.js               # [LIVE] Anti-starvation
│   │   │   ├── retry-budget-manager.js          # [LIVE] Retry budget

│   │   │   # NB: 16 dead governance modules deleted 2026-06-27 (D.3/L1, 311f44a)
│   │   ├── auth/
│   │   │   ├── auth-service.js                   # Register/login/logout, server-side sessions
│   │   │   └── password.js                       # Scrypt password hashing
│   │   ├── middleware/
│   │   │   ├── auth-context.js                   # Session cookie → req.user/workspace
│   │   │   ├── ai-book-guard.js                  # AI chat book-scoped guard
│   │   │   ├── workspace-ownership.js            # Book → workspace ownership resolution
│   │   │   └── worker-auth-middleware.js          # Bearer wrk.* → req.authenticatedWorker
│   │   ├── metrics/
│   │   │   └── prometheus.js                      # Prometheus metrics (/metrics)
│   │   ├── state/
│   │   │   ├── index.js
│   │   │   └── scene-state.js                   # Per-asset state (canonical, Redis HASH)
│   │   ├── storage/
│   │   │   ├── index.js
│   │   │   ├── asset-registry.js                # Redis registry (legacy)
│   │   │   ├── filesystem-store.js              # File storage
│   │   │   ├── manifest.js                      # Manifest
│   │   │   └── postgres/
│   │   │       ├── database.js                  # Connection
│   │   │       ├── schema.js                    # DDL (30+ tables)
│   │   │       └── repositories/
│   │   │           ├── book-repo.js             # Book CRUD, workspace ownership
│   │   │           ├── book-source-repo.js      # Source dedup registry
│   │   │           ├── cache-repo.js            # Cache entries
│   │   │           ├── chat-repo.js             # AI chat messages
│   │   │           ├── chat-session-repo.js     # AI chat sessions
│   │   │           ├── events-repo.js           # Book events
│   │   │           ├── gen-session-repo.js      # Agent sessions
│   │   │           ├── iu-repo.js               # Image units
│   │   │           ├── scene-assets-repo.js     # Scene assets + dirty flags
│   │   │           ├── task-repo.js             # Generation tasks
│   │   │           ├── user-repo.js             # User CRUD, case-insensitive
│   │   │           ├── workspace-repo.js        # Workspace + members
│   │   │           ├── session-repo.js          # Server-side sessions
│   │   │           ├── guest-repo.js            # Guest identities + purge
│   │   │           ├── worker-repo.js           # Worker registration + credentials
│   │   │           └── generation-cancel-repo.js # Cancellation tracking
│   │   ├── utils/
│   │   │   ├── scene-title-utils.js             # Scene title utilities
│   │   │   ├── scene-hash.js                    # Scene hashing
│   │   │   ├── character-identity.js            # Character identification
│   │   │   └── string-utils.js                  # String utilities
│   │   └── workflows/
│   │       ├── index.js
│   │       ├── workflow-loader.js               # JSON template loader
│   │       ├── connector-loader.js              # Connector loader
│   │       └── entity-schema.js                 # Entity schema
│   └── tests/
│       ├── asset-state.test.js
│       ├── book-diff-unit.test.js
│       ├── book-event-log.test.js
│       ├── book-source.test.js
│       ├── book-sync.test.js
│       ├── coreference-agent.test.js
│       ├── coreference-cleanup.test.js
│       ├── coreference-image.test.js
│       ├── gen-scope.test.js
│       ├── happy-path.test.js                   # 30+ lifecycle tests
│       ├── iu-progress-utils.test.js
│       ├── layer-config.test.js
│       ├── prompt-dependency-registry.test.js
│       ├── scene-asset-registry.test.js
│       ├── scene-hash.test.js
│       ├── scene-patch-utils.test.js
│       ├── scene-split.test.js                  # 21 duration/coverage tests
│       ├── scene-state.test.js
│       ├── scope-filter.test.js
│       ├── scope-slide.test.js
│       ├── video-workflows.test.js
│       └── book-diff-unit.test.js               # (485 tests total, 0 failing)
│
├── worker/                                      # GPU workers (ESM)
│   ├── worker/
│   │   ├── package.json
│   │   └── worker.cjs                            # [CORE] CJS: Polling → ComfyUI → result (PW-2 private worker)
│   ├── start-video.sh
│   ├── start-worker.sh
│   ├── mc.sh
│   ├── bootstrap-video.sh
│   ├── bootstrap-light.sh
│   ├── fix-nodes-audio.sh
│   └── fix-nodes-image.sh
│
├── gpu-hub/
│   ├── package.json
│   ├── Dockerfile
│   ├── server.js                                # [ENTRY]
│   └── gpu-hub.js                               # [CORE] Workspace-scoped queues, auth, orphan sweep, dead letter
│
├── proxy/
│   ├── docker-compose.yml
│   └── conf/default.conf
│
├── frontends/
│   ├── website/
│   │   ├── index.html                       # Public site (animastor.in)
│   │   └── library/index.html               # Public Library (/library, no auth)
│   ├── app/                                 # Responsive web application (app.animastor.in, Preact + Vite)
│   │   ├── package.json
│   │   ├── vite.config.ts
│   │   └── src/
│   │       ├── layouts/                     # MobileShell / DesktopShell
│   │       ├── pages/                       # File, Generator, Player, Editor, Navigator…
│   │       ├── api/                         # /api/v1 (relative base)
│   │       └── styles/
│   └── android/                             # Android application (Kotlin, Gradle)
│       └── app/
│
├── docs/                                        # Documentation
│   ├── 01-overview/
│   │   ├── SYSTEM_OVERVIEW.md
│   │   ├── SYSTEM_MAP.md
│   │   ├── ARCHITECTURE.md
│   │   ├── DATA_FLOW.md
│   │   └── PROJECT_STRUCTURE.md
│   ├── 02-orchestration/
│   │   ├── ORCHESTRATOR_LIFECYCLE.md
│   │   ├── ORCHESTRATOR_FACADE_PR.md
│   │   ├── M5_COMPETING_WRITERS.md
│   │   ├── REGENERATION_SYSTEM.md
│   │   └── STATE_WRITERS_MAP.md
│   ├── 03-audit/
│   │   ├── ARCHITECTURAL_AUDIT.md
│   │   ├── ARCHITECTURAL_AUDIT_TODO.md
│   │   ├── ARCHITECTURAL_DEBT.md
│   │   ├── CONFLICTING_SUBSYSTEMS.md
│   │   ├── DEPENDENCY_ANALYSIS.md
│   │   ├── DOCUMENTATION_AUDIT.md
│   │   └── PLAYER_AUDIT.md
│   ├── 04-planning/
│   │   ├── ROADMAP_6M.md
│   │   ├── WORKFLOW_ROADMAP.md
│   │   └── MIGRATION_PLAN.md
│   ├── 05-frontend/
│   │   ├── PROGRESS_HANDOFF.md
│   │   └── PLAYER_STATE.md
│   ├── 06-workflows/
│   │   ├── CONNECTOR_ARCHITECTURE.md
│   │   ├── CONNECTORS.md
│   │   ├── WORKFLOW_ARCHITECTURE.md
│   │   ├── WORKFLOW_ASSISTANT_VISION.md
│   │   └── WORKFLOWS.md
│   ├── 07-agents-and-generators/
│   │   ├── AGENTS.md
│   │   ├── COREFERENCE_RESOLUTION.md
│   │   ├── COREFERENCE_ARCHITECTURE_REVIEW.md
│   │   ├── COREFERENCE_TODO.md
│   │   ├── GENERATORS.md
│   │   ├── IMAGINATION_UNIT.md
│   │   ├── IMAGINATION_UNIT_VERIFICATION.md
│   │   └── VBOOK_GENERATION_COVERAGE_TODO.md
│   ├── 99-archive/                              # Archived documents
│   ├── architectural-essence.md
│   └── CHANGELOG.md
│
├── docs/                                        # Documentation (flat, legacy)
│   ├── README.md
│   ├── CHANGELOG.md
│   └── architectural-essence.md
│
└── backups/                                     # .tar.gz archives
```

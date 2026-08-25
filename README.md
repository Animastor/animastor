<p align="center">
  <img src="frontends/app/public/logo.png" alt="Animastor" width="128" />
</p>

<h1 align="center">Animastor</h1>

<p align="center">
  <strong>AI-powered animated storytelling platform</strong><br/>
  Turn text into multimedia books with AI narration, imagery, and video.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" /></a>
  <a href="#quick-start"><img src="https://img.shields.io/badge/Docker_Compose-Ready-2496ED?style=flat&logo=docker&logoColor=white" alt="Docker" /></a>
  <img src="https://img.shields.io/badge/platform-Node.js%20%7C%20Android%20%7C%20Web-339933?logo=node.js&logoColor=white" alt="Platform" />
</p>

---

## What is Animastor?

Animastor is an open-source platform that transforms text books into animated multimedia experiences. Import a plain text file, and the system uses AI agents to analyze structure, extract characters and locations, generate scenes, and produce a complete audiovisual narrative — complete with AI voice narration, generated images, and animated video.

**Who is it for?**

- Authors and publishers who want to bring text to life
- Educators creating engaging multimedia courseware
- Developers building on an extensible AI content pipeline
- Anyone curious about AI-driven storytelling

## Key Features

- **Text Import** — Import `.txt` files; AI agents automatically parse structure, characters, locations, and scenes
- **AI Voice Narration** — Multi-voice TTS with per-character voice assignment and dialog support
- **Image Generation** — Scene-by-scene visual imagery generated from AI-crafted prompts
- **Video Animation** — Animated video sequences from image compositions (LTX models)
- **Smart Orchestration** — Automated pipeline: import → AI analysis → generation → playback, with retry, quotas, and circuit-breaking
- **Web & Android** — Responsive web app (Preact + Vite) and native Android client with offline-capable player
- **AI Assistant** — Built-in chat with AI models for editing and refining book content
- **Multi-user Workspaces** — Per-workspace isolation with guest and registered user support
- **GPU Worker Pool** — Distributed GPU compute with private, shared, and system worker modes
- **Extensible Workflows** — Declarative ComfyUI workflow + connector system for custom generation pipelines

## How It Works

```
Text Input
    │
    ▼
┌──────────────┐
│  AI Agents   │  Analyze structure, extract characters, locations, scenes
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  Orchestrator │  Plan per-asset generation (audio / image / video)
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  GPU Workers  │  Generate via ComfyUI: TTS, Stable Diffusion, LTX
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  Player       │  Audio + video playback with scene navigation
└──────────────┘
```

## Architecture at a Glance

| Layer | Component | Description |
|-------|-----------|-------------|
| **Frontend** | `frontends/app` | Responsive web app — MobileShell / DesktopShell (Preact + Vite) |
| **Frontend** | `frontends/android` | Native Android app (Kotlin) with media player |
| **Backend** | `backend` | API server + orchestration engine (Node.js / Express) |
| **Compute** | `gpu-hub` | GPU task dispatcher with workspace-scoped queues |
| **Workers** | `worker` | GPU workers — image (SD), audio (TTS), video (LTX) via ComfyUI |
| **Storage** | PostgreSQL + Redis | 30+ tables canonical state; Redis for runtime, queues, heartbeats |
| **Proxy** | `proxy` | Nginx reverse proxy with TLS and multi-domain routing |

For the full architecture deep-dive, see [docs/01-overview/ARCHITECTURE.md](docs/01-overview/ARCHITECTURE.md).

## Quick Start

### Prerequisites

- Docker and Docker Compose
- An AI API key (OpenRouter, OpenAI, or compatible endpoint)
- An NVIDIA GPU with CUDA (for local image/video generation) — or use cloud GPU workers

### 1. Clone and configure

```bash
git clone https://github.com/Animastor/animastor.git
cd animastor
cp .env.example .env
# Edit .env — set POSTGRES_PASSWORD, WORKSPACE_SECRET_KEY, and AI_API_BASE_URL
```

### 2. Start all services

```bash
docker compose up -d
```

This launches PostgreSQL, Redis, Backend, GPU Hub, and Nginx.

### 3. Open the app

Navigate to `http://localhost` (or your configured domain). Register an account, import a `.txt` book, and start generating.

### Building the Android App

```bash
./build-apk.sh
```

Requires Android SDK. See [build-apk.sh](build-apk.sh) for details.

## Documentation

Comprehensive documentation lives in the [`docs/`](docs/) directory:

| Document | Description |
|----------|-------------|
| [System Overview](docs/01-overview/SYSTEM_OVERVIEW.md) | Subsystems, use cases, and data flow |
| [Architecture](docs/01-overview/ARCHITECTURE.md) | Backend layers, components, and dependencies |
| [System Map](docs/01-overview/SYSTEM_MAP.md) | Detailed "as-is" map of all subsystems |
| [Data Flow](docs/01-overview/DATA_FLOW.md) | 10 scenarios: import → bootstrap → generation → playback |
| [Project Structure](docs/01-overview/PROJECT_STRUCTURE.md) | File tree with module descriptions |
| [Changelog](docs/CHANGELOG.md) | Full change history |

Additional documentation:

- [Orchestration](docs/02-orchestration/ORCHESTRATION.md) — Orchestrator lifecycle and state management
- [Workflows & Connectors](docs/06-workflows/WORKFLOWS.md) — Declarative ComfyUI pipeline system
- [AI Agents](docs/07-agents-and-generators/AGENTS.md) — 6-step AI analysis pipeline
- [Architectural Audit](docs/03-audit/ARCHITECTURAL_AUDIT.md) — Comprehensive codebase audit
- [6-Month Roadmap](docs/04-planning/ROADMAP_6M.md) — Project roadmap

## Project Structure

```
animastor/
├── backend/           # API server + orchestration engine (Node.js)
├── frontends/
│   ├── app/           # Responsive web app (Preact + Vite)
│   ├── android/       # Native Android app (Kotlin)
│   └── website/       # Public website (animastor.in)
├── gpu-hub/           # GPU compute dispatcher
├── worker/            # GPU workers (ComfyUI)
├── proxy/             # Nginx reverse proxy
├── docs/              # Documentation
├── scripts/           # Utility scripts
├── docker-compose.yml # Service orchestration
└── .env.example       # Environment configuration template
```

## Development

### Local development without Docker

```bash
# Backend
cd backend && npm install && node src/backend.cjs

# Web app
cd frontends/app && npm install && npm run dev
```

### Running tests

```bash
cd backend && npm test
```

### Rebuilding services

```bash
./backend-rebuild.sh          # Rebuild backend container
./front-backend-rebuild.sh    # Rebuild frontend + backend
```

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a pull request.

## Security

To report security vulnerabilities, please see [SECURITY.md](SECURITY.md).

## License

This project is licensed under the [MIT License](LICENSE).

> **Note:** AI models, workflows, and third-party tools used by Animastor may have their own licenses. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for details.

## Acknowledgements

- [ComfyUI](https://github.com/comfyanonymous/ComfyUI) — Node-based diffusion model UI
- [LTX](https://github.com/Lightricks/LTX-Video) — Video generation models
- [OpenRouter](https://openrouter.ai/) — AI model routing
- [PostgreSQL](https://www.postgresql.org/) — Relational database
- [Redis](https://redis.io/) — In-memory data store
- [Preact](https://preactjs.com/) — Fast 3kB alternative to React
- [Express](https://expressjs.com/) — Node.js web framework

---

<p align="center">
  Built with AI, for storytellers everywhere.
</p>

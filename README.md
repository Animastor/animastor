# Animastor

AI-powered animated storytelling platform.

## Services

| Service     | Description                        | Tech            |
|-------------|------------------------------------|-----------------|
| `backend`   | API server + orchestration engine  | Node.js         |
| `frontend`  | Android mobile app                 | Kotlin, Gradle  |
| `worker`    | Background job workers (image/video)| Node.js        |
| `gpu-hub`   | GPU compute dispatcher             | Node.js         |
| `proxy`     | Nginx reverse proxy                | nginx           |
| `site`      | Static landing page                | HTML            |

## Quick Start

```bash
docker compose up -d
```

## Building the Android App

```bash
./build-apk.sh
```

Requires Android SDK.

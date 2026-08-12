# Animastor

AI-powered animated storytelling platform.

## Services

| Service     | Description                        | Tech            |
|-------------|------------------------------------|-----------------|
| `backend`   | API server + orchestration engine  | Node.js         |
| `frontends/android` | Android mobile app                      | Kotlin, Gradle  |
| `worker`    | Background job workers (image/video)| Node.js        |
| `gpu-hub`   | GPU compute dispatcher             | Node.js         |
| `proxy`     | Nginx reverse proxy                | nginx           |
| `frontends/website` | Public website (animastor.in)            | HTML        |
| `frontends/app`     | Responsive web app (app.animastor.in) | Preact       |
| `tools/mobile-web-tester` | Android phone-preview tester for the mobile web | Kotlin, Gradle |

## Quick Start

```bash
docker compose up -d
```

## Building the Android App

```bash
./build-apk.sh
```

Requires Android SDK.

## Mobile Web Tester

`tools/mobile-web-tester` — минимальное Android-приложение-«телефон» для
визуального тестирования веб-приложения на планшете (CSS-эмуляция viewport
390×844 и др., mobile UA, автологин в Basic Auth `app.animastor.in`).
Сборка и детали — [`docs/08-mobile-web-migration/07-MOBILE-WEB-TESTER.md`](docs/08-mobile-web-migration/07-MOBILE-WEB-TESTER.md).

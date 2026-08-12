# Animastor — Architecture Map

Одна страница: карта доменов и репозитория. Для людей и AI-кодеров.

## Домены (production)

| Домен              | Что отдаёт                                                                 | Auth |
|--------------------|----------------------------------------------------------------------------|------|
| `animastor.in`     | **Публичный сайт**: landing, документация, публичная Library, net-disk      | нет  |
| `app.animastor.in` | **Веб-приложение** — responsive: `MobileShell` / `DesktopShell`             | Basic Auth, кроме `/library` |
| `m.animastor.in`   | Legacy compatibility: 301 → `app.animastor.in` (путь сохраняется)           | —    |

Правило: **hostname определяет приложение, viewport определяет presentation**.
Один frontend, один API, одни stores. Layout зависит только от ширины вьюпорта:

```
< 1180px  → MobileShell   (нижний таб-бар: Файл/Генератор/Плеер/Редактор/Навигатор)
>= 1180px → DesktopShell  (шапка Generator/Player/Editor + панели слева/справа)
```

## Репозиторий

```
frontends/
├── website/          ← animastor.in — публичный сайт (статика + public /library)
├── app/              ← app.animastor.in — responsive веб-приложение (Preact)
│   └── src/
│       ├── layouts/  ←   MobileShell / DesktopShell
│       ├── pages/    ←   File, Generator, Player, Editor, Navigator, Settings…
│       ├── components/
│       ├── stores/   ←   единые stores для всех представлений
│       ├── api/      ←   /api/v1 (относительный base — hostname не зашит)
│       └── styles/
└── android/          ← Android-приложение (Kotlin, Gradle)

backend/              ← API-сервер + оркестрация генерации (Node.js, Docker)
worker/               ← GPU-воркеры (ComfyUI + Node.js)
gpu-hub/              ← диспетчер GPU-очередей
proxy/                ← nginx: домены, Basic Auth, reverse proxy (proxy/conf/default.conf)
tools/                ← тестеры для планшета (mobile-web-tester, desktop-web-tester)
docs/                 ← подробная документация (по фазам миграций и подсистемам)
```

## Ключевые факты

- `app.animastor.in` — единственный эндпоинт приложения. `/library` на нём —
  единственный публичный роут (nginx `location = /library`, auth off, содержимое —
  из публичного сайта). История-роуты SPA (`/file`, `/generate`, `/play`, `/edit`,
  `/navigate`, `/settings`) — за Basic Auth (тот же `proxy/conf/.htpasswd`).
- API: `/api/v1` → backend:3000, `/gpu` → gpu-hub:5000 — на обоих доменах.
- Basic Auth на текущем этапе — существующая Nginx-авторизация; отдельной системы
  авторизации нет.
- SSL: Let's Encrypt, `/etc/letsencrypt/live/animastor.in/` (общий для всех доменов
  семейства). При добавлении домена — расширить SAN:
  `certbot certonly --webroot -w <host-webroot: frontends/website> -d animastor.in -d www.animastor.in -d m.animastor.in -d app.animastor.in --expand`

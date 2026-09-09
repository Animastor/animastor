# @animastor/file

Book import/open/create/close/export UI for Animastor, packaged as a standalone Preact module.

> **Scope — Preact/Web UI module.** This package is a **specialized Web/Frontend UI module** built on **Preact** (+ `@preact/signals`), for embedding into browser-based Animastor hosts (`frontends/app`). It is **not** a platform-independent or domain module: it renders DOM through Preact JSX. It is **not intended for Android/native UI** — the Android File surface (`FileFragment` / `fragment_file.xml`) remains a separate native implementation; this package does not target it directly. Domain logic (book session, import flows, generation/player integration) stays host-owned behind the ports — extracting a cross-platform `file-core` is a possible future task, not part of this package.

The File owns no runtime infrastructure. Every host dependency — session identity, import/open/create/close actions, HTTP downloads, i18n, toast notifications, navigation, desktop open-requests, deep-link handling, icons — arrives through the [`FilePorts`](#fileports) contract injected as a prop. The package never imports host stores, the API client, router, i18n or icon kit, so it can be mounted by any **Preact** host that implements the ports.

## Install

```sh
npm install @animastor/file
```

Peer dependencies (must be provided by the host):

- `preact` >= 10.5
- `@preact/signals` >= 1

## Usage

```tsx
import { render } from 'preact';
import { FilePage, type FilePorts } from '@animastor/file';

const ports: FilePorts = {
  session: { bookId, buildId, phase, errorMessage, importMessages, isExporting, navigationEvent },
  actions: { importBookFromFile, openBookById, closeBook, createBlankBook, setExporting, setExportProgress },
  http: { getBlob },
  i18n: { t, tf },
  toast: { toast },
  navigation: { navigate },
  openRequests: { onOpenRequest },
  deepLink: { takeBookParam },
  icons: { Folder, Add, Library, Download, Image, VolumeUp, Video },
};

render(<FilePage ports={ports} />, document.getElementById('app'));
```

## Public API

| Export | Kind | Purpose |
|---|---|---|
| `FilePage` | component | The File surface; takes `{ path?: string; ports: FilePorts }` |
| `FilePorts` | type | The full host contract (9 ports, see below) |
| Individual port types | types | `FileSessionPort`, `FileActionsPort`, `FileHttpPort`, `FileI18nPort`, `FileToastPort`, `FileNavigationPort`, `FileOpenRequestPort`, `FileDeepLinkPort`, `FileIconsPort` |
| Payload types | types | `FilePhase`, `FileNavigationEvent`, `FileRoute`, `FileExportType`, `FileI18nKey`, `FileIconProps`, `FileIconComponent` |

### FilePorts

| Port | Role |
|---|---|
| `session` (`FileSessionPort`) | Shared book identity + File screen state signals |
| `actions` (`FileActionsPort`) | Import/open/create/close book + export state |
| `http` (`FileHttpPort`) | Blob download for exports |
| `i18n` (`FileI18nPort`) | `t`/`tf` for the File's i18n keys |
| `toast` (`FileToastPort`) | Export-failure toast notifications |
| `navigation` (`FileNavigationPort`) | Router: `/play` \| `/generate` \| `/edit` \| `/library` |
| `openRequests` (`FileOpenRequestPort`) | Desktop "Open" action subscription |
| `deepLink` (`FileDeepLinkPort`) | `?book=`/`?open=` URL param consumption |
| `icons` (`FileIconsPort`) | 7 icon components (Folder, Add, Library, Download, Image, VolumeUp, Video) |

## Behavior contract

- Import: `<input type=file>` + drag-drop → POST /book/import (multipart); navigates to Play/Generate when done.
- Create New Book: POST /book/blank → navigate to Editor.
- Library: navigate to `/library`.
- Download section: book needs bookId; media need bookId + buildId + ready phase.
- Deep link: `/file?book=<id>` loads an existing server-side book.
- Desktop open-request: `animastor:open-file` CustomEvent → triggers the file picker.
- NavigationEvent one-shot: consume-and-reset handshake (Android hasSwitchedToPlay parity).

## Package boundary

- The package imports only `preact`, `preact/hooks`, `preact/jsx-runtime` and `@preact/signals`.
- Host stores, `api/client`, router, i18n, icons, `AppShell` and adapter modules are **forbidden** inside the package (enforced by boundary tests in the repository).
- `@animastor/file → host` = forbidden; `host → @animastor/file` = allowed through the public entry point only.
- **Technology boundary**: `@animastor/file` is a **Preact/Web UI module** — not a cross-platform or domain package. The Android/native File surface is out of scope.

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit
npm run test        # vitest (characterization + boundary tests)
npm run build       # tsup → dist/ (ESM + d.ts + sourcemaps)
```

## License

MIT

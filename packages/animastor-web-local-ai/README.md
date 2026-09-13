# @animastor/web-local-ai

Local AI Connector section UI for Animastor web frontend.

Host capabilities (api, i18n, ui) arrive via the injected `LocalAiPorts` contract. The package never imports host stores, `api/client`, or app-level UI directly. Domain logic (validation, token rules, status keys, share status, error mapping) is consumed from `@animastor/web-settings` — a pure, side-effect-free Tier B package, which makes this the first package→package dependency in the web layer (a clean DAG).

## Usage

```tsx
import { LocalAISection } from '@animastor/web-local-ai';
import type { LocalAiPorts } from '@animastor/web-local-ai';

const ports: LocalAiPorts = { /* api, i18n, ui */ };

<LocalAISection ports={ports} />
```

The host composition point lives in `frontends/app/src/app/localAiAdapters.ts`.

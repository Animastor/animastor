# @animastor/web-workers

Private Worker Management UI for Animastor web frontend.

Host capabilities (api, i18n, ui, auth, icons) arrive via the injected `WorkerPorts` contract. The package never imports host stores, `api/client`, or app-level UI directly.

## Usage

```tsx
import { PrivateWorkersSection } from '@animastor/web-workers';
import type { WorkerPorts } from '@animastor/web-workers';

const ports: WorkerPorts = { /* ... */ };

<PrivateWorkersSection ports={ports} />
```

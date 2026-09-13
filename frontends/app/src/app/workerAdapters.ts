// Host-owned composition of WorkerPorts
//
// This file is the ONLY seam where the app's shared infrastructure meets the
// Worker contract: the worker modules (@animastor/web-workers) consume
// `workerPorts` and know nothing about the modules below.
//
//   pages/SettingsPage.tsx ──pass──▶ <PrivateWorkersSection ports={workerPorts} />
//
//   WorkerPorts (@animastor/web-workers — public entry)
//      ↓
//   workerAdapters (this file — the single composition seam)
//   ├── api/client     ← getJson, postJson, deleteJson, deleteJsonBody, ApiError
//   ├── app/i18n       ← t, tf functions (typed key union)
//   ├── app/icons      ← IconAdd, IconReset
//   ├── state/authStore ← isAuthenticated
//   ├── lib/ui         ← Modal, toast

import { getJson, postJson, deleteJson, deleteJsonBody, ApiError } from '../api/client';
import { t, tf } from '../app/i18n';
import { IconAdd, IconReset } from '../app/icons';
import { authMe } from '../state/authStore';
import { Modal, toast } from '../lib/ui';
import type { WorkerPorts } from '@animastor/web-workers';

export const workerPorts: WorkerPorts = {
  api: {
    getJson,
    postJson,
    deleteJson,
    deleteJsonBody,
    ApiError,
  },
  i18n: { t: t as never, tf: tf as never },
  icons: { Add: IconAdd, Reset: IconReset },
  auth: { isAuthenticated: () => !!authMe.value.authenticated },
  ui: { Modal, toast },
};

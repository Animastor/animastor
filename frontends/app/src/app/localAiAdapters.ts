// Host-owned composition of LocalAiPorts
//
// This file is the ONLY seam where the app's shared infrastructure meets the
// Local AI contract: the package modules (@animastor/web-local-ai) consume
// `localAiPorts` and know nothing about the modules below.
//
//   pages/SettingsPage.tsx ──pass──▶ <LocalAISection ports={localAiPorts} />
//
//   LocalAiPorts (@animastor/web-local-ai — public entry)
//      ↓
//   localAiAdapters (this file — the single composition seam)
//   ├── api/client     ← getJson, postJson, putJson, deleteJson, ApiError
//   ├── app/i18n       ← t, tf functions (typed key union)
//   ├── lib/ui         ← Modal, toast

import { getJson, postJson, putJson, deleteJson, ApiError } from '../api/client';
import { t, tf } from './i18n';
import { Modal, toast } from '../lib/ui';
import type { LocalAiPorts } from '@animastor/web-local-ai';

export const localAiPorts: LocalAiPorts = {
  api: {
    getJson,
    postJson,
    putJson,
    deleteJson,
    ApiError,
  },
  i18n: { t: t as never, tf: tf as never },
  ui: { Modal, toast },
};

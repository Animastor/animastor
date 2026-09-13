// Host-owned composition of EditorPorts
//
// This file is the ONLY seam where the app's shared infrastructure meets the
// Editor contract: the editor modules (@animastor/web-editor entityEditor /
// waveform / idgen) consume `editorPorts` and know nothing about the modules
// below.
//
//   pages/EditPage.tsx ──pass──▶ <EntityAddButton ports={editorPorts} ... />
//   pages/EditPage.tsx ──pass──▶ <Waveform ... />  (no ports needed — pure component)
//   pages/EditPage.tsx ──import──▶ { chapterId } from '@animastor/web-editor' (pure)
//
//   EditorPorts (@animastor/web-editor — public entry)
//      ↓
//   editorAdapters (this file — the single composition seam)
//   ├── app/i18n      ← t function (typed key union)
//   ├── app/icons     ← IconAdd, IconMinus
//   ├── lib/ui        ← Modal component

import { t } from './i18n';
import { IconAdd, IconMinus } from './icons';
import { Modal } from '../lib/ui';
import type { EditorPorts } from '@animastor/web-editor';

export const editorPorts: EditorPorts = {
  i18n: { t },
  icons: { Add: IconAdd, Minus: IconMinus },
  modal: { Modal },
};

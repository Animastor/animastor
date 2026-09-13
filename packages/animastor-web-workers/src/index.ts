// @animastor/web-workers public entry point.
//
// Private Worker Management UI for Animastor web frontend:
//   - Worker CRUD (create/rotate/revoke/delete) with one-time key disclosure
//   - Setup Contract driven wizard (profiles, modes, platforms, instructions)
//   - Sharing V2 (public/users scope, recipients, expiry)
//   - Notification adapter (badge counts, derived notices)
//
// Host capabilities (api, i18n, ui, auth, icons) arrive via the injected
// WorkerPorts contract. The package imports nothing from the host app directly.
//
// Host consumers:
//   pages/SettingsPage.tsx — PrivateWorkersSection

// Ports and types
export type { WorkerPorts, WorkerApiPort, WorkerApiError, WorkerI18nPort, WorkerI18nKey, WorkerT, WorkerTf, WorkerUiPort, WorkerAuthPort, WorkerIconsPort, WorkerIconComponent, WorkerIconProps, WorkerModalProps } from './ports';

// Components (require WorkerPorts injection)
export { PrivateWorkersSection } from './PrivateWorkersSection';
export { SharingModal, SharedWithMeView, CommunityView } from './WorkerSharingUI';

// Pure types (re-exported for host convenience)
export type { PrivateWorker, WorkerType, WorkerMode, WorkerStatus, CreateWorkerResponse, RotateWorkerResponse, ListWorkersResponse } from './privateWorkers';
export type { SharePolicy, ShareGrant, ShareState, SharedWithMeWorker, LookupUser, ShareScope, ShareMode } from './sharing';
export type { ShareNotice } from './shareNotifications';

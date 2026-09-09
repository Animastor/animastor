// @animastor/file — public API
//
// The package exposes the File UI surface (FilePage) and the FilePorts contract.
// The host wires real implementations of the ports in app/fileAdapters.ts.

export { FilePage } from './FilePage';

export type {
  FilePorts,
  FileSessionPort,
  FileActionsPort,
  FileHttpPort,
  FileI18nPort,
  FileToastPort,
  FileNavigationPort,
  FileOpenRequestPort,
  FileDeepLinkPort,
  FileIconsPort,
  FilePhase,
  FileNavigationEvent,
  FileRoute,
  FileExportType,
  FileI18nKey,
  FileIconProps,
  FileIconComponent,
} from './ports';

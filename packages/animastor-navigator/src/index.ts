// @animastor/navigator — public API
//
// The package exposes the Navigator UI surface (NavigatePage) and the
// NavigatorPorts contract. The host wires real implementations of the ports
// in app/navigatorAdapters.ts.

export { NavigatePage, buildStructure, chapterLabel, sceneLabel, unitLabel } from './NavigatePage';
export type { NavItem } from './NavigatePage';

export type {
  NavigatorPorts,
  SeekPort,
  BookSourcePort,
  PositionPort,
  InvalidationPort,
  ReloadPort,
  ShellModePort,
  NavigationPort,
  HttpPort,
  I18nPort,
  IconsPort,
  ActivePosition,
  PlaybackPreparedEvent,
  ResourceInvalidationEvent,
  NetworkRecoverySignal,
  ReloadResult,
  NavigatorI18nKey,
  NavigatorT,
  NavigatorIconProps,
} from './ports';

export type {
  BookData,
  BookChapter,
  BookScene,
  BookUnit,
} from './models';

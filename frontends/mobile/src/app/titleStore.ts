// Dynamic secondary-toolbar state — mirrors Android fragments customizing their
// own toolbar: title (b.toolbar.title = detail.label) and a trailing action chip
// (b.toolbar.addView(devChip), gravity END). The AppShell secondary toolbar falls
// back to path-based titles when unset, and renders the action chip on the right.
import { signal } from '@preact/signals';

export const secondaryTitle = signal<string | null>(null);

export function setSecondaryTitle(title: string | null): void {
  secondaryTitle.value = title;
}

export interface ToolbarAction {
  label: string;
  onClick: () => void;
  ariaLabel?: string;
}

export const secondaryAction = signal<ToolbarAction | null>(null);

export function setSecondaryAction(action: ToolbarAction | null): void {
  secondaryAction.value = action;
}

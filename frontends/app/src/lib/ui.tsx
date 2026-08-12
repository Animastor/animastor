// Reusable UI primitives — web equivalents of common Android widgets used by
// stage-2 screens: TabLayout (Tabs), SwitchMaterial (Switch), AlertDialog (Modal),
// Toast, LinearProgressIndicator (ProgressBar). Styled via base.css tokens.
import type { JSX } from 'preact';

// ─────────────────────────────────────────────────────
// Tabs — 1:1 with Widget.Animastor.TabLayout (tabTextColor onSurfaceVariant,
// tabSelectedTextColor colorSecondary, indicator 3dp colorSecondary).
// ─────────────────────────────────────────────────────
export function Tabs<T extends string | number>({ items, value, onChange, ariaLabel }: {
  items: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel?: string;
}) {
  return (
    <div class="tabs" role="tablist" aria-label={ariaLabel}>
      {items.map((it) => (
        <button
          key={String(it.value)}
          role="tab"
          aria-selected={it.value === value}
          class={'tabs__item' + (it.value === value ? ' tabs__item--active' : '')}
          onClick={() => onChange(it.value)}
        >{it.label}</button>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────
// Switch — SwitchMaterial equivalent (track + thumb, accent when on).
// ─────────────────────────────────────────────────────
export function Switch({ checked, onChange, ariaLabel }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      class={'switch' + (checked ? ' switch--on' : '')}
      onClick={(e) => { e.stopPropagation(); onChange(!checked); }}
    >
      <span class="switch__thumb" />
    </button>
  );
}

// ─────────────────────────────────────────────────────
// Modal — AlertDialog equivalent. Renders into a fixed backdrop.
// ─────────────────────────────────────────────────────
export function Modal({ title, onClose, children, footer }: {
  title?: string;
  onClose: () => void;
  children: JSX.Element | JSX.Element[];
  footer?: JSX.Element | JSX.Element[];
}) {
  return (
    <div class="modal-backdrop" onClick={onClose} role="presentation">
      <div class="modal" role="dialog" aria-modal="true" aria-label={title}
        onClick={(e) => e.stopPropagation()}>
        {title && <div class="modal__title">{title}</div>}
        <div class="modal__body">{children}</div>
        {footer && <div class="modal__footer">{footer}</div>}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────
// Toast — android.widget.Toast equivalent (short message, auto-dismiss).
// ─────────────────────────────────────────────────────
let toastRoot: HTMLDivElement | null = null;
function ensureToastRoot(): HTMLDivElement {
  if (!toastRoot || !document.body.contains(toastRoot)) {
    toastRoot = document.createElement('div');
    toastRoot.className = 'toast-root';
    document.body.appendChild(toastRoot);
  }
  return toastRoot;
}

export function toast(message: string, durationMs = 2200): void {
  const root = ensureToastRoot();
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  root.appendChild(el);
  requestAnimationFrame(() => el.classList.add('toast--show'));
  setTimeout(() => {
    el.classList.remove('toast--show');
    setTimeout(() => el.remove(), 250);
  }, durationMs);
}

// ─────────────────────────────────────────────────────
// ProgressBar — LinearProgressIndicator equivalent (indeterminate).
// ─────────────────────────────────────────────────────
export function ProgressBar() {
  return (
    <div class="progress" role="progressbar" aria-label="loading">
      <div class="progress__bar" />
    </div>
  );
}

// ─────────────────────────────────────────────────────
// Error text — errorText TextView (colorError) equivalent.
// ─────────────────────────────────────────────────────
export function ErrorText({ message }: { message: string }) {
  return <p class="wf-error">{message}</p>;
}

// formatValueText — Android WorkflowDetails.formatValueText():
// strings are quoted, others toString(), plus "  ·  <dataType|any>".
export function formatValueText(value: unknown, dataType?: string): string {
  const v = value;
  const valueStr = v == null ? '<not set>' : typeof v === 'string' ? `"${v}"` : String(v);
  const typeStr = dataType && dataType.trim() ? dataType : 'any';
  return `${valueStr}  ·  ${typeStr}`;
}

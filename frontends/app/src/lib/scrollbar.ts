// Persistent vertical scroll indicator for touch (coarse-pointer) devices.
//
// On mobile browsers the native scrollbar is an overlay: it fades out a moment
// after scrolling stops, so nothing hints that content continues below the
// fold — and the ::-webkit-scrollbar styling from base.css is ignored there.
// On fine-pointer (mouse) devices the styled native scrollbar is always visible
// instead, and this module is a no-op.
//
// For every scrollable container a fixed, pointer-transparent overlay is drawn
// at its right edge: a 5px outline-variant track with a 5px accent thumb — the
// Android scrollbar design (scrollbar_thumb.xml / scrollbar_track.xml, 3px
// radius). The overlay is repositioned from getBoundingClientRect() on every
// scroll / resize / DOM mutation frame and is only visible while the container
// actually overflows (scrollHeight > clientHeight), mirroring Android's
// fadeScrollbars=false: no scrollbar when everything fits.

const MIN_THUMB = 24; // px — comfortable touch-sized thumb
const TRACK_W = 5; // px — matches the Android 5dp scrollbar
const isCoarse =
  typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

/** Scrollable containers currently rendered with an indicator. */
const hosts = new Set<HTMLElement>();
/** host -> overlay element (child of document.body). */
const inds = new WeakMap<HTMLElement, HTMLDivElement>();

function updateHost(host: HTMLElement): void {
  const ind = inds.get(host);
  if (!ind) return;
  // Close the attach/removal race: a host queued for scan may be removed from
  // the DOM before the rAF runs — drop it instead of leaking an indicator.
  if (!host.isConnected) {
    detach(host);
    return;
  }
  const { scrollTop, scrollHeight, clientHeight } = host;
  const overflow = scrollHeight - clientHeight;
  // Hidden when the content fits (Android fadeScrollbars=false) or the
  // container is not laid out / scrolled out of the viewport.
  if (overflow <= 1 || clientHeight <= 0) {
    ind.style.opacity = '0';
    return;
  }
  const rect = host.getBoundingClientRect();
  if (rect.bottom <= 0 || rect.top >= innerHeight) {
    ind.style.opacity = '0';
    return;
  }
  const thumbH = Math.min(clientHeight, Math.max(MIN_THUMB, Math.round((clientHeight * clientHeight) / scrollHeight)));
  const maxTop = clientHeight - thumbH;
  const thumb = ind.firstElementChild as HTMLElement;
  ind.style.left = Math.round(rect.right - TRACK_W - 1) + 'px';
  ind.style.top = Math.round(rect.top) + 'px';
  ind.style.height = clientHeight + 'px';
  ind.style.opacity = '1';
  thumb.style.height = thumbH + 'px';
  thumb.style.top = Math.round((scrollTop / overflow) * maxTop) + 'px';
}

let updateRaf = 0;
function scheduleAll(): void {
  if (updateRaf) return;
  updateRaf = requestAnimationFrame(() => {
    updateRaf = 0;
    for (const host of hosts) updateHost(host);
  });
}

function isScrollableY(el: HTMLElement): boolean {
  return /(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY);
}

function attach(host: HTMLElement): void {
  if (!isCoarse || hosts.has(host) || !isScrollableY(host)) return;
  hosts.add(host);
  const ind = document.createElement('div');
  ind.className = 'vs-ind';
  const thumb = document.createElement('div');
  thumb.className = 'vs-thumb';
  ind.appendChild(thumb);
  document.body.appendChild(ind);
  inds.set(host, ind);
  updateHost(host);
}

function detach(host: HTMLElement): void {
  if (!hosts.has(host)) return;
  hosts.delete(host);
  const ind = inds.get(host);
  if (ind) ind.remove();
  inds.delete(host);
}

// ── Discovery: full scan at init + subtree scans of added nodes ──
const pendingScan: HTMLElement[] = [];
let scanRaf = 0;
function queueScan(nodes: NodeList | readonly Node[]): void {
  for (const n of nodes) {
    if (n instanceof HTMLElement) pendingScan.push(n);
  }
  if (scanRaf) return;
  scanRaf = requestAnimationFrame(() => {
    scanRaf = 0;
    const batch = pendingScan.splice(0);
    for (const el of batch) {
      if (isScrollableY(el)) attach(el);
      const inner = el.querySelectorAll('*');
      for (let i = 0; i < inner.length; i++) {
        const child = inner[i];
        if (child instanceof HTMLElement && isScrollableY(child)) attach(child);
      }
    }
    scheduleAll();
  });
}

const mo = new MutationObserver((muts) => {
  for (const m of muts) {
    if (m.removedNodes.length) {
      for (const n of m.removedNodes) {
        if (n instanceof HTMLElement) {
          for (const host of Array.from(hosts)) {
            if (host === n || n.contains(host)) detach(host);
          }
        }
      }
    }
    if (m.addedNodes.length) queueScan(m.addedNodes);
  }
});

export function initScrollbar(): void {
  if (!isCoarse) return;
  // Initial scan — the first route is already rendered by the time this runs.
  const all = document.querySelectorAll('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (el instanceof HTMLElement && isScrollableY(el)) attach(el);
  }
  mo.observe(document.body, { subtree: true, childList: true });
  // Capture-phase scroll catches every scrollable element (host and ancestors —
  // an ancestor scroll also moves the host's viewport rect), no per-host
  // listeners needed.
  document.addEventListener('scroll', scheduleAll, { capture: true, passive: true });
  window.addEventListener('resize', scheduleAll, { passive: true });
  // Images loading can grow content below the fold without adding DOM nodes.
  document.addEventListener('load', scheduleAll, true);
  if (document.fonts) {
    document.fonts.ready.then(scheduleAll).catch(() => {});
  }
  scheduleAll();
}

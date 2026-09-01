// Tests for the minimal share-notification adapter (SH-2 UX §5/§6): notice
// subscription/emission, badge counters derived from the canonical state
// (never cached as the source of truth), and the initial-sync rule (first
// load seeds the badge without toasting pre-existing access).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  onShareNotice, emitShareNotice, noticeFromEntry, shareNoticeMessage,
  syncSharedWithMe, markSharedSeen, resetShareNotifications,
  sharedWithMeCount, sharedUnreadCount,
} from './shareNotifications';
import type { SharedWithMeWorker } from './sharing';

function swm(id: string, sharedBy = 'ivan'): SharedWithMeWorker {
  return {
    worker_id: id, name: `Worker ${id}`, worker_type: 'audio', capabilities: null,
    owner_workspace_id: 'ws1', revoked_at: null, last_seen: null,
    created_at: null, granted_at: null,
    share_policy: { policy_id: 'p', scope_kind: 'users', starts_at: null, expires_at: null },
    access_reason: { kind: 'shared_by_user', shared_by: sharedBy, shared_by_display_name: null, owner_workspace_name: null },
  };
}

beforeEach(() => {
  resetShareNotifications();
});

// Signals are module-level singletons; the reset helper clears all session
// state (notice-dedup set, viewed set, both counters) between cases.
afterEach(() => {
  resetShareNotifications();
  vi.restoreAllMocks();
});

describe('notice transport seam', () => {
  it('subscribers receive emitted notices; unsubscribe stops them', () => {
    const seen: string[] = [];
    const off = onShareNotice((n) => seen.push(n.worker_name ?? ''));
    emitShareNotice({ event: 'worker.shared_with_user', worker_id: 'w1', worker_name: 'Home GPU', actor_username: 'ivan', ts: 1 });
    off();
    emitShareNotice({ event: 'worker.shared_with_user', worker_id: 'w1', worker_name: 'Again', actor_username: 'ivan', ts: 2 });
    expect(seen).toEqual(['Home GPU']);
  });

  it('a throwing subscriber never breaks others', () => {
    const ok = vi.fn();
    const off1 = onShareNotice(() => { throw new Error('boom'); });
    const off2 = onShareNotice(ok);
    emitShareNotice({ event: 'worker.shared_with_user', worker_id: 'w', worker_name: 'n', actor_username: 'a', ts: 1 });
    expect(ok).toHaveBeenCalledTimes(1);
    off1(); off2();
  });

  it('noticeFromEntry mirrors the backend event contract fields', () => {
    const n = noticeFromEntry(swm('w9', 'maria'), 42);
    expect(n).toEqual({
      event: 'worker.shared_with_user',
      worker_id: 'w9',
      worker_name: 'Worker w9',
      actor_username: 'maria',
      ts: 42,
    });
  });

  it('shareNoticeMessage formats «<username> shared Worker "X" with you»', () => {
    expect(shareNoticeMessage(
      { event: 'worker.shared_with_user', worker_id: 'w', worker_name: 'Home GPU', actor_username: 'Ivan', ts: 1 },
      (actor, worker) => `${actor} shared Worker "${worker}" with you`,
    )).toBe('Ivan shared Worker "Home GPU" with you');
  });
});

describe('syncSharedWithMe (badge + derived notices)', () => {
  it('initial sync seeds the count but raises NO notices', () => {
    const spy = vi.fn();
    const off = onShareNotice(spy);
    const fresh = syncSharedWithMe([], [swm('w1'), swm('w2')]);
    expect(fresh).toEqual([]);                 // no toasts for pre-existing access
    expect(sharedWithMeCount.value).toBe(2);   // badge reflects personal grants
    expect(sharedUnreadCount.value).toBe(2);
    expect(spy).not.toHaveBeenCalled();
    off();
  });

  it('a later sync with a new grant raises exactly one notice', () => {
    const spy = vi.fn();
    const off = onShareNotice(spy);
    syncSharedWithMe([], [swm('w1')]);
    const fresh = syncSharedWithMe([swm('w1')], [swm('w1'), swm('w2', 'maria')]);
    expect(fresh.map((w) => w.worker_id)).toEqual(['w2']);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].actor_username).toBe('maria');
    off();
  });

  it('revoked/expired entries vanish from the count (server truth, not cache)', () => {
    syncSharedWithMe([], [swm('w1'), swm('w2')]);
    syncSharedWithMe([swm('w1'), swm('w2')], [swm('w1')]);
    expect(sharedWithMeCount.value).toBe(1);
  });

  it('badge counts personal shares only — the community pool never leaks in', () => {
    // The caller is responsible for feeding ONLY /workers/shared-with-me
    // results; this test pins the contract that the count equals the list.
    syncSharedWithMe([], [swm('w1')]);
    expect(sharedWithMeCount.value).toBe(1);
    syncSharedWithMe([swm('w1')], []);
    expect(sharedWithMeCount.value).toBe(0);
    expect(sharedUnreadCount.value).toBe(0);
  });

  it('markSharedSeen clears the unread badge but not the total', () => {
    const list = [swm('w1'), swm('w2')];
    syncSharedWithMe([], list);
    markSharedSeen(list);
    expect(sharedUnreadCount.value).toBe(0);
    expect(sharedWithMeCount.value).toBe(2);
  });

  it('markSharedSeen on an empty list is a no-op', () => {
    syncSharedWithMe([], []);
    markSharedSeen([]);
    expect(sharedUnreadCount.value).toBe(0);
  });
});

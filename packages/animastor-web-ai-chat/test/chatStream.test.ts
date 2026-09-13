// @animastor/web-ai-chat test suite — pure function tests only.
// Streaming behavior tests (using postChatStream) stay in the host.
import { describe, expect, it } from 'vitest';
import { sourceBadgeKey, streamErrorKey, isUserCancelled } from '../src/chatStream';

describe('chatStream — honest source indicator mapping', () => {
  it('maps the safe ai_source tokens to Private AI / Shared AI badges', () => {
    expect(sourceBadgeKey('shared')).to.equal('ai_source_shared');
    expect(sourceBadgeKey('private-local')).to.equal('ai_source_private');
    expect(sourceBadgeKey('cloud')).to.equal('ai_source_cloud');
    expect(sourceBadgeKey('system')).to.equal('ai_source_system');
    expect(sourceBadgeKey('unknown-garbage')).to.equal(null);
    expect(sourceBadgeKey(null)).to.equal(null);
    expect(sourceBadgeKey(undefined)).to.equal(null);
  });

  it('never maps anything to an owner/endpoint badge (no such token exists)', () => {
    for (const s of ['endpoint', 'owner', 'connector', 'workspace', 'llmc.a.b']) {
      expect(sourceBadgeKey(s)).to.equal(null);
    }
  });

  it('maps sanitized backend codes to honest localized states', () => {
    expect(streamErrorKey('ai_unavailable')).to.equal('ai_state_unavailable');
    expect(streamErrorKey('shared_unavailable')).to.equal('ai_state_shared_unavailable');
    expect(streamErrorKey('connector_offline')).to.equal('ai_state_offline');
    expect(streamErrorKey('session_closed')).to.equal('ai_state_offline');
    expect(streamErrorKey('runtime_unreachable')).to.equal('ai_state_runtime_unreachable');
    expect(streamErrorKey('timeout')).to.equal('ai_state_timeout');
    expect(streamErrorKey('busy')).to.equal('ai_state_busy');
    expect(streamErrorKey('stream_failed')).to.equal('ai_state_stream_failed');
    expect(streamErrorKey('cancelled')).to.equal('ai_cancelled');
    expect(streamErrorKey('mystery_code')).to.equal(null); // fall back to backend message
    expect(streamErrorKey(undefined)).to.equal(null);
  });
});

describe('isUserCancelled — user stop vs other aborts', () => {
  it('flags only the explicit user cancel (stop button)', () => {
    expect(isUserCancelled({ name: 'AbortError' }, { current: true })).to.equal(true);
    expect(isUserCancelled(null, { current: true })).to.equal(true);
    expect(isUserCancelled({ name: 'AbortError' }, { current: false })).to.equal(true);
    expect(isUserCancelled({ name: 'TypeError' }, { current: false })).to.equal(false);
    expect(isUserCancelled(null, { current: false })).to.equal(false);
  });
});

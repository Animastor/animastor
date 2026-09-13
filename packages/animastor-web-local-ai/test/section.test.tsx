// LocalAISection component tests — render the /settings/local-ai section
// through the LocalAiPorts contract with fake ports (no host import).
//
// Pinned behaviors (docs/architecture/web-local-ai-extraction-audit.md §6.9):
//  - section renders its chrome (title, add-connector form) via port i18n;
//  - connector list empty state renders the localized empty hint;
//  - a connector row renders the status pill + share-this-AI block;
//  - create connector posts the validated body and opens the one-time
//    token disclosure modal (register kind, run command);
//  - closing the disclosure modal DROPS the credential (transient state —
//    the security invariant: no persistence, no re-display);
//  - bind posts the provider-binding body; unbind DELETEs it;
//  - model refresh posts to the refresh endpoint and re-renders the count;
//  - test provider posts /settings/ai/test and shows the ok notice;
//  - share endpoint create/share/unshare/delete flows hit their endpoints;
//  - revoke flow opens the confirm modal and DELETEs the connector.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/preact';
import { LocalAISection } from '../src/LocalAISection';
import type { LocalAiPorts, LocalAiApiError } from '../src/ports';

// ── Fake i18n dictionary (host dictionary stays host-owned; keys mirror it) ──

const STRINGS: Record<string, string> = {
  local_ai_title: 'Local AI Connector',
  local_ai_desc: 'Connect a local runtime',
  local_ai_add_title: 'Add connector',
  local_ai_name_label: 'Name',
  local_ai_name_hint: 'my-ollama',
  local_ai_runtime_label: 'Runtime',
  local_ai_add_hint: 'Add hint',
  local_ai_create: 'Create',
  local_ai_list_title: 'Connectors',
  local_ai_empty: 'No connectors yet',
  local_ai_bind: 'Bind',
  local_ai_rebind: 'Rebind',
  local_ai_unbind: 'Unbind',
  local_ai_bound: 'Bound: {0}',
  local_ai_unbound: 'Unbound',
  local_ai_binding_active: 'Bound provider active',
  local_ai_binding_none: 'No provider bound',
  local_ai_reg_title: 'Registration token',
  local_ai_reg_token_label: 'Token',
  local_ai_credential_warning: 'Shown once only',
  local_ai_reg_ttl_hint: 'TTL hint',
  local_ai_setup_title: 'Setup',
  local_ai_setup_intro: 'Setup intro',
  local_ai_setup_step_1: 'Step 1',
  local_ai_setup_step_2: 'Step 2',
  local_ai_setup_step_3: 'Step 3',
  local_ai_setup_step_4: 'Step 4',
  local_ai_run_command_label: 'Run command',
  local_ai_rotate_hint: 'Rotate hint',
  local_ai_models_count: 'Models: {0}',
  local_ai_models_disclaimer: 'Reported ids, not loaded',
  local_ai_models_refreshed: 'Models refreshed ({0})',
  local_ai_model_auto: 'auto',
  local_ai_model_pick_hint: 'pick a model',
  local_ai_pending_hint: 'Pending hint',
  local_ai_reissue_token: 'Reissue token',
  local_ai_refresh_models: 'Refresh models',
  local_ai_test_cold_warning: 'Cold warning',
  local_ai_test_fail: 'Test failed: {0}',
  local_ai_revoke_confirm: 'Revoke {0}?',
  local_ai_revoke_hint: 'Revoke hint',
  local_ai_revoked: 'Revoked {0}',
  local_ai_err_no_models: 'No models discovered',
  local_ai_err_generic: 'Generic error',
  local_ai_err_auth: 'Auth error',
  local_ai_err_forbidden: 'Forbidden',
  local_ai_err_not_found: 'Not found',
  local_ai_err_rate_limited: 'Rate limited',
  local_ai_bound_badge: 'Bound',
  local_ai_runtime_ok: 'Runtime OK',
  local_ai_runtime_unknown: 'Runtime unknown',
  local_ai_runtime_ollama: 'Ollama',
  local_ai_runtime_openai_compatible: 'OpenAI-compatible',
  local_ai_status_pending: 'Pending',
  local_ai_status_online: 'Online',
  local_ai_status_offline: 'Offline',
  local_ai_name_required: 'Name required',
  share_ai_title: 'Share this AI',
  share_ai_no_endpoint_hint: 'No endpoint yet',
  share_ai_create_endpoint: 'Create endpoint',
  share_ai_create_endpoint_hint: 'Create endpoint hint',
  share_ai_share_button: 'Share',
  share_ai_unshare_button: 'Unshare',
  share_ai_enable_confirm: 'Enable sharing?',
  share_ai_enabled_notice: 'Sharing enabled',
  share_ai_disabled_notice: 'Sharing disabled',
  share_ai_endpoint_created: 'Endpoint created: {0}',
  share_ai_endpoint_deleted: 'Endpoint deleted',
  share_ai_concurrency_label: 'Concurrency: {0}',
  share_ai_models_label: 'Model: {0}',
  share_ai_status_private: 'Private',
  share_ai_status_shared: 'Shared',
  worker_last_seen: 'Last seen',
  worker_done: 'Done',
  worker_copy: 'Copy',
  worker_copied: 'Copied',
  worker_revoke: 'Revoke',
  worker_delete: 'Delete',
  worker_rotate: 'Rotate',
  worker_rotate_short: 'Rot',
  worker_trouble_title: 'Troubleshooting',
  worker_copy_failed: 'Copy failed',
  dialog_cancel: 'Cancel',
  ai_provider_test: 'Test',
  ai_provider_test_ok: 'Test OK',
  ai_provider_model: 'Model',
  ai_provider_last_tested: 'Last tested',
  play_loading: 'Loading…',
};

// ── Fake ports ─────────────────────────────────────────────────────────────

class FakeApiError extends Error implements LocalAiApiError {
  readonly name = 'ApiError';
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface ConnectorRow {
  connector_id: string;
  name: string;
  runtime_type: string;
  status: 'pending' | 'online' | 'offline';
  live: boolean;
  last_seen: number | null;
  models_count: number;
  capabilities: null;
  runtime_meta: null;
  created_at: number | null;
}

function connector(partial: Partial<ConnectorRow> & { connector_id: string; name: string }): ConnectorRow {
  return {
    runtime_type: 'ollama',
    status: 'online',
    live: true,
    last_seen: Date.now(),
    models_count: 2,
    capabilities: null,
    runtime_meta: { runtime_ok: true },
    created_at: null,
    ...partial,
  };
}

let calls: Array<{ method: string; url: string; body?: unknown }>;

function makePorts(status: { connectors: ConnectorRow[] }, models: Record<string, string[]>, provider: unknown): LocalAiPorts & {
  api: {
    getJson: ReturnType<typeof vi.fn>;
    postJson: ReturnType<typeof vi.fn>;
    putJson: ReturnType<typeof vi.fn>;
    deleteJson: ReturnType<typeof vi.fn>;
  };
} {
  calls = [];
  const getJson = vi.fn(async (url: string) => {
    calls.push({ method: 'GET', url });
    if (url === '/ai-connector/status') return status;
    if (url === '/ai-connector/models') {
      return { connectors: Object.entries(models).map(([connector_id, m]) => ({ connector_id, models: m })) };
    }
    if (url === '/settings/ai/provider') return provider as never;
    if (url === '/ai-endpoints') return { endpoints: [] };
    throw new FakeApiError('unexpected', 404);
  });
  const postJson = vi.fn(async (url: string, body?: unknown) => {
    calls.push({ method: 'POST', url, body });
    if (url === '/ai-connector/registrations') {
      return {
        connector: connector({ connector_id: 'c2', name: 'New connector', status: 'pending', live: false }),
        reg_token: 'llmcreg.id.secret',
        reg_expires_at: Date.now() + 60_000,
        ws_url: '/ws',
      };
    }
    if (url.endsWith('/models/refresh')) return { ok: true, models: ['m1', 'm2', 'm3'] };
    if (url === '/settings/ai/test') return { ok: true, model: 'qwen3' };
    return {};
  });
  const putJson = vi.fn(async (url: string, body?: unknown) => {
    calls.push({ method: 'PUT', url, body });
    return {};
  });
  const deleteJson = vi.fn(async (url: string) => {
    calls.push({ method: 'DELETE', url });
    return {};
  });
  return {
    api: {
      getJson,
      postJson,
      putJson,
      deleteJson,
      ApiError: FakeApiError,
    },
    i18n: {
      t: (key: string, fallback?: string) => STRINGS[key] ?? fallback ?? key,
      tf: (key: string, ...params: unknown[]) => (STRINGS[key] ?? key).replace(/\{(\d)\}/g, (_, i) => String(params[Number(i)] ?? '')),
    },
    ui: {
      Modal: (props: { title?: string; children: unknown; onClose: () => void }) => (
        <div class="fake-modal" data-testid="fake-modal">
          <div class="fake-modal__title">{props.title}</div>
          <div class="fake-modal__body">{props.children}</div>
          <button data-testid="fake-modal-close" onClick={props.onClose}>close</button>
        </div>
      ),
      toast: vi.fn((msg: string) => calls.push({ method: 'TOAST', url: msg })),
    },
  };
}

afterEach(() => { cleanup(); });

/** Text-matched BUTTON inside the fake modal (the confirm footer button). */
function modalButtonByText(text: string): HTMLElement {
  const modal = screen.getByTestId('fake-modal');
  const el = within(modal)
    .getAllByText(text)
    .find((n) => n.tagName === 'BUTTON');
  if (!el) throw new Error(`no modal button with text ${text}`);
  return el as HTMLElement;
}

/** Text-matched BUTTON in the section body, outside the fake modal. */
function bodyButtonByText(text: string): HTMLElement {
  const el = screen.getAllByText(text).find(
    (n) => n.tagName === 'BUTTON' && !n.closest('.fake-modal'),
  );
  if (!el) throw new Error(`no body button with text ${text}`);
  return el as HTMLElement;
}

// ── Render / empty state ────────────────────────────────────────────────────

describe('LocalAISection render (fake ports, no host imports)', () => {
  it('renders the section chrome and the connector empty state', async () => {
    const ports = makePorts({ connectors: [] }, {}, { provider: null, has_workspace_provider: false });
    render(<LocalAISection ports={ports} />);
    await waitFor(() => expect(screen.getByText('No connectors yet')).toBeTruthy());
    expect(screen.getByText('Local AI Connector')).toBeTruthy();
    expect(screen.getByText('Add connector')).toBeTruthy();
    expect(screen.getByText('No provider bound')).toBeTruthy();
    // Initial status load hits all four read endpoints.
    expect(ports.api.getJson).toHaveBeenCalledWith('/ai-connector/status');
    expect(ports.api.getJson).toHaveBeenCalledWith('/ai-connector/models');
    expect(ports.api.getJson).toHaveBeenCalledWith('/settings/ai/provider');
    expect(ports.api.getJson).toHaveBeenCalledWith('/ai-endpoints');
  });

  it('renders a connector row with status pill, runtime and share block', async () => {
    const ports = makePorts(
      { connectors: [connector({ connector_id: 'c1', name: 'Ollama box' })] },
      { c1: ['qwen3', 'qwen2.5'] },
      { provider: null, has_workspace_provider: false },
    );
    render(<LocalAISection ports={ports} />);
    await waitFor(() => expect(screen.getByText('Ollama box')).toBeTruthy());
    expect(screen.getByText('Online')).toBeTruthy();
    expect(screen.getByText('Runtime OK')).toBeTruthy();
    expect(screen.getByText('Models: 2')).toBeTruthy();
    expect(screen.getByText('Share this AI')).toBeTruthy();
    expect(screen.getByText('No endpoint yet')).toBeTruthy();
    expect(screen.getByText('Create endpoint')).toBeTruthy();
  });
});

// ── Create connector → one-time token modal → close clears credential ───────

describe('create connector → one-time token disclosure (security invariant)', () => {
  it('posts the validated body and opens the register disclosure modal with the run command', async () => {
    const ports = makePorts({ connectors: [] }, {}, { provider: null, has_workspace_provider: false });
    render(<LocalAISection ports={ports} />);
    await waitFor(() => expect(screen.getByText('No connectors yet')).toBeTruthy());

    fireEvent.input(screen.getByLabelText('Name'), { target: { value: '  My Ollama ' } });
    await fireEvent.click(screen.getByText('Create'));
    await waitFor(() => expect(screen.getByTestId('fake-modal')).toBeTruthy());

    const createCall = calls.find((c) => c.method === 'POST' && c.url === '/ai-connector/registrations');
    expect(createCall?.body).toEqual({ name: 'My Ollama', runtime_type: 'ollama' });
    // One-time token rendered exactly once (plaintext lives only in the modal).
    expect(screen.getByText('llmcreg.id.secret')).toBeTruthy();
    expect(screen.getByText(/npx animastor-ai-connector/)).toBeTruthy();
  });

  it('closing the disclosure modal DROPS the credential from the DOM (transient state only)', async () => {
    const ports = makePorts({ connectors: [] }, {}, { provider: null, has_workspace_provider: false });
    render(<LocalAISection ports={ports} />);
    await waitFor(() => expect(screen.getByText('No connectors yet')).toBeTruthy());

    fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'X' } });
    await fireEvent.click(screen.getByText('Create'));
    await waitFor(() => expect(screen.getByTestId('fake-modal')).toBeTruthy());
    expect(screen.getByText('llmcreg.id.secret')).toBeTruthy();

    await fireEvent.click(screen.getByTestId('fake-modal-close'));
    await waitFor(() => expect(screen.queryByText('llmcreg.id.secret')).toBeNull());
    expect(screen.queryByTestId('fake-modal')).toBeNull();
  });

  it('validates the name client-side (no POST on empty name)', async () => {
    const ports = makePorts({ connectors: [] }, {}, { provider: null, has_workspace_provider: false });
    render(<LocalAISection ports={ports} />);
    await waitFor(() => expect(screen.getByText('No connectors yet')).toBeTruthy());

    await fireEvent.click(screen.getByText('Create'));
    await waitFor(() => expect(screen.getByText('Name required')).toBeTruthy());
    expect(calls.find((c) => c.url === '/ai-connector/registrations')).toBeUndefined();
  });
});

// ── Bind / unbind provider ──────────────────────────────────────────────────

describe('provider binding', () => {
  it('bind posts PUT /settings/ai/provider with the selected model', async () => {
    const ports = makePorts(
      { connectors: [connector({ connector_id: 'c1', name: 'Ollama box' })] },
      { c1: ['qwen3'] },
      { provider: null, has_workspace_provider: false },
    );
    render(<LocalAISection ports={ports} />);
    await waitFor(() => expect(screen.getByText('Ollama box')).toBeTruthy());

    const input = screen.getByLabelText('Model');
    fireEvent.input(input, { target: { value: 'qwen3' } });
    await fireEvent.click(screen.getByText('Bind'));
    await waitFor(() => expect(screen.getByText('Bound: Ollama box')).toBeTruthy());

    const bindCall = calls.find((c) => c.method === 'PUT' && c.url === '/settings/ai/provider');
    expect(bindCall?.body).toEqual({ provider_type: 'local-ai', connector_id: 'c1', model: 'qwen3' });
  });

  it('shows the bound provider state and unbind DELETEs it', async () => {
    const ports = makePorts(
      { connectors: [connector({ connector_id: 'c1', name: 'Ollama box' })] },
      { c1: ['qwen3'] },
      {
        provider: {
          provider_type: 'local-ai',
          connector_id: 'c1',
          model: 'qwen3',
          status: 'ok',
          last_tested_at: Date.now(),
        },
        has_workspace_provider: true,
      },
    );
    render(<LocalAISection ports={ports} />);
    await waitFor(() => expect(screen.getByText(/Bound provider active/)).toBeTruthy());

    await fireEvent.click(screen.getByText('Unbind'));
    await waitFor(() => expect(screen.getByText(/^Unbound$/)).toBeTruthy());
    expect(calls.find((c) => c.method === 'DELETE' && c.url === '/settings/ai/provider')).toBeTruthy();
  });
});

// ── Model refresh / test provider ────────────────────────────────────────────

describe('model refresh + test provider', () => {
  it('refresh posts to the refresh endpoint and surfaces the refreshed count', async () => {
    const ports = makePorts(
      { connectors: [connector({ connector_id: 'c1', name: 'Ollama box', models_count: 1 })] },
      { c1: ['qwen3'] },
      { provider: null, has_workspace_provider: false },
    );
    render(<LocalAISection ports={ports} />);
    await waitFor(() => expect(screen.getByText('Ollama box')).toBeTruthy());

    await fireEvent.click(screen.getByText('Refresh models'));
    await waitFor(() => expect(screen.getByText('Models refreshed (3)')).toBeTruthy());
    expect(calls.find((c) => c.method === 'POST' && c.url === '/ai-connector/connectors/c1/models/refresh')).toBeTruthy();
  });

  it('test posts /settings/ai/test and shows the ok notice with the model', async () => {
    const ports = makePorts(
      { connectors: [connector({ connector_id: 'c1', name: 'Ollama box' })] },
      { c1: ['qwen3'] },
      { provider: null, has_workspace_provider: false },
    );
    render(<LocalAISection ports={ports} />);
    await waitFor(() => expect(screen.getByText('Ollama box')).toBeTruthy());

    await fireEvent.click(screen.getByText('Test'));
    await waitFor(() => expect(screen.getByText(/Test OK/)).toBeTruthy());
    const testCall = calls.find((c) => c.method === 'POST' && c.url === '/settings/ai/test');
    expect(testCall?.body).toEqual({ provider_type: 'local-ai', connector_id: 'c1' });
  });
});

// ── Share endpoint flows ─────────────────────────────────────────────────────

describe('share endpoint flows', () => {
  it('create endpoint posts /ai-endpoints with the connector binding', async () => {
    const ports = makePorts(
      { connectors: [connector({ connector_id: 'c1', name: 'Ollama box' })] },
      { c1: ['qwen3'] },
      { provider: null, has_workspace_provider: false },
    );
    ports.api.postJson.mockImplementation(async (url: string, body?: unknown) => {
      calls.push({ method: 'POST', url, body });
      if (url === '/ai-endpoints') return { endpoint: { endpoint_id: 'ep1', name: 'Ollama box endpoint' } };
      if (url === '/ai-connector/registrations') {
        return {
          connector: connector({ connector_id: 'c2', name: 'n', status: 'pending', live: false }),
          reg_token: 'llmcreg.i.s', reg_expires_at: 1, ws_url: '/ws',
        };
      }
      return {};
    });
    render(<LocalAISection ports={ports} />);
    await waitFor(() => expect(screen.getByText('Ollama box')).toBeTruthy());

    await fireEvent.click(screen.getByText('Create endpoint'));
    await waitFor(() => expect(screen.getByText(/Endpoint created/)).toBeTruthy());
    const call = calls.find((c) => c.method === 'POST' && c.url === '/ai-endpoints');
    expect(call?.body).toEqual({ name: 'Ollama box endpoint', connector_id: 'c1', runtime_type: 'ollama' });
  });

  it('share opens the confirm modal, posts consent, unshare and delete hit their endpoints', async () => {
    const ep = {
      endpoint_id: 'ep1',
      workspace_id: 'w1',
      connector_id: 'c1',
      name: 'ep one',
      runtime_type: 'ollama',
      model: null,
      description: null,
      enabled: true,
      sharing_enabled: false,
      connector_live: true,
      runtime_reachable: true,
      models_discovered: 3,
      concurrency_limit: 2,
      created_at: null,
      updated_at: null,
    };
    // Mutable server state: share/unshare mutate the endpoint row so the
    // re-read (loadStatus) returns the CURRENT sharing state.
    const endpoints = [ep];
    const ports = makePorts({ connectors: [connector({ connector_id: 'c1', name: 'Ollama box' })] }, { c1: ['qwen3'] }, { provider: null, has_workspace_provider: false });
    ports.api.getJson.mockImplementation(async (url: string) => {
      calls.push({ method: 'GET', url });
      if (url === '/ai-connector/status') return { connectors: [connector({ connector_id: 'c1', name: 'Ollama box' })] };
      if (url === '/ai-connector/models') return { connectors: [{ connector_id: 'c1', models: ['qwen3'] }] };
      if (url === '/settings/ai/provider') return { provider: null, has_workspace_provider: false };
      if (url === '/ai-endpoints') return { endpoints: [...endpoints] };
      throw new FakeApiError('x', 404);
    });
    ports.api.postJson.mockImplementation(async (url: string, body?: unknown) => {
      calls.push({ method: 'POST', url, body });
      if (url === '/ai-endpoints/ep1/share') { ep.sharing_enabled = true; return {}; }
      return {};
    });
    ports.api.deleteJson.mockImplementation(async (url: string) => {
      calls.push({ method: 'DELETE', url });
      if (url === '/ai-endpoints/ep1/share') { ep.sharing_enabled = false; return {}; }
      if (url === '/ai-endpoints/ep1') { endpoints.length = 0; return {}; }
      return {};
    });
    render(<LocalAISection ports={ports} />);
    await waitFor(() => expect(screen.getByText('ep one')).toBeTruthy());
    expect(screen.getByText('Private')).toBeTruthy();

    // Share: confirm modal → consent POST (the modal's confirm button).
    fireEvent.click(bodyButtonByText('Share'));
    expect(screen.getByText('Enable sharing?')).toBeTruthy();
    await fireEvent.click(modalButtonByText('Share'));
    await waitFor(() => expect(screen.getByText('Sharing enabled')).toBeTruthy());
    expect(calls.find((c) => c.method === 'POST' && c.url === '/ai-endpoints/ep1/share')?.body).toEqual({ confirm_share: true });

    // Unshare: DELETE /share (row button, no modal in this flow)
    await waitFor(() => expect(screen.getByText('Shared')).toBeTruthy());
    await fireEvent.click(screen.getByText('Unshare'));
    await waitFor(() => expect(screen.getByText('Sharing disabled')).toBeTruthy());
    expect(calls.find((c) => c.method === 'DELETE' && c.url === '/ai-endpoints/ep1/share')).toBeTruthy();

    // Delete endpoint
    await waitFor(() => expect(screen.getByText('Private')).toBeTruthy());
    await fireEvent.click(screen.getByText('Delete'));
    await waitFor(() => expect(screen.getByText('Endpoint deleted')).toBeTruthy());
    expect(calls.find((c) => c.method === 'DELETE' && c.url === '/ai-endpoints/ep1')).toBeTruthy();
  });
});

// ── Revoke flow ─────────────────────────────────────────────────────────────

describe('revoke flow', () => {
  it('opens the confirm modal and DELETEs the connector on confirm', async () => {
    const ports = makePorts(
      { connectors: [connector({ connector_id: 'c1', name: 'Ollama box' })] },
      { c1: ['qwen3'] },
      { provider: null, has_workspace_provider: false },
    );
    render(<LocalAISection ports={ports} />);
    await waitFor(() => expect(screen.getByText('Ollama box')).toBeTruthy());

    fireEvent.click(bodyButtonByText('Revoke'));
    await waitFor(() => expect(screen.getByText('Revoke Ollama box?')).toBeTruthy());

    // The modal footer confirm button.
    await fireEvent.click(modalButtonByText('Revoke'));
    await waitFor(() => expect(screen.getByText(/Revoked Ollama box/)).toBeTruthy());
    expect(calls.find((c) => c.method === 'DELETE' && c.url === '/ai-connector/connectors/c1')).toBeTruthy();
  });
});

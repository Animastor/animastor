import { useEffect, useState } from 'preact/hooks';
import { getJson } from '../api/client';
import type { ConnectorDetail } from '../api/models';
import { t, tf } from '../app/i18n';
import { devConnector } from '../app/routeState';
import { setSecondaryTitle } from '../app/titleStore';
import { Tabs, ProgressBar, ErrorText } from '../lib/ui';

// DeveloperViewPage — 1:1 with DeveloperViewFragment. Two tabs: Raw JSON
// (/connectors/{name}/raw, pretty-printed) and Bindings (flattened
// inputs/outputs/parameters table from ConnectorDetail). Opened from the
// WorkflowDetails `</>` chip via /dev?connector=<name>.

interface BindingRow {
  section: 'inputs' | 'outputs' | 'parameters';
  entityKey: string;
  nodeId: string;
  field: string;
  expectedClass?: string | null;
  nodeClass?: string | null;
  required: boolean;
  defaultValue?: unknown;
  min?: unknown;
  max?: unknown;
}

export function DeveloperViewPage(props: { path?: string }) {
  void props;
  // Android passes connectorName via fragment args — mirrored by the
  // devConnector route-state store (set by WorkflowDetailsPage's dev chip).
  // Fall back to ?connector= for page refresh / direct links, so the screen
  // stays reachable after reload (route-state is lost on a full page load).
  const [name] = useState(() =>
    devConnector.value ?? new URLSearchParams(window.location.search).get('connector') ?? '');
  const [tab, setTab] = useState<'json' | 'bindings'>('json');
  const [rawJson, setRawJson] = useState<string>('');
  const [rows, setRows] = useState<BindingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setSecondaryTitle(name || t('developer_tools'));
    return () => { setSecondaryTitle(null); devConnector.value = null; };
  }, [name]);

  useEffect(() => {
    if (!name) { setError('missing connector'); setLoading(false); return; }
    setLoading(true); setError('');
    (async () => {
      try {
        // Raw JSON (best-effort)
        try {
          const raw = await getJson<unknown>(`/connectors/${encodeURIComponent(name)}/raw`);
          setRawJson(JSON.stringify(raw, null, 2));
        } catch {
          setRawJson('// Raw connector data not available\n// API returned null');
        }
        // Bindings table
        const detail = await getJson<ConnectorDetail>(`/connectors/${encodeURIComponent(name)}`);
        const all: BindingRow[] = [];
        for (const [key, b] of Object.entries(detail.inputs)) {
          if (b.type === 'multi' && b.bindings?.length) {
            for (const sub of b.bindings) {
              all.push({
                section: 'inputs', entityKey: `${key}[${sub.arrayPosition ?? 0}]`,
                nodeId: sub.nodeId ?? '', field: '', expectedClass: sub.expectedClass ?? null,
                nodeClass: sub.nodeClass ?? null, required: sub.required ?? false,
              });
            }
          } else {
            all.push({
              section: 'inputs', entityKey: key, nodeId: b.nodeId ?? '', field: b.field ?? '',
              expectedClass: b.expectedClass ?? null, nodeClass: b.nodeClass ?? null,
              required: b.required ?? false,
            });
          }
        }
        for (const [key, b] of Object.entries(detail.outputs)) {
          all.push({
            section: 'outputs', entityKey: key, nodeId: b.nodeId ?? '', field: b.field ?? '',
            expectedClass: b.expectedClass ?? null, nodeClass: b.nodeClass ?? null, required: false,
          });
        }
        for (const [key, b] of Object.entries(detail.parameters)) {
          all.push({
            section: 'parameters', entityKey: key, nodeId: b.nodeId ?? '', field: b.field ?? '',
            expectedClass: b.expectedClass ?? null, nodeClass: b.nodeClass ?? null, required: false,
            defaultValue: b.defaultValue, min: b.min, max: b.max,
          });
        }
        setRows(all);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, [name]);

  const sections: { key: BindingRow['section']; label: string }[] = [
    { key: 'inputs', label: t('workflow_tab_inputs') },
    { key: 'outputs', label: t('workflow_tab_outputs') },
    { key: 'parameters', label: t('workflow_tab_parameters') },
  ];

  return (
    <section class="page wf-page">
      {loading && <ProgressBar />}
      {error && <ErrorText message={error} />}

      <Tabs
        items={[
          { value: 'json', label: 'Raw JSON' },
          { value: 'bindings', label: 'Bindings' },
        ]}
        value={tab}
        onChange={setTab}
        ariaLabel={name}
      />

      {tab === 'json' && (
        <pre class="dev-json">{rawJson || t('workflow_no_data')}</pre>
      )}

      {tab === 'bindings' && (
        <div class="wf-tab-content">
          {sections.map((s) => {
            const sectionRows = rows.filter((r) => r.section === s.key);
            if (!sectionRows.length) return null;
            return (
              <div key={s.key}>
                <div class="wf-guide-header">{s.label}</div>
                {sectionRows.map((r, i) => (
                  <article class="card dev-row" key={`${s.key}-${i}`}>
                    <div class="wf-binding__top">
                      <b class="wf-binding__label">{r.entityKey}</b>
                      {r.required && <span class="wf-status wf-status--accent">{t('workflow_input_required')}</span>}
                    </div>
                    <p class="wf-binding__info wf-status--accent">Node {r.nodeId} ({r.nodeClass || r.expectedClass || '?'}) · {r.field}</p>
                    {s.key === 'parameters' && r.defaultValue != null && (
                      <p class="wf-binding__info">
                        {tf('workflow_param_default', String(r.defaultValue))}
                        {r.min != null && r.max != null ? `  ·  ${tf('param_range_hint', String(r.min), String(r.max))}` : ''}
                      </p>
                    )}
                  </article>
                ))}
              </div>
            );
          })}
          {rows.length === 0 && <p class="wf-empty">{t('workflow_no_data')}</p>}
        </div>
      )}
    </section>
  );
}

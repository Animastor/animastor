import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { getJson, putJson, postJson } from '../api/client';
import type { ConnectorGroupedResponse, ConnectorSummary, AddConnectorResponse } from '../api/models';
import { t, tf } from '../app/i18n';
import type { StrKey } from '../app/i18n';
import { navigate } from '../app/router';
import type { Route } from '../app/router';
import { detailsEditMode } from '../app/routeState';
import { setSecondaryTitle } from '../app/titleStore';
import { Switch, toast, ProgressBar, ErrorText } from '../lib/ui';

// WorkflowTypeListPage — 1:1 with WorkflowTypeListFragment (shared
// WorkflowManagerViewModel grouped lists). Lists connectors of one type with an
// enable/disable switch, status badge, and Details button. Add Workflow reads a
// connector JSON file and POSTs it to /connectors (AddConnectorRequest).
type WfType = 'audio' | 'image' | 'video';

// Android sets toolbar.title = workflow_type_title(typeTitle); the type titles
// come from workflow_manager_{audio,image,video}. Web mirrors via the title store.
const TYPE_TITLES: Record<WfType, StrKey> = {
  audio: 'workflow_manager_audio',
  image: 'workflow_manager_image',
  video: 'workflow_manager_video',
};

export function WorkflowTypeListPage(props: { type?: string; path?: string }) {
  const type = (props.type as WfType) || 'audio';

  useEffect(() => {
    setSecondaryTitle(t(TYPE_TITLES[type]));
    return () => setSecondaryTitle(null);
  }, [type]);
  const [list, setList] = useState<ConnectorSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const g = await getJson<ConnectorGroupedResponse>('/connectors/grouped');
      setList(g[type] ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [type]);

  useEffect(() => { void load(); }, [load]);

  const onToggle = async (c: ConnectorSummary, enabled: boolean) => {
    try {
      await putJson(`/connectors/${encodeURIComponent(c.name)}/status`, { enabled });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      void load();
    }
  };

  const openDetails = (c: ConnectorSummary) => {
    // Disabled connectors open in edit mode (Android passes editMode=true via
    // fragment args — mirrored by detailsEditMode route-state store).
    detailsEditMode.value = !c.enabled;
    navigate(`/workflows/${encodeURIComponent(c.name)}` as Route);
  };

  // ── Add Workflow: read connector JSON, guess name, POST /connectors ──
  const onFileSelected = async (file: File) => {
    if (!file) return;
    try {
      const raw = await file.text();
      if (!raw.trim()) { toast(t('workflow_manager_add') + ': ' + t('workflow_no_data')); return; }
      const map = JSON.parse(raw) as Record<string, unknown>;
      let name = (map['name'] as string | undefined)?.trim();
      if (!name) name = guessConnectorName(file.name);
      if (!name) { toast('Connector name not found in JSON'); return; }
      const res = await postJson<AddConnectorResponse>('/connectors', { name, connector: map });
      if (res.ok) {
        toast(t('workflow_manager_add') + ': ' + name);
        void load();
      } else {
        toast(res.error || 'Failed to add workflow');
      }
    } catch (e) {
      toast('Error: ' + ((e as Error).message || ''));
    }
  };

  const statusInfo = (c: ConnectorSummary): { text: string; cls: string } => {
    if (!c.enabled) return { text: t('workflow_status_edit_mode'), cls: 'wf-status--accent' };
    switch (c.status) {
      case 'compatible': return { text: t('workflow_status_compatible'), cls: 'wf-status--ok' };
      case 'incompatible': return { text: t('workflow_status_incompatible'), cls: 'wf-status--error' };
      case 'registered': return { text: t('workflow_status_registered'), cls: 'wf-status--muted' };
      default: return { text: t('workflow_status_unknown'), cls: 'wf-status--muted' };
    }
  };

  return (
    <section class="page wf-page wf-page--list">
      {loading && <ProgressBar />}
      {error && <ErrorText message={error} />}
      {list.map((c) => {
        const st = statusInfo(c);
        return (
          <article class="card wf-entry" key={c.name} onClick={() => openDetails(c)}>
            <div class="wf-entry__row">
              <span class="wf-entry__label">{c.label}</span>
              <span class={`wf-status ${st.cls}`}>{st.text}</span>
            </div>
            <p class="wf-entry__connector">{tf('workflow_connector', c.name)}</p>
            <div class="wf-entry__row wf-entry__actions">
              <Switch
                checked={c.enabled}
                ariaLabel={c.enabled ? t('workflow_disable') : t('workflow_enable')}
                onChange={(v) => void onToggle(c, v)}
              />
              <button
                class="btn btn--outlined wf-entry__details"
                onClick={(e) => { e.stopPropagation(); openDetails(c); }}
              >{t('workflow_details')}</button>
            </div>
          </article>
        );
      })}
      {!loading && !error && list.length === 0 && (
        <p class="page__ph">{t('workflow_manager_no_workflows')}</p>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(e) => {
          const f = (e.target as HTMLInputElement).files?.[0];
          if (f) void onFileSelected(f);
          (e.target as HTMLInputElement).value = '';
        }}
      />
      <div class="wf-page__footer">
        <button class="btn btn--block" onClick={() => fileInputRef.current?.click()}>
          {t('workflow_manager_add')}
        </button>
      </div>
    </section>
  );
}

// guessConnectorName — Android: displayName minus extension and "_suffix";
// prefixes "conn-" unless already present.
export function guessConnectorName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '').replace(/_[^_]*$/, '');
  return base.startsWith('conn-') ? base : `conn-${base}`;
}

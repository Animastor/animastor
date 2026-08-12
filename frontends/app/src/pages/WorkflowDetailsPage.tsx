import { useCallback, useEffect, useState } from 'preact/hooks';
import { getJson, putJson } from '../api/client';
import type { CompatibilityStatus, ConnectorDetail, GuideBinding } from '../api/models';
import { t, tf } from '../app/i18n';
import { navigate } from '../app/router';
import type { Route } from '../app/router';
import { devConnector, detailsEditMode } from '../app/routeState';
import { setSecondaryTitle, setSecondaryAction } from '../app/titleStore';
import { Tabs, Modal, toast, ProgressBar, ErrorText, formatValueText } from '../lib/ui';

// WorkflowDetailsPage — 1:1 with WorkflowDetailsFragment + TabContentFragment.
// Header card (connector/type/status) + TabLayout (Inputs/Outputs/Parameters/
// Compatibility). Parameters are editable (PUT /connectors/{name}/parameters);
// in edit mode (?edit=1) bindings/guide nodes can be re-pointed to a compatible
// workflow node (PUT /connectors/{name}/bindings). Dev chip → /dev?connector=.

interface BindingItem {
  key: string;
  label: string;
  nodeId: string;
  field: string;
  required: boolean;
  dataType: string;
  defaultValue?: unknown;
  min?: unknown;
  max?: unknown;
  kind: string;
  expectedClass: string;
  nodeClass: string;
}

interface GuideNodeItem {
  label: string;
  nodeId: string;
  nodeClass: string;
  fieldFrameIdx: string;
  fieldStrength: string;
  imageSource: string;
}

type Tab = 'inputs' | 'outputs' | 'parameters' | 'compatibility';

export function WorkflowDetailsPage(props: { name?: string; path?: string }) {
  const name = props.name ?? '';
  // Android passes editMode via fragment args; web mirrors with the
  // detailsEditMode route-state store (set by WorkflowTypeListPage).
  const [editMode] = useState(() => detailsEditMode.value);
  const [detail, setDetail] = useState<ConnectorDetail | null>(null);
  const [compat, setCompat] = useState<CompatibilityStatus | null>(null);
  const [paramValues, setParamValues] = useState<Record<string, unknown>>({});
  const [nodeTypes, setNodeTypes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('inputs');
  const [editParam, setEditParam] = useState<BindingItem | null>(null);
  const [editBinding, setEditBinding] = useState<{ item: BindingItem; section: 'inputs' | 'outputs'; key: string } | null>(null);
  const [editGuide, setEditGuide] = useState<GuideNodeItem | null>(null);

  useEffect(() => {
    setSecondaryTitle(name || t('workflow'));
    // NOTE: detailsEditMode is intentionally NOT reset on unmount — resetting it
    // here would break back-navigation (details→dev→back loses edit mode, since
    // the useState initializer only runs on mount). Every entry point
    // (WorkflowTypeListPage) sets it fresh before navigate(), so a stale value
    // on direct deep-links is the acceptable trade-off.
    return () => setSecondaryTitle(null);
  }, [name]);

  // "</>" dev chip — Android adds it to the fragment toolbar (gravity END,
  // marginEnd 16) and opens DeveloperViewFragment with the connector name as a
  // fragment arg; the web mirrors it via the toolbar action slot + route-state.
  useEffect(() => {
    if (!name) return;
    setSecondaryAction({
      label: '</>',
      ariaLabel: t('developer_tools'),
      onClick: () => { devConnector.value = name; navigate('/dev' as Route); },
    });
    return () => setSecondaryAction(null);
  }, [name]);

  const load = useCallback(async () => {
    if (!name) { setError('missing connector'); setLoading(false); return; }
    setLoading(true); setError('');
    try {
      const d = await getJson<ConnectorDetail>(`/connectors/${encodeURIComponent(name)}`);
      setDetail(d);
      setSecondaryTitle(d.label || name);
      // Compatibility BEFORE tabData (setupTabs reads compatibility at build time).
      let c: CompatibilityStatus | null = null;
      try { c = await getJson<CompatibilityStatus>(`/connectors/${encodeURIComponent(name)}/compatibility`); }
      catch { /* compatibility endpoint may 404 for non-registered */ }
      setCompat(c);
      try {
        const wf = await getJson<{ nodeTypes: Record<string, string> }>(`/workflows/${encodeURIComponent(d.workflow)}`);
        setNodeTypes(wf.nodeTypes ?? {});
      } catch { setNodeTypes({}); }
      try {
        const pv = await getJson<{ values: Record<string, unknown> }>(`/connectors/${encodeURIComponent(name)}/parameters`);
        setParamValues(pv.values ?? {});
      } catch {
        const defaults: Record<string, unknown> = {};
        for (const [k, b] of Object.entries(d.parameters)) defaults[k] = b.defaultValue;
        setParamValues(defaults);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [name]);

  useEffect(() => { void load(); }, [load]);

  const buildInputs = (): BindingItem[] => {
    if (!detail) return [];
    return Object.entries(detail.inputs).flatMap(([key, b]) => {
      if (b.type === 'multi' && b.bindings && b.bindings.length) {
        return b.bindings.map((sub) => ({
          key: `${key}[${sub.arrayPosition ?? 0}]`,
          label: sub.label || `${b.label} ${(sub.arrayPosition ?? 0) + 1}`,
          nodeId: sub.nodeId ?? '',
          field: '',
          required: sub.required ?? false,
          dataType: 'image',
          kind: 'input',
          expectedClass: sub.expectedClass ?? '',
          nodeClass: sub.nodeClass ?? '',
        }));
      }
      return [{
        key,
        label: b.label,
        nodeId: b.nodeId ?? '',
        field: b.field ?? '',
        required: b.required ?? false,
        dataType: b.dataType ?? '',
        kind: b.kind ?? 'input',
        expectedClass: b.expectedClass ?? '',
        nodeClass: b.nodeClass ?? '',
      }];
    });
  };

  const buildOutputs = (): BindingItem[] => {
    if (!detail) return [];
    return Object.entries(detail.outputs).map(([key, b]) => ({
      key,
      label: b.label,
      nodeId: b.nodeId ?? '',
      field: b.field ?? '',
      required: false,
      dataType: b.dataType ?? '',
      kind: b.kind ?? 'output',
      expectedClass: b.expectedClass ?? '',
      nodeClass: b.nodeClass ?? '',
    }));
  };

  const buildParameters = (): BindingItem[] => {
    if (!detail) return [];
    return Object.entries(detail.parameters).map(([key, b]) => ({
      key,
      label: b.label,
      nodeId: b.nodeId ?? '',
      field: b.field ?? '',
      required: false,
      dataType: b.dataType ?? '',
      defaultValue: b.defaultValue,
      min: b.min,
      max: b.max,
      kind: b.kind ?? 'parameter',
      expectedClass: b.expectedClass ?? '',
      nodeClass: b.nodeClass ?? '',
    }));
  };

  const guideNodes: GuideNodeItem[] = detail?.guideNodes?.bindings?.map((g: GuideBinding, i: number) => ({
    label: g.label || `Guide ${i + 1}`,
    nodeId: g.nodeId ?? '',
    nodeClass: g.nodeClass ?? '',
    fieldFrameIdx: g.fields?.frameIdx ?? '',
    fieldStrength: g.fields?.strength ?? '',
    imageSource: g.fields?.imageSource ?? '',
  })) ?? [];

  const saveParameter = async (item: BindingItem, value: unknown) => {
    try {
      const res = await putJson<{ ok: boolean; error?: string | null; currentValue?: unknown }>(
        `/connectors/${encodeURIComponent(name)}/parameters`, { paramKey: item.key, value });
      if (res.ok) {
        setParamValues((v) => ({ ...v, [item.key]: res.currentValue ?? value }));
        toast(t('param_save_success'));
        setEditParam(null);
      } else {
        toast(tf('param_save_error', res.error || ''));
      }
    } catch (e) {
      toast(tf('param_save_error', (e as Error).message));
    }
  };

  const saveBinding = async (section: 'inputs' | 'outputs', item: BindingItem, nodeId: string) => {
    try {
      const res = await putJson<{ ok: boolean; error?: string | null }>(
        `/connectors/${encodeURIComponent(name)}/bindings`,
        { section, entityKey: item.key, nodeId, field: item.field });
      if (res.ok) { toast(t('param_save_success')); void load(); }
      else toast(res.error || '');
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const saveGuideNode = async (g: GuideNodeItem, nodeId: string) => {
    // Guide nodes are stored as bindings (section inputs, entityKey label-based).
    try {
      const res = await putJson<{ ok: boolean; error?: string | null }>(
        `/connectors/${encodeURIComponent(name)}/bindings`,
        { section: 'inputs', entityKey: g.label, nodeId });
      if (res.ok) { toast(t('param_save_success')); void load(); }
      else toast(res.error || '');
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <section class="page wf-page">
      {loading && <ProgressBar />}
      {error && <ErrorText message={error} />}

      {detail && (
        <>
          {/* Header card */}
          <article class="card wf-header">
            <div class="wf-header__row"><span>{t('workflow_detail_connector')}</span><b>{detail.name}</b></div>
            <div class="wf-header__row"><span>{t('workflow_detail_type')}</span><b>{detail.type.charAt(0).toUpperCase() + detail.type.slice(1)}</b></div>
            <div class="wf-header__row">
              <span>{t('workflow_detail_status')}</span>
              <b class={editMode ? 'wf-status--accent' : (compat?.compatible ? 'wf-status--ok' : 'wf-status--error')}>
                {editMode ? t('workflow_status_edit_mode')
                  : compat ? (compat.compatible ? t('workflow_status_compatible') : t('workflow_status_incompatible'))
                  : t('workflow_status_unknown')}
              </b>
            </div>
            {detail.workflowHash && (
              <div class="wf-header__row wf-header__row--wrap"><span>{t('workflow_detail_hash')}</span><b class="wf-hash">{detail.workflowHash}</b></div>
            )}
            <div class="wf-header__row"><span>{t('workflow_detail_version')}</span><b>{detail.version}</b></div>
            <div class="wf-header__row"><span>{t('workflow_detail_nodes')}</span><b>{nodeTypes ? Object.keys(nodeTypes).length : 0}</b></div>
          </article>


          <Tabs
            items={[
              { value: 'inputs', label: t('workflow_tab_inputs') },
              { value: 'outputs', label: t('workflow_tab_outputs') },
              { value: 'parameters', label: t('workflow_tab_parameters') },
              { value: 'compatibility', label: t('workflow_tab_compatibility') },
            ]}
            value={tab}
            onChange={setTab}
            ariaLabel={t('workflow')}
          />

          {tab === 'inputs' && (
            <div class="wf-tab-content">
              {buildInputs().map((item) => (
                <BindingCard key={item.key} item={item} editMode={editMode}
                  onEdit={() => setEditBinding({ item, section: 'inputs', key: item.key })} />
              ))}
              {buildInputs().length === 0 && <p class="wf-empty">{t('workflow_no_data')}</p>}
              {guideNodes.length > 0 && (
                <>
                  <div class="wf-guide-header">{t('workflow_guide_nodes')}</div>
                  {guideNodes.map((g, i) => (
                    <article class="card wf-binding" key={g.label + i}>
                      <div class="wf-binding__top">
                        <b class="wf-binding__label">{g.label}</b>
                        {editMode && (
                          <button class="btn btn--outlined wf-binding__edit" onClick={() => setEditGuide(g)}>{t('workflow_param_edit')}</button>
                        )}
                      </div>
                      <p class="wf-binding__info wf-status--accent">{(g.nodeClass || 'LTXVAddGuide')} ({g.nodeId})</p>
                      {[g.fieldFrameIdx && `frame: ${g.fieldFrameIdx}`, g.fieldStrength && `strength: ${g.fieldStrength}`, g.imageSource && `image: ${g.imageSource}`]
                        .filter(Boolean).join('  ·  ') && (
                        <p class="wf-binding__info">{[g.fieldFrameIdx && `frame: ${g.fieldFrameIdx}`, g.fieldStrength && `strength: ${g.fieldStrength}`, g.imageSource && `image: ${g.imageSource}`].filter(Boolean).join('  ·  ')}</p>
                      )}
                    </article>
                  ))}
                </>
              )}
            </div>
          )}

          {tab === 'outputs' && (
            <div class="wf-tab-content">
              {buildOutputs().map((item) => (
                <BindingCard key={item.key} item={item} editMode={editMode}
                  onEdit={() => setEditBinding({ item, section: 'outputs', key: item.key })} />
              ))}
              {buildOutputs().length === 0 && <p class="wf-empty">{t('workflow_no_data')}</p>}
            </div>
          )}

          {tab === 'parameters' && (
            <div class="wf-tab-content">
              {buildParameters().map((item) => (
                <article class="card wf-binding" key={item.key}>
                  <div class="wf-binding__top">
                    <b class="wf-binding__label">{item.label}</b>
                    <button class="wf-binding__edit-link" onClick={() => setEditParam(item)}>{t('workflow_details')}</button>
                  </div>
                  <p class="wf-binding__value">{formatValueText(paramValues[item.key], item.dataType)}</p>
                  {editMode && item.nodeId && <p class="wf-binding__info wf-status--accent">Node {item.nodeId} · {item.field}</p>}
                </article>
              ))}
              {buildParameters().length === 0 && <p class="wf-empty">{t('workflow_no_data')}</p>}
            </div>
          )}

          {tab === 'compatibility' && (
            <div class="wf-tab-content">
              {compat ? (
                <>
                  <article class="card wf-binding">
                    <div class="wf-binding__top">
                      <b class="wf-binding__label">{t('workflow_detail_hash')}</b>
                      <span class={'wf-status ' + (compat.hashMatch ? 'wf-status--ok' : 'wf-status--error')}>
                        {compat.hashMatch ? t('workflow_compat_hash_match') : t('workflow_compat_hash_mismatch')}
                      </span>
                    </div>
                    {compat.workflowHash && <p class="wf-binding__info wf-hash">{compat.workflowHash}</p>}
                  </article>
                  <article class="card wf-binding">
                    <b class="wf-binding__label">{tf('workflow_compat_nodes_checked', compat.nodesChecked ?? 0, compat.nodesTotal ?? 0)}</b>
                  </article>
                  <article class="card wf-binding">
                    <b class="wf-binding__label">{t('workflow_tab_compatibility')}</b>
                    {compat.warnings?.length ? compat.warnings.map((w, i) => (
                      <p class="wf-binding__info wf-status--error" key={i}>{w}</p>
                    )) : <p class="wf-binding__info">{t('workflow_compat_no_warnings')}</p>}
                    {compat.lastValidated && <p class="wf-binding__info">{tf('workflow_compat_last_validated', compat.lastValidated)}</p>}
                  </article>
                </>
              ) : <p class="wf-empty">{t('workflow_no_data')}</p>}
            </div>
          )}
        </>
      )}

      {/* ── Parameter edit dialog ── */}
      {editParam && detail && (
        <ParamDialog
          item={editParam}
          currentValue={paramValues[editParam.key]}
          onSave={(v) => void saveParameter(editParam, v)}
          onClose={() => setEditParam(null)}
        />
      )}

      {/* ── Binding edit dialog (edit mode) ── */}
      {editBinding && (
        <NodePickerDialog
          title={tf('param_edit_title', editBinding.item.label)}
          nodeTypes={nodeTypes}
          current={editBinding.item}
          onSave={(nodeId) => { void saveBinding(editBinding.section, editBinding.item, nodeId); setEditBinding(null); }}
          onClose={() => setEditBinding(null)}
        />
      )}

      {/* ── Guide node edit dialog (edit mode) ── */}
      {editGuide && (
        <NodePickerDialog
          title={tf('param_edit_title', editGuide.label)}
          nodeTypes={nodeTypes}
          current={editGuide}
          filterClass={editGuide.nodeClass || 'LTXVAddGuide'}
          onSave={(nodeId) => { void saveGuideNode(editGuide, nodeId); setEditGuide(null); }}
          onClose={() => setEditGuide(null)}
        />
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────
// Binding card (inputs/outputs)
// ─────────────────────────────────────────────────────
function BindingCard({ item, editMode, onEdit }: {
  item: BindingItem; editMode: boolean; onEdit: () => void;
}) {
  const infoParts: string[] = [];
  if (item.nodeId) {
    const cls = item.nodeClass || item.expectedClass || 'Node';
    infoParts.push(`${cls} (${item.nodeId})`);
  }
  if (item.field) infoParts.push(item.field);
  if (item.dataType) infoParts.push(item.dataType);
  return (
    <article class="card wf-binding">
      <div class="wf-binding__top">
        <b class="wf-binding__label">{item.label}</b>
        {item.required && <span class="wf-status wf-status--accent">{t('workflow_input_required')}</span>}
        {editMode && (
          <button class="btn btn--outlined wf-binding__edit" onClick={onEdit}>{t('workflow_param_edit')}</button>
        )}
      </div>
      {infoParts.length > 0 && (
        <p class={'wf-binding__info' + (editMode ? ' wf-status--accent' : '')}>{infoParts.join('  ·  ')}</p>
      )}
    </article>
  );
}

// ─────────────────────────────────────────────────────
// Parameter edit dialog — dialog_edit_parameter.xml equivalent
// ─────────────────────────────────────────────────────
function ParamDialog({ item, currentValue, onSave, onClose }: {
  item: BindingItem; currentValue?: unknown; onSave: (v: unknown) => void; onClose: () => void;
}) {
  const [text, setText] = useState(currentValue?.toString() ?? item.defaultValue?.toString() ?? '');
  const typeStr = item.dataType || 'string';
  const rangeInfo = item.min != null && item.max != null
    ? tf('param_range_hint', String(item.min), String(item.max))
    : t('param_no_range');
  const parse = (raw: string): unknown => {
    if (!raw.trim()) return null;
    switch (item.dataType) {
      case 'int': { const n = Number(raw); return Number.isNaN(n) ? raw : n; }
      case 'float': case 'number': { const n = Number(raw); return Number.isNaN(n) ? raw : n; }
      default: return raw;
    }
  };
  return (
    <Modal title={tf('param_edit_title', item.label)} onClose={onClose}
      footer={
        <>
          <button class="btn btn--outlined" onClick={() => setText(item.defaultValue?.toString() ?? '')}>{t('param_reset_default')}</button>
          <button class="btn" onClick={() => { onSave(parse(text)); }}>{t('param_save')}</button>
          <button class="btn btn--outlined" onClick={onClose}>{t('param_cancel')}</button>
        </>
      }>
      <p class="wf-dialog__label">{tf('param_current_value', currentValue?.toString() ?? '<not set>')}</p>
      <p class="wf-dialog__info">{typeStr} · {rangeInfo}</p>
      <input
        class="select wf-dialog__input"
        value={text}
        placeholder={t('param_edit_hint')}
        autoFocus
        onKeyDown={(e) => { if (e.key === 'Enter') onSave(parse(text)); }}
        onInput={(e) => setText((e.target as HTMLInputElement).value)}
      />
    </Modal>
  );
}

// ─────────────────────────────────────────────────────
// Node picker dialog — binding/guide edit (edit mode).
// Radio list of compatible workflow nodes; PUT /bindings.
// ─────────────────────────────────────────────────────
function NodePickerDialog({ title, nodeTypes, current, filterClass, onSave, onClose }: {
  title: string;
  nodeTypes: Record<string, string>;
  current: { nodeId: string; nodeClass?: string; expectedClass?: string; label: string };
  filterClass?: string;
  onSave: (nodeId: string) => void;
  onClose: () => void;
}) {
  const entries = Object.entries(nodeTypes)
    .sort(([a], [b]) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0));
  const compatible = filterClass
    ? entries.filter(([, cls]) => cls === filterClass)
    : current.expectedClass
      ? entries.filter(([, cls]) => cls === current.expectedClass)
      : entries;
  const pool = compatible.length ? compatible : entries.length ? entries
    : [[current.nodeId, current.nodeClass || current.expectedClass || 'Node'] as [string, string]];
  const selectedIdx = Math.max(0, pool.findIndex(([id]) => id === current.nodeId));
  const [selected, setSelected] = useState(selectedIdx);

  return (
    <Modal title={title} onClose={onClose}
      footer={
        <>
          <button class="btn" onClick={() => onSave(pool[selected]?.[0] ?? current.nodeId)}>{t('param_save')}</button>
          <button class="btn btn--outlined" onClick={onClose}>{t('param_cancel')}</button>
        </>
      }>
      <p class="wf-dialog__info">{t('workflow_tab_inputs')}</p>
      <div class="wf-node-list">
        {pool.map(([id, cls], i) => (
          <label class={'wf-node' + (i === selected ? ' wf-node--on' : '')} key={id + cls}>
            <input
              type="radio"
              name="node"
              checked={i === selected}
              onChange={() => setSelected(i)}
            />
            <span>{cls} ({id})</span>
          </label>
        ))}
      </div>
    </Modal>
  );
}

import { useCallback, useEffect, useState } from 'preact/hooks';
import { getJson, postJson } from '../api/client';
import type { ConnectorGroupedResponse } from '../api/models';
import { t, tf } from '../app/i18n';
import type { StrKey } from '../app/i18n';
import { navigate } from '../app/router';
import type { Route } from '../app/router';
import { toast, ProgressBar, ErrorText } from '../lib/ui';

// WorkflowsPage — 1:1 with WorkflowManagerFragment + fragment_workflow_manager.xml.
// Three cards (audio/image/video) fed by /connectors/grouped (F12: active counts
// are server-computed), each with subtitle = first connector label, an active
// count, and a Manage button → /workflows/type/:type. Reload button re-scans disk.
export function WorkflowsPage(props: { path?: string }) {
  void props;
  const [grouped, setGrouped] = useState<ConnectorGroupedResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const g = await getJson<ConnectorGroupedResponse>('/connectors/grouped');
      setGrouped(g);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const onReload = async () => {
    try {
      await postJson('/connectors/reload');
      toast('Reloading connectors...');
      void load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const cards: { type: 'audio' | 'image' | 'video'; title: StrKey; desc: StrKey; listKey: 'audio' | 'image' | 'video'; countKey: 'audio_active_count' | 'image_active_count' | 'video_active_count' }[] = [
    { type: 'audio', title: 'workflow_manager_audio', desc: 'workflow_manager_audio_desc', listKey: 'audio', countKey: 'audio_active_count' },
    { type: 'image', title: 'workflow_manager_image', desc: 'workflow_manager_image_desc', listKey: 'image', countKey: 'image_active_count' },
    { type: 'video', title: 'workflow_manager_video', desc: 'workflow_manager_video_desc', listKey: 'video', countKey: 'video_active_count' },
  ];

  return (
    <section class="page wf-page">
      {loading && <ProgressBar />}
      {error && <ErrorText message={error} />}
      {cards.map((c) => {
        const list = grouped?.[c.listKey] ?? [];
        const active = grouped?.[c.countKey] ?? 0;
        const subtitle = list.length ? list[0].label : t('workflow_manager_no_workflows');
        return (
          <article class="card wf-card" key={c.type}
            onClick={() => navigate(`/workflows/type/${c.type}` as Route)}>
            <h3 class="wf-card__title">{t(c.title)}</h3>
            <p class="wf-card__subtitle">{subtitle}</p>
            <p class="wf-card__count">{tf(active === 1 ? 'workflow_manager_active' : 'workflow_manager_active_plural', active)}</p>
            <button
              class="btn btn--outlined wf-card__manage"
              onClick={(e) => { e.stopPropagation(); navigate(`/workflows/type/${c.type}` as Route); }}
            >{t('workflow_manager_manage')}</button>
          </article>
        );
      })}
      <button class="btn btn--outlined btn--block" onClick={() => void onReload()} style="margin-top:.5rem">
        {t('workflow_manager_reload')}
      </button>
    </section>
  );
}

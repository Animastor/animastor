// ═══════════════════════════════════════════════════════════════
//  Vendored wire types — VBook agent lifecycle API contracts
// ═══════════════════════════════════════════════════════════════
//  Structural mirrors of api/models.ts types. The host passes real
//  wire payloads through the transport port; TypeScript enforces
//  structural compatibility without this package importing the
//  host's api/models module.

/** GET /book/{id}/agent-status response (api/models.ts:568).
 *  Narrowed to the fields the lifecycle reads. */
export interface AgentStatusWire {
  active: boolean;
  session_id?: string | null;
  session_status?: string | null;
  progress_msg?: string | null;
  source_type?: string | null;
  window_index?: number | null;
  created_scenes?: number | null;
  total_scenes?: number | null;
  remaining_cached?: number | null;
  window_size?: number | null;
  window_start_scene?: number | null;
  window_total_scenes?: number | null;
  window_scene_index?: number | null;
  step_type?: string | null;
}

/** GET /book/{id}/status response (api/models.ts:620).
 *  Narrowed to the field the bootstrap decision reads (`ready`). */
export interface BookStatusWire {
  ready?: boolean;
}

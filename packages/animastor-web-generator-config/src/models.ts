// ═══════════════════════════════════════════════════════════════
//  Vendored wire types — layer config API contracts
// ═══════════════════════════════════════════════════════════════
//  Structural mirrors of api/models.ts types. The host passes
//  real wire payloads through the transport port; TypeScript
//  enforces structural compatibility without this package
//  importing the host's api/models module.

/** GET /book/{id}/layer-config response (api/models.ts:592). */
export interface LayerConfig {
  book_id?: string | null;
  audio_enabled: boolean;
  image_enabled: boolean;
  video_enabled: boolean;
  vbook_enabled: boolean;
  chunk_size: number;
  audio_timeout_minutes?: number | null;
  image_timeout_minutes?: number | null;
  video_timeout_minutes?: number | null;
  analysis_mode?: 'sequential' | 'parallel';
  analysis_parallelism?: number | null;
}

/** GET /book/{id}/assets-state response (api/models.ts:438). */
export interface AssetsState {
  has_assets?: boolean;
}

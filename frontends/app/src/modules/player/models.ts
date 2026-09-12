// Player-local vendored book/scene model types (the navigator/file
// extraction precedent — docs/architecture/web-player-module-extraction-audit.md §8.1).
//
// These are structural (NOT nominal) — they mirror the subset of api/models
// types that the Player engine reads (BookData → sceneRefs, SceneStatusResponse,
// StoryboardResponse). The host passes the real BookData from api/models
// through the http port; TypeScript enforces structural compatibility without
// the Player contour importing the host's api/models module. The pure
// sceneRefs() helper moves with the package (it is already duplicated as
// generateStore's re-export) — types only, no logic fork: any drift from the
// api/models shapes is rejected at the host adapter bridge.

/** Flat scene list in book order (mirrors api/models.SceneRef — BookData.sceneRefs() port). */
export interface SceneRef {
  chapterId: string;
  sceneId: string;
  sceneType?: string;
}

/** Structural subset of api/models.BookData that sceneRefs() traverses. */
export interface BookData {
  scene_list?: { chapter_id?: string | null; scene_id?: string | null; type?: string | null }[] | null;
  chapters?: BookChapter[] | null;
}

export interface BookChapter {
  chapter_id?: string | null;
  scenes?: BookScene[] | null;
}

export interface BookScene {
  scene_id?: string | null;
  type?: string | null;
}

/** Flat scene list in book order — same algorithm as api/models.sceneRefs:
 *  prefers the server-computed scene_list, falls back to chapter→scene
 *  traversal (scene type comes from the scene itself). */
export function sceneRefs(book: BookData): SceneRef[] {
  const flat = book.scene_list;
  if (flat && flat.length) {
    return flat.map((f) => ({
      chapterId: f.chapter_id ?? '',
      sceneId: f.scene_id ?? '',
      sceneType: f.type ?? undefined,
    }));
  }
  const out: SceneRef[] = [];
  for (const ch of book.chapters ?? []) {
    for (const sc of ch.scenes ?? []) {
      out.push({ chapterId: ch.chapter_id ?? '', sceneId: sc.scene_id ?? '', sceneType: sc.type ?? undefined });
    }
  }
  return out;
}

/** GET /scene/{b}/{ch}/{sc}/status — mirrors api/models.SceneStatusResponse. */
export interface SceneStatusResponse {
  book_id?: string | null;
  chapter_id?: string | null;
  scene_id?: string | null;
  build_id?: string | null;
  scene_type?: string | null;
  audio_ready: boolean;
  video_ready: boolean;
  image_ready: boolean;
}

/** GET /scene/{b}/{ch}/{sc}/storyboard — mirrors api/models.StoryboardResponse. */
export interface StoryboardResponse {
  chunk_id: string;
  book_id?: string | null;
  chapter_id?: string | null;
  scene_id?: string | null;
  build_id: string;
  scene_type?: string | null;
  ius: StoryboardIu[];
}

export interface StoryboardIu {
  unit_id: string;
  scene_id?: string | null;
  text?: string | null;
  text_proportion?: number | null;
  estimated_duration_sec?: number | null;
  audio_file?: string | null;
  start_ms?: number | null;
  end_ms?: number | null;
  /** Server-computed playback duration (interval → estimate → default); the
   *  client never re-derives it (N1). */
  duration_ms?: number | null;
}

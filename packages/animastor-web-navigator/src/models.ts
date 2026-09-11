// Navigator-local book model types.
//
// These are structural (NOT nominal) — they mirror the subset of api/models
// types that the Navigator surface reads. The host adapter bridges the real
// BookData from api/models; TypeScript enforces structural compatibility
// without the package importing the host's api/models module.

export interface BookData {
  chapters?: BookChapter[] | null;
}

export interface BookChapter {
  chapter_id?: string | null;
  chapter_title?: string | null;
  type?: string | null;
  is_special?: boolean;
  display_number?: number | null;
  scenes?: BookScene[] | null;
}

export interface BookScene {
  scene_id?: string | null;
  scene_title?: string | null;
  display_index?: number | null;
  type?: string | null;
  style?: string | null;
  units?: BookUnit[] | null;
}

export interface BookUnit {
  id?: string | null;
  type?: string | null;
  text?: string | null;
}

/**
 * Compute the 1-based display index for a unit inside its scene.
 * Mirrors api/models.unitIndex — same algorithm, structural BookData input.
 */
export function unitIndex(book: BookData | null, chapterId: string | null, sceneId: string | null, unitOffset: number): number {
  if (!book || !chapterId || !sceneId) return 0;
  for (const ch of book.chapters ?? []) {
    if (ch.chapter_id === chapterId) {
      for (const sc of ch.scenes ?? []) {
        if (sc.scene_id === sceneId) return unitOffset + 1;
      }
    }
  }
  return 0;
}

// SharedPositionManager equivalent (ActivePosition). Single source of truth shared
// between Play, Navigate and Edit for external seek navigation.
import { signal } from '@preact/signals';

export interface ActivePosition {
  chapterId: string | null;
  sceneId: string | null;
  unitId: string | null;
  chunkId: string | null;
  unitIndex: number;
}

export const position = signal<ActivePosition>({
  chapterId: null, sceneId: null, unitId: null, chunkId: null, unitIndex: 0
});

const empty: ActivePosition = {
  chapterId: null, sceneId: null, unitId: null, chunkId: null, unitIndex: 0
};

export function navigateTo(p: Partial<ActivePosition>): void {
  position.value = { ...empty, ...position.value, ...p } as ActivePosition;
}

export function clearPosition(): void {
  position.value = { ...empty };
}

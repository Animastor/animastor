import { describe, it, expect } from 'vitest';
import { chapterId, sceneId, unitId } from '../src/idgen';

describe('idgen', () => {
  describe('chapterId', () => {
    it('returns a string with ch- prefix', () => {
      const id = chapterId();
      expect(id).toMatch(/^ch-[0-9a-f]{8}$/);
    });

    it('generates unique ids', () => {
      const ids = new Set(Array.from({ length: 100 }, () => chapterId()));
      expect(ids.size).toBe(100);
    });
  });

  describe('sceneId', () => {
    it('returns a string with sc- prefix', () => {
      const id = sceneId();
      expect(id).toMatch(/^sc-[0-9a-f]{8}$/);
    });

    it('generates unique ids', () => {
      const ids = new Set(Array.from({ length: 100 }, () => sceneId()));
      expect(ids.size).toBe(100);
    });
  });

  describe('unitId', () => {
    it('returns a string with iu- prefix', () => {
      const id = unitId();
      expect(id).toMatch(/^iu-[0-9a-f]{8}$/);
    });

    it('generates unique ids', () => {
      const ids = new Set(Array.from({ length: 100 }, () => unitId()));
      expect(ids.size).toBe(100);
    });
  });
});

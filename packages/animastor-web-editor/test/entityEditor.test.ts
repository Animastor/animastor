import { describe, it, expect } from 'vitest';
import { ENTITY_SCHEMAS } from '../src/entityEditor';

describe('entityEditor', () => {
  describe('ENTITY_SCHEMAS', () => {
    it('has schemas for all four entity kinds', () => {
      expect(Object.keys(ENTITY_SCHEMAS)).toEqual(
        expect.arrayContaining(['character', 'location', 'voice', 'behavior']),
      );
    });

    it('character schema has 3 extra fields', () => {
      expect(ENTITY_SCHEMAS.character.fields).toHaveLength(3);
    });

    it('location schema has 7 extra fields', () => {
      expect(ENTITY_SCHEMAS.location.fields).toHaveLength(7);
    });

    it('voice schema has 1 extra field', () => {
      expect(ENTITY_SCHEMAS.voice.fields).toHaveLength(1);
    });

    it('behavior schema has 1 extra field', () => {
      expect(ENTITY_SCHEMAS.behavior.fields).toHaveLength(1);
    });

    it('all schema kinds match their key', () => {
      for (const [key, schema] of Object.entries(ENTITY_SCHEMAS)) {
        expect(schema.kind).toBe(key);
      }
    });
  });
});

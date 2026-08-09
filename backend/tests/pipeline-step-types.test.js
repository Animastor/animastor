const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

// Guard against the class of bug where a new pipeline step (e.g.
// 'repair_fantasy_snakes') is added in code but the PostgreSQL CHECK
// constraint agent_steps_step_type_check is not updated — the step's
// INSERT crashes the whole window at runtime. The constraint is
// duplicated in schema.js (CREATE TABLE for fresh DBs + the migration
// update that drops/recreates it for existing DBs) — BOTH must stay in
// sync with the step types actually used by the pipeline.

describe('pipeline step types vs agent_steps.step_type CHECK constraint', () => {
    const stepsSrc = fs.readFileSync(path.join(__dirname, '../src/services/agent/pipeline-steps.js'), 'utf8');
    const schemaSrc = fs.readFileSync(path.join(__dirname, '../src/storage/postgres/schema.js'), 'utf8');

    const usedTypes = new Set(
        [...stepsSrc.matchAll(/createStep\(\s*sessionId,\s*'([a-z_]+)'/g)].map(m => m[1])
    );

    // Both constraint declarations: the CREATE TABLE and the migration update
    // (the latter is written as `CHECK (step_type IN (...))` — note the space).
    const checkBlocks = [
        ...schemaSrc.matchAll(/CHECK\s*\(step_type IN \(\s*([\s\S]*?)\s*\)\)/g),
    ].map(m => new Set([...m[1].matchAll(/'([a-z_]+)'/g)].map(x => x[1])));

    it('pipeline uses at least one step type (sanity of the extraction)', () => {
        expect(usedTypes.size).to.be.greaterThan(5);
    });

    it('schema.js declares the step_type CHECK in both CREATE TABLE and migration', () => {
        expect(checkBlocks.length).to.equal(2);
    });

    for (const [i, allowed] of checkBlocks.entries()) {
        it(`every createStep() type is allowed by constraint declaration #${i + 1}`, () => {
            const missing = [...usedTypes].filter(t => !allowed.has(t));
            expect(missing, `step type(s) used in pipeline-steps.js but missing from the agent_steps.step_type CHECK: ${missing.join(', ')}`).to.deep.equal([]);
        });
    }
});

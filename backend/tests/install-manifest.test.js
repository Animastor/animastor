const { expect } = require('chai');
const path = require('path');
const manifest = require('../src/installer/install-manifest');

const PROFILES = ['audio/qwen-tts', 'image/qwen-image', 'video/ltx-2.3'];

describe('Install Manifest — loader & validator', () => {
    describe('canonical manifests on disk', () => {
        it('loads all three production profile manifests', () => {
            const all = manifest.loadAllManifests();
            expect(Object.keys(all).sort()).to.deep.equal(PROFILES.slice().sort());
        });

        for (const profileId of PROFILES) {
            it(`validates ${profileId}`, () => {
                const m = manifest.loadManifest(profileId);
                expect(m._validation.valid).to.be.true;
                expect(m._validation.errors).to.deep.equal([]);
                expect(m.profile.id).to.equal(profileId);
                expect(m.manifest_version).to.equal(manifest.MANIFEST_SCHEMA_VERSION);
            });
        }

        it('every required dependency has non-empty workflow provenance', () => {
            const all = manifest.loadAllManifests();
            for (const [id, m] of Object.entries(all)) {
                for (const dep of m.dependencies) {
                    if (dep.requirement === 'required') {
                        expect(dep.provenance, `${id}: ${dep.id} provenance`).to.be.an('object');
                        expect(dep.provenance.workflows, `${id}: ${dep.id} workflows`).to.be.an('array').that.is.not.empty;
                    }
                }
            }
        });

        it('explicitly separates required / optional dependencies', () => {
            const all = manifest.loadAllManifests();
            for (const m of Object.values(all)) {
                const reqs = m.dependencies.filter((d) => d.requirement === 'required');
                const opts = m.dependencies.filter((d) => d.requirement === 'optional');
                expect(reqs, `${m.profile.id} required deps`).to.be.an('array').that.is.not.empty;
                expect(opts.length, `${m.profile.id} optional deps`).to.be.greaterThan(0);
            }
        });

        it('covers custom nodes, models, runtime, worker bundle and verification sections', () => {
            const all = manifest.loadAllManifests();
            for (const m of Object.values(all)) {
                const kinds = new Set(m.dependencies.map((d) => d.kind));
                expect(kinds.has('custom_node'), `${m.profile.id} custom nodes`).to.be.true;
                expect(kinds.has('model') || kinds.has('model_repo'), `${m.profile.id} models`).to.be.true;
                expect(m.runtime_requirements.comfyui).to.be.an('object');
                expect(m.runtime_requirements.python).to.be.an('object');
                expect(m.runtime_requirements.torch).to.be.an('object');
                expect(m.worker_bundle).to.be.an('object');
                expect(m.worker_bundle.env.required).to.include('ANIMASTOR_WORKER_TOKEN');
                expect(m.verification).to.be.an('object');
                expect(m.verification.pass).to.be.a('string');
            }
        });

        it('does not invent canonical versions without evidence (audio/image ComfyUI & torch stay unknown)', () => {
            const audio = manifest.loadManifest('audio/qwen-tts');
            const image = manifest.loadManifest('image/qwen-image');
            for (const m of [audio, image]) {
                expect(m.runtime_requirements.comfyui.pin, `${m.profile.id} comfyui pin`).to.be.null;
                expect(m.runtime_requirements.comfyui.basis).to.equal('unknown');
                expect(m.runtime_requirements.comfyui.known_working_reference).to.be.an('object');
                expect(m.runtime_requirements.torch.pin, `${m.profile.id} torch pin`).to.be.null;
                expect(m.runtime_requirements.torch.basis).to.equal('unknown');
                expect(m.runtime_requirements.torch.known_working_reference).to.be.an('object');
            }
        });

        it('video carries the only evidence-backed canonical pins (v0.27.0 + 2.6.0+cu124, known_working)', () => {
            const video = manifest.loadManifest('video/ltx-2.3');
            expect(video.runtime_requirements.comfyui.basis).to.equal('known_working');
            expect(video.runtime_requirements.comfyui.pin.tag).to.equal('v0.27.0');
            expect(video.runtime_requirements.torch.basis).to.equal('known_working');
            expect(video.runtime_requirements.torch.pin).to.equal('2.6.0+cu124');
        });

        it('keeps provider-specific information in environment_reference with explicit disclaimers', () => {
            const all = manifest.loadAllManifests();
            for (const m of Object.values(all)) {
                expect(m.environment_reference, `${m.profile.id} environment_reference`).to.be.an('array').that.is.not.empty;
                for (const ref of m.environment_reference) {
                    expect(ref.provider).to.be.a('string').that.is.not.empty;
                    expect(ref.audit).to.be.a('string').that.is.not.empty;
                    expect(ref.disclaimer).to.match(/MUST NOT be treated as/i);
                }
            }
        });

        it('E2E references are split: fork image for audio/image, separate config for video', () => {
            const audio = manifest.loadManifest('audio/qwen-tts');
            const image = manifest.loadManifest('image/qwen-image');
            const video = manifest.loadManifest('video/ltx-2.3');
            expect(audio.environment_reference[0].comfyui.repository).to.include('rajsingh1-dev/ComfyUI');
            expect(image.environment_reference[0].comfyui.repository).to.include('rajsingh1-dev/ComfyUI');
            expect(video.environment_reference[0].comfyui.repository).to.not.include('rajsingh1-dev');
            expect(video.environment_reference[0].torch).to.equal('2.6.0+cu124');
            expect(audio.environment_reference[0].torch).to.equal('2.10.0+cu128');
        });

        it('does not invent model download sources — unknown sources carry todo markers', () => {
            const image = manifest.loadManifest('image/qwen-image');
            const video = manifest.loadManifest('video/ltx-2.3');
            for (const m of [image, video]) {
                for (const dep of m.dependencies.filter((d) => d.kind === 'model' && d.requirement === 'required')) {
                    expect(dep.source.repository, `${m.profile.id}: ${dep.id} repository must not be invented`).to.be.null;
                    expect(dep.source.verification).to.equal('unknown');
                    expect(dep.source.todo).to.be.a('string').that.is.not.empty;
                }
            }
            // and validation surfaces these honesty gaps as warnings
            expect(image._validation.warnings.length).to.be.greaterThan(0);
            expect(video._validation.warnings.length).to.be.greaterThan(0);
        });

        it('video manifest records unresolved class attributions instead of guessing', () => {
            const video = manifest.loadManifest('video/ltx-2.3');
            expect(video.open_class_attributions).to.be.an('object');
            const classes = video.open_class_attributions.classes.map((c) => c.class_type);
            expect(classes).to.include('SaveVideo');
            expect(classes).to.include('CreateVideo');
        });

        it('video VHS requirement stays unknown until /object_info verification', () => {
            const video = manifest.loadManifest('video/ltx-2.3');
            const vhs = video.dependencies.find((d) => d.id === 'custom-node:comfyui-videohelpersuite');
            expect(vhs).to.be.an('object');
            expect(vhs.requirement).to.equal('unknown');
            expect(vhs.basis).to.equal('unknown');
        });
    });

    describe('validateManifest (synthetic)', () => {
        function baseManifest() {
            return {
                manifest_version: manifest.MANIFEST_SCHEMA_VERSION,
                revision: 'test-1',
                profile: { id: 'image/test', type: 'image', name: 'test' },
                provenance: { workflows: ['wf-test'] },
                runtime_requirements: {
                    comfyui: { policy: 'exact-pin-preferred', pin: null, basis: 'unknown', todo: 'check' },
                    python: { policy: 'minimum', minimum: '3.10', basis: 'minimum_supported' },
                    torch: { policy: 'exact', pin: null, basis: 'unknown', todo: 'check' },
                    nodejs: { policy: 'minimum', minimum: '20', basis: 'minimum_supported' },
                    nvidia_driver: { policy: 'reference-only', basis: 'environment_reference' },
                },
                dependencies: [],
                worker_bundle: {
                    min_version: '2.0.0',
                    files: ['worker.cjs'],
                    env: { required: ['HUB_URL'], optional: [] },
                },
                verification: { method: 'resolver-diff', pass: 'x', warn: 'y', fail: 'z' },
            };
        }

        it('accepts a minimal valid manifest', () => {
            const v = manifest.validateManifest(baseManifest());
            expect(v.valid).to.be.true;
            expect(v.errors).to.deep.equal([]);
        });

        it('rejects wrong schema version', () => {
            const m = baseManifest();
            m.manifest_version = '0.0.1';
            expect(manifest.validateManifest(m).valid).to.be.false;
        });

        it('rejects profile.id not matching type/name', () => {
            const m = baseManifest();
            m.profile.id = 'video/test';
            const v = manifest.validateManifest(m);
            expect(v.valid).to.be.false;
            expect(v.errors.join(' ')).to.match(/profile\.id/);
        });

        it('rejects missing workflow provenance (workflows are the source of required)', () => {
            const m = baseManifest();
            m.provenance.workflows = [];
            expect(manifest.validateManifest(m).valid).to.be.false;
        });

        it('rejects required dependency without workflow provenance', () => {
            const m = baseManifest();
            m.dependencies.push({ id: 'x', kind: 'model', filename: 'f.gguf', target_dir: 'models/unet', requirement: 'required', basis: 'required' });
            const v = manifest.validateManifest(m);
            expect(v.valid).to.be.false;
            expect(v.errors.join(' ')).to.match(/provenance/);
        });

        it('rejects duplicate dependency ids and invalid enums', () => {
            const m = baseManifest();
            const dep = { id: 'x', kind: 'model', filename: 'f.gguf', target_dir: 'models/unet', requirement: 'optional', basis: 'optional' };
            m.dependencies.push(dep, { ...dep });
            let v = manifest.validateManifest(m);
            expect(v.errors.join(' ')).to.match(/duplicated/);

            const m2 = baseManifest();
            m2.dependencies.push({ ...dep, basis: 'guessed' });
            v = manifest.validateManifest(m2);
            expect(v.errors.join(' ')).to.match(/basis/);
        });

        it('loadManifest throws on unknown profile', () => {
            expect(() => manifest.loadManifest('audio/nope')).to.throw(/not found/);
        });
    });
});

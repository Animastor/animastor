'use strict';
// E2E phase A driver: runs the Animastor installer INSIDE the one-off
// install container (docker run -i --rm), answering the interactive prompts
// by matching their text (same technique as installer-cli.test.js C8).
// The Worker Key is fed ONLY through this stdin pipe — never argv, never env.
const { spawn } = require('child_process');
const fs = require('fs');

const TOKEN = fs.readFileSync('/tmp/opencode/e2e-token', 'utf8').trim();
const NET = process.argv[2];
const IMAGE = process.argv[3] || 'animastor-worker:e2e';

const args = [
    'run', '-i', '--rm', '--name', 'animastor-worker-install',
    '--network', NET,
    '-v', '/home/animastor/data:/data/animastor',
    '-v', '/home/sureg/ComfyUI/models/TTS:/data/animastor/comfyui/models/TTS',
    '-e', 'ANIMASTOR_EXIT_AFTER_INSTALL=1',
    IMAGE,
];

// Order-independent answers: every prompt has a UNIQUE bounded regex (the
// bounded gap keeps plan-preview text from bridging into a real prompt).
// Real readline prompts end with "[Yes/No] " (confirm) or ": " (secret).
const answers = [
    [/Continue with the CPU-only installation\? \[Yes\/No\]\s*$/, 'yes'],
    [/Install command-line management tools\? \[Yes\/No\]\s*$/, 'yes'],
    [/Install this reference ComfyUI\? \[Yes\/No\]\s*$/, 'yes'],
    [/ComfyUI-Qwen3-TTS[\s\S]{0,120}\[Yes\/No\]\s*$/, 'yes'],
    [/Qwen3-TTS-12Hz-1\.7B-VoiceDesign[\s\S]{0,160}\[Yes\/No\]\s*$/, 'no'],
    [/Install optional profile workflows\?[\s\S]{0,450}\[Yes\/No\]\s*$/, 'no'],
    [/Worker setup:[\s\S]{0,200}\[Yes\/No\]\s*$/, 'yes'],
    [/Enter ANIMASTOR_WORKER_TOKEN[\s\S]{0,80}:\s*$/, TOKEN],
];
// NOTE: models prompt (when it appears) lists BOTH repos — the VoiceDesign
// regex matches it and answers 'no' (models are bind-mounted; a prompt here
// means the resolver did not accept them — investigate instead of
// re-downloading 8.4 GB).

const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
let out = '';
let tail = '';
const answered = new Set();
const step = (s) => {
    out += s; tail += s;
    process.stdout.write(s);
    for (let i = 0; i < answers.length; i++) {
        if (answered.has(i)) continue;
        const [re, ans] = answers[i];
        if (re.test(tail.slice(-1500))) {
            child.stdin.write(`${ans}\n`);
            fs.appendFileSync('/tmp/opencode/phaseA-answers.log', `[answered ${i}] ${re.source.slice(0, 60)}\n`);
            tail = '';
            answered.add(i);
            break;
        }
    }
};
child.stdout.on('data', (d) => step(d.toString()));
child.stderr.on('data', (d) => step(d.toString()));
child.on('close', (code) => {
    fs.appendFileSync('/tmp/opencode/phaseA-answers.log', `[driver] exit=${code} answered=${answered.size}/${answers.length}\n`);
    process.exit(code === 0 ? 0 : 1);
});

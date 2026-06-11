const fs = require('fs');
const path = require('path');

const WF_DIR = "/data/workflows";
const logPrefix = '[WORKFLOWS]';

const workflows = {};

function loadWorkflows() {
    if (fs.existsSync(WF_DIR)) {
        fs.readdirSync(WF_DIR).forEach(f => {
            if (f.endsWith('.json')) {
                const name = f.replace('.json', '');
                workflows[name] = JSON.parse(fs.readFileSync(path.join(WF_DIR, f), 'utf8'));
            }
        });
        console.log(`${logPrefix} Loaded ${Object.keys(workflows).length} workflows from ${WF_DIR}`);
    } else {
        console.warn(`${logPrefix} Workflow directory not found: ${WF_DIR}`);
    }
    return workflows;
}

function getWorkflow(name) {
    if (!workflows[name]) {
        throw new Error(`Workflow not found: ${name}`);
    }
    return JSON.parse(JSON.stringify(workflows[name]));
}

module.exports = { loadWorkflows, getWorkflow, workflows };

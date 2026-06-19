// ======================================================
// Workflow Loader — v2.0.0 (Connector-aware)
// ======================================================
// Loads ComfyUI JSON workflows from /data/workflows/
// and their corresponding connectors from /data/connectors/.
//
// The connector layer abstracts workflow internals (nodeId, fields)
// so backend code never references them directly.

const fs = require('fs');
const path = require('path');
const connectorLoader = require('./connector-loader');

const WF_DIR = "/data/workflows";
const logPrefix = '[WORKFLOWS]';

const workflows = {};
const workflowHashes = {}; // name → sha256

function log(msg) {
    console.log(`${logPrefix} ${msg}`);
}

function loadWorkflows() {
    let count = 0;
    if (fs.existsSync(WF_DIR)) {
        fs.readdirSync(WF_DIR).forEach(f => {
            if (f.endsWith('.json') && !f.startsWith('old_')) {
                const name = f.replace('.json', '');
                try {
                    const raw = fs.readFileSync(path.join(WF_DIR, f), 'utf8');
                    const json = JSON.parse(raw);
                    workflows[name] = json;
                    workflowHashes[name] = connectorLoader.computeWorkflowHash(json);
                    count++;
                } catch (err) {
                    console.warn(`${logPrefix} Error loading workflow ${f}: ${err.message}`);
                }
            }
        });
        log(`Loaded ${count} workflows from ${WF_DIR}`);

        // Load and validate connectors against loaded workflows
        log(`Loading connectors...`);
        const connResult = connectorLoader.initialize(workflows);
        if (connResult.warnings.length > 0) {
            for (const w of connResult.warnings) {
                console.warn(`${logPrefix} ⚠️ ${w}`);
            }
        }
        if (connResult.errors.length > 0) {
            console.error(`${logPrefix} ❌ Connector errors: ${connResult.errors.length}`);
        }

        // Check that every workflow has a matching connector
        const missingConnectors = [];
        for (const wfName of Object.keys(workflows)) {
            if (!connectorLoader.getConnector(wfName)) {
                missingConnectors.push(wfName);
            }
        }
        if (missingConnectors.length > 0) {
            const msg = `Missing connectors for workflows: ${missingConnectors.join(', ')}. ` +
                `Every workflow must have a matching connector file in /data/connectors/.`;
            console.error(`${logPrefix} ❌ FATAL: ${msg}`);
            throw new Error(msg);
        }

        log(`Connectors: ${Object.keys(connResult.connectors).length} loaded, ` +
            `${connResult.warnings.length} warnings, ${connResult.errors.length} errors`);
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

/**
 * Get the connector for a given workflow name.
 * Returns null if no connector is registered for this workflow.
 */
function getConnector(workflowName) {
    return connectorLoader.getConnector(workflowName);
}

/**
 * Get the computed hash for a workflow.
 */
function getWorkflowHash(name) {
    return workflowHashes[name] || null;
}

module.exports = { loadWorkflows, getWorkflow, getConnector, getWorkflowHash, workflows };

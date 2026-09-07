// ======================================================
// Workflow Loader — v2.0.0 (Connector-aware)
// ======================================================
// Loads ComfyUI JSON workflows and their corresponding connectors from the AI
// tree (backend/ai/workflows + backend/ai/connectors), alongside skills, rules
// and assembly profiles.
//
// The connector layer abstracts workflow internals (nodeId, fields)
// so backend code never references them directly.

const fs = require('fs');
const path = require('path');
const connectorLoader = require('./connector-loader');

// Directory resolution order: explicit injection (configure) → env (WF_DIR)
// → host default (backend/ai/workflows). The default is a HOST concern —
// it moves out of the module when the connector core is extracted.
const DEFAULT_WF_DIR = path.join(__dirname, '../../ai/workflows');
let WF_DIR = process.env.WF_DIR || DEFAULT_WF_DIR;
let loggerRef = console;

const logPrefix = '[WORKFLOWS]';

function log(msg) { loggerRef.log(`${logPrefix} ${msg}`); }
function warn(msg) { loggerRef.warn(`${logPrefix} ${msg}`); }

/**
 * Dependency-injected configuration (extraction readiness): override the
 * workflows directory and/or the logger before loadWorkflows(). Env vars
 * and defaults still apply when nothing is injected.
 *
 * @param {{ workflowsDir?: string, logger?: object }} [options]
 */
function configure({ workflowsDir, logger } = {}) {
    if (workflowsDir) WF_DIR = workflowsDir;
    if (logger) loggerRef = logger;
}

/**
 * Resolve the active workflows directory (for diagnostics/messages).
 * @returns {string}
 */
function getWorkflowsDir() {
    return WF_DIR;
}

const workflows = {};
const workflowHashes = {}; // name → sha256

function loadWorkflows() {
    let count = 0;
    // Fresh-load semantics: clear previous entries so re-loading after a
    // directory change (tests, hot reload) never leaves phantom workflows.
    for (const key of Object.keys(workflows)) delete workflows[key];
    for (const key of Object.keys(workflowHashes)) delete workflowHashes[key];
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
                    warn(`Error loading workflow ${f}: ${err.message}`);
                }
            }
        });
        log(`Loaded ${count} workflows from ${WF_DIR}`);

        // Load and validate connectors against loaded workflows
        log(`Loading connectors...`);
        const connResult = connectorLoader.initialize(workflows);
        if (connResult.warnings.length > 0) {
            for (const w of connResult.warnings) {
                warn(`⚠️ ${w}`);
            }
        }
        if (connResult.errors.length > 0) {
            loggerRef.error(`${logPrefix} ❌ Connector errors: ${connResult.errors.length}`);
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
                `Every workflow must have a matching connector file in the connectors dir (${connectorLoader.getConnectorsDir()}).`;
            loggerRef.error(`${logPrefix} ❌ FATAL: ${msg}`);
            throw new Error(msg);
        }

        log(`Connectors: ${Object.keys(connResult.connectors).length} loaded, ` +
            `${connResult.warnings.length} warnings, ${connResult.errors.length} errors`);
    } else {
        warn(`Workflow directory not found: ${WF_DIR}`);
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

module.exports = { loadWorkflows, getWorkflow, getConnector, getWorkflowHash, workflows, configure, getWorkflowsDir };

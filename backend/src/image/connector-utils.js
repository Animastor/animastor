// ======================================================
// Image Connector Utilities
// ======================================================

const wfLoader = require('../workflows/workflow-loader');
const profileOverride = require('../services/profile-override');

const WORKFLOW_NAME = 'img-qwen-image';

function getImageNodeId(entityKey) {
  const connector = wfLoader.getConnector(WORKFLOW_NAME);
  if (connector) {
    const cl = require('../workflows/connector-loader');
    const nodeId = cl.getNodeId(connector, entityKey);
    if (nodeId) return nodeId;
  }
  return null;
}

function applyImageValue(wf, entityKey, value) {
  const connector = wfLoader.getConnector(WORKFLOW_NAME);
  if (connector) {
    const cl = require('../workflows/connector-loader');
    return cl.setValue(wf, connector, entityKey, value);
  }
  return false;
}

/**
 * Pure helper (testable): extract the image assembly-profile name from a
 * connector object. Returns null when no connector/profile exists — callers
 * fall back to the built-in assembly then (there is no 'default' profile).
 * @param {object|null} connector
 * @returns {string|null}
 */
function imageProfileNameFromConnector(connector) {
    return connector?.profile?.imageProfile || null;
}

/**
 * Resolve the image assembly-profile name. A user override (global settings
 * choice) wins; otherwise the image workflow's connector profile
 * (e.g. "qwen-image" via conn-image-generation.json); finally null (built-in
 * assembly).
 * @returns {string|null}
 */
function resolveImageProfileName() {
    return profileOverride.getOverride('image')
        || imageProfileNameFromConnector(wfLoader.getConnector(WORKFLOW_NAME));
}

module.exports = {
    getImageNodeId,
    applyImageValue,
    imageProfileNameFromConnector,
    resolveImageProfileName,
    WORKFLOW_NAME,
};

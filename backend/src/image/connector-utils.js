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
 * connector object. Falls back to 'default' when no connector/profile exists.
 * @param {object|null} connector
 * @returns {string}
 */
function imageProfileNameFromConnector(connector) {
    return connector?.profile?.imageProfile || 'default';
}

/**
 * Resolve the image assembly-profile name. A user override (global settings
 * choice) wins; otherwise the image workflow's connector profile
 * (e.g. "qwen-image" via conn-image-generation.json); finally "default".
 * @returns {string}
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

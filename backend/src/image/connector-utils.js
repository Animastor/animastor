// ======================================================
// Image Connector Utilities
// ======================================================

const wfLoader = require('../workflows/workflow-loader');

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

module.exports = {
    getImageNodeId,
    applyImageValue,
    WORKFLOW_NAME,
};

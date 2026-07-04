// ======================================================
// Audio Connector Utilities
// ======================================================

const { execSync } = require('child_process');
const wfLoader = require('../workflows/workflow-loader');

let _ffmpegChecked = false;
let _ffmpegAvailable = false;

function isFFmpegAvailable() {
  if (!_ffmpegChecked) {
    try {
      execSync('ffmpeg -version', { stdio: 'ignore', timeout: 3000 });
      _ffmpegAvailable = true;
    } catch {
      _ffmpegAvailable = false;
    }
    _ffmpegChecked = true;
  }
  return _ffmpegAvailable;
}

function applyAudioValue(wf, workflowName, entityKey, value) {
  const connector = wfLoader.getConnector(workflowName);
  if (connector) {
    const cl = require('../workflows/connector-loader');
    return cl.setValue(wf, connector, entityKey, value);
  }
  return false;
}

function getAudioNodeId(workflowName, entityKey) {
  const connector = wfLoader.getConnector(workflowName);
  if (connector) {
    const cl = require('../workflows/connector-loader');
    return cl.getNodeId(connector, entityKey);
  }
  return null;
}

module.exports = {
    isFFmpegAvailable,
    applyAudioValue,
    getAudioNodeId,
};

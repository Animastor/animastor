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

/**
 * Pure helper (testable): extract the audio assembly-profile name from a
 * connector object. Falls back to 'default' when no connector/profile exists.
 * @param {object|null} connector
 * @returns {string}
 */
function audioProfileNameFromConnector(connector) {
    return connector?.profile?.audioProfile || 'default';
}

module.exports = {
    isFFmpegAvailable,
    applyAudioValue,
    getAudioNodeId,
    audioProfileNameFromConnector,
};

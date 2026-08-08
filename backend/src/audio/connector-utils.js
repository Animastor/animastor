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
 * connector object. Returns null when no connector/profile exists — callers
 * fall back to the built-in assembly then (there is no 'default' profile).
 * @param {object|null} connector
 * @returns {string|null}
 */
function audioProfileNameFromConnector(connector) {
    return connector?.profile?.audioProfile || null;
}

module.exports = {
    isFFmpegAvailable,
    applyAudioValue,
    getAudioNodeId,
    audioProfileNameFromConnector,
};

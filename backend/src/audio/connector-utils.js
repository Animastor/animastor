// ======================================================
// Audio Media Utilities (S-3)
// ======================================================
// Local audio media utilities ONLY (ffmpeg availability probe).
// ComfyUI/provider knowledge (applyAudioValue / getAudioNodeId /
// audioProfileNameFromConnector) was removed in S-3 — that knowledge lives
// exclusively in the generation provider seam
// (backend/src/generation/comfyui-provider.js: applyValue / getNodeId /
// profileNameFromConnector). audio-service.js keeps delegating shims so the
// barrel surface is unchanged.

const { execSync } = require('child_process');

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

module.exports = {
    isFFmpegAvailable,
};

// ======================================================
// ANIMASTOR BACKEND — CONFIG ROUTES
// ======================================================
// /api/v1/config endpoints — client-facing limits consumed by the editors.
//
// The limits are served from the backend so the Android + web editors enforce
// the SAME values the server validates on save (core-routes.cjs prompt guard).
// If a limit later becomes a user-configurable setting (Settings screen), this
// endpoint can read it from a settings store while falling back to the module
// constant — the client contract ({ limits: {...} }) stays unchanged.

const { IMAGE_PROMPT_MAX_CHARS } = require('../services/agent-prompts');

module.exports = function(app) {
    // ======================================================
    // GET APP CONFIG — limits for the editors
    // ======================================================
    app.get('/api/v1/config', (req, res) => {
        res.json({
            limits: {
                // Max chars for a frame prompt (image.prompt / video.action) —
                // matches the save-boundary validation in core-routes.cjs.
                image_prompt_max_chars: IMAGE_PROMPT_MAX_CHARS,
            },
        });
    });

    console.log('[ROUTES] Config routes loaded');
};

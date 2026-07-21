// ======================================================
// ANIMASTOR BACKEND — CONNECTOR ROUTES
// ======================================================
// /api/v1/connectors/* endpoints.
//
// Connector Registry API for Workflow Manager UI.

module.exports = function(app, redis, deps) {
    const { wfManager } = deps;
    const { log } = deps.utils || { log: console.log };

    // ⚠️ IMPORTANT: Static routes MUST be defined BEFORE parameterized routes (:name).
    // Express matches routes top-to-bottom — /grouped would match as :name otherwise.

    // ======================================================
    // LIST ALL CONNECTORS
    // ======================================================
    app.get('/api/v1/connectors', async (req, res) => {
        try {
            const connectors = wfManager.listConnectors();
            res.json({ connectors });
        } catch (err) {
            console.error('[CONNECTORS] List error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // ADD NEW CONNECTOR (static — must be before :name)
    // ======================================================
    app.post('/api/v1/connectors', async (req, res) => {
        try {
            const { name, connector } = req.body || {};
            if (!name || !connector) {
                return res.status(400).json({
                    error: 'Both "name" (string) and "connector" (object) are required in request body'
                });
            }

            // Validate the name format (conn- prefix expected)
            if (!name.startsWith('conn-')) {
                return res.status(400).json({
                    error: 'Connector name must start with "conn-" prefix'
                });
            }

            const result = wfManager.addConnector(name, connector);
            if (!result.ok) {
                return res.status(400).json({ error: result.error });
            }

            log(`[CONNECTORS] New connector added: ${name}`);
            res.status(201).json({
                ok: true,
                name,
                warnings: result.warnings,
                message: `Connector "${name}" added successfully`
            });
        } catch (err) {
            console.error('[CONNECTORS] Add error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // VALIDATE CONNECTOR JSON (static — must be before :name)
    // ======================================================
    app.post('/api/v1/connectors/validate', async (req, res) => {
        try {
            const { connector, name } = req.body || {};
            if (!connector) {
                return res.status(400).json({ error: 'connector JSON object required in body' });
            }
            const result = wfManager.validateConnectorJson(connector, name);
            res.json(result);
        } catch (err) {
            console.error('[CONNECTORS] Validate error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // RELOAD ALL CONNECTORS FROM DISK (static — must be before :name)
    // ======================================================
    app.post('/api/v1/connectors/reload', async (req, res) => {
        try {
            const result = wfManager.reloadConnectors();
            res.json({
                ok: true,
                connectorsLoaded: result.connectors,
                warnings: result.warnings,
                errors: result.errors
            });
        } catch (err) {
            console.error('[CONNECTORS] Reload error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // GET ENTITY SCHEMA (static — must be before :name)
    // ======================================================
    app.get('/api/v1/connectors/entities', async (req, res) => {
        try {
            const { kind } = req.query;
            let entities;
            if (kind) {
                entities = wfManager.getEntitiesByKind(kind);
            } else {
                entities = wfManager.listEntities();
            }
            res.json({ entities });
        } catch (err) {
            console.error('[CONNECTORS] Entities error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // GET CONNECTORS BY TYPE (static — must be before :name)
    // ======================================================
    app.get('/api/v1/connectors/grouped', async (req, res) => {
        try {
            const result = wfManager.getConnectorsGrouped();
            res.json(result);
        } catch (err) {
            console.error('[CONNECTORS] Grouped error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // GET CONNECTOR DETAIL (parameterized — must be after all static routes)
    // ======================================================
    app.get('/api/v1/connectors/:name', async (req, res) => {
        try {
            const { name } = req.params;
            const detail = wfManager.getConnectorDetail(name);
            if (!detail) {
                return res.status(404).json({ error: `Connector "${name}" not found` });
            }
            res.json(detail);
        } catch (err) {
            console.error('[CONNECTORS] Detail error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // GET CONNECTOR COMPATIBILITY STATUS (parameterized)
    // ======================================================
    app.get('/api/v1/connectors/:name/compatibility', async (req, res) => {
        try {
            const { name } = req.params;
            const status = wfManager.getConnectorCompatibility(name);
            if (!status) {
                return res.status(404).json({ error: `Connector "${name}" not found` });
            }
            res.json(status);
        } catch (err) {
            console.error('[CONNECTORS] Compatibility error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // UPDATE CONNECTOR PARAMETER (parameterized)
    // ======================================================
    app.put('/api/v1/connectors/:name/parameters', async (req, res) => {
        try {
            const { name } = req.params;
            const { paramKey, value } = req.body || {};

            if (!paramKey) {
                return res.status(400).json({ error: 'paramKey is required in body' });
            }

            const result = wfManager.updateConnectorParameter(name, paramKey, value);
            if (!result.ok) {
                const status = result.error?.includes('not found') ? 404 : 400;
                return res.status(status).json({ error: result.error });
            }

            res.json(result);
        } catch (err) {
            console.error('[CONNECTORS] Update parameter error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // GET CONNECTOR PARAMETER VALUES (parameterized)
    // ======================================================
    app.get('/api/v1/connectors/:name/parameters', async (req, res) => {
        try {
            const { name } = req.params;
            const values = wfManager.getConnectorParameterValues(name);
            if (values === null) {
                return res.status(404).json({ error: `Connector "${name}" not found` });
            }
            res.json({ values });
        } catch (err) {
            console.error('[CONNECTORS] Get parameter values error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // UPDATE CONNECTOR STATUS (enable/disable) (parameterized)
    // ======================================================
    app.put('/api/v1/connectors/:name/status', async (req, res) => {
        try {
            const { name } = req.params;
            const { enabled } = req.body || {};

            if (typeof enabled !== 'boolean') {
                return res.status(400).json({ error: 'enabled (boolean) is required in body' });
            }

            const result = wfManager.setConnectorStatus(name, enabled);
            if (!result.ok) {
                return res.status(404).json({ error: result.error });
            }

            res.json(result);
        } catch (err) {
            console.error('[CONNECTORS] Status error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // GET PROMPT PROFILES — active profiles + available options by type
    // ======================================================
    app.get('/api/v1/connectors/profiles', async (req, res) => {
        try {
            const result = wfManager.getConnectorsGrouped();
            const profiles = { audio: null, image: null, video: null };

            for (const type of ['audio', 'image', 'video']) {
                const connectors = result[type] || [];
                // Collect unique profiles from all connectors of this type
                const profileSet = new Set();
                for (const conn of connectors) {
                    if (conn.profile) {
                        if (conn.profile.audioProfile) profileSet.add(conn.profile.audioProfile);
                        if (conn.profile.imageProfile) profileSet.add(conn.profile.imageProfile);
                        if (conn.profile.videoProfile) profileSet.add(conn.profile.videoProfile);
                    }
                }
                if (profileSet.size > 0) {
                    profiles[type] = Array.from(profileSet).join(', ');
                }
            }

            // Include available profile options from skill files
            const profileLoader = require('../services/prompt-profile-loader');
            const options = profileLoader.listAvailableProfiles();

            res.json({ profiles, options });
        } catch (err) {
            console.error('[CONNECTORS] Profiles error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // UPDATE CONNECTOR BINDING (parameterized)
    // ======================================================
    app.put('/api/v1/connectors/:name/bindings', async (req, res) => {
        try {
            const { name } = req.params;
            const { section, entityKey, nodeId, field } = req.body || {};

            if (!section || !entityKey) {
                return res.status(400).json({ error: '"section" (inputs|outputs) and "entityKey" are required in body' });
            }

            const updates = {};
            if (nodeId !== undefined) updates.nodeId = nodeId;
            if (field !== undefined) updates.field = field;

            if (Object.keys(updates).length === 0) {
                return res.status(400).json({ error: 'At least one of "nodeId" or "field" must be provided' });
            }

            const result = wfManager.updateConnectorBinding(name, section, entityKey, updates);
            if (!result.ok) {
                return res.status(404).json({ error: result.error });
            }

            log(`[CONNECTORS] Binding updated: ${name}.${section}.${entityKey}`);
            res.json({ ok: true });
        } catch (err) {
            console.error('[CONNECTORS] Update binding error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // GET CONNECTOR RAW JSON (parameterized — Developer Mode)
    // ======================================================
    app.get('/api/v1/connectors/:name/raw', async (req, res) => {
        try {
            const { name } = req.params;
            const connector = wfManager.getRawConnector(name);
            if (!connector) {
                return res.status(404).json({ error: `Connector "${name}" not found` });
            }
            res.json(connector);
        } catch (err) {
            console.error('[CONNECTORS] Raw error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    log('[ROUTES] Connector routes loaded');
};

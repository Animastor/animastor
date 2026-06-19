// ======================================================
// ANIMASTOR BACKEND — CONNECTOR ROUTES
// ======================================================
// /api/v1/connectors/* endpoints.
//
// Connector Registry API for Workflow Manager UI.
//
// Usage:
//   require('./routes/connector-routes.cjs')(app, redis, deps);

module.exports = function(app, redis, deps) {
    const { wfManager } = deps;
    const { log } = deps.utils || { log: console.log };

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
    // GET CONNECTOR DETAIL
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
    // GET CONNECTOR COMPATIBILITY STATUS
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
    // GET CONNECTOR RAW JSON (Developer Mode)
    // ======================================================
    app.get('/api/v1/connectors/:name/raw', async (req, res) => {
        try {
            const { name } = req.params;
            const connector = wfManager.getRawConnector(name);
            if (!connector) {
                return res.status(404).json({ error: `Connector "${name}" not found` });
            }
            // Return full raw connector (including nodeIds, bindings, etc.)
            res.json(connector);
        } catch (err) {
            console.error('[CONNECTORS] Raw error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // VALIDATE CONNECTOR JSON
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
    // RELOAD ALL CONNECTORS FROM DISK
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
    // GET ENTITY SCHEMA
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
    // GET CONNECTORS BY TYPE (grouped)
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

    log('[ROUTES] Connector routes loaded');
};

// ======================================================
// ANIMASTOR BACKEND — WORKFLOW ROUTES
// ======================================================
// /api/v1/workflows/* endpoints.
//
// Workflow status API for Workflow Manager UI.
//
// Usage:
//   require('./routes/workflow-routes.cjs')(app, redis, deps);

module.exports = function(app, redis, deps) {
    const { wfManager } = deps;
    const { log } = deps.utils || { log: console.log };

    // ======================================================
    // LIST ALL WORKFLOWS
    // ======================================================
    app.get('/api/v1/workflows', async (req, res) => {
        try {
            const workflows = wfManager.listWorkflows();
            res.json({ workflows });
        } catch (err) {
            console.error('[WORKFLOWS] List error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // GET WORKFLOW DETAIL
    // ======================================================
    app.get('/api/v1/workflows/:name', async (req, res) => {
        try {
            const { name } = req.params;
            const detail = wfManager.getWorkflowDetail(name);
            if (!detail) {
                return res.status(404).json({ error: `Workflow "${name}" not found` });
            }
            res.json(detail);
        } catch (err) {
            console.error('[WORKFLOWS] Detail error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // GET WORKFLOW HASH
    // ======================================================
    app.get('/api/v1/workflows/:name/hash', async (req, res) => {
        try {
            const { name } = req.params;
            const hash = wfManager.getWorkflowHash(name);
            if (hash === null) {
                return res.status(404).json({ error: `Workflow "${name}" not found` });
            }
            res.json({ name, hash });
        } catch (err) {
            console.error('[WORKFLOWS] Hash error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // GET WORKFLOW SUMMARY (counts by type)
    // ======================================================
    app.get('/api/v1/workflows/summary', async (req, res) => {
        try {
            const workflows = wfManager.listWorkflows();
            const summary = {
                total: workflows.length,
                byType: {},
                withConnector: 0,
                withoutConnector: 0
            };

            for (const wf of workflows) {
                summary.byType[wf.type] = (summary.byType[wf.type] || 0) + 1;
                if (wf.hasConnector) summary.withConnector++;
                else summary.withoutConnector++;
            }

            res.json(summary);
        } catch (err) {
            console.error('[WORKFLOWS] Summary error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    log('[ROUTES] Workflow routes loaded');
};

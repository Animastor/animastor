#!/usr/bin/env node
// ======================================================
// animastor-ai-connector — CLI entrypoint (LAC-3, Phase 3)
// ======================================================
// One command, one outbound connection:
//   npx animastor-ai-connector --url wss://…/api/v1/ai-connector/ws \
//     --token llmcreg.… --runtime-type ollama
//
// V1 surface: registration/activation (hello/ready), heartbeat with
// discovered models, explicit model discovery (models.refresh → ONE local
// GET /v1/models). No inference, no proxy surface, no filesystem/shell
// access, metadata-only logging (AD-6).
//
// Credential handling: a one-time llmcreg.* token activates the connector
// and the freshly minted llmc.* credential is printed EXACTLY ONCE (stdout,
// prefixed) — never logged again, never persisted by the connector itself.
// ======================================================

const { parseConfig, usage } = require('./lib/config.cjs');
const { createConnectorSession } = require('./lib/connector.cjs');

function main() {
    const argv = process.argv.slice(2);
    if (argv.includes('--help') || argv.includes('-h')) {
        console.log(usage());
        process.exit(0);
    }
    const parsed = parseConfig(argv);
    if (!parsed.ok) {
        // Errors never echo token material (config validates shape only).
        console.error('Configuration invalid:');
        for (const e of parsed.errors) console.error(`  - ${e}`);
        console.error('\n' + usage());
        process.exit(2);
    }
    const cfg = parsed.config;

    let printedActivation = false;
    const session = createConnectorSession({
        config: cfg,
        logger: console,
        hooks: {
            // §8.1 step 5: the minted llmc.* arrives EXACTLY once in ready —
            // sole disclosure is this single stdout line (never logged).
            onCredential(credential) {
                if (printedActivation) return;
                printedActivation = true;
                process.stdout.write('\nConnector activated. Persistent credential (store it now, shown once):\n');
                process.stdout.write(`${credential}\n\n`);
            },
        },
    });

    const shutdown = () => {
        session.stop();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    session.start();
}

if (require.main === module) {
    main();
}

module.exports = { main };

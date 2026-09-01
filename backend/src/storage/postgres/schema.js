const { query } = require('./database');

const SCHEMA_SQL = `
-- ======================================================
-- Animastor PostgreSQL Schema
-- Canonical persistent state layer
-- ======================================================

-- Users / accounts
CREATE TABLE IF NOT EXISTS users (
    user_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username            TEXT UNIQUE NOT NULL,
    password_hash       TEXT,
    email               TEXT UNIQUE,
    recovery_key_hash   TEXT,
    display_name        TEXT,
    avatar_url          TEXT,
    role                TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin','premium')),
    settings            JSONB DEFAULT '{}',
    created_at          BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
    updated_at          BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint)
);

-- Workspaces (ownership boundary for books)
CREATE TABLE IF NOT EXISTS workspaces (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    owner_user_id   UUID REFERENCES users(user_id),
    type            TEXT NOT NULL DEFAULT 'personal' CHECK(type IN ('personal','temporary','team')),
    expires_at      BIGINT,
    created_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
    updated_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint)
);

CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_user_id);
-- NOTE: idx_workspaces_expires is created by migration GW-2 together with the
-- expires_at column — it cannot live here because on a pre-existing DB the
-- workspaces table already lacks that column and the index statement would
-- fail before GW-2 gets a chance to add it.


-- Workspace members (collaboration foundation)
CREATE TABLE IF NOT EXISTS workspace_members (
    workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    role            TEXT NOT NULL DEFAULT 'viewer' CHECK(role IN ('owner','editor','viewer')),
    created_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
    PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members(user_id);

-- Guest identities (temporary workspace access, no username/password)
CREATE TABLE IF NOT EXISTS guests (
    guest_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash      TEXT NOT NULL UNIQUE,
    workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    created_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint * 1000),
    expires_at      BIGINT NOT NULL,
    revoked_at      BIGINT
);

CREATE INDEX IF NOT EXISTS idx_guests_workspace ON guests(workspace_id);

-- Workspace AI provider (Experimental Beta — Milestone 1)
-- ONE active provider per workspace — PK enforces the single-row invariant.
-- api_key_enc is AES-256-GCM ciphertext (iv:tag:payload) — never plaintext.
-- provider_type is a TEXT enum-like: 'openrouter' | 'openai-compatible' | 'custom'
--   (custom kept for back-compat with the very first rollout). The 'provider'
--   column is the legacy duplicate of provider_type — kept for one release so
--   any caller still reading the old field keeps seeing the same value.
-- status is derived from the most recent Test Connection. ON DELETE CASCADE:
-- purging a (guest) workspace purges its AI provider too.
CREATE TABLE IF NOT EXISTS workspace_ai_providers (
    workspace_id    UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    provider        TEXT NOT NULL DEFAULT 'openai-compatible',
    provider_type   TEXT NOT NULL DEFAULT 'openai-compatible',
    endpoint        TEXT NOT NULL,
    api_key_enc     TEXT NOT NULL,
    model           TEXT,
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    status          TEXT NOT NULL DEFAULT 'untested' CHECK(status IN ('untested','ok','failed')),
    last_tested_at  BIGINT,
    created_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
    updated_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint)
);

-- System settings (platform-level JSONB key/value store, SYS-1)
-- Used by the admin kill-switch: 'system_ai' key -> { enabled: boolean }.
-- Generic enough to host future platform toggles without new tables.
CREATE TABLE IF NOT EXISTS system_settings (
    key         TEXT PRIMARY KEY,
    value       JSONB NOT NULL,
    updated_at  BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint)
);

-- System AI provider (platform-level, admin-configured)
-- One row keyed by id='default'. Stores the encrypted key, model and endpoint
-- the admin configures for the platform — independent of any workspace.
-- Reuses the same AES-256-GCM ciphertext envelope as workspace_ai_providers
-- (encrypted by encryptSecret in workspace-ai-provider.js — see migration
-- SYS-1 below). Source: env vars still act as a secondary fallback.
CREATE TABLE IF NOT EXISTS system_ai_providers (
    id             TEXT PRIMARY KEY DEFAULT 'default',
    provider_type  TEXT NOT NULL DEFAULT 'openai-compatible',
    endpoint       TEXT NOT NULL,
    api_key_enc    TEXT NOT NULL,
    model          TEXT,
    status         TEXT NOT NULL DEFAULT 'untested' CHECK(status IN ('untested','ok','failed')),
    last_tested_at BIGINT,
    created_at     BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
    updated_at     BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint)
);

-- Insert the default key only when not yet seeded. The value is the kill-switch
-- default: ON (preserves existing beta behaviour — explicit, not implicit).
INSERT INTO system_settings (key, value)
VALUES ('system_ai', '{"enabled": true}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Sessions (server-side auth sessions, hardened by migration step AM-*)
CREATE TABLE IF NOT EXISTS sessions (
    session_id      UUID PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    token_hash      TEXT NOT NULL,
    created_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint * 1000),
    expires_at      BIGINT NOT NULL,
    revoked_at      BIGINT
);

CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Books registry
CREATE TABLE IF NOT EXISTS books (
    book_id         TEXT PRIMARY KEY,
    workspace_id    UUID REFERENCES workspaces(id),
    user_id         UUID REFERENCES users(user_id),
    title           TEXT,
    author          TEXT,
    language        TEXT DEFAULT 'en',
    visibility      TEXT DEFAULT 'private' CHECK(visibility IN ('private','public','shared')),
    tags            TEXT[] DEFAULT '{}',
    created_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
    updated_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
    metadata        JSONB
);

-- Book versions (snapshots for diff)
CREATE TABLE IF NOT EXISTS book_snapshots (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    book_id         TEXT NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
    version         INTEGER NOT NULL DEFAULT 1,
    snapshot        JSONB NOT NULL,
    created_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
    state           TEXT NOT NULL DEFAULT 'old' CHECK(state IN ('old','working','new')),
    UNIQUE(book_id, version)
);

-- Scene metadata
CREATE TABLE IF NOT EXISTS scenes (
    scene_id        TEXT NOT NULL,
    chapter_id      TEXT NOT NULL,
    book_id         TEXT NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
    scene_order     INTEGER NOT NULL DEFAULT 0,
    scene_type      TEXT DEFAULT 'narration',
    title           TEXT,
    status          TEXT DEFAULT 'pending' CHECK(status IN ('pending','generating','ready','failed','dirty')),
    scene_hash      TEXT,
    build_id        TEXT,
    created_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
    updated_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
    metadata        JSONB,
    PRIMARY KEY (book_id, chapter_id, scene_id)
);

-- Per-layer asset state
CREATE TABLE IF NOT EXISTS asset_states (
    book_id         TEXT NOT NULL,
    chapter_id      TEXT NOT NULL,
    scene_id        TEXT NOT NULL,
    layer           TEXT NOT NULL CHECK(layer IN ('audio','image','video','filesystem')),
    status          TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('clean','dirty','queued','generating','ready','failed')),
    hash            TEXT,
    version         INTEGER DEFAULT 1,
    updated_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
    error           TEXT,
    PRIMARY KEY (book_id, chapter_id, scene_id, layer)
);

-- Cache manifest (deterministic asset tracking)
CREATE TABLE IF NOT EXISTS cache_entries (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    asset_key       TEXT NOT NULL UNIQUE,
    book_id         TEXT NOT NULL,
    chapter_id      TEXT,
    scene_id        TEXT,
    asset_type      TEXT NOT NULL CHECK(asset_type IN ('audio','image','video','manifest','preview')),
    file_path       TEXT,
    file_size       BIGINT,
    content_hash    TEXT,
    version         INTEGER DEFAULT 1,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready','stale','failed')),
    created_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
    updated_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
    metadata        JSONB
);

CREATE INDEX IF NOT EXISTS idx_cache_book ON cache_entries(book_id);
CREATE INDEX IF NOT EXISTS idx_cache_scene ON cache_entries(book_id, chapter_id, scene_id);
CREATE INDEX IF NOT EXISTS idx_cache_status ON cache_entries(status);
CREATE INDEX IF NOT EXISTS idx_cache_hash ON cache_entries(content_hash);

-- Asset dependency graph
CREATE TABLE IF NOT EXISTS asset_dependencies (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    book_id         TEXT NOT NULL,
    source_layer    TEXT NOT NULL,
    target_layer    TEXT NOT NULL,
    description     TEXT,
    UNIQUE(book_id, source_layer, target_layer)
);

-- Generation task history
-- workspace_id (PW-2): server-derived ownership anchor for workspace-aware
-- job ownership. Resolved at dispatch from book → books.workspace_id and
-- never client-supplied. Nullable: legacy rows and system-pool tasks may
-- lack it.
CREATE TABLE IF NOT EXISTS generation_tasks (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    task_id         TEXT NOT NULL,
    book_id         TEXT NOT NULL,
    chapter_id      TEXT,
    scene_id        TEXT,
    task_type       TEXT NOT NULL CHECK(task_type IN ('audio','image','video')),
    status          TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','cancelled')),
    worker_id       TEXT,
    workspace_id    UUID REFERENCES workspaces(id),
    retry_count     INTEGER DEFAULT 0,
    max_retries     INTEGER DEFAULT 3,
    error           TEXT,
    created_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
    started_at      BIGINT,
    completed_at    BIGINT,
    metadata        JSONB
);

CREATE INDEX IF NOT EXISTS idx_tasks_book ON generation_tasks(book_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON generation_tasks(status);
-- NOTE: idx_tasks_workspace is created by migration PW-2 below — it must run
-- AFTER the workspace_id column exists (on existing databases the CREATE
-- TABLE IF NOT EXISTS above does not add the column).

-- Private Worker registry (Experimental Beta — Private Worker Phase 1)
-- Durable source of truth for private worker identity and credentials.
-- Identity is server-assigned (UUID) and NEVER client-supplied. The
-- credential secret exists only as a SHA-256 hash (sessions/guests
-- pattern). workspace_id is the ownership anchor, ON DELETE CASCADE
-- purges a workspace's workers together with the workspace itself.
-- NOTE: the original dormant version of this table (self-chosen TEXT PK,
-- no workspace/token columns, worker_type CHECK including 'upscale') is
-- rebuilt by migration PW-1 below, a real migration not a free ALTER.
CREATE TABLE IF NOT EXISTS workers (
    worker_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- NULL only for mode='system' (Animastor-operated pool), enforced by
    -- the workers_scope_check constraint below (FC: fail-closed registry).
    workspace_id    UUID REFERENCES workspaces(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    worker_type     TEXT NOT NULL CHECK(worker_type IN ('audio','image','video')),
    capabilities    JSONB,
    mode            TEXT NOT NULL DEFAULT 'private' CHECK(mode IN ('private','share','system')),
    status          TEXT NOT NULL DEFAULT 'offline' CHECK(status IN ('online','offline','busy','error')),
    token_hash      TEXT NOT NULL UNIQUE,
    token_prefix    TEXT,
    created_by      UUID REFERENCES users(user_id),
    revoked_at      BIGINT,
    last_seen       BIGINT,
    version         TEXT,
    metadata        JSONB,
    created_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
    -- FAIL CLOSED ownership anchor: only Animastor-operated workers may be
    -- workspace-less — private/share workers ALWAYS belong to a workspace.
    CONSTRAINT workers_scope_check CHECK (mode = 'system' OR workspace_id IS NOT NULL)
);

-- (index idx_workers_workspace is created by migration PW-1 below — it must
-- not run from SCHEMA_SQL: on a pre-existing legacy workers table the
-- workspace_id column does not yet exist, and PW-1 is the real migration)

-- Reconciliation & recovery log
CREATE TABLE IF NOT EXISTS reconciliation_events (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    book_id         TEXT NOT NULL,
    event_type      TEXT NOT NULL,
    details         TEXT,
    created_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint)
);

-- Build manifests (per-build output tracking)
CREATE TABLE IF NOT EXISTS output_manifests (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    build_id        TEXT NOT NULL,
    book_id         TEXT NOT NULL,
    asset_type      TEXT NOT NULL,
    scene_count     INTEGER DEFAULT 0,
    total_size      BIGINT DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'building' CHECK(status IN ('building','ready','failed')),
    created_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
    completed_at    BIGINT,
    UNIQUE(build_id, book_id, asset_type)
);

-- Per-IU metadata (storyboard items)
CREATE TABLE IF NOT EXISTS image_units (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    book_id         TEXT NOT NULL,
    build_id        TEXT NOT NULL,
    chapter_id      TEXT NOT NULL,
    scene_id        TEXT NOT NULL,
    unit_id         TEXT NOT NULL,
    scene_order     INTEGER NOT NULL DEFAULT 0,
    text            TEXT,
    text_length     INTEGER DEFAULT 0,
    text_proportion REAL DEFAULT 0,
    scene_duration_sec REAL DEFAULT 0,
    estimated_duration_sec REAL DEFAULT 0,
    scene_audio_file TEXT,
    start_ms        BIGINT DEFAULT 0,
    end_ms          BIGINT DEFAULT 0,
    created_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
    UNIQUE(build_id, book_id, chapter_id, scene_id, unit_id)
);

CREATE INDEX IF NOT EXISTS idx_image_units_book ON image_units(book_id);
CREATE INDEX IF NOT EXISTS idx_image_units_build ON image_units(build_id);
CREATE INDEX IF NOT EXISTS idx_image_units_scene ON image_units(build_id, book_id, chapter_id, scene_id);

-- ======================================================
-- Future tables (ready for upcoming features)
-- ======================================================

-- Storyboard elements (rich scene breakdown)
CREATE TABLE IF NOT EXISTS storyboard_elements (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    book_id         TEXT NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
    chapter_id      TEXT NOT NULL,
    scene_id        TEXT NOT NULL,
    element_type    TEXT NOT NULL CHECK(element_type IN ('character','background','action','dialog','effect','transition','camera','lighting')),
    content         JSONB NOT NULL DEFAULT '{}',
    sort_order      INTEGER DEFAULT 0,
    created_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
    updated_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint)
);

CREATE INDEX IF NOT EXISTS idx_storyboard_scene ON storyboard_elements(book_id, chapter_id, scene_id);

-- Audio layers (per-scene audio tracks)
CREATE TABLE IF NOT EXISTS audio_layers (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    book_id         TEXT NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
    chapter_id      TEXT NOT NULL,
    scene_id        TEXT NOT NULL,
    layer_type      TEXT NOT NULL CHECK(layer_type IN ('narration','music','sfx','ambient','silence')),
    source          TEXT,
    duration_sec    REAL DEFAULT 0,
    volume          REAL DEFAULT 1.0,
    fade_in         REAL DEFAULT 0,
    fade_out        REAL DEFAULT 0,
    params          JSONB DEFAULT '{}',
    created_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint)
);

CREATE INDEX IF NOT EXISTS idx_audio_scene ON audio_layers(book_id, chapter_id, scene_id);

-- ======================================================
-- Phase A: Persistent asset registry, chat, event log
-- ======================================================

-- Scene assets (path of truth for asset files + metadata)
CREATE TABLE IF NOT EXISTS scene_assets (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    book_id         TEXT NOT NULL,
    chapter_id      TEXT NOT NULL,
    scene_id        TEXT NOT NULL,
    asset_type      TEXT NOT NULL CHECK(asset_type IN ('audio','image','video','storyboard','subtitle','preview','manifest')),
    path            TEXT,
    duration_sec    REAL,
    width           INTEGER,
    height          INTEGER,
    format          TEXT,
    sample_rate     INTEGER,
    channel_count   INTEGER,
    chunks          JSONB,
    build_id        TEXT,
    scene_hash      TEXT,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready','stale','failed','missing','placeholder')),
    error           TEXT,
    metadata        JSONB,
    created_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
    updated_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
    UNIQUE(book_id, chapter_id, scene_id, asset_type, build_id)
);

CREATE INDEX IF NOT EXISTS idx_scene_assets_scene ON scene_assets(book_id, chapter_id, scene_id);
CREATE INDEX IF NOT EXISTS idx_scene_assets_build ON scene_assets(build_id);
CREATE INDEX IF NOT EXISTS idx_scene_assets_status ON scene_assets(status);
CREATE INDEX IF NOT EXISTS idx_scene_assets_type ON scene_assets(asset_type);
CREATE INDEX IF NOT EXISTS idx_scene_assets_hash ON scene_assets(book_id, scene_hash);

-- AI chat sessions (flat table used by ai-routes.cjs for backward compatibility)
CREATE TABLE IF NOT EXISTS ai_chat_sessions (
    id              TEXT PRIMARY KEY,
    book_id         TEXT NOT NULL,
    title           TEXT NOT NULL DEFAULT 'Chat',
    mode            TEXT NOT NULL DEFAULT 'chat',
    messages        JSONB NOT NULL DEFAULT '[]'::jsonb,
    context         JSONB DEFAULT '{}'::jsonb,
    locked          BOOLEAN NOT NULL DEFAULT false,
    created_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
    updated_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint)
);

CREATE INDEX IF NOT EXISTS idx_ai_chat_sessions_book ON ai_chat_sessions(book_id);

-- Legacy chat tables (chat_sessions / chat_messages) were removed: no code
-- has read them for a long time (the chat lives in ai_chat_sessions;
-- agent cancel messages were written to a table nobody read). runMigrations
-- drops them below for existing deployments.

-- Book events (persistent, append-only history of book evolution)
CREATE TABLE IF NOT EXISTS book_events (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    book_id         TEXT NOT NULL,
    chapter_id      TEXT,
    scene_id        TEXT,
    event_type      TEXT NOT NULL,
    state           TEXT,
    actor           TEXT,
    ref_type        TEXT,
    ref_id          TEXT,
    details         JSONB,
    created_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint)
);

CREATE INDEX IF NOT EXISTS idx_events_book ON book_events(book_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_scene ON book_events(book_id, chapter_id, scene_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_type ON book_events(event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_events_ref ON book_events(ref_type, ref_id);

-- ======================================================
-- Agent pipeline (book import / scene generation agents)
-- ======================================================

-- Agent sessions: one per book import operation
CREATE TABLE IF NOT EXISTS agent_sessions (
    session_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    book_id         TEXT NOT NULL,
    source_type     TEXT NOT NULL DEFAULT 'txt_import' CHECK(source_type IN ('txt_import','ai_text','manual')),
    status          TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','paused','completed','failed','cancelled')),
    progress_msg    TEXT,
    knowledge_base  JSONB,
    window_data     JSONB,
    created_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
    updated_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint)
);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_book ON agent_sessions(book_id);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_status ON agent_sessions(status);

-- Agent steps: sequential pipeline stages
CREATE TABLE IF NOT EXISTS agent_steps (
    step_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id      UUID NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
    step_type       TEXT NOT NULL CHECK(step_type IN (
                        'analyze_structure','analyze_characters','analyze_locations',
                        'create_scenes','enrich_scenes',
                        'create_units','create_visual_prompts',
                        'collect_character_candidates','resolve_character_mentions',
                        'generate_voices',
                        'polish_storyboard','reconcile_passports',
                        'reconcile_video_actions','polish_video_actions',
                        'repair_fantasy_snakes'
                    )),
    step_index      INTEGER NOT NULL DEFAULT 0,
    scene_index     INTEGER, -- NULL for whole-chapter steps, scene index for per-scene steps
    status          TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed','skipped')),
    result          JSONB,
    error           TEXT,
    started_at      BIGINT,
    finished_at     BIGINT,
    created_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint)
);

CREATE INDEX IF NOT EXISTS idx_agent_steps_session ON agent_steps(session_id);
CREATE INDEX IF NOT EXISTS idx_agent_steps_status ON agent_steps(status);

-- Agent conversations: groups AI model calls per step
CREATE TABLE IF NOT EXISTS agent_conversations (
    conversation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id      UUID NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
    step_id         UUID REFERENCES agent_steps(step_id) ON DELETE CASCADE,
    attempt         INTEGER NOT NULL DEFAULT 1,
    model           TEXT,
    created_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint)
);

CREATE INDEX IF NOT EXISTS idx_agent_conv_step ON agent_conversations(step_id);
CREATE INDEX IF NOT EXISTS idx_agent_conv_session ON agent_conversations(session_id);

-- Agent messages: prompt/response pairs for each AI call
CREATE TABLE IF NOT EXISTS agent_messages (
    message_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES agent_conversations(conversation_id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK(role IN ('system','user','assistant')),
    content         TEXT NOT NULL,
    created_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint)
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_conv ON agent_messages(conversation_id);
`;

async function runMigrations() {
    const statements = SCHEMA_SQL
        .split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0);

    for (const stmt of statements) {
        try {
            await query(stmt);
        } catch (err) {
            console.error('[PG] Migration error in statement:', err.message);
            console.error('[PG] Statement:', stmt.substring(0, 120));
            throw err;
        }
    }

    // Idempotent column additions for existing databases.
    const columnAdditions = [
        { table: 'scenes', column: 'scene_hash', type: 'TEXT' },
        { table: 'scenes', column: 'build_id', type: 'TEXT' },
        { table: 'image_units', column: 'start_ms', type: 'BIGINT DEFAULT 0' },
        { table: 'image_units', column: 'end_ms', type: 'BIGINT DEFAULT 0' },
        { table: 'agent_sessions', column: 'knowledge_base', type: 'JSONB' },
        { table: 'agent_sessions', column: 'window_data', type: 'JSONB' },
        { table: 'ai_chat_sessions', column: 'topic_id', type: "TEXT NOT NULL DEFAULT 'book'" },
        { table: 'ai_chat_sessions', column: 'title', type: "TEXT NOT NULL DEFAULT 'Chat'" },
    ];

    for (const { table, column, type } of columnAdditions) {
        try {
            await query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${type}`);
        } catch (err) {
            console.error(`[PG] Failed to add column ${table}.${column}: ${err.message}`);
            throw err;
        }
    }

    // Legacy chat tables removal: chat_messages/chat_sessions have been dead
    // for a long time (chat state lives in ai_chat_sessions). Drop them so
    // existing deployments converge; CREATE for them is gone above.
    for (const legacyTable of ['chat_messages', 'chat_sessions']) {
        try {
            await query(`DROP TABLE IF EXISTS ${legacyTable} CASCADE`);
        } catch (err) {
            console.error(`[PG] Failed to drop legacy table ${legacyTable}: ${err.message}`);
        }
    }

    // Drop FK constraints if they were created by an earlier version of this
    // migration. We removed the FKs to match other book-keyed tables
    // (asset_states, cache_entries, scene_assets) that allow orphan references
    // for flexibility — the application layer guarantees book existence.
    const fkDrops = [
        { table: 'scenes', constraint: 'scenes_book_id_fkey' },
    ];
    for (const { table, constraint } of fkDrops) {
        try {
            await query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${constraint}`);
        } catch (err) {
            console.error(`[PG] Failed to drop FK ${constraint} on ${table}: ${err.message}`);
        }
    }

    await query(`CREATE INDEX IF NOT EXISTS idx_scenes_hash ON scenes(book_id, scene_hash)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_scenes_build ON scenes(build_id)`);

    // Make step_id nullable in agent_conversations for the new unified pipeline
    // (old schema had step_id NOT NULL, new pipeline inserts without step_id)
    try {
        await query(`ALTER TABLE agent_conversations ALTER COLUMN step_id DROP NOT NULL`);
    } catch (err) {
        // If already nullable or other error, ignore
        if (!err.message.includes('does not exist')) {
            console.error('[PG] Failed to drop NOT NULL on step_id:', err.message);
        }
    }

    // Add 'placeholder' to scene_assets status check constraint
    try {
        await query(`ALTER TABLE scene_assets DROP CONSTRAINT IF EXISTS scene_assets_status_check`);
        await query(`ALTER TABLE scene_assets ADD CONSTRAINT scene_assets_status_check
            CHECK (status IN ('pending','ready','stale','failed','missing','placeholder'))`);
        console.log('[PG] Updated scene_assets status check constraint (added placeholder)');
    } catch (err) {
        if (!err.message.includes('does not exist')) {
            console.error('[PG] Failed to update scene_assets status constraint:', err.message);
        }
    }

    // ======================================================
    // R13: Version columns for scenes and scene_assets
    // ======================================================
    // content_version is bumped when scene content (text/units) changes.
    // audio_config_version is bumped when audio config (voice/settings) changes.
    // These enable version-based caching — assets from an older version
    // are stale and need regeneration.
    try {
        await query(`ALTER TABLE scenes ADD COLUMN IF NOT EXISTS content_version INTEGER NOT NULL DEFAULT 1`);
        console.log('[PG] Added scenes.content_version');
    } catch (err) {
        if (!err.message.includes('already exists')) {
            console.error('[PG] Failed to add scenes.content_version:', err.message);
        }
    }
    try {
        await query(`ALTER TABLE scenes ADD COLUMN IF NOT EXISTS audio_config_version INTEGER NOT NULL DEFAULT 1`);
        console.log('[PG] Added scenes.audio_config_version');
    } catch (err) {
        if (!err.message.includes('already exists')) {
            console.error('[PG] Failed to add scenes.audio_config_version:', err.message);
        }
    }
    try {
        await query(`ALTER TABLE scene_assets ADD COLUMN IF NOT EXISTS scene_content_version INTEGER`);
        console.log('[PG] Added scene_assets.scene_content_version');
    } catch (err) {
        if (!err.message.includes('already exists')) {
            console.error('[PG] Failed to add scene_assets.scene_content_version:', err.message);
        }
    }
    try {
        await query(`ALTER TABLE scene_assets ADD COLUMN IF NOT EXISTS scene_audio_config_version INTEGER`);
        console.log('[PG] Added scene_assets.scene_audio_config_version');
    } catch (err) {
        if (!err.message.includes('already exists')) {
            console.error('[PG] Failed to add scene_assets.scene_audio_config_version:', err.message);
        }
    }

    // Add 'paused' to agent_sessions status check constraint
    try {
        await query(`ALTER TABLE agent_sessions DROP CONSTRAINT IF EXISTS agent_sessions_status_check`);
        await query(`ALTER TABLE agent_sessions ADD CONSTRAINT agent_sessions_status_check
            CHECK (status IN ('running','paused','completed','failed','cancelled'))`);
        console.log('[PG] Updated agent_sessions status check constraint (added paused, cancelled)');
    } catch (err) {
        if (!err.message.includes('does not exist')) {
            console.error('[PG] Failed to update agent_sessions status constraint:', err.message);
        }
    }

    // Keep agent_steps step_type check constraint in sync with the pipeline.
    // Latest addition: 'repair_fantasy_snakes' (stepRepairFantasyIds — the final
    // visual barrier against hallucinated snake_case ids). PostgreSQL doesn't
    // support ALTER CONSTRAINT to add new values to CHECK — drop and recreate.
    try {
        await query(`ALTER TABLE agent_steps DROP CONSTRAINT IF EXISTS agent_steps_step_type_check`);
        await query(`ALTER TABLE agent_steps ADD CONSTRAINT agent_steps_step_type_check
            CHECK (step_type IN (
                'analyze_structure','analyze_characters','analyze_locations',
                'create_scenes','enrich_scenes',
                'create_units','create_visual_prompts',
                'collect_character_candidates','resolve_character_mentions',
                'generate_voices',
                'polish_storyboard','reconcile_passports',
                'reconcile_video_actions','polish_video_actions',
                'repair_fantasy_snakes'
            ))`);
        console.log('[PG] Updated agent_steps step_type check constraint (added repair_fantasy_snakes)');
    } catch (err) {
        if (!err.message.includes('does not exist')) {
            console.error('[PG] Failed to update step_type constraint:', err.message);
        }
    }

    // dirty_unit_ids TEXT[] — per-unit dirty tracking for granular force-regen
    try {
        await query(`ALTER TABLE scenes ADD COLUMN IF NOT EXISTS dirty_unit_ids TEXT[] DEFAULT '{}'`);
        console.log('[PG] Added scenes.dirty_unit_ids');
    } catch (err) {
        if (!err.message.includes('already exists')) {
            console.error('[PG] Failed to add scenes.dirty_unit_ids:', err.message);
        }
    }

    // Make context column nullable in ai_chat_sessions (routes pass null for new sessions)
    try {
        await query(`ALTER TABLE ai_chat_sessions ALTER COLUMN context DROP NOT NULL`);
        console.log('[PG] Made ai_chat_sessions.context nullable');
    } catch (err) {
        if (!err.message.includes('does not exist')) {
            console.error('[PG] Failed to alter ai_chat_sessions.context:', err.message);
        }
    }

    // ======================================================
    // Phase 4 (R4.1): Persistent dirty flag in scenes table
    // ======================================================
    // is_dirty persists across Redis crashes. Set to TRUE when
    // bumpSceneVersions bumps content_version. Cleared after
    // regeneration completes. The scheduler checks this flag
    // as a secondary dirty detection mechanism alongside Redis
    // per-asset states.
    try {
        await query(`ALTER TABLE scenes ADD COLUMN IF NOT EXISTS is_dirty BOOLEAN NOT NULL DEFAULT FALSE`);
        console.log('[PG] Added scenes.is_dirty');
    } catch (err) {
        if (!err.message.includes('already exists')) {
            console.error('[PG] Failed to add scenes.is_dirty:', err.message);
        }
    }

    // ======================================================
    // Coreference Resolution: 5 tables (P0)
    // ======================================================
    // Character resolution pipeline stores:
    //   character_resolution_runs — versioned run tracking
    //   character_window_candidates — coarse candidate collection
    //   sentence_resolutions — sentence-level (for scene metadata)
    //   character_mentions — mention-level (for unit participants)
    //   character_aliases — safe alias index built from mentions

    try {
        await query(`CREATE TABLE IF NOT EXISTS character_resolution_runs (
            run_id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            book_id                 TEXT NOT NULL,
            chapter_id              TEXT,
            analysis_window_index   INTEGER NOT NULL,
            run_type                TEXT NOT NULL CHECK(run_type IN ('coarse_candidates','fine_mentions')),
            source_start            INTEGER NOT NULL,
            source_end              INTEGER NOT NULL,
            generation_start        INTEGER,
            generation_end          INTEGER,
            resolver_version        TEXT NOT NULL,
            model                   TEXT,
            character_registry_hash TEXT NOT NULL,
            source_hash             TEXT NOT NULL,
            status                  TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
            error                   TEXT,
            created_at              BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
            completed_at            BIGINT
        )`);
        console.log('[PG] Created character_resolution_runs table');
    } catch (err) {
        if (!err.message.includes('already exists')) {
            console.error('[PG] Failed to create character_resolution_runs:', err.message);
        }
    }

    try {
        await query(`CREATE TABLE IF NOT EXISTS character_window_candidates (
            id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            run_id                  UUID NOT NULL REFERENCES character_resolution_runs(run_id) ON DELETE CASCADE,
            book_id                 TEXT NOT NULL,
            chapter_id              TEXT,
            analysis_window_index   INTEGER NOT NULL,
            source_start            INTEGER NOT NULL,
            source_end              INTEGER NOT NULL,
            character_id            TEXT NOT NULL,
            alias_texts             TEXT[] NOT NULL DEFAULT '{}',
            evidence                TEXT,
            confidence              REAL,
            created_at              BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
            UNIQUE(run_id, character_id)
        )`);
        await query(`CREATE INDEX IF NOT EXISTS idx_char_candidates_book_window
            ON character_window_candidates(book_id, analysis_window_index)`);
        console.log('[PG] Created character_window_candidates table');
    } catch (err) {
        if (!err.message.includes('already exists')) {
            console.error('[PG] Failed to create character_window_candidates:', err.message);
        }
    }

    try {
        await query(`CREATE TABLE IF NOT EXISTS sentence_resolutions (
            id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            run_id          UUID NOT NULL REFERENCES character_resolution_runs(run_id) ON DELETE CASCADE,
            book_id         TEXT NOT NULL,
            chapter_id      TEXT,
            scene_id        TEXT NOT NULL,
            sentence_index  INTEGER NOT NULL,
            source_start    INTEGER NOT NULL,
            source_end      INTEGER NOT NULL,
            sentence_text   TEXT NOT NULL,
            character_ids   TEXT[] NOT NULL DEFAULT '{}',
            unknown_mentions JSONB NOT NULL DEFAULT '[]'::jsonb,
            resolved_by     TEXT NOT NULL DEFAULT 'agent' CHECK(resolved_by IN ('agent','fallback')),
            created_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
            UNIQUE(run_id, scene_id, sentence_index)
        )`);
        await query(`CREATE INDEX IF NOT EXISTS idx_sentence_resolutions_book_span
            ON sentence_resolutions(book_id, source_start, source_end)`);
        console.log('[PG] Created sentence_resolutions table');
    } catch (err) {
        if (!err.message.includes('already exists')) {
            console.error('[PG] Failed to create sentence_resolutions:', err.message);
        }
    }

    try {
        await query(`CREATE TABLE IF NOT EXISTS character_mentions (
            id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            run_id          UUID NOT NULL REFERENCES character_resolution_runs(run_id) ON DELETE CASCADE,
            book_id         TEXT NOT NULL,
            chapter_id      TEXT,
            scene_id        TEXT,
            sentence_index  INTEGER NOT NULL,
            source_start    INTEGER NOT NULL,
            source_end      INTEGER NOT NULL,
            mention_text    TEXT NOT NULL,
            mention_norm    TEXT NOT NULL,
            character_id    TEXT,
            mention_type    TEXT NOT NULL CHECK(mention_type IN (
                'name','profession','description','pronoun','nickname','title','unknown'
            )),
            role            TEXT CHECK(role IN ('subject','object','possessive','passive','unknown')),
            confidence      REAL,
            evidence        TEXT,
            created_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint)
        )`);
        await query(`CREATE INDEX IF NOT EXISTS idx_char_mentions_book_span
            ON character_mentions(book_id, source_start, source_end)`);
        await query(`CREATE INDEX IF NOT EXISTS idx_char_mentions_book_char
            ON character_mentions(book_id, character_id)`);
        console.log('[PG] Created character_mentions table');
    } catch (err) {
        if (!err.message.includes('already exists')) {
            console.error('[PG] Failed to create character_mentions:', err.message);
        }
    }

    try {
        await query(`CREATE TABLE IF NOT EXISTS character_aliases (
            book_id         TEXT NOT NULL,
            alias_norm      TEXT NOT NULL,
            alias_text      TEXT NOT NULL,
            character_id    TEXT NOT NULL,
            source          TEXT NOT NULL CHECK(source IN ('character_name','mention_resolution','manual')),
            evidence_count  INTEGER NOT NULL DEFAULT 1,
            is_safe         BOOLEAN NOT NULL DEFAULT FALSE,
            reason          TEXT,
            updated_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
            PRIMARY KEY(book_id, alias_norm, character_id)
        )`);
        await query(`CREATE INDEX IF NOT EXISTS idx_char_aliases_book
            ON character_aliases(book_id, alias_norm)`);
        console.log('[PG] Created character_aliases table');
    } catch (err) {
        if (!err.message.includes('already exists')) {
            console.error('[PG] Failed to create character_aliases:', err.message);
        }
    }

    console.log('[PG] Schema initialized');

    // ======================================================
    // Book Source (SHA256 hash → book_id mapping)
    // ======================================================

    try {
        await query(`CREATE TABLE IF NOT EXISTS book_source (
            id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            file_hash       TEXT NOT NULL,
            file_name       TEXT NOT NULL DEFAULT '',
            file_size       BIGINT NOT NULL DEFAULT 0,
            book_id         TEXT NOT NULL,
            source_type     TEXT NOT NULL DEFAULT 'txt' CHECK(source_type IN ('txt','ai_text')),
            created_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
            UNIQUE(file_hash, book_id)
        )`);
        await query(`CREATE INDEX IF NOT EXISTS idx_book_source_hash ON book_source(file_hash)`);
        await query(`CREATE INDEX IF NOT EXISTS idx_book_source_book ON book_source(book_id)`);
        console.log('[PG] Created book_source table');
    } catch (err) {
        if (!err.message.includes('already exists')) {
            console.error('[PG] Failed to create book_source:', err.message);
        }
    }

    // ── book_source: per-identity dedup migration ─────────────────────────
    // The original UNIQUE(file_hash) allowed only ONE book per source hash
    // across the whole database. Re-importing the same TXT by a different
    // identity re-pointed that single row (ON CONFLICT DO UPDATE), silently
    // stealing the dedup reference from the original owner. Dedup is now
    // identity-scoped (current identity + TXT → owned book), so the index
    // must allow one row per (file_hash, book_id).
    try {
        await query(`ALTER TABLE book_source DROP CONSTRAINT IF EXISTS book_source_file_hash_key`);
        await query(`CREATE UNIQUE INDEX IF NOT EXISTS book_source_hash_book_key ON book_source(file_hash, book_id)`);
    } catch (err) {
        console.error('[PG] Failed to migrate book_source uniqueness:', err.message);
    }

    // ======================================================
    // Add completion_status column to book_generation_sessions
    // ======================================================

    try {
        await query(`ALTER TABLE book_generation_sessions ADD COLUMN IF NOT EXISTS completion_status TEXT DEFAULT NULL`);
        console.log('[PG] Added completion_status to book_generation_sessions');
    } catch (err) {
        if (!err.message.includes('already exists') && !err.message.includes('duplicate column')) {
            console.error('[PG] Failed to add completion_status:', err.message);
        }
    }

    // ======================================================
    // Book Generation Sessions (window state in PG)
    // ======================================================

    try {
        await query(`CREATE TABLE IF NOT EXISTS book_generation_sessions (
            id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            book_id             TEXT NOT NULL,
            window_index        INTEGER NOT NULL DEFAULT 0,
            source_offset_start INTEGER DEFAULT 0,
            source_offset_end   INTEGER DEFAULT 0,
            generated_scene_from INTEGER DEFAULT NULL,
            generated_scene_to   INTEGER DEFAULT NULL,
            window_size         INTEGER NOT NULL DEFAULT 3,
            status              TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','generating','completed','failed','queued')),
            error               TEXT,
            progress_msg        TEXT,
            created_at          BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
            updated_at          BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint)
        )`);
        await query(`CREATE INDEX IF NOT EXISTS idx_gen_session_book ON book_generation_sessions(book_id)`);
        await query(`CREATE INDEX IF NOT EXISTS idx_gen_session_status ON book_generation_sessions(status)`);
        console.log('[PG] Created book_generation_sessions table');
    } catch (err) {
        if (!err.message.includes('already exists')) {
            console.error('[PG] Failed to create book_generation_sessions:', err.message);
        }
    }

    // ======================================================
    // Generation cancellation tombstones (Cathedral Recon #3 §5.4)
    // ======================================================
    // Persistent marker that the user explicitly cancelled generation for a
    // book. Written by POST /cancel-generation, cleared by POST /regenerate.
    // Survives Redis loss so automatic resumption (startup-resume / future
    // work-list rebuild) can never resurrect an explicitly cancelled run.
    try {
        await query(`CREATE TABLE IF NOT EXISTS generation_cancellations (
            book_id         TEXT PRIMARY KEY,
            cancelled_at    BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
            reason          TEXT,
            created_by      TEXT,
            updated_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint)
        )`);
        console.log('[PG] Created generation_cancellations table');
    } catch (err) {
        if (!err.message.includes('already exists')) {
            console.error('[PG] Failed to create generation_cancellations:', err.message);
        }
    }

    // ======================================================
    // Account & Workspace Foundation (Account System Phase 1)
    // ======================================================
    // Migrate the dormant users table to support username-based auth
    // and create workspace/membership tables.

    // 1. Add username column to users (nullable initially for migration)
    try {
        await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT`);
        console.log('[PG] Added users.username column');
    } catch (err) {
        if (!err.message.includes('already exists')) {
            console.error('[PG] Failed to add users.username:', err.message);
        }
    }

    // 2. Make email nullable (was UNIQUE NOT NULL)
    try {
        await query(`ALTER TABLE users ALTER COLUMN email DROP NOT NULL`);
        console.log('[PG] Made users.email nullable');
    } catch (err) {
        if (!err.message.includes('does not exist')) {
            console.error('[PG] Failed to make users.email nullable:', err.message);
        }
    }

    // 3. Add recovery_key_hash column
    try {
        await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_key_hash TEXT`);
        console.log('[PG] Added users.recovery_key_hash column');
    } catch (err) {
        if (!err.message.includes('already exists')) {
            console.error('[PG] Failed to add users.recovery_key_hash:', err.message);
        }
    }

    // 4. Enforce username: backfill nulls → NOT NULL → UNIQUE.
    // Each step is independent: the UNIQUE constraint may already exist
    // (earlier run) while NOT NULL is still absent on live databases.
    try {
        await query(`UPDATE users SET username = 'user_' || substr(user_id::text, 1, 8) WHERE username IS NULL`);
    } catch (err) {
        console.error('[PG] Failed to backfill users.username:', err.message);
    }
    try {
        await query(`ALTER TABLE users ALTER COLUMN username SET NOT NULL`);
    } catch (err) {
        // Absent table/column covered by message check; NOT NULL on an already
        // NOT NULL column is a no-op in PG, so any error here is worth logging.
        console.error('[PG] Failed to set users.username NOT NULL:', err.message);
    }
    try {
        await query(`ALTER TABLE users ADD CONSTRAINT users_username_unique UNIQUE (username)`);
        console.log('[PG] Added unique constraint on users.username');
    } catch (err) {
        if (!err.message.includes('already exists')) {
            console.error('[PG] Failed to add unique constraint on users.username:', err.message);
        }
    }
    // 4b. Canonical (case-insensitive) username uniqueness — enforced DB-side.
    // Display form keeps its original case; comparison is lower().
    try {
        await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users(lower(username))`);
        console.log('[PG] Added case-insensitive unique index on users.username');
    } catch (err) {
        if (!err.message.includes('already exists')) {
            console.error('[PG] Failed to create lower-username unique index:', err.message);
        }
    }

    // 5. Add workspace_id to books (nullable initially)
    try {
        await query(`ALTER TABLE books ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id)`);
        console.log('[PG] Added books.workspace_id column');
    } catch (err) {
        if (!err.message.includes('already exists')) {
            console.error('[PG] Failed to add books.workspace_id:', err.message);
        }
    }

    // 6. Create index on books.workspace_id
    try {
        await query(`CREATE INDEX IF NOT EXISTS idx_books_workspace ON books(workspace_id)`);
        console.log('[PG] Created index on books.workspace_id');
    } catch (err) {
        if (!err.message.includes('already exists')) {
            console.error('[PG] Failed to create idx_books_workspace:', err.message);
        }
    }

    // 7. Seed development user and personal workspace for existing books
    // This ensures all existing test/development books have an owner.
    try {
        const { rows: existingUsers } = await query(`SELECT user_id FROM users WHERE username = 'developer' LIMIT 1`);
        let devUserId;

        if (existingUsers.length === 0) {
            // Create developer user
            const { rows: newUser } = await query(`
                INSERT INTO users (username, display_name, role)
                VALUES ('developer', 'Developer', 'admin')
                ON CONFLICT (username) DO UPDATE SET username = 'developer'
                RETURNING user_id
            `);
            devUserId = newUser[0].user_id;
            console.log(`[PG] Created development user: ${devUserId}`);
        } else {
            devUserId = existingUsers[0].user_id;
        }

        // Create personal workspace for developer
        const { rows: existingWorkspaces } = await query(
            `SELECT id FROM workspaces WHERE owner_user_id = $1 AND type = 'personal' LIMIT 1`,
            [devUserId]
        );
        let workspaceId;

        if (existingWorkspaces.length === 0) {
            const { rows: newWorkspace } = await query(`
                INSERT INTO workspaces (name, owner_user_id, type)
                VALUES ('Developer Workspace', $1, 'personal')
                RETURNING id
            `, [devUserId]);
            workspaceId = newWorkspace[0].id;
            console.log(`[PG] Created personal workspace for developer: ${workspaceId}`);

            // Add developer as owner member
            await query(`
                INSERT INTO workspace_members (workspace_id, user_id, role)
                VALUES ($1, $2, 'owner')
                ON CONFLICT (workspace_id, user_id) DO NOTHING
            `, [workspaceId, devUserId]);
        } else {
            workspaceId = existingWorkspaces[0].id;
        }

        // Link existing books without workspace to developer workspace
        const { rows: unlinkedBooks } = await query(
            `UPDATE books SET workspace_id = $1 WHERE workspace_id IS NULL RETURNING book_id`,
            [workspaceId]
        );
        if (unlinkedBooks.length > 0) {
            console.log(`[PG] Linked ${unlinkedBooks.length} existing books to developer workspace`);
        }
    } catch (err) {
        console.error('[PG] Failed to seed development user/workspace:', err.message);
    }

    console.log('[PG] Account & Workspace foundation initialized');

    // ======================================================
    // Authentication MVP (Account System Phase 3)
    // ======================================================
    // Server-side sessions table (fresh) + hardening for any DB that already
    // ran an earlier iteration of this migration.

    // AM-1: token_hash column (safe db representation — raw tokens never stored)
    try {
        await query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS token_hash TEXT`);
    } catch (err) {
        if (!err.message.includes('already exists') && !err.message.includes('does not exist')) {
            console.error('[PG] Failed to add sessions.token_hash:', err.message);
        }
    }
    // AM-2: purge sessions from any earlier iteration (they lack token hashes
    // and are unusable). Keeps NOT NULL enforcement below total-safe.
    try {
        await query(`DELETE FROM sessions WHERE token_hash IS NULL OR token_hash = ''`);
    } catch (err) {
        console.error('[PG] Failed to purge legacy sessions:', err.message);
    }
    try {
        await query(`ALTER TABLE sessions ALTER COLUMN token_hash SET NOT NULL`);
    } catch (err) {
        console.error('[PG] Failed to set sessions.token_hash NOT NULL:', err.message);
    }
    // AM-3: explicit created_at (epoch ms), expires_at, revoked_at hardening
    try {
        await query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint * 1000)`);
    } catch (err) {
        if (!err.message.includes('already exists')) console.error('[PG] Failed to add sessions.created_at:', err.message);
    }
    try {
        await query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS expires_at BIGINT`);
        await query(`ALTER TABLE sessions ALTER COLUMN expires_at SET NOT NULL`);
    } catch (err) {
        if (!err.message.includes('does not exist')) console.error('[PG] Failed to harden sessions.expires_at:', err.message);
    }
    try {
        await query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS revoked_at BIGINT`);
    } catch (err) {
        if (!err.message.includes('already exists')) console.error('[PG] Failed to add sessions.revoked_at:', err.message);
    }
    // AM-4: session_id no longer needs a server default (the app supplies it
    // together with the token — they must never drift apart).
    try {
        await query(`ALTER TABLE sessions ALTER COLUMN session_id DROP DEFAULT`);
    } catch (err) {
        if (!err.message.includes('does not exist')) console.error('[PG] Failed to drop sessions.session_id default:', err.message);
    }
    // AM-5: lookup indexes
    try {
        await query(`CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash)`);
        await query(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`);
    } catch (err) {
        if (!err.message.includes('already exists')) console.error('[PG] Failed to create session indexes:', err.message);
    }

    console.log('[PG] Authentication sessions initialized');

    // ======================================================
    // Guest Workspace MVP (Account System Phase 4)
    // ======================================================
    // Temporary identities for visitors without accounts + workspace
    // expiration support. Converted (not copied) when the guest registers.

    // GW-1: workspaces owner becomes optional (guest workspaces are unowned
    // until conversion) — NULL means "temporary, no human owner yet".
    try {
        await query(`ALTER TABLE workspaces ALTER COLUMN owner_user_id DROP NOT NULL`);
    } catch (err) {
        if (!err.message.includes('does not exist')) console.error('[PG] Failed to relax workspaces.owner_user_id:', err.message);
    }
    // GW-2: workspace expiration (temporary workspaces carry a deadline;
    // personal workspaces keep NULL = no expiry).
    try {
        await query(`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS expires_at BIGINT`);
        await query(`CREATE INDEX IF NOT EXISTS idx_workspaces_expires ON workspaces(expires_at)`);
    } catch (err) {
        if (!err.message.includes('already exists')) console.error('[PG] Failed to add workspaces.expires_at:', err.message);
    }
    // GW-3: guests table (token-hash-only, like sessions — raw tokens never
    // persisted).
    try {
        await query(`CREATE TABLE IF NOT EXISTS guests (
            guest_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            token_hash      TEXT NOT NULL UNIQUE,
            workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            created_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint * 1000),
            expires_at      BIGINT NOT NULL,
            revoked_at      BIGINT
        )`);
        await query(`CREATE INDEX IF NOT EXISTS idx_guests_workspace ON guests(workspace_id)`);
    } catch (err) {
        if (!err.message.includes('already exists')) console.error('[PG] Failed to create guests table:', err.message);
    }

    console.log('[PG] Guest identity support initialized');

    // ======================================================
    // PW-1: Private Worker registry (Experimental Beta — Phase 1)
    // ======================================================
    // Repurpose the dormant `workers` table into the durable source of
    // truth for private worker identity & credentials. This is a REAL
    // migration, not a free ALTER: the original table had a self-chosen
    // TEXT primary key, no workspace/token columns and a worker_type
    // CHECK that included 'upscale'. The table was verified empty in
    // every environment it ever ran in (zero code paths ever wrote to
    // it), so the rebuild drops and recreates it. If rows ever exist,
    // the rebuild is skipped loudly rather than destroying data.
    try {
        const { rows: shapeRows } = await query(`
            SELECT data_type FROM information_schema.columns
            WHERE table_name = 'workers' AND column_name = 'worker_id'
        `);
        if (shapeRows.length === 0) {
            // Table absent — the canonical CREATE TABLE IF NOT EXISTS above
            // already produced the new shape.
            await query(`CREATE INDEX IF NOT EXISTS idx_workers_workspace ON workers(workspace_id)`);
        } else if (shapeRows[0].data_type === 'uuid') {
            // Already migrated — keep the canonical CHECK constraints in sync
            // (PostgreSQL cannot ALTER a CHECK to add/remove values).
            await query(`ALTER TABLE workers DROP CONSTRAINT IF EXISTS workers_worker_type_check`);
            await query(`ALTER TABLE workers ADD CONSTRAINT workers_worker_type_check
                CHECK (worker_type IN ('audio','image','video'))`);
            await query(`ALTER TABLE workers DROP CONSTRAINT IF EXISTS workers_mode_check`);
            await query(`ALTER TABLE workers ADD CONSTRAINT workers_mode_check
                CHECK (mode IN ('private','share'))`);
            await query(`CREATE INDEX IF NOT EXISTS idx_workers_workspace ON workers(workspace_id)`);
        } else {
            const { rows: countRows } = await query(`SELECT COUNT(*)::int AS n FROM workers`);
            if ((countRows[0]?.n || 0) > 0) {
                console.error('[PG] PW-1: legacy workers table has rows — rebuild SKIPPED, manual migration required');
            } else {
                await query(`DROP TABLE workers`);
                await query(`CREATE TABLE workers (
                    worker_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    workspace_id    UUID REFERENCES workspaces(id) ON DELETE CASCADE,
                    name            TEXT NOT NULL,
                    worker_type     TEXT NOT NULL CHECK(worker_type IN ('audio','image','video')),
                    capabilities    JSONB,
                    mode            TEXT NOT NULL DEFAULT 'private' CHECK(mode IN ('private','share','system')),
                    status          TEXT NOT NULL DEFAULT 'offline' CHECK(status IN ('online','offline','busy','error')),
                    token_hash      TEXT NOT NULL UNIQUE,
                    token_prefix    TEXT,
                    created_by      UUID REFERENCES users(user_id),
                    revoked_at      BIGINT,
                    last_seen       BIGINT,
                    version         TEXT,
                    metadata        JSONB,
                    created_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
                    CONSTRAINT workers_scope_check CHECK (mode = 'system' OR workspace_id IS NOT NULL)
                )`);
                await query(`CREATE INDEX IF NOT EXISTS idx_workers_workspace ON workers(workspace_id)`);
                console.log('[PG] PW-1: rebuilt dormant workers table for private worker identity');
            }
        }
    } catch (err) {
        console.error('[PG] PW-1 workers migration failed:', err.message);
        throw err;
    }

    console.log('[PG] Private worker registry initialized');

    // ======================================================
    // PW-4: Fail-closed worker registry (three-mode model)
    // ======================================================
    // Extends the registry to the final identity model: PRIVATE (a user's
    // own workspace), SHARE (owner volunteers the worker to the community)
    // and SYSTEM (Animastor-operated pool — promo/trials/commercial lanes).
    // SYSTEM workers are workspace-less; every other mode MUST have an
    // owning workspace (workers_scope_check). Idempotent for fresh DBs
    // (canonical CREATE TABLE already carries the final shape).
    try {
        await query(`ALTER TABLE workers DROP CONSTRAINT IF EXISTS workers_mode_check`);
        await query(`ALTER TABLE workers ADD CONSTRAINT workers_mode_check
            CHECK (mode IN ('private','share','system'))`);
        await query(`ALTER TABLE workers ALTER COLUMN workspace_id DROP NOT NULL`);
        await query(`ALTER TABLE workers DROP CONSTRAINT IF EXISTS workers_scope_check`);
        await query(`ALTER TABLE workers ADD CONSTRAINT workers_scope_check
            CHECK (mode = 'system' OR workspace_id IS NOT NULL)`);
    } catch (err) {
        console.error('[PG] PW-4 workers fail-closed migration failed:', err.message);
        throw err;
    }

    console.log('[PG] Worker registry fail-closed model initialized (private/share/system)');

    // ======================================================
    // PW-2: Workspace-aware job ownership (Experimental Beta — Phase 2)
    // ======================================================
    // Add the server-derived workspace ownership anchor to generation_tasks.
    // Idempotent: column add + backfill from books + index. The backfill only
    // touches rows whose workspace_id IS NULL, so re-runs are safe and rows
    // written by the new dispatch path are never overwritten.
    try {
        const { rows: taskCols } = await query(`
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'generation_tasks' AND column_name = 'workspace_id'
        `);
        if (taskCols.length === 0) {
            await query(`ALTER TABLE generation_tasks
                ADD COLUMN workspace_id UUID REFERENCES workspaces(id)`);
            console.log('[PG] PW-2: added generation_tasks.workspace_id');
        }
        const backfill = await query(`
            UPDATE generation_tasks t
            SET workspace_id = b.workspace_id
            FROM books b
            WHERE t.book_id = b.book_id
              AND t.workspace_id IS NULL
              AND b.workspace_id IS NOT NULL
        `);
        if (backfill.rowCount > 0) {
            console.log(`[PG] PW-2: backfilled workspace_id on ${backfill.rowCount} generation_tasks row(s)`);
        }
        await query(`CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON generation_tasks(workspace_id)`);
    } catch (err) {
        console.error('[PG] PW-2 generation_tasks migration failed:', err.message);
        throw err;
    }

    console.log('[PG] Workspace-aware generation task ownership initialized');

    // ======================================================
    // PAP-1: Personal AI Provider schema extension (Phase 4)
    // ======================================================
    // Adds the provider_type / status / last_tested_at columns that the spec
    // §2 requires, and a CHECK constraint on status. Idempotent: each step can
    // run on a brand-new DB (the CREATE TABLE already has the columns) or an
    // existing one. `provider` is backfilled in lock-step with provider_type
    // so legacy callers reading the old field see the same value.
    try {
        await query(`ALTER TABLE workspace_ai_providers
            ADD COLUMN IF NOT EXISTS provider_type TEXT`);
        await query(`ALTER TABLE workspace_ai_providers
            ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'untested'`);
        await query(`ALTER TABLE workspace_ai_providers
            ADD COLUMN IF NOT EXISTS last_tested_at BIGINT`);

        // Backfill provider_type from the legacy provider column when the new
        // column is NULL or empty. Map known aliases to the canonical enum.
        await query(`
            UPDATE workspace_ai_providers SET provider_type = CASE
                WHEN provider IN ('openrouter','openai-compatible','custom') THEN provider
                WHEN provider IS NULL OR provider = '' THEN 'openai-compatible'
                WHEN lower(provider) IN ('openai','openai-api') THEN 'openai-compatible'
                ELSE 'custom'
            END
            WHERE provider_type IS NULL OR provider_type = ''
        `);
        // Drop legacy 'custom' rows that arose before a real provider_type was
        // selected — normalized to openai-compatible (OpenAI-compatible default).
        await query(`
            UPDATE workspace_ai_providers SET provider = provider_type
            WHERE provider IS NULL OR provider = '' OR provider NOT IN ('openrouter','openai-compatible','custom')
        `);

        // CHECK on status — recreate idempotently. PG doesn't allow IF NOT EXISTS.
        await query(`ALTER TABLE workspace_ai_providers
            DROP CONSTRAINT IF EXISTS workspace_ai_providers_status_check`);
        await query(`ALTER TABLE workspace_ai_providers
            ADD CONSTRAINT workspace_ai_providers_status_check
            CHECK (status IN ('untested','ok','failed'))`);

        console.log('[PG] PAP-1: workspace_ai_providers extended (provider_type/status/last_tested_at)');
    } catch (err) {
        console.error('[PG] PAP-1 workspace_ai_providers extension failed:', err.message);
        throw err;
    }

    console.log('[PG] Personal AI provider schema initialized');

    // ======================================================
    // SYS-1: System AI control + provider (kill switch)
    // ======================================================
    // Adds two tables behind the admin kill-switch:
    //   system_settings      — generic JSONB key/value store.
    //                          Seeded with `system_ai` = { enabled: true } so
    //                          the existing beta keeps working (explicit
    //                          switch, default ON; admin flips OFF to cut
    //                          the cost boundary).
    //   system_ai_providers  — admin-configured platform provider. AES-256-GCM
    //                          ciphertext only — the admin UI never sees the
    //                          plaintext key after saving it.
    //
    // The CREATE TABLE IF NOT EXISTS above is idempotent; this migration
    // block only hardens an existing row (CHECK on status, default seed for
    // system_ai.enabled, status CHECK for system_ai_providers) and logs.
    try {
        await query(`ALTER TABLE system_ai_providers
            DROP CONSTRAINT IF EXISTS system_ai_providers_status_check`);
        await query(`ALTER TABLE system_ai_providers
            ADD CONSTRAINT system_ai_providers_status_check
            CHECK (status IN ('untested','ok','failed'))`);
        console.log('[PG] SYS-1: system_ai_providers status check constraint ensured');
    } catch (err) {
        if (!err.message.includes('does not exist')) {
            console.error('[PG] SYS-1 status constraint failed:', err.message);
        }
    }

    try {
        await query(`INSERT INTO system_settings (key, value)
            VALUES ('system_ai', '{"enabled": true}'::jsonb)
            ON CONFLICT (key) DO NOTHING`);
        console.log('[PG] SYS-1: system_settings seeded (system_ai.enabled = true default)');
    } catch (err) {
        console.error('[PG] SYS-1 seed failed:', err.message);
    }

    console.log('[PG] System AI control schema initialized');
}

module.exports = { runMigrations, SCHEMA_SQL };

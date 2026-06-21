const { query } = require('./database');

const SCHEMA_SQL = `
-- ======================================================
-- Animastor PostgreSQL Schema
-- Canonical persistent state layer
-- ======================================================

-- Users / accounts (future)
CREATE TABLE IF NOT EXISTS users (
    user_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           TEXT UNIQUE NOT NULL,
    password_hash   TEXT,
    display_name    TEXT,
    avatar_url      TEXT,
    role            TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin','premium')),
    settings        JSONB DEFAULT '{}',
    created_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
    updated_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint)
);

-- Books registry
CREATE TABLE IF NOT EXISTS books (
    book_id         TEXT PRIMARY KEY,
    user_id         UUID REFERENCES users(user_id),
    title           TEXT,
    author          TEXT,
    language        TEXT DEFAULT 'ru',
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
CREATE TABLE IF NOT EXISTS generation_tasks (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    task_id         TEXT NOT NULL,
    book_id         TEXT NOT NULL,
    chapter_id      TEXT,
    scene_id        TEXT,
    task_type       TEXT NOT NULL CHECK(task_type IN ('audio','image','video')),
    status          TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','cancelled')),
    worker_id       TEXT,
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

-- Worker registry
CREATE TABLE IF NOT EXISTS workers (
    worker_id       TEXT PRIMARY KEY,
    worker_type     TEXT NOT NULL CHECK(worker_type IN ('audio','image','video','upscale')),
    capabilities    JSONB,
    status          TEXT NOT NULL DEFAULT 'offline' CHECK(status IN ('online','offline','busy','error')),
    last_seen       BIGINT,
    version         TEXT,
    metadata        JSONB,
    created_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint)
);

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
    mode            TEXT NOT NULL DEFAULT 'chat',
    messages        JSONB NOT NULL DEFAULT '[]'::jsonb,
    context         JSONB DEFAULT '{}'::jsonb,
    locked          BOOLEAN NOT NULL DEFAULT false,
    created_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
    updated_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint)
);

CREATE INDEX IF NOT EXISTS idx_ai_chat_sessions_book ON ai_chat_sessions(book_id);

-- Chat sessions (grouping of messages into user conversations)
CREATE TABLE IF NOT EXISTS chat_sessions (
    session_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID REFERENCES users(user_id),
    book_id         TEXT NOT NULL,
    title           TEXT NOT NULL DEFAULT 'Chat',
    topic_id        TEXT NOT NULL DEFAULT 'book',
    mode            TEXT NOT NULL DEFAULT 'conversation',
    message_count   INTEGER NOT NULL DEFAULT 0,
    created_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
    updated_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint)
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_book ON chat_sessions(book_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON chat_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated ON chat_sessions(updated_at DESC);

-- Chat messages (assistant + user, per session / scene / topic)
CREATE TABLE IF NOT EXISTS chat_messages (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id      UUID REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
    book_id         TEXT NOT NULL,
    scene_id        TEXT,
    character_id    TEXT,
    topic           TEXT,
    role            TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
    message         TEXT NOT NULL,
    metadata        JSONB,
    created_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint)
);

CREATE INDEX IF NOT EXISTS idx_chat_book ON chat_messages(book_id);
CREATE INDEX IF NOT EXISTS idx_chat_scene ON chat_messages(book_id, scene_id);
CREATE INDEX IF NOT EXISTS idx_chat_character ON chat_messages(book_id, character_id);
CREATE INDEX IF NOT EXISTS idx_chat_topic ON chat_messages(book_id, topic);
CREATE INDEX IF NOT EXISTS idx_chat_time ON chat_messages(book_id, created_at);

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
    status          TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','failed')),
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
                        'analyze_characters','analyze_locations','create_scenes',
                        'create_units','create_visual_prompts'
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
        { table: 'chat_messages', column: 'session_id', type: 'UUID' },
        { table: 'agent_sessions', column: 'knowledge_base', type: 'JSONB' },
        { table: 'agent_sessions', column: 'window_data', type: 'JSONB' },
        { table: 'ai_chat_sessions', column: 'topic_id', type: 'TEXT NOT NULL DEFAULT \'book\'' },
    ];

    for (const { table, column, type } of columnAdditions) {
        try {
            await query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${type}`);
        } catch (err) {
            console.error(`[PG] Failed to add column ${table}.${column}: ${err.message}`);
            throw err;
        }
    }

    // Drop FK constraints if they were created by an earlier version of this
    // migration. We removed the FKs to match other book-keyed tables
    // (asset_states, cache_entries, scene_assets) that allow orphan references
    // for flexibility — the application layer guarantees book existence.
    const fkDrops = [
        { table: 'chat_messages', constraint: 'chat_messages_book_id_fkey' },
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
    await query(`CREATE INDEX IF NOT EXISTS idx_chat_session ON chat_messages(session_id)`);

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

    // Add 'analyze_structure' to agent_steps step_type check constraint
    try {
        // PostgreSQL doesn't support ALTER CONSTRAINT to add new values to CHECK.
        // We drop and recreate the constraint.
        await query(`ALTER TABLE agent_steps DROP CONSTRAINT IF EXISTS agent_steps_step_type_check`);
        await query(`ALTER TABLE agent_steps ADD CONSTRAINT agent_steps_step_type_check
            CHECK (step_type IN (
                'analyze_structure','analyze_characters','analyze_locations',
                'create_scenes','create_units','create_visual_prompts'
            ))`);
        console.log('[PG] Updated agent_steps step_type check constraint (added analyze_structure)');
    } catch (err) {
        if (!err.message.includes('does not exist')) {
            console.error('[PG] Failed to update step_type constraint:', err.message);
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
            UNIQUE(file_hash)
        )`);
        await query(`CREATE INDEX IF NOT EXISTS idx_book_source_hash ON book_source(file_hash)`);
        await query(`CREATE INDEX IF NOT EXISTS idx_book_source_book ON book_source(book_id)`);
        console.log('[PG] Created book_source table');
    } catch (err) {
        if (!err.message.includes('already exists')) {
            console.error('[PG] Failed to create book_source:', err.message);
        }
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
}

module.exports = { runMigrations, SCHEMA_SQL };

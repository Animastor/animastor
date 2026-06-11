// ======================================================
// Storage Module - v1.0.0 → v2.0.0 (PostgreSQL)
// ======================================================
// Storage layer exports
//
// ARCHITECTURE — Three storage layers, each with a single responsibility:
//
//   PostgreSQL → Canonical persistent truth (scene state, book data, asset manifests,
//                user accounts, storyboard items, audio layers, scene assets,
//                chat messages, event log)
//                Survives restarts. System recovers from Postgres after crash.
//
//   Redis     → Runtime transport (queues, heartbeats, leases, realtime coordination)
//               Ephemeral by design (now persisted via volume for faster restart).
//               NOT the source of truth — runtime state only.
//
//   Filesystem → Asset storage (audio MP3, image PNG, video MP4)
//                Immutable output files keyed by build/scene/asset IDs.
//
const postgres = require('./postgres');
const manifest = require('./manifest');

module.exports = {
    filesystem: require('./filesystem-store'),
    registry: require('./asset-registry'),
    sceneAssetRegistry: require('../services/scene-asset-registry'),
    bookEventLog: require('../services/book-event-log'),
    chatStore: require('../services/chat-store'),
    bookSource: require('../services/book-source'),
    bookIntegrity: require('../services/book-integrity'),
    bookSync: require('../services/book-sync'),
    layerConfig: require('../services/layer-config'),
    genScope: require('../services/gen-scope'),
    manifest: manifest,
    postgres: postgres,
    redis: null   // Will be provided by main app
};

# Workflow Manager — Implementation Roadmap

> **Version:** 1.0.0  
> **Status:** Draft  
> **Last updated:** 2026-06-19

---

## 1. Overview

The Workflow Manager is a new subsystem that enables users to manage ComfyUI workflows through the application interface rather than through direct file system access. It consists of backend APIs, frontend screens, and a developer mode for advanced users.

This document provides a **phased implementation roadmap** with specific tasks, dependencies, and acceptance criteria for each stage.

---

## 2. Phased Implementation Plan

### Stage 1: Connector Architecture (Backend)

**Goal:** Extend the existing connector system with the APIs needed for UI management.

**Estimated effort:** 3-5 days

#### 1.1 Connector Registry API

**Files to create/modify:**
- `backend/src/routes/connector-routes.cjs` **(NEW)**
- `backend/src/workflows/connector-loader.js` (extend)

**Endpoints to add:**

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/v1/connectors` | List all connectors with status |
| `GET` | `/api/v1/connectors/:name` | Get connector details |
| `GET` | `/api/v1/connectors/:name/compatibility` | Get compatibility status |
| `POST` | `/api/v1/connectors/validate` | Validate a connector JSON |
| `POST` | `/api/v1/connectors/reload` | Hot-reload from disk |

**Implementation details:**
- `GET /api/v1/connectors` returns: name, label, type, workflow, status, version, lastValidated
- `GET /api/v1/connectors/:name/compatibility` runs `checkCompatibility()` in real-time
- `POST /api/v1/connectors/validate` accepts raw JSON, validates structure + compatibility
- `POST /api/v1/connectors/reload` re-reads `data/connectors/` directory, re-registers all connectors
- All endpoints are behind the existing authentication/rate-limiting

#### 1.2 Connector Hot-Reload

**Changes to `connector-loader.js`:**
- Add `reload()` method that clears and re-runs `loadConnectors()` + `registerConnectors()`
- Add `registerConnector(name, connector)` for single-connector registration
- Add `unregisterConnector(name)` for removal
- Wire `POST /api/v1/connectors/reload` → `reload()`

#### 1.3 Workflow Status API

**Changes to `workflow-loader.js`:**
- Add `getWorkflowStatus(name)` → returns hash, loaded timestamp, connector status
- Add `getAllWorkflowStatuses()` → returns status for all workflows

**Files to create:**
- `backend/src/routes/workflow-routes.cjs` **(NEW)**

**Endpoints:**

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/v1/workflows` | List all workflows |
| `GET` | `/api/v1/workflows/:name` | Get workflow details |
| `GET` | `/api/v1/workflows/:name/hash` | Get workflow hash |

#### 1.4 Acceptance Criteria (Stage 1)

- [ ] `GET /api/v1/connectors` returns correct list matching `data/connectors/` files
- [ ] `GET /api/v1/connectors/:name/compatibility` reports correct status for all existing connectors
- [ ] `POST /api/v1/connectors/validate` correctly validates a well-formed connector
- [ ] `POST /api/v1/connectors/validate` returns errors for a malformed connector
- [ ] `POST /api/v1/connectors/reload` picks up new connector files without restart
- [ ] All existing tests continue to pass
- [ ] Backend starts without errors

---

### Stage 2: Workflow Manager (Frontend)

**Goal:** Build the Workflow Manager screens in the Android app.

**Estimated effort:** 5-7 days

#### 2.1 Settings Navigation Update

**File to modify:**
- `frontend/.../SettingsFragment.kt`

Add "Workflow Manager" entry to settings list:

```
Settings
├── Visual Books
├── Audio
├── Video
├── Workers
├── Workflow Manager       ← NEW
└── Developer Tools
```

#### 2.2 Workflow Manager Screen

**Files to create:**
- `frontend/.../WorkflowManagerFragment.kt` **(NEW)**
- `frontend/.../WorkflowManagerViewModel.kt` **(NEW)**

**Layout:**

```
┌──────────────────────────────────────────────┐
│  ← Workflow Manager                          │
│                                              │
│  ┌──────────────────────────────────────┐    │
│  │ 🎤 Audio Workflows                   │    │
│  │ 1 active workflow                    │    │
│  │ TTS Narration (Qwen)                 │    │
│  │                      [ Manage ]      │    │
│  └──────────────────────────────────────┘    │
│                                              │
│  ┌──────────────────────────────────────┐    │
│  │ 🖼 Image Workflows                   │    │
│  │ 1 active workflow                    │    │
│  │ Image Generation (Qwen)              │    │
│  │                      [ Manage ]      │    │
│  └──────────────────────────────────────┘    │
│                                              │
│  ┌──────────────────────────────────────┐    │
│  │ 🎬 Video Workflows                   │    │
│  │ 1 active workflow                    │    │
│  │ Video Generation (4 Images)          │    │
│  │                      [ Manage ]      │    │
│  └──────────────────────────────────────┘    │
└──────────────────────────────────────────────┘
```

#### 2.3 Workflow Type List Screen

**Files to create:**
- `frontend/.../WorkflowTypeListFragment.kt` **(NEW)**

**Layout (example for Image Workflows):**

```
┌──────────────────────────────────────────────┐
│  ← Workflow Manager > Image Workflows       │
│                                              │
│  ✓ Image Generation (Qwen)                  │
│  Connector: conn-image-generation           │
│  Status: Compatible ✓                       │
│                      [ Details ] [ Disable ] │
│                                              │
│  [ + Add Workflow ]                         │
└──────────────────────────────────────────────┘
```

#### 2.4 Workflow Details Screen

**Files to create:**
- `frontend/.../WorkflowDetailsFragment.kt` **(NEW)**

**Layout:**

```
┌──────────────────────────────────────────────┐
│  ← Image Generation (Qwen)                  │
│                                              │
│  ┌──────────────────────────────────────┐    │
│  │ Workflow: img-qwen-image             │    │
│  │ Connector: conn-image-generation     │    │
│  │ Type: Image                          │    │
│  │ Status: Compatible ✓                 │    │
│  └──────────────────────────────────────┘    │
│                                              │
│  [Inputs] [Outputs] [Parameters] [Compat.]  │
│                                              │
│  Parameters tab content:                     │
│  Width:       768           [ Edit ]        │
│  Height:      1024          [ Edit ]        │
│  Steps:       8             [ Edit ]        │
│  CFG:         2             [ Edit ]        │
│  Sampler:     euler         [ Edit ]        │
│  Scheduler:   normal        [ Edit ]        │
└──────────────────────────────────────────────┘
```

**Tab contents by tab:**

| Tab | Content | Data Source |
|-----|---------|-------------|
| Inputs | Entity key → nodeId mapping (label only) | `connector.inputs` |
| Outputs | Entity key → nodeId mapping (label only) | `connector.outputs` |
| Parameters | Editable parameter list with current values | `connector.parameters` |
| Compatibility | Hash status, node check count, version | `checkCompatibility()` |

#### 2.5 API Models (Android)

**Files to create:**
- `frontend/.../repository/ConnectorModels.kt` **(NEW)**
- `frontend/.../repository/WorkflowModels.kt` **(NEW)**

Data classes to add:

```kotlin
data class ConnectorSummary(
    val name: String,
    val label: String,
    val type: String,
    val workflow: String,
    val status: String,
    val version: String,
    val lastValidated: String?
)

data class ConnectorDetail(
    val name: String,
    val workflow: String,
    val label: String,
    val description: String,
    val type: String,
    val version: String,
    val inputs: Map<String, Binding>,
    val outputs: Map<String, Binding>,
    val parameters: Map<String, ParameterBinding>,
    val metadata: JsonObject?
)

data class CompatibilityStatus(
    val compatible: Boolean,
    val hashMatch: Boolean,
    val nodesChecked: Int,
    val nodesTotal: Int,
    val warnings: List<String>,
    val errors: List<String>
)
```

#### 2.6 Backend API Interface

**File to extend:**
- `frontend/.../repository/BackendApi.kt`

Add Retrofit interface methods:

```kotlin
@GET("api/v1/connectors")
suspend fun getConnectors(): Response<List<ConnectorSummary>>

@GET("api/v1/connectors/{name}")
suspend fun getConnectorDetail(@Path("name") name: String): Response<ConnectorDetail>

@GET("api/v1/connectors/{name}/compatibility")
suspend fun getConnectorCompatibility(@Path("name") name: String): Response<CompatibilityStatus>

@POST("api/v1/connectors/validate")
suspend fun validateConnector(@Body body: RequestBody): Response<ValidationResult>

@POST("api/v1/connectors/reload")
suspend fun reloadConnectors(): Response<Unit>
```

#### 2.7 Acceptance Criteria (Stage 2)

- [ ] Settings screen shows "Workflow Manager" entry
- [ ] Workflow Manager shows correct category cards with active counts
- [ ] Tap category → shows list of workflows for that type
- [ ] Tap workflow → shows details screen with 4 tabs
- [ ] Parameters tab shows correct values from connector
- [ ] Compatibility tab shows live status
- [ ] UI does not show nodeId, expectedClass, or internal bindings to non-developer users
- [ ] All data is loaded via API (no hardcoded values)

---

### Stage 3: Workflow Details & Parameters (Extended)

**Goal:** Enable parameter editing and workflow enable/disable.

**Estimated effort:** 3-4 days

#### 3.1 Parameter Editing

**Backend:**
- `PUT /api/v1/connectors/:name/parameters` — Update parameter defaults
- Parameter validation (type checking, range validation)
- Options: save to connector file or runtime-only override

**Frontend:**
- Edit button in Parameters tab opens inline editor
- Support for different input types:
  - Integer: number picker / slider
  - Float: number picker / slider with step
  - String: text input / dropdown (for samplers, schedulers)
- "Save" button sends updated values to backend
- "Reset to default" button

#### 3.2 Workflow Enable/Disable

**Backend:**
- `PUT /api/v1/connectors/:name/status` — Toggle enabled/disabled
- Disabled workflows are skipped during dispatch

**Frontend:**
- Toggle switch in workflow list item
- Disabled workflows shown with grayed-out style

#### 3.3 Workflow Quick Actions

**In workflow type list screen:**
- Enable/Disable toggle
- Delete workflow (unregister + remove file)
- Add workflow (file picker for .json + auto-connector creation in future)

#### 3.4 Acceptance Criteria (Stage 3)

- [ ] Parameter editor opens inline for each parameter
- [ ] Changes are saved via API
- [ ] Enable/disable toggle works correctly
- [ ] Disabled workflows are visually distinct
- [ ] Parameter validation works (rejects out-of-range values)

---

### Stage 4: Developer Mode

**Goal:** Expose advanced workflow details for developers and power users.

**Estimated effort:** 3-4 days

#### 4.1 Navigation

Add to Settings → Developer Tools:

```
Developer Tools
├── Workflow Developer     ← NEW
├── (existing entries)
```

**File to create/modify:**
- `frontend/.../DeveloperViewFragment.kt` **(NEW)** or extend existing developer tools

#### 4.2 Developer Workflow Screen

**Layout:**

```
┌──────────────────────────────────────────────┐
│  ← Workflow Developer                        │
│                                              │
│  Select workflow: [ Image Generation ▼ ]    │
│                                              │
│  ┌─── Connector Mapping ─────────────────┐   │
│  │ Positive Prompt  → CLIPTextEncode #108│   │
│  │ Negative Prompt  → CLIPTextEncode #109│   │
│  │ Generated Image  ← SaveImage #1008    │   │
│  │     ...                               │   │
│  │                        [ Edit Mapping ]│   │
│  └───────────────────────────────────────┘   │
│                                              │
│  ┌─── Compatibility Details ─────────────┐   │
│  │ Workflow Hash: ✓ Match                │   │
│  │ Nodes Checked: 6/6                    │   │
│  │ Connector Version: 1.0.0              │   │
│  │                        [ Recheck ]    │   │
│  └───────────────────────────────────────┘   │
│                                              │
│  ┌─── Raw Connector ─────────────────────┐   │
│  │ { "connectorVersion": "1.0.0", ... }  │   │
│  │                        [ Edit JSON ]  │   │
│  └───────────────────────────────────────┘   │
└──────────────────────────────────────────────┘
```

#### 4.3 Mapping Editor

**Layout:**

```
┌──────────────────────────────────────────────┐
│  ← Mapping Editor                            │
│                                              │
│  Backend Entity                              │
│  [ Positive Prompt ▼ ]                       │
│                                              │
│  Workflow Node                               │
│  [ CLIPTextEncode #108 ▼ ]                  │
│                                              │
│  Field                                       │
│  [ inputs.text ▼ ]                          │
│                                              │
│  [ Save ]  [ Cancel ]                       │
└──────────────────────────────────────────────┘
```

#### 4.4 Backend Developer Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/v1/connectors/:name/raw` | Raw connector JSON |
| `GET` | `/api/v1/connectors/:name/mapping` | Structured entity→node mapping |
| `PUT` | `/api/v1/connectors/:name/mapping/:entityKey` | Update a single binding |
| `PUT` | `/api/v1/connectors/:name/raw` | Update entire connector JSON |

#### 4.5 Acceptance Criteria (Stage 4)

- [ ] Developer Tools screen accessible from Settings
- [ ] Connector Mapping shows all bindings with nodeIds and expectedClasses
- [ ] Mapping Editor allows changing entity-to-node bindings
- [ ] Raw Connector View shows full JSON
- [ ] Warnings are hidden from normal user screens

---

### Stage 5: Workflow Assistant Integration (Foundation)

**Goal:** Prepare architecture for AI Workflow Assistant without implementing it fully.

**Estimated effort:** 1-2 days (design only)

- Ensure all connector APIs support AI tool calls
- Define tool schemas for Workflow Assistant (analyze, create, validate)
- Design data flow for auto-connector generation

> **Note:** This stage is documented in detail in `WorkflowAssistantVision.md`.

---

## 3. Dependency Graph

```
Stage 1 (Backend API)
    │
    ▼
Stage 2 (Frontend Manager)
    │
    ├──► Stage 3 (Parameters & Controls)
    │
    └──► Stage 4 (Developer Mode)
              │
              ▼
         Stage 5 (AI Assistant — future)
```

- **Stage 1** is a prerequisite for all subsequent stages
- **Stage 2** can be developed in parallel with Stage 1 (using mock data)
- **Stages 3 and 4** can be developed in parallel after Stage 2
- **Stage 5** requires all previous stages

---

## 4. File Creation/Modification Summary

### New Backend Files

| File | Stage | Purpose |
|------|-------|---------|
| `backend/src/routes/connector-routes.cjs` | 1 | Connector registry API |
| `backend/src/routes/workflow-routes.cjs` | 1 | Workflow status API |
| `backend/src/services/workflow-manager.js` | 1 | Orchestration layer for workflow management |

### New Frontend Files

| File | Stage | Purpose |
|------|-------|---------|
| `ui/WorkflowManagerFragment.kt` | 2 | Main workflow manager screen |
| `ui/WorkflowManagerViewModel.kt` | 2 | ViewModel for manager |
| `ui/WorkflowTypeListFragment.kt` | 2 | Workflow list by type |
| `ui/WorkflowDetailsFragment.kt` | 2 | Workflow detail with tabs |
| `ui/WorkflowDetailsViewModel.kt` | 2 | ViewModel for details |
| `ui/DeveloperViewFragment.kt` | 4 | Developer workflow screen |
| `ui/MappingEditorFragment.kt` | 4 | Mapping editor screen |
| `repository/ConnectorModels.kt` | 2 | Data models for connectors |
| `repository/WorkflowModels.kt` | 2 | Data models for workflows |

---

## 5. Risks and Mitigation

| Risk | Stage | Mitigation |
|------|-------|------------|
| Backend API changes break frontend | 1-2 | Version all new endpoints as `/api/v1/` |
| Connector hot-reload corrupts state | 1 | Atomic swap, validation before registration |
| Android fragment navigation too deep | 2-4 | Use nested nav graphs, keep max 3 levels |
| Parameter editing conflicts with runtime | 3 | Runtime overrides vs persisted defaults distinction |
| Large workflows slow down details screen | 2 | Lazy-load tabs, cache API responses |
| Developer Mode exposes internals to regular users | 4 | Navigation only from Developer Tools menu, behind setting toggle |

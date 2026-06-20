# Workflow Manager — Implementation Roadmap

> **Version:** 1.2.0  
> **Status:** Active  
> **Last updated:** 2026-06-20 (Smart Bindings, Edit Mode complete)

---

## 1. Overview

The Workflow Manager is a new subsystem that enables users to manage ComfyUI workflows through the application interface rather than through direct file system access. It consists of backend APIs, frontend screens, and a developer mode for advanced users.

This document provides a **phased implementation roadmap** with specific tasks, dependencies, and acceptance criteria for each stage.

---

## 2. Phased Implementation Plan

### ✅ Stage 1: Connector Architecture (Backend)

**Goal:** Extend the existing connector system with the APIs needed for UI management.

**Status:** COMPLETED

#### 1.1 Connector Registry API

**Files created:**
- `backend/src/routes/connector-routes.cjs`
- `backend/src/routes/workflow-routes.cjs`

**Additional endpoints now available:**

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/v1/connectors` | List all connectors with status |
| `GET` | `/api/v1/connectors/:name` | Get connector details |
| `GET` | `/api/v1/connectors/:name/compatibility` | Get compatibility status |
| `GET` | `/api/v1/connectors/:name/parameters` | Get parameter values |
| `GET` | `/api/v1/connectors/:name/raw` | Raw connector JSON (dev mode) |
| `GET` | `/api/v1/connectors/entities` | Entity schema listing |
| `GET` | `/api/v1/connectors/grouped` | Connectors grouped by type |
| `POST` | `/api/v1/connectors/validate` | Validate a connector JSON |
| `POST` | `/api/v1/connectors/reload` | Hot-reload from disk |
| `PUT` | `/api/v1/connectors/:name/parameters` | Update parameter value |
| `PUT` | `/api/v1/connectors/:name/status` | Enable/disable connector |
| `GET` | `/api/v1/workflows` | List all workflows |
| `GET` | `/api/v1/workflows/:name` | Get workflow details |
| `GET` | `/api/v1/workflows/:name/hash` | Get workflow hash |
| `GET` | `/api/v1/workflows/summary` | Workflow summary counts |

#### 1.2 Connector Hot-Reload

**Implemented in connector-loader.js:**
- `reload()` — clears and re-runs load + register, preserves enabled/disabled state
- `registerConnector(name, connector)` — single-connector registration
- `unregisterConnector(name)` — removal from both indices
- `updateConnectorParameter()` — validates type/min/max, updates in-memory
- `resetConnectorParameter()` — returns current value

#### 1.3 Workflow Status API

**Implemented in workflow-routes.cjs:**
- `GET /api/v1/workflows` — with type detection (audio/image/video)
- `GET /api/v1/workflows/:name` — with nodeTypes map
- `GET /api/v1/workflows/:name/hash` — SHA-256 hex
- `GET /api/v1/workflows/summary` — counts byType, withConnector/withoutConnector

#### 1.4 Acceptance Criteria (Stage 1)

- [x] `GET /api/v1/connectors` returns correct list matching `data/connectors/` files
- [x] `GET /api/v1/connectors/:name/compatibility` reports correct status for all existing connectors
- [x] `POST /api/v1/connectors/validate` correctly validates a well-formed connector
- [x] `POST /api/v1/connectors/validate` returns errors for a malformed connector
- [x] `POST /api/v1/connectors/reload` picks up new connector files without restart
- [x] All existing tests continue to pass
- [x] Backend starts without errors

---

### ✅ Stage 2: Workflow Manager (Frontend)

**Goal:** Build the Workflow Manager screens in the Android app.

**Status:** COMPLETED

#### 2.1 Settings Navigation Update

**File modified:**
- `frontend/app/src/main/java/.../SettingsFragment.kt`

"Workflow Manager" entry added to settings list, navigates to WorkflowManagerFragment.

#### 2.2 Workflow Manager Screen

**Files created:**
- `frontend/.../ui/WorkflowManagerFragment.kt` — category cards (Audio/Image/Video) with active counts
- `frontend/.../ui/WorkflowManagerViewModel.kt` — loads connectors grouped by type

#### 2.3 Workflow Type List Screen

**Files created:**
- `frontend/.../ui/WorkflowTypeListFragment.kt` — workflow list by type with enabled/disabled toggle
- `frontend/.../res/layout/item_workflow_entry.xml` — card with label, connector name, status, SwitchMaterial toggle, Details button

#### 2.4 Workflow Details Screen

**Files created:**
- `frontend/.../ui/WorkflowDetailsFragment.kt` — 4-tab layout (Inputs/Outputs/Parameters/Compatibility)
- `frontend/.../ui/WorkflowDetailsViewModel.kt` — loads detail, compatibility, parameter values
- `frontend/.../res/layout/fragment_workflow_details.xml` — header card + TabLayout + ViewPager2
- `frontend/.../res/layout/dialog_edit_parameter.xml` — parameter edit dialog with Save/Reset/Cancel

**Tab contents by tab:**

| Tab | Content | Data Source |
|-----|---------|-------------|
| Inputs | Entity key → nodeId mapping (label only) | `connector.inputs` |
| Outputs | Entity key → nodeId mapping (label only) | `connector.outputs` |
| Parameters | Editable parameter list with current values | `connector.parameters` + `GET /connectors/:name/parameters` |
| Compatibility | Hash status, node check count, version | `checkCompatibility()` |

#### 2.5 API Models (Android)

**Files created:**
- `frontend/.../repository/ConnectorModels.kt` — includes all models: summary, detail, binding, compatibility, validation, parameters, status

#### 2.6 Backend API Interface

**File extended:**
- `frontend/.../repository/BackendApi.kt` — all connector + workflow endpoints defined

#### 2.7 Acceptance Criteria (Stage 2)

- [x] Settings screen shows "Workflow Manager" entry
- [x] Workflow Manager shows correct category cards with active counts
- [x] Tap category → shows list of workflows for that type
- [x] Tap workflow → shows details screen with 4 tabs
- [x] Parameters tab shows correct values from connector + live API
- [x] Compatibility tab shows live status
- [x] UI does not show nodeId, expectedClass, or internal bindings to non-developer users
- [x] All data is loaded via API (no hardcoded values)

---

### ✅ Stage 3: Workflow Details & Parameters (Extended)

**Goal:** Enable parameter editing and workflow enable/disable.

**Status:** COMPLETED (Parameter Editing + Enable/Disable Toggle)

#### 3.1 Parameter Editing

**Backend:**
- `PUT /api/v1/connectors/:name/parameters` — Update parameter defaults ✅
- `GET /api/v1/connectors/:name/parameters` — Get current parameter values ✅
- Parameter validation (type checking, range validation with min/max clamping) ✅
- In-memory update (runtime-only override) ✅

**Frontend:**
- Edit button in Parameters tab opens `dialog_edit_parameter.xml` dialog ✅
- Support for different input types:
  - Integer: `TYPE_CLASS_NUMBER` ✅
  - Float: `TYPE_CLASS_NUMBER | TYPE_NUMBER_FLAG_DECIMAL` ✅
  - String: `TYPE_CLASS_TEXT` ✅
- "Save" button sends `PUT /connectors/:name/parameters` to backend ✅
- "Reset to default" button resets input field to connector's default value ✅
- Live value display updates via `currentParamValues` StateFlow ✅
- Type and range info shown below input (e.g. "int · Range: 1 – 100") ✅

#### 3.2 Workflow Enable/Disable

**Backend:**
- `PUT /api/v1/connectors/:name/status` — Toggle enabled/disabled ✅
- `connectorEnabled` map in connector-loader.js with `setConnectorStatus()`/`isConnectorEnabled()` ✅
- State preserved across hot-reload ✅
- Backend checks enabled status through getter for future dispatch filtering ✅

**Frontend:**
- `SwitchMaterial` toggle in each workflow list item ✅
- Disabled workflows shown with grayed-out style (alpha 0.45) ✅
- Details button disabled for disabled workflows ✅
- RecyclerView-safe: listener removed before `isChecked` set to prevent spurious API calls on bind() ✅
- Refresh after toggle via `sharedViewModel.loadConnectors()` ✅

#### 3.3 Workflow Quick Actions
- [x] Add workflow (file picker for .json → POST /api/v1/connectors → auto-refresh)
- [ ] Delete workflow (unregister + remove file)

#### 3.4 Binding Editing (Edit Mode)

**Backend:**
- `PUT /api/v1/connectors/:name/bindings` — Update nodeId/field per binding ✅
- `updateConnectorBinding()` in connector-loader + workflow-manager ✅
- `expectedClass` + `nodeClass` fields in connector detail API response ✅
- Backend resolves `nodeClass` from workflow JSON (class_type lookup) ✅

**Frontend:**
- Edit Mode: toggle OFF → Details opens with editMode=true ✅
- Inputs/Outputs cards show "Edit" button in edit mode ✅
- Card shows "CLIPTextEncode (108)" instead of "Node 108" ✅
- Smart Edit dialog: RadioGroup of compatible nodes filtered by expectedClass ✅
- Fallback: all nodes if expectedClass not set, current node if no workflow data ✅

#### 3.5 Compatibility Check Upgrade
- Per-binding `expectedClass` vs `workflowNode.class_type` check ✅
- Required port without nodeId → warning ✅
- Backward compatible (checks only run when fields are set) ✅

#### 3.6 Acceptance Criteria (Stage 3)

- [x] Parameter editor opens inline for each parameter (via dialog_edit_parameter.xml)
- [x] Changes are saved via API (`PUT /connectors/:name/parameters`)
- [x] Enable/disable toggle works correctly (`PUT /connectors/:name/status`)
- [x] Disabled workflows are visually distinct (alpha 0.45 + controls disabled)
- [x] Parameter validation works (rejects out-of-range values, clamps on backend)
- [x] Binding editing saves nodeId changes via API
- [x] Smart dialog shows compatible nodes filtered by expectedClass
- [x] Card display shows class name with node ID

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
| `PUT` | `/api/v1/connectors/:name/bindings` | Update a single binding (section/entityKey/nodeId/field) |
| `PUT` | `/api/v1/connectors/:name/raw` | Update entire connector JSON |

#### 4.5 Acceptance Criteria (Stage 4)

- [ ] Developer Tools screen accessible from Settings
- [ ] Connector Mapping shows all bindings with nodeIds and expectedClasses
- [x] Mapping Editor allows changing entity-to-node bindings (Edit Mode dialog)
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
| `ui/DeveloperViewFragment.kt` | 4 | Developer workflow screen (planned) |
| `ui/MappingEditorFragment.kt` | 4 | Mapping editor screen (planned) |
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

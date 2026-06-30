# Workflow Assistant — Vision Document

> **Version:** 1.0.0  
> **Status:** Draft / Future  
> **Last updated:** 2026-06-19

---

## 1. Overview

The Workflow Assistant is a **future AI-powered tool** that will enable users to interact with the workflow system through natural language. It is designed as an extension of the existing AI Assistant architecture (`chat-engine.cjs`, `agent-service.js`) with specialized tools for workflow analysis and connector creation.

**Current status:** Not implemented. This document outlines the vision, architecture requirements, and design decisions.

---

## 2. Vision Statement

Users should be able to:

1. **Upload a ComfyUI workflow** and receive an automatically generated connector
2. **Ask questions** about any workflow ("What are my inputs?", "Why isn't this workflow running?")
3. **Modify connectors** through conversation ("Connect the positive prompt to the new CLIP node")
4. **Diagnose problems** ("This workflow produces black images — what's wrong?")
5. **Get recommendations** ("Which workflow should I use for this scene type?")

---

## 3. Architecture Requirements

For the Workflow Assistant to function effectively, the underlying system must provide:

### 3.1 Prerequisites (from Stages 1-4)

| Prerequisite | Stage | Why It's Needed |
|-------------|-------|-----------------|
| Connector registry API | 1 | Assistant needs to query available connectors |
| Workflow loader API | 1 | Assistant needs to read workflow templates |
| Entity schema | 1 | Assistant needs to know valid entity types |
| Compatibility checker | 1 | Assistant needs to validate connectors |
| Parameter metadata | 3 | Assistant needs to know parameter constraints |
| Developer Mode API | 4 | Assistant needs full binding access |

### 3.2 Required Data Sources

The Assistant needs read access to:

```
Data/Workflows/
├── Raw workflow JSON (full node graph)
├── Connector JSON (current bindings)
├── Entity schema (canonical entity definitions)
├── Compatibility reports (validation results)
└── Metadata (labels, descriptions, types)
```

### 3.3 AI Tool Definitions

The Workflow Assistant will expose the following tools (analogous to existing tools in `chat-engine.cjs`):

#### Tool: `analyze_workflow`
- **Purpose:** Analyze a raw ComfyUI workflow JSON and describe its structure
- **Input:** Workflow JSON
- **Output:** List of input nodes, output nodes, parameter nodes, node classes, connections
- **Used for:** Understanding unknown workflows

#### Tool: `suggest_connector`
- **Purpose:** Generate a connector structure from a workflow analysis
- **Input:** Workflow analysis result + entity schema
- **Output:** Proposed connector JSON with entity→node mappings
- **Used for:** Auto-creating connectors from uploaded workflows

#### Tool: `validate_connector`
- **Purpose:** Validate a connector against a workflow and report issues
- **Input:** Connector JSON + Workflow JSON
- **Output:** Validation results with suggested fixes
- **Used for:** Diagnosing connector problems

#### Tool: `find_output_nodes`
- **Purpose:** Locate SaveImage/SaveAudio/SaveVideo nodes in a workflow
- **Input:** Workflow JSON
- **Output:** Node IDs and class types of output nodes
- **Used for:** Identifying workflow outputs

#### Tool: `find_input_nodes`
- **Purpose:** Locate input-capable nodes (CLIPTextEncode, LoadImage, etc.)
- **Input:** Workflow JSON
- **Output:** Node IDs with expected input types
- **Used for:** Identifying workflow inputs

#### Tool: `diagnose_workflow`
- **Purpose:** Run diagnostics on a workflow to find common issues
- **Input:** Workflow JSON (optional: connector)
- **Output:** List of warnings (missing connections, unsupported nodes, etc.)
- **Used for:** Troubleshooting workflow execution failures

---

## 4. Interaction Design

### 4.1 Entry Point

```
Settings
→ Workflow Manager
→ Workflow Assistant
```

The Assistant opens as a chat interface, similar to the existing AI Assistant.

### 4.2 Conversation Flow

```
User: "I uploaded a new workflow called 'my-animator.json'. Can you analyze it?"

Assistant: [calls analyze_workflow]
           "I've analyzed the workflow. Here's what I found:
            
            **Inputs:**
            - CLIPTextEncode (node 45) — expects text input
            - LoadImage (node 22) — expects image input
            
            **Outputs:**
            - SaveImage (node 1008) — saves generated image
            
            **Parameters:**
            - KSampler (node 50) — steps, cfg, sampler_name
            
            Would you like me to create a connector for this workflow?"
```

```
User: "Yes, please create a connector."

Assistant: [calls suggest_connector]
           "I've created a connector based on the workflow analysis:
           
            **Suggested mappings:**
            - positivePrompt → CLIPTextEncode #45 (inputs.text)
            - generatedImage → SaveImage #1008
            
            **Parameters detected:**
            - steps → KSampler #50 (inputs.steps)
            - cfg → KSampler #50 (inputs.cfg)
            
            Shall I save this connector and register it?"
```

```
User: "Can you check why this workflow isn't working?"

Assistant: [calls diagnose_workflow]
           "I found several issues:
            
            1. **Missing model loader** — The workflow references 'CheckpointLoader' 
               but no model file is specified
            2. **Unconnected node** — Node 67 (VAEDecode) has no input connection
            3. **Hash mismatch** — The workflow has been modified since the connector 
               was created (expected hash: abc123, got: def456)
            
            Would you like me to suggest fixes?"
```

### 4.3 Error Types the Assistant Should Detect

| Error Type | Detection Method | Suggested Fix |
|-----------|-----------------|---------------|
| Missing node in workflow | Compare connector bindings to workflow keys | Update connector bindings |
| Hash mismatch | Hash comparison | Update connector hash, review changes |
| Missing model/checkpoint | Scan workflow for loader nodes | Add model configuration |
| Unconnected nodes | Trace node connections graph | Add missing connections |
| Invalid parameter values | Check parameter ranges | Adjust value |
| Wrong node class | Check class_type vs expectedClass | Update connector nodeClasses |
| Missing output node | Scan for Save* nodes | Add output node to workflow |

---

## 5. Integration with Existing AI Infrastructure

### 5.1 Architecture Layering

```
┌─────────────────────────────────────────────┐
│           Workflow Assistant Chat           │
│  (New specialized chat interface)           │
└─────────────────────┬───────────────────────┘
                      │ uses
┌─────────────────────▼───────────────────────┐
│          Chat Engine (existing)              │
│  backend/src/services/chat-engine.cjs        │
│  Extended with workflow tools                │
└─────────────────────┬───────────────────────┘
                      │ calls
┌─────────────────────▼───────────────────────┐
│          Connector System (existing)         │
│  connector-loader.js, entity-schema.js       │
└─────────────────────────────────────────────┘
```

### 5.2 Reusing Existing Components

| Existing Component | How It's Used |
|-------------------|---------------|
| `chat-engine.cjs` | Tool-based chat architecture, system prompts |
| `context-builder.js` | Building workflow context for prompts |
| `ai-service.js` | AI model calls (OpenRouter/Nvidia) |
| `entity-schema.js` | Ground-truth for entity types |
| `connector-loader.js` | Validation and compatibility logic |
| `workflow-loader.js` | Workflow template access |

### 5.3 New Components Needed

| Component | Purpose |
|-----------|---------|
| `workflow-assistant-tools.js` | Tool implementations (analyze, suggest, diagnose) |
| `workflow-assistant-chat.js` | Specialized chat handler for workflow context |
| `workflow-graph-analyzer.js` | Static analysis of ComfyUI node graphs |

---

## 6. Future Expansion Possibilities

### 6.1 Visual Workflow Editor

After the Assistant can understand and create connectors, a visual editor could be built:

- **Left panel:** Available entities from entity-schema.js
- **Right panel:** Workflow nodes from connector
- **Middle:** Drag-and-drop binding connections
- **Bottom:** Raw JSON view

### 6.2 Workflow Library

A shared repository of pre-built workflows with connectors:
- Community-contributed workflows
- One-click import through the Assistant
- Rating and compatibility badges

### 6.3 Multi-Platform Support

The Workflow Assistant could be extended to support non-ComfyUI platforms:
- Stable Diffusion WebUI
- Diffusers pipelines
- Custom Python scripts
- Each platform gets its own connector format with shared entity schema

### 6.4 Automated Workflow Optimization

The Assistant could:
- Suggest optimal parameter values based on scene type
- Recommend workflow variants for different quality/speed tradeoffs
- Automatically adjust CFG, steps, and samplers based on content analysis

---

## 7. Implementation Recommendations

### 7.1 Start Simple

Phase 1 of the Workflow Assistant should focus on:
1. **Analysis** — Reading and describing existing workflows
2. **Validation** — Checking connector compatibility
3. **Diagnostics** — Finding common issues

Do NOT start with:
- Auto-connector creation (high complexity)
- Workflow modification (safety concerns)
- Visual editor (separate project)

### 7.2 Build on Existing Chat Engine

The Workflow Assistant should be a **new mode** in the existing chat engine, not a separate service. This gives:
- Shared session management
- Consistent UX (same chat interface)
- Reusable AI model configuration
- Existing tool infrastructure

### 7.3 Use Structured Output

All workflow analysis should produce structured JSON (not free text) to enable:
- UI rendering of results
- Follow-up tool calls
- History and comparison
- Automated testing

### 7.4 Safety Constraints

- Never modify workflow files directly (always create connectors)
- Validate all AI-suggested connectors through the existing validation pipeline
- Require user confirmation before registering new connectors
- Keep a history of connector changes for rollback

---

## 8. Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| AI generates incorrect connectors | Medium | Always validate through existing pipeline, require user confirmation |
| AI cannot understand complex workflows | Low | Start with simple workflows, add graph analysis tools incrementally |
| User relies on AI without understanding | Low | Show clear validation results, require manual confirmation |
| Performance: large workflows slow analysis | Medium | Limit analysis to relevant nodes, use caching |
| Scope creep into visual editor | Medium | Keep clear boundary between chat and visual tools |

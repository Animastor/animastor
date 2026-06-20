package com.example.animastor.repository

// ======================================================
// Connector Models
// ======================================================

data class ConnectorListResponse(
    val connectors: List<ConnectorSummary> = emptyList()
)

data class ConnectorSummary(
    val name: String = "",
    val label: String = "",
    val type: String = "unknown",
    val workflow: String = "",
    val status: String = "unknown",
    val version: String = "1.0.0",
    val description: String = "",
    val enabled: Boolean = true
)

data class ConnectorDetail(
    val name: String = "",
    val workflow: String = "",
    val workflowHash: String? = null,
    val label: String = "",
    val description: String = "",
    val type: String = "unknown",
    val version: String = "1.0.0",
    val metadata: Map<String, Any>? = null,
    val inputs: Map<String, BindingDef> = emptyMap(),
    val outputs: Map<String, BindingDef> = emptyMap(),
    val parameters: Map<String, BindingDef> = emptyMap(),
    val guideNodes: GuideNodes? = null,
    val hasGuideNodes: Boolean = false
)

data class GuideNodes(
    val nodeType: String = "unknown",
    val bindings: List<GuideBinding> = emptyList()
)

data class GuideBinding(
    val label: String = "",
    val nodeId: String? = null,
    val nodeClass: String? = null,
    val fields: GuideFieldDef? = null
)

data class GuideFieldDef(
    val frameIdx: String? = null,
    val strength: String? = null,
    val imageSource: String? = null
)

data class BindingDef(
    val nodeId: String? = null,
    val field: String? = null,
    val label: String = "",
    val entityType: String? = null,
    val required: Boolean = false,
    val dataType: String? = null,
    val kind: String? = null,
    val defaultValue: Any? = null,
    val min: Any? = null,
    val max: Any? = null,
    val type: String? = null,          // "multi" for multi-bindings
    val bindings: List<SubBinding>? = null,  // for multi-bindings
    val expectedClass: String? = null,
    val nodeClass: String? = null
)

data class SubBinding(
    val nodeId: String? = null,
    val label: String? = null,
    val entityType: String? = null,
    val required: Boolean = false,
    val arrayPosition: Int? = null,
    val expectedClass: String? = null,
    val nodeClass: String? = null
)

data class CompatibilityStatus(
    val name: String = "",
    val workflow: String = "",
    val compatible: Boolean = false,
    val hashMatch: Boolean = false,
    val nodesChecked: Int = 0,
    val nodesTotal: Int = 0,
    val warnings: List<String> = emptyList(),
    val errors: List<String> = emptyList(),
    val workflowHash: String? = null,
    val lastValidated: String? = null
)

data class ConnectorValidationResult(
    val valid: Boolean = false,
    val structureErrors: List<String> = emptyList(),
    val compatibility: CompatibilityStatus? = null,
    val errors: List<String> = emptyList()
)

data class ConnectorReloadResult(
    val ok: Boolean = false,
    val connectorsLoaded: Int = 0,
    val warnings: List<String> = emptyList(),
    val errors: List<String> = emptyList()
)

// ======================================================
// Connector Status Models (Enable/Disable)
// ======================================================

data class ConnectorStatusRequest(
    val enabled: Boolean
)

data class ConnectorStatusResponse(
    val ok: Boolean = false,
    val error: String? = null,
    val enabled: Boolean? = null
)

// ======================================================
// Binding Update Models (Edit Mode)
// ======================================================

data class UpdateBindingRequest(
    val section: String,
    val entityKey: String,
    val nodeId: String? = null,
    val field: String? = null
)

data class UpdateBindingResponse(
    val ok: Boolean = false,
    val error: String? = null
)

// ======================================================
// Parameter Update Models (Stage 3)
// ======================================================

data class UpdateParameterRequest(
    val paramKey: String,
    val value: Any?
)

data class UpdateParameterResponse(
    val ok: Boolean = false,
    val error: String? = null,
    val previousValue: Any? = null,
    val currentValue: Any? = null,
    val warnings: List<String>? = null
)

data class ConnectorParameterValues(
    val values: Map<String, Any?> = emptyMap()
)

// ======================================================

data class ConnectorGroupedResponse(
    val audio: List<ConnectorSummary> = emptyList(),
    val image: List<ConnectorSummary> = emptyList(),
    val video: List<ConnectorSummary> = emptyList(),
    val unknown: List<ConnectorSummary> = emptyList()
)

// ======================================================
// Add Connector Models
// ======================================================

data class AddConnectorRequest(
    val name: String,
    val connector: Map<String, Any?>
)

data class AddConnectorResponse(
    val ok: Boolean = false,
    val error: String? = null,
    val name: String? = null,
    val warnings: List<String>? = null,
    val message: String? = null
)

// ======================================================
// Entity Schema Models
// ======================================================

data class EntitySchemaResponse(
    val entities: Map<String, EntityDef> = emptyMap()
)

data class EntityDef(
    val key: String = "",
    val label: String = "",
    val type: String = "",
    val kind: String = "",
    val description: String = ""
)

// ======================================================
// Workflow Models
// ======================================================

data class WorkflowListResponse(
    val workflows: List<WorkflowSummary> = emptyList()
)

data class WorkflowSummary(
    val name: String = "",
    val type: String = "unknown",
    val nodes: Int = 0,
    val hasConnector: Boolean = false,
    val connectorName: String? = null,
    val hash: String? = null
)

data class WorkflowDetail(
    val name: String = "",
    val nodes: Int = 0,
    val nodeTypes: Map<String, String> = emptyMap(),
    val hash: String? = null,
    val hasConnector: Boolean = false,
    val connectorName: String? = null
)

data class WorkflowHashResponse(
    val name: String = "",
    val hash: String? = null
)

data class WorkflowSummaryResponse(
    val total: Int = 0,
    val byType: Map<String, Int> = emptyMap(),
    val withConnector: Int = 0,
    val withoutConnector: Int = 0
)

package com.example.animastor.ui

import android.os.Bundle
import android.text.InputType
import android.util.Log
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.fragment.app.Fragment
import androidx.fragment.app.viewModels
import androidx.lifecycle.lifecycleScope
import androidx.viewpager2.widget.ViewPager2
import com.example.animastor.R
import com.example.animastor.databinding.FragmentWorkflowDetailsBinding
import com.example.animastor.network.RetrofitClient
import com.example.animastor.repository.CompatibilityStatus
import com.example.animastor.repository.ConnectorDetail
import com.example.animastor.repository.UpdateBindingRequest
import com.example.animastor.ui.WorkflowDetailsViewModel.BindingDisplayItem
import com.google.android.material.button.MaterialButton
import com.google.android.material.color.MaterialColors
import com.google.android.material.tabs.TabLayout
import com.google.android.material.tabs.TabLayoutMediator
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

private const val TAG = "WorkflowDetails"

class WorkflowDetailsFragment : Fragment(R.layout.fragment_workflow_details) {

    private var binding: FragmentWorkflowDetailsBinding? = null
    private val detailsViewModel: WorkflowDetailsViewModel by viewModels {
        WorkflowDetailsViewModel.factory
    }

    private var connectorName: String = ""
    private var editMode: Boolean = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        arguments?.let {
            connectorName = it.getString(ARG_CONNECTOR_NAME, "")
            editMode = it.getBoolean(ARG_EDIT_MODE, false)
        }
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        binding = FragmentWorkflowDetailsBinding.bind(view)
        val b = binding ?: return

        b.toolbar.setNavigationOnClickListener {
            parentFragmentManager.popBackStack()
        }

        // Show edit mode badge in toolbar
        if (editMode) {
            b.toolbar.subtitle = getString(R.string.workflow_status_edit_mode)
            b.toolbar.setSubtitleTextColor(requireContext().getColor(R.color.cinema_accent))
        }

        // Add Developer Mode chip in toolbar — text "</>" with gold outline
        val devChip = com.google.android.material.chip.Chip(requireContext(), null, com.google.android.material.R.attr.chipStyle)
        devChip.text = "</>"
        devChip.textSize = 13f
        devChip.isCheckable = false
        devChip.isClickable = true
        devChip.setChipBackgroundColorResource(android.R.color.transparent)
        devChip.setChipStrokeColorResource(R.color.cinema_accent)
        devChip.chipStrokeWidth = 1.5f
        devChip.setTextColor(requireContext().getColor(R.color.cinema_accent))
        devChip.chipCornerRadius = 12f
        val chipLp = androidx.appcompat.widget.Toolbar.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        )
        chipLp.gravity = android.view.Gravity.END or android.view.Gravity.CENTER_VERTICAL
        chipLp.marginEnd = 16
        devChip.layoutParams = chipLp
        devChip.setOnClickListener { openDeveloperView() }
        b.toolbar.addView(devChip)

        // Observe loading
        lifecycleScope.launch {
            detailsViewModel.loading.collectLatest { loading ->
                b.loadingIndicator.visibility = if (loading) View.VISIBLE else View.GONE
            }
        }

        // Observe detail data
        lifecycleScope.launch {
            detailsViewModel.connectorDetail.collectLatest { detail ->
                if (detail != null) {
                    updateHeader(b, detail)
                    setupTabs(b)
                }
            }
        }

        // Observe error
        lifecycleScope.launch {
            detailsViewModel.error.collectLatest { err ->
                if (err != null && binding != null) {
                    val b2 = binding ?: return@collectLatest
                    b2.statusText.text = err
                    b2.statusText.setTextColor(requireContext().getColor(R.color.cinema_error))
                }
            }
        }

        // Load data
        if (connectorName.isNotBlank()) {
            detailsViewModel.loadConnector(connectorName)
        }
    }

    private fun updateHeader(b: FragmentWorkflowDetailsBinding, detail: ConnectorDetail) {
        b.toolbar.title = detail.label

        b.connectorName.text = detail.name
        b.workflowType.text = detail.type.replaceFirstChar { it.uppercase() }

        // Observe compatibility status for the header
        lifecycleScope.launch {
            detailsViewModel.compatibility.collectLatest { compat ->
                if (compat != null) {
                    if (editMode) {
                        b.statusText.text = getString(R.string.workflow_status_edit_mode)
                        b.statusText.setTextColor(requireContext().getColor(R.color.cinema_accent))
                    } else {
                        val statusText = if (compat.compatible)
                            getString(R.string.workflow_status_compatible)
                        else
                            getString(R.string.workflow_status_incompatible)
                        b.statusText.text = statusText
                        b.statusText.setTextColor(
                            if (compat.compatible)
                                requireContext().getColor(R.color.cinema_success)
                            else
                                requireContext().getColor(R.color.cinema_error)
                        )
                    }
                }
            }
        }
    }

    fun isEditMode(): Boolean = editMode
    fun getViewModel(): WorkflowDetailsViewModel = detailsViewModel

    private fun setupTabs(b: FragmentWorkflowDetailsBinding) {
        val tabTitles = listOf(
            getString(R.string.workflow_tab_inputs),
            getString(R.string.workflow_tab_outputs),
            getString(R.string.workflow_tab_parameters),
            getString(R.string.workflow_tab_compatibility)
        )

        // Collect tab data from ViewModel
        lifecycleScope.launch {
            detailsViewModel.tabData.collectLatest { tabData ->
                // Skip if already set up (prevent duplicate TabLayoutMediator.attach())
                if (b.viewPager.adapter != null) return@collectLatest

                val nodeTypes = detailsViewModel.workflowNodeTypes.value
        val guideItems = tabData.guideNodes.mapIndexed { idx, g ->
            GuideNodeDisplayItem(
                label = g.label,
                nodeId = g.nodeId,
                nodeClass = g.nodeClass,
                fieldFrameIdx = g.fieldFrameIdx,
                fieldStrength = g.fieldStrength,
                imageSource = g.imageSource,
                index = idx
            )
        }

                // Use this fragment as the parent for FragmentStateAdapter
                val adapter = TabPagerAdapter(
                    this@WorkflowDetailsFragment,
                    tabData.inputs,
                    tabData.outputs,
                    tabData.parameters,
                    detailsViewModel.compatibility.value,
                    connectorName,
                    editMode,
                    nodeTypes,
                    guideItems
                )
                b.viewPager.adapter = adapter

                // Link TabLayout with ViewPager2
                TabLayoutMediator(b.tabLayout, b.viewPager) { tab, position ->
                    tab.text = tabTitles[position]
                }.attach()
            }
        }
    }

    private fun openDeveloperView() {
        val fragment = DeveloperViewFragment.newInstance(connectorName)
        parentFragmentManager.beginTransaction()
            .add(R.id.nav_host_container, fragment, "DeveloperViewFragment")
            .addToBackStack(null)
            .commit()
    }

    override fun onDestroyView() {
        binding = null
        super.onDestroyView()
    }

    companion object {
        private const val ARG_CONNECTOR_NAME = "connectorName"
        private const val ARG_LABEL = "label"
        private const val ARG_EDIT_MODE = "editMode"

        fun newInstance(connectorName: String, label: String, editMode: Boolean = false): WorkflowDetailsFragment {
            val fragment = WorkflowDetailsFragment()
            fragment.arguments = Bundle().apply {
                putString(ARG_CONNECTOR_NAME, connectorName)
                putString(ARG_LABEL, label)
                putBoolean(ARG_EDIT_MODE, editMode)
            }
            return fragment
        }
    }
}

// ─── Pager Adapter ────────────────────────────────────

// ─── Guide Node Display Item ──────────────────────

data class GuideNodeDisplayItem(
    val label: String = "",
    val nodeId: String = "",
    val nodeClass: String = "",
    val fieldFrameIdx: String = "",
    val fieldStrength: String = "",
    val imageSource: String = "",
    val index: Int = 0
)

class TabPagerAdapter(
    fragment: Fragment,
    private val inputs: List<BindingDisplayItem>,
    private val outputs: List<BindingDisplayItem>,
    private val parameters: List<BindingDisplayItem>,
    private val compatibility: CompatibilityStatus?,
    private val connectorName: String = "",
    private val editMode: Boolean = false,
    private val workflowNodeTypes: Map<String, String> = emptyMap(),
    private val guideNodes: List<GuideNodeDisplayItem> = emptyList()
) : androidx.viewpager2.adapter.FragmentStateAdapter(fragment) {
    override fun getItemCount() = 4

    override fun createFragment(position: Int): Fragment {
        return TabContentFragment.newInstance(
            position, inputs, outputs, parameters, compatibility,
            connectorName, editMode, workflowNodeTypes, guideNodes
        )
    }
}

// ─── Tab Content Fragment ────────────────────────────

class TabContentFragment : Fragment() {

    private var connectorName: String = ""
    private var editMode: Boolean = false
    private var workflowNodeTypes: Map<String, String> = emptyMap()

    companion object {
        private const val ARG_POSITION = "position"
        private const val ARG_INPUTS = "inputs"
        private const val ARG_OUTPUTS = "outputs"
        private const val ARG_PARAMETERS = "parameters"
        private const val ARG_COMPAT = "compatibility"
        private const val ARG_CONNECTOR_NAME = "connector_name"
        private const val ARG_EDIT_MODE = "edit_mode"
        private const val ARG_NODE_TYPES = "node_types"
        private const val ARG_GUIDE_NODES = "guide_nodes"

        fun newInstance(
            position: Int,
            inputs: List<BindingDisplayItem>,
            outputs: List<BindingDisplayItem>,
            parameters: List<BindingDisplayItem>,
            compatibility: CompatibilityStatus?,
            connectorName: String = "",
            editMode: Boolean = false,
            workflowNodeTypes: Map<String, String> = emptyMap(),
            guideNodes: List<GuideNodeDisplayItem> = emptyList()
        ): TabContentFragment {
            val f = TabContentFragment()
            f.arguments = Bundle().apply {
                putInt(ARG_POSITION, position)
                putString(ARG_INPUTS, serializeItems(inputs))
                putString(ARG_OUTPUTS, serializeItems(outputs))
                putString(ARG_PARAMETERS, serializeItems(parameters))
                putString(ARG_CONNECTOR_NAME, connectorName)
                putBoolean(ARG_EDIT_MODE, editMode)
                putString(ARG_NODE_TYPES, serializeNodeTypes(workflowNodeTypes))
                putString(ARG_GUIDE_NODES, serializeGuideNodes(guideNodes))
                if (compatibility != null) {
                    putString(ARG_COMPAT, serializeCompat(compatibility))
                }
            }
            return f
        }

        private fun serializeItems(items: List<BindingDisplayItem>): String {
            return items.joinToString("|||") { item ->
                "${item.key}\n${item.label}\n${item.nodeId}\n${item.field}\n${item.required}\n${item.dataType}\n${item.defaultValue}\n${item.min}\n${item.max}\n${item.expectedClass}\n${item.nodeClass}"
            }
        }

        private fun serializeNodeTypes(map: Map<String, String>): String {
            return map.entries.joinToString("||") { "${it.key}:${it.value}" }
        }

        private fun deserializeNodeTypes(raw: String): Map<String, String> {
            if (raw.isBlank()) return emptyMap()
            val result = mutableMapOf<String, String>()
            for (entry in raw.split("||")) {
                val idx = entry.indexOf(':')
                if (idx > 0) {
                    result[entry.substring(0, idx)] = entry.substring(idx + 1)
                }
            }
            return result
        }

        private fun serializeGuideNodes(items: List<GuideNodeDisplayItem>): String {
            return items.joinToString("|||") { g ->
                "${g.label}\n${g.nodeId}\n${g.nodeClass}\n${g.fieldFrameIdx}\n${g.fieldStrength}\n${g.imageSource}\n${g.index}"
            }
        }

        private fun deserializeGuideNodes(raw: String): List<GuideNodeDisplayItem> {
            if (raw.isBlank()) return emptyList()
            return raw.split("|||").filter { it.isNotBlank() }.map { entry ->
                val parts = entry.split("\n")
                GuideNodeDisplayItem(
                    label = parts.getOrElse(0) { "" },
                    nodeId = parts.getOrElse(1) { "" },
                    nodeClass = parts.getOrElse(2) { "" },
                    fieldFrameIdx = parts.getOrElse(3) { "" },
                    fieldStrength = parts.getOrElse(4) { "" },
                    imageSource = parts.getOrElse(5) { "" },
                    index = parts.getOrElse(6) { "0" }.toIntOrNull() ?: 0
                )
            }
        }

        private fun serializeCompat(c: CompatibilityStatus): String {
            return buildString {
                append(c.compatible)
                append("\n").append(c.hashMatch)
                append("\n").append(c.nodesChecked)
                append("\n").append(c.nodesTotal)
                append("\n").append(c.warnings.joinToString(";;"))
                append("\n").append(c.lastValidated ?: "")
            }
        }

        private fun deserializeItems(raw: String): List<BindingDisplayItem> {
            if (raw.isBlank()) return emptyList()
            return raw.split("|||").filter { it.isNotBlank() }.map { entry ->
                val parts = entry.split("\n")
                BindingDisplayItem(
                    key = parts.getOrElse(0) { "" },
                    label = parts.getOrElse(1) { "" },
                    nodeId = parts.getOrElse(2) { "" },
                    field = parts.getOrElse(3) { "" },
                    required = parts.getOrElse(4) { "false" }.toBoolean(),
                    dataType = parts.getOrElse(5) { "" },
                    defaultValue = parseAny(parts.getOrElse(6) { "" }),
                    min = parseAny(parts.getOrElse(7) { "" }),
                    max = parseAny(parts.getOrElse(8) { "" }),
                    expectedClass = parts.getOrElse(9) { "" },
                    nodeClass = parts.getOrElse(10) { "" }
                )
            }
        }

        private fun parseAny(value: String): Any? {
            if (value.isBlank() || value == "null") return null
            return value.toIntOrNull() ?: value.toFloatOrNull() ?: value.toDoubleOrNull() ?: value
        }

        private fun deserializeCompat(raw: String): CompatibilityStatus? {
            if (raw.isBlank()) return null
            val parts = raw.split("\n")
            return CompatibilityStatus(
                compatible = parts.getOrElse(0) { "false" }.toBoolean(),
                hashMatch = parts.getOrElse(1) { "false" }.toBoolean(),
                nodesChecked = parts.getOrElse(2) { "0" }.toIntOrNull() ?: 0,
                nodesTotal = parts.getOrElse(3) { "0" }.toIntOrNull() ?: 0,
                warnings = parts.getOrElse(4) { "" }.split(";;").filter { it.isNotBlank() },
                lastValidated = parts.getOrElse(5) { "" }.ifBlank { null }
            )
        }
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        val args = arguments ?: return TextView(requireContext()).apply {
            text = "No data"
        }

        val position = args.getInt(ARG_POSITION, 0)
        val inputs = deserializeItems(args.getString(ARG_INPUTS, ""))
        val outputs = deserializeItems(args.getString(ARG_OUTPUTS, ""))
        val parameters = deserializeItems(args.getString(ARG_PARAMETERS, ""))
        val compatibility = deserializeCompat(args.getString(ARG_COMPAT, ""))
        connectorName = args.getString(ARG_CONNECTOR_NAME, "")
        editMode = args.getBoolean(ARG_EDIT_MODE, false)
        workflowNodeTypes = deserializeNodeTypes(args.getString(ARG_NODE_TYPES, ""))
        val guideNodes = deserializeGuideNodes(args.getString(ARG_GUIDE_NODES, ""))

        // Parameters tab (position 2) gets interactive UI
        if (position == 2) {
            return createParameterView(inflater, container, parameters)
        }

        // Inputs / Outputs tabs (positions 0, 1) get card-based UI
        if (position == 0 || position == 1) {
            val items = if (position == 0) inputs else outputs
            val emptyMsg = if (position == 0) "No inputs" else "No outputs"
            val section = if (position == 0) "inputs" else "outputs"
            return if (position == 0 && guideNodes.isNotEmpty()) {
                createBindingViewWithGuides(items, emptyMsg, section, guideNodes)
            } else {
                createBindingView(items, emptyMsg, section)
            }
        }

        // Compatibility tab (position 3) gets card-based UI
        if (position == 3) {
            return createCompatView(compatibility)
        }

        // Fallback (should not reach here)
        return TextView(requireContext()).apply { text = "" }
    }

    // ─── Interactive Parameter View ───────────────────

    private var paramValueViews = mutableMapOf<String, TextView>()
    private var paramDataItems = listOf<BindingDisplayItem>()

    private fun createParameterView(
        @Suppress("UNUSED_PARAMETER") inflater: LayoutInflater?,
        @Suppress("UNUSED_PARAMETER") container: ViewGroup?,
        parameters: List<BindingDisplayItem>
    ): View {
        paramDataItems = parameters
        val scrollView = ScrollView(requireContext())
        scrollView.setPadding(16, 8, 16, 16)

        val containerLayout = LinearLayout(requireContext())
        containerLayout.orientation = LinearLayout.VERTICAL
        containerLayout.layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        )

        if (parameters.isEmpty()) {
            val emptyText = TextView(requireContext())
            emptyText.text = "No parameters"
            emptyText.setTextColor(
                MaterialColors.getColor(requireContext(), com.google.android.material.R.attr.colorOnSurfaceVariant,
                    requireContext().getColor(R.color.cinema_text_secondary))
            )
            emptyText.textSize = 14f
            emptyText.setPadding(16, 32, 16, 32)
            emptyText.gravity = Gravity.CENTER
            containerLayout.addView(emptyText)
        } else {
            for (item in parameters) {
                containerLayout.addView(createParameterCard(item))
            }
        }

        scrollView.addView(containerLayout)

        // Observe live value updates
        val vm = getParentFragmentViewModel()
        if (vm != null) {
            lifecycleScope.launch {
                vm.currentParamValues.collectLatest { values ->
                    for ((key, tv) in paramValueViews) {
                        val newValue = values[key]
                        val item = paramDataItems.find { it.key == key }
                        tv.text = formatValueText(newValue, item)
                    }
                }
            }
        }

        return scrollView
    }

    private fun createParameterCard(item: BindingDisplayItem): View {
        val ctx = requireContext()
        val card = com.google.android.material.card.MaterialCardView(ctx)
        val lp = ViewGroup.MarginLayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        )
        lp.bottomMargin = 8
        card.layoutParams = lp
        card.radius = 12f
        card.cardElevation = 1f
        card.strokeWidth = 0
        card.setCardBackgroundColor(
            MaterialColors.getColor(ctx, com.google.android.material.R.attr.colorSurfaceVariant,
                ctx.getColor(R.color.cinema_surface_variant))
        )
        card.isClickable = true
        card.isFocusable = true
        val foregroundAttr = intArrayOf(android.R.attr.selectableItemBackground)
        val ta = ctx.obtainStyledAttributes(foregroundAttr)
        val foreground = ta.getDrawable(0)
        ta.recycle()
        if (foreground != null) card.foreground = foreground

        val inner = LinearLayout(ctx)
        inner.orientation = LinearLayout.HORIZONTAL
        inner.setPadding(16, 12, 12, 12)
        inner.gravity = Gravity.CENTER_VERTICAL
        inner.layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        )

        // Left side: label + value
        val textWrap = LinearLayout(ctx)
        textWrap.orientation = LinearLayout.VERTICAL
        textWrap.layoutParams = LinearLayout.LayoutParams(
            0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f
        )

        val label = TextView(ctx)
        label.text = item.label
        label.setTextColor(
            MaterialColors.getColor(ctx, com.google.android.material.R.attr.colorOnSurface,
                ctx.getColor(R.color.cinema_text_primary))
        )
        label.textSize = 15f
        label.setTypeface(null, android.graphics.Typeface.BOLD)
        textWrap.addView(label)

        val valueText = TextView(ctx)
        valueText.text = formatValueText(getCurrentValue(item), item)
        valueText.setTextColor(
            MaterialColors.getColor(ctx, com.google.android.material.R.attr.colorOnSurfaceVariant,
                ctx.getColor(R.color.cinema_text_secondary))
        )
        valueText.textSize = 13f
        valueText.layoutParams = ViewGroup.MarginLayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = 2 }
        textWrap.addView(valueText)

        // In edit mode, show node reference
        if (editMode && item.nodeId.isNotBlank()) {
            val nodeRef = TextView(ctx)
            nodeRef.text = "Node ${item.nodeId} · ${item.field}"
            nodeRef.setTextColor(ctx.getColor(R.color.cinema_accent))
            nodeRef.textSize = 11f
            nodeRef.layoutParams = ViewGroup.MarginLayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = 1 }
            textWrap.addView(nodeRef)
        }

        // Store reference for live updates
        paramValueViews[item.key] = valueText

        inner.addView(textWrap)

        // Right side: edit link text
        val editLink = TextView(ctx)
        editLink.text = ctx.getString(R.string.workflow_details)
        editLink.textSize = 13f
        editLink.setTextColor(
            MaterialColors.getColor(ctx, com.google.android.material.R.attr.colorSecondary,
                ctx.getColor(R.color.cinema_accent))
        )
        editLink.setOnClickListener {
            showEditParameterDialog(item)
        }
        editLink.setPadding(12, 4, 12, 4)
        editLink.layoutParams = ViewGroup.MarginLayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        )

        inner.addView(editLink)
        card.addView(inner)

        return card
    }

    private fun getCurrentValue(item: BindingDisplayItem): Any? {
        val vm = getParentFragmentViewModel() ?: return item.defaultValue
        return vm.currentParamValues.value[item.key] ?: item.defaultValue
    }

    private fun formatValueText(value: Any?, item: BindingDisplayItem?): String {
        val displayValue = value ?: item?.defaultValue
        val valueStr = when (displayValue) {
            null -> "<not set>"
            is String -> "\"$displayValue\""
            else -> displayValue.toString()
        }
        val typeStr = item?.dataType?.ifBlank { "any" } ?: "any"
        return "$valueStr  ·  $typeStr"
    }

    @Suppress("DEPRECATION")
    private fun getParentFragmentViewModel(): WorkflowDetailsViewModel? {
        val parentFrag = parentFragment
        if (parentFrag is WorkflowDetailsFragment) {
            return parentFrag.getViewModel()
        }
        // Fallback for nested fragment access
        val host = (requireActivity() as? androidx.fragment.app.FragmentActivity)
            ?.supportFragmentManager?.findFragmentByTag("WorkflowDetailsFragment")
        if (host is WorkflowDetailsFragment) {
            return host.getViewModel()
        }
        return null
    }

    private fun showEditParameterDialog(item: BindingDisplayItem) {
        val ctx = requireContext()
        val vm = getParentFragmentViewModel() ?: return

        val currentValue = vm.currentParamValues.value[item.key]
        val displayValue = currentValue ?: item.defaultValue

        val dialogView = LayoutInflater.from(ctx).inflate(R.layout.dialog_edit_parameter, null)
        val paramInput = dialogView.findViewById<com.google.android.material.textfield.TextInputEditText>(R.id.paramInput)
        val inputLayout = dialogView.findViewById<com.google.android.material.textfield.TextInputLayout>(R.id.inputLayout)
        val currentValueLabel = dialogView.findViewById<TextView>(R.id.currentValueLabel)
        val typeInfo = dialogView.findViewById<TextView>(R.id.typeInfo)

        // Set current value
        currentValueLabel.text = getString(R.string.param_current_value, displayValue?.toString() ?: "<not set>")

        // Set type and range info
        val typeStr = item.dataType.ifBlank { "string" }
        val rangeInfo = if (item.min != null && item.max != null) {
            getString(R.string.param_range_hint, item.min.toString(), item.max.toString())
        } else {
            getString(R.string.param_no_range)
        }
        typeInfo.text = "$typeStr  ·  $rangeInfo"

        // Set input hint and value
        inputLayout.hint = item.label
        paramInput.setText(displayValue?.toString() ?: "")

        // Set input type based on data type
        when (item.dataType) {
            "int" -> paramInput.inputType = android.text.InputType.TYPE_CLASS_NUMBER
            "float", "number" -> paramInput.inputType = android.text.InputType.TYPE_CLASS_NUMBER or android.text.InputType.TYPE_NUMBER_FLAG_DECIMAL
            else -> paramInput.inputType = android.text.InputType.TYPE_CLASS_TEXT
        }

        val dialog = AlertDialog.Builder(ctx)
            .setTitle(getString(R.string.param_edit_title, item.label))
            .setView(dialogView)
            .create()

        dialog.show()

        // Wire buttons
        dialogView.findViewById<com.google.android.material.button.MaterialButton>(R.id.saveButton)
            .setOnClickListener {
                val newValue = parseInputValue(paramInput.text.toString(), item)
                vm.saveParameter(connectorName, item.key, newValue)
                dialog.dismiss()
            }

        dialogView.findViewById<com.google.android.material.button.MaterialButton>(R.id.resetButton)
            .setOnClickListener {
                paramInput.setText(item.defaultValue?.toString() ?: "")
            }

        dialogView.findViewById<com.google.android.material.button.MaterialButton>(R.id.cancelButton)
            .setOnClickListener {
                dialog.dismiss()
            }
    }

    private fun parseInputValue(text: String, item: BindingDisplayItem): Any? {
        if (text.isBlank()) return null
        return when (item.dataType) {
            "int" -> text.toIntOrNull() ?: text
            "float", "number" -> text.toDoubleOrNull() ?: text
            else -> text
        }
    }

    // ─── Card-based Binding View with Guide Nodes ────

    private fun createBindingViewWithGuides(
        items: List<BindingDisplayItem>, emptyMsg: String, section: String,
        guideNodes: List<GuideNodeDisplayItem>
    ): View {
        val scrollView = ScrollView(requireContext())
        scrollView.setPadding(16, 8, 16, 16)

        val containerLayout = LinearLayout(requireContext())
        containerLayout.orientation = LinearLayout.VERTICAL
        containerLayout.layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        )

        // Regular bindings
        if (items.isEmpty()) {
            val emptyText = TextView(requireContext())
            emptyText.text = emptyMsg
            emptyText.setTextColor(
                MaterialColors.getColor(requireContext(), com.google.android.material.R.attr.colorOnSurfaceVariant,
                    requireContext().getColor(R.color.cinema_text_secondary))
            )
            emptyText.textSize = 14f
            emptyText.setPadding(16, 16, 16, 16)
            emptyText.gravity = Gravity.CENTER
            containerLayout.addView(emptyText)
        } else {
            for (item in items) {
                containerLayout.addView(createBindingCard(item, section))
            }
        }

        // Guide nodes section header
        if (guideNodes.isNotEmpty()) {
            val divider = View(requireContext())
            divider.layoutParams = ViewGroup.MarginLayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 1
            ).apply { topMargin = 16; bottomMargin = 12 }
            divider.setBackgroundColor(
                MaterialColors.getColor(requireContext(), com.google.android.material.R.attr.colorOutlineVariant,
                    requireContext().getColor(R.color.cinema_text_secondary))
            )
            containerLayout.addView(divider)

            val header = TextView(requireContext())
            header.text = "Guide Image Nodes"
            header.textSize = 13f
            header.setTextColor(requireContext().getColor(R.color.cinema_accent))
            header.setTypeface(null, android.graphics.Typeface.BOLD)
            header.layoutParams = ViewGroup.MarginLayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = 8 }
            containerLayout.addView(header)

            for (g in guideNodes) {
                containerLayout.addView(createGuideNodeCard(g))
            }
        }

        scrollView.addView(containerLayout)
        return scrollView
    }

    private fun createGuideNodeCard(g: GuideNodeDisplayItem): View {
        val ctx = requireContext()
        val card = com.google.android.material.card.MaterialCardView(ctx)
        val lp = ViewGroup.MarginLayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        )
        lp.bottomMargin = 8
        card.layoutParams = lp
        card.radius = 12f
        card.cardElevation = 1f
        card.strokeWidth = 0
        card.setCardBackgroundColor(
            MaterialColors.getColor(ctx, com.google.android.material.R.attr.colorSurfaceVariant,
                ctx.getColor(R.color.cinema_surface_variant))
        )

        val inner = LinearLayout(ctx)
        inner.orientation = LinearLayout.VERTICAL
        inner.setPadding(16, 12, 16, 12)
        inner.layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        )

        // Header: label + node + edit button
        val headerRow = LinearLayout(ctx)
        headerRow.orientation = LinearLayout.HORIZONTAL
        headerRow.gravity = Gravity.CENTER_VERTICAL
        headerRow.layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        )

        val label = TextView(ctx)
        label.text = g.label
        label.setTextColor(
            MaterialColors.getColor(ctx, com.google.android.material.R.attr.colorOnSurface,
                ctx.getColor(R.color.cinema_text_primary))
        )
        label.textSize = 14f
        label.setTypeface(null, android.graphics.Typeface.BOLD)
        label.layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        headerRow.addView(label)

        // Edit button for guide nodes in edit mode
        if (editMode) {
            val editBtn = MaterialButton(ctx, null, com.google.android.material.R.attr.materialButtonOutlinedStyle)
            editBtn.text = "Edit"
            editBtn.textSize = 11f
            editBtn.isAllCaps = false
            editBtn.setTypeface(null, android.graphics.Typeface.BOLD)
            editBtn.setPadding(8, 0, 8, 0)
            editBtn.minimumHeight = 32
            editBtn.minimumWidth = 48
            val editLp = ViewGroup.MarginLayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
            editLp.marginStart = 8
            editBtn.layoutParams = editLp
            editBtn.setOnClickListener {
                showEditGuideNodeDialog(g)
            }
            headerRow.addView(editBtn)
        }

        inner.addView(headerRow)

        // Node info
        val displayClass = g.nodeClass.ifBlank { "LTXVAddGuide" }
        val nodeInfo = TextView(ctx)
        nodeInfo.text = "$displayClass (${g.nodeId})"
        nodeInfo.setTextColor(ctx.getColor(R.color.cinema_accent))
        nodeInfo.textSize = 12f
        nodeInfo.layoutParams = ViewGroup.MarginLayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = 2 }
        inner.addView(nodeInfo)

        // Fields
        val fields = mutableListOf<String>()
        if (g.fieldFrameIdx.isNotBlank()) fields.add("frame: ${g.fieldFrameIdx}")
        if (g.fieldStrength.isNotBlank()) fields.add("strength: ${g.fieldStrength}")
        if (g.imageSource.isNotBlank()) fields.add("image: ${g.imageSource}")

        if (fields.isNotEmpty()) {
            val fieldsText = TextView(ctx)
            fieldsText.text = fields.joinToString("  ·  ")
            fieldsText.setTextColor(
                MaterialColors.getColor(ctx, com.google.android.material.R.attr.colorOnSurfaceVariant,
                    ctx.getColor(R.color.cinema_text_secondary))
            )
            fieldsText.textSize = 11f
            fieldsText.layoutParams = ViewGroup.MarginLayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = 4 }
            inner.addView(fieldsText)
        }

        card.addView(inner)
        return card
    }

    // ─── Card-based Binding View (Inputs / Outputs) ───

    private fun createBindingView(items: List<BindingDisplayItem>, emptyMsg: String, section: String): View {
        val scrollView = ScrollView(requireContext())
        scrollView.setPadding(16, 8, 16, 16)

        val containerLayout = LinearLayout(requireContext())
        containerLayout.orientation = LinearLayout.VERTICAL
        containerLayout.layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        )

        if (items.isEmpty()) {
            val emptyText = TextView(requireContext())
            emptyText.text = emptyMsg
            emptyText.setTextColor(
                MaterialColors.getColor(requireContext(), com.google.android.material.R.attr.colorOnSurfaceVariant,
                    requireContext().getColor(R.color.cinema_text_secondary))
            )
            emptyText.textSize = 14f
            emptyText.setPadding(16, 32, 16, 32)
            emptyText.gravity = Gravity.CENTER
            containerLayout.addView(emptyText)
        } else {
            for (item in items) {
                containerLayout.addView(createBindingCard(item, section))
            }
        }

        scrollView.addView(containerLayout)
        return scrollView
    }

    private fun createBindingCard(item: BindingDisplayItem, section: String): View {
        val ctx = requireContext()
        val card = com.google.android.material.card.MaterialCardView(ctx)
        val lp = ViewGroup.MarginLayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        )
        lp.bottomMargin = 8
        card.layoutParams = lp
        card.radius = 12f
        card.cardElevation = 1f
        card.strokeWidth = 0
        card.setCardBackgroundColor(
            MaterialColors.getColor(ctx, com.google.android.material.R.attr.colorSurfaceVariant,
                ctx.getColor(R.color.cinema_surface_variant))
        )

        val inner = LinearLayout(ctx)
        inner.orientation = LinearLayout.VERTICAL
        inner.setPadding(16, 12, 16, 12)
        inner.layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        )

        // Top row: label + required badge + edit button (edit mode)
        val topRow = LinearLayout(ctx)
        topRow.orientation = LinearLayout.HORIZONTAL
        topRow.gravity = Gravity.CENTER_VERTICAL
        topRow.layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        )

        val label = TextView(ctx)
        label.text = item.label
        label.setTextColor(
            MaterialColors.getColor(ctx, com.google.android.material.R.attr.colorOnSurface,
                ctx.getColor(R.color.cinema_text_primary))
        )
        label.textSize = 15f
        label.setTypeface(null, android.graphics.Typeface.BOLD)
        label.layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        topRow.addView(label)

        if (item.required) {
            val requiredBadge = TextView(ctx)
            requiredBadge.text = "Required"
            requiredBadge.textSize = 11f
            requiredBadge.setTextColor(
                MaterialColors.getColor(ctx, com.google.android.material.R.attr.colorSecondary,
                    ctx.getColor(R.color.cinema_accent))
            )
            requiredBadge.setPadding(8, 2, 8, 2)
            topRow.addView(requiredBadge)
        }

        // Edit button in edit mode — outlined style for visibility
        if (editMode) {
            val editBtn = MaterialButton(ctx, null, com.google.android.material.R.attr.materialButtonOutlinedStyle)
            editBtn.text = "Edit"
            editBtn.textSize = 11f
            editBtn.isAllCaps = false
            editBtn.setTypeface(null, android.graphics.Typeface.BOLD)
            editBtn.setPadding(8, 0, 8, 0)
            editBtn.minimumHeight = 32
            editBtn.minimumWidth = 48
            val editLp = ViewGroup.MarginLayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
            editLp.marginStart = 8
            editBtn.layoutParams = editLp
            editBtn.setOnClickListener {
                showEditBindingDialog(item, section)
            }
            topRow.addView(editBtn)
        }

        inner.addView(topRow)

        // Bottom row: ClassName (nodeId) · field · type
        val infoParts = mutableListOf<String>()
        if (item.nodeId.isNotBlank()) {
            val displayClass = item.nodeClass.ifBlank { item.expectedClass.ifBlank { "Node" } }
            infoParts.add("$displayClass ($item.nodeId)")
        }
        if (item.field.isNotBlank()) infoParts.add(item.field)
        if (item.dataType.isNotBlank()) infoParts.add(item.dataType)

        if (infoParts.isNotEmpty()) {
            val info = TextView(ctx)
            info.text = infoParts.joinToString("  ·  ")
            if (editMode) {
                info.setTextColor(ctx.getColor(R.color.cinema_accent))
            } else {
                info.setTextColor(
                    MaterialColors.getColor(ctx, com.google.android.material.R.attr.colorOnSurfaceVariant,
                        ctx.getColor(R.color.cinema_text_secondary))
                )
            }
            info.textSize = 12f
            info.layoutParams = ViewGroup.MarginLayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = 4 }
            inner.addView(info)
        }

        card.addView(inner)
        return card
    }

    // ─── Binding Edit Dialog with Smart Node Picker ───

    private fun showEditBindingDialog(item: BindingDisplayItem, section: String) {
        val ctx = requireContext()

        // Find compatible nodes: if expectedClass is set, filter by class_type
        val compatibleNodes = if (item.expectedClass.isNotBlank()) {
            workflowNodeTypes.filter { (_, cls) -> cls == item.expectedClass }
        } else {
            workflowNodeTypes
        }

        // Build display list: "CLIPTextEncode (108)" or just "108 (unknown)"
        val nodeEntries: List<Pair<String, String>> = if (compatibleNodes.isNotEmpty()) {
            compatibleNodes.entries
                .sortedBy { it.key.toIntOrNull() ?: 0 }
                .map { (id, cls) -> "$cls ($id)" to id }
        } else if (workflowNodeTypes.isNotEmpty()) {
            // Fallback: show all nodes if none match expectedClass
            workflowNodeTypes.entries
                .sortedBy { it.key.toIntOrNull() ?: 0 }
                .map { (id, cls) -> "$cls ($id)" to id }
        } else {
            // No workflow data — show just current node
            val classLabel = item.nodeClass.ifBlank { item.expectedClass.ifBlank { "Node" } }
            listOf("$classLabel (${item.nodeId})" to item.nodeId)
        }

        // Find pre-selected position
        val selectedIndex = nodeEntries.indexOfFirst { (_, id) -> id == item.nodeId }

        val dialogView = LayoutInflater.from(ctx).inflate(R.layout.dialog_edit_parameter, null)
        val inputLayout = dialogView.findViewById<com.google.android.material.textfield.TextInputLayout>(R.id.inputLayout)
        val currentValueLabel = dialogView.findViewById<TextView>(R.id.currentValueLabel)
        val typeInfo = dialogView.findViewById<TextView>(R.id.typeInfo)

        // Replace input with a selectable list of compatible nodes
        inputLayout.visibility = android.view.View.GONE
        currentValueLabel.visibility = android.view.View.GONE

        // Show info
        typeInfo.text = "Select a compatible node for \"${item.label}\""

        // Create radio group
        val radioGroup = android.widget.RadioGroup(ctx)
        radioGroup.layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        )
        radioGroup.setPadding(0, 8, 0, 8)

        for (i in nodeEntries.indices) {
            val (label, _) = nodeEntries[i]
            val radio = android.widget.RadioButton(ctx)
            radio.text = label
            radio.id = i
            radio.isChecked = i == selectedIndex
            radio.setTextColor(
                MaterialColors.getColor(ctx, com.google.android.material.R.attr.colorOnSurface,
                    ctx.getColor(R.color.cinema_text_primary))
            )
            radio.textSize = 14f
            radio.setPadding(16, 8, 16, 8)
            radio.layoutParams = android.widget.RadioGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
            radioGroup.addView(radio)
        }

        // Find the dialog's root container and add radio group
        val dialogRoot = dialogView.findViewById<LinearLayout>(R.id.dialogRoot)
        dialogRoot.addView(radioGroup, 0)

        // Track selected node ID
        var selectedNodeId = nodeEntries.getOrNull(selectedIndex.coerceAtLeast(0))?.second ?: item.nodeId

        radioGroup.setOnCheckedChangeListener { group, checkedId ->
            val idx = group.indexOfChild(group.findViewById(checkedId))
            if (idx in nodeEntries.indices) {
                selectedNodeId = nodeEntries[idx].second
            }
        }

        val dialog = AlertDialog.Builder(ctx)
            .setTitle("Edit Binding: ${item.label}")
            .setView(dialogView)
            .create()

        dialog.show()

        dialogView.findViewById<com.google.android.material.button.MaterialButton>(R.id.saveButton)
            .setOnClickListener {
                saveBinding(connectorName, section, item.key, selectedNodeId, item.field)
                dialog.dismiss()
            }

        dialogView.findViewById<com.google.android.material.button.MaterialButton>(R.id.resetButton)
            .setOnClickListener {
                selectedNodeId = item.nodeId
                // Re-select the original node
                val origIdx = nodeEntries.indexOfFirst { (_, id) -> id == item.nodeId }
                if (origIdx >= 0) {
                    radioGroup.check(origIdx)
                }
            }

        dialogView.findViewById<com.google.android.material.button.MaterialButton>(R.id.cancelButton)
            .setOnClickListener {
                dialog.dismiss()
            }
    }

    // ─── Guide Node Edit Dialog ──────────────────────

    private fun showEditGuideNodeDialog(g: GuideNodeDisplayItem) {
        val ctx = requireContext()

        // Filter by LTXVAddGuide or show all if no class info
        val guideNodes = if (g.nodeClass.isNotBlank()) {
            workflowNodeTypes.filter { (_, cls) -> cls == g.nodeClass }
        } else {
            workflowNodeTypes.filter { (_, cls) -> cls == "LTXVAddGuide" }
        }

        val nodeEntries: List<Pair<String, String>> = if (guideNodes.isNotEmpty()) {
            guideNodes.entries
                .sortedBy { it.key.toIntOrNull() ?: 0 }
                .map { (id, cls) -> "$cls ($id)" to id }
        } else if (workflowNodeTypes.isNotEmpty()) {
            workflowNodeTypes.entries
                .sortedBy { it.key.toIntOrNull() ?: 0 }
                .map { (id, cls) -> "$cls ($id)" to id }
        } else {
            listOf("${g.nodeClass.ifBlank { "LTXVAddGuide" }} (${g.nodeId})" to g.nodeId)
        }

        val selectedIndex = nodeEntries.indexOfFirst { (_, id) -> id == g.nodeId }

        val dialogView = LayoutInflater.from(ctx).inflate(R.layout.dialog_edit_parameter, null)
        val inputLayout = dialogView.findViewById<com.google.android.material.textfield.TextInputLayout>(R.id.inputLayout)
        val currentValueLabel = dialogView.findViewById<TextView>(R.id.currentValueLabel)
        val typeInfo = dialogView.findViewById<TextView>(R.id.typeInfo)

        inputLayout.visibility = android.view.View.GONE
        currentValueLabel.visibility = android.view.View.GONE
        typeInfo.text = "Select a guide node for \"${g.label}\""

        val radioGroup = android.widget.RadioGroup(ctx)
        radioGroup.layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        )
        radioGroup.setPadding(0, 8, 0, 8)

        for (i in nodeEntries.indices) {
            val (label, _) = nodeEntries[i]
            val radio = android.widget.RadioButton(ctx)
            radio.text = label
            radio.id = i
            radio.isChecked = i == selectedIndex
            radio.setTextColor(
                MaterialColors.getColor(ctx, com.google.android.material.R.attr.colorOnSurface,
                    ctx.getColor(R.color.cinema_text_primary))
            )
            radio.textSize = 14f
            radio.setPadding(16, 8, 16, 8)
            radio.layoutParams = android.widget.RadioGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
            radioGroup.addView(radio)
        }

        val dialogRoot = dialogView.findViewById<LinearLayout>(R.id.dialogRoot)
        dialogRoot.addView(radioGroup, 0)

        var selectedNodeId = nodeEntries.getOrNull(selectedIndex.coerceAtLeast(0))?.second ?: g.nodeId

        radioGroup.setOnCheckedChangeListener { group, checkedId ->
            val idx = group.indexOfChild(group.findViewById(checkedId))
            if (idx in nodeEntries.indices) {
                selectedNodeId = nodeEntries[idx].second
            }
        }

        val dialog = AlertDialog.Builder(ctx)
            .setTitle("Edit Guide: ${g.label}")
            .setView(dialogView)
            .create()

        dialog.show()

        dialogView.findViewById<com.google.android.material.button.MaterialButton>(R.id.saveButton)
            .setOnClickListener {
                saveBinding(connectorName, "guideNodes", g.index.toString(), selectedNodeId, null)
                dialog.dismiss()
            }

        dialogView.findViewById<com.google.android.material.button.MaterialButton>(R.id.resetButton)
            .setOnClickListener {
                selectedNodeId = g.nodeId
                val origIdx = nodeEntries.indexOfFirst { (_, id) -> id == g.nodeId }
                if (origIdx >= 0) {
                    radioGroup.check(origIdx)
                }
            }

        dialogView.findViewById<com.google.android.material.button.MaterialButton>(R.id.cancelButton)
            .setOnClickListener {
                dialog.dismiss()
            }
    }

    private fun saveBinding(connectorName: String, section: String, entityKey: String, nodeId: String, field: String?) {
        lifecycleScope.launch {
            try {
                val api = RetrofitClient.api
                val request = UpdateBindingRequest(
                    section = section,
                    entityKey = entityKey,
                    nodeId = nodeId,
                    field = field
                )
                val response = api.putConnectorBinding(connectorName, request)
                if (response.ok) {
                    Log.i(TAG, "Binding updated: $connectorName.$section.$entityKey → nodeId=$nodeId")
                    Toast.makeText(requireContext(), "Binding updated", Toast.LENGTH_SHORT).show()
                } else {
                    Log.w(TAG, "Failed to update binding: ${response.error}")
                    Toast.makeText(requireContext(), response.error ?: "Failed to update binding", Toast.LENGTH_LONG).show()
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error updating binding", e)
                Toast.makeText(requireContext(), "Error: ${e.message}", Toast.LENGTH_LONG).show()
            }
        }
    }

    // ─── Card-based Compatibility View ───────────────

    private fun createCompatView(compat: CompatibilityStatus?): View {
        val ctx = requireContext()
        val scrollView = ScrollView(ctx)
        scrollView.setPadding(16, 8, 16, 16)

        val containerLayout = LinearLayout(ctx)
        containerLayout.orientation = LinearLayout.VERTICAL
        containerLayout.layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        )

        if (compat == null) {
            val emptyText = TextView(ctx)
            emptyText.text = "No compatibility data available"
            emptyText.setTextColor(
                MaterialColors.getColor(ctx, com.google.android.material.R.attr.colorOnSurfaceVariant,
                    ctx.getColor(R.color.cinema_text_secondary))
            )
            emptyText.textSize = 14f
            emptyText.setPadding(16, 32, 16, 32)
            emptyText.gravity = Gravity.CENTER
            containerLayout.addView(emptyText)
        } else {
            // ── Status card ────────────────────────────
            containerLayout.addView(createStatusCard(compat))

            // ── Warnings card (if any) ─────────────────
            if (compat.warnings.isNotEmpty()) {
                val wCard = createWarningsCard(compat.warnings)
                val wLp = (wCard.layoutParams as? ViewGroup.MarginLayoutParams)
                if (wLp != null) wLp.topMargin = 8
                containerLayout.addView(wCard)
            }
        }

        scrollView.addView(containerLayout)
        return scrollView
    }

    private fun createStatusCard(compat: CompatibilityStatus): View {
        val ctx = requireContext()
        val compatible = compat.compatible
        val card = com.google.android.material.card.MaterialCardView(ctx)
        val lp = ViewGroup.MarginLayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        )
        card.layoutParams = lp
        card.radius = 12f
        card.cardElevation = 1f
        card.strokeWidth = 0

        val bgColor = if (compatible)
            MaterialColors.getColor(ctx, com.google.android.material.R.attr.colorSurfaceVariant,
                ctx.getColor(R.color.cinema_surface_variant))
        else
            MaterialColors.getColor(ctx, com.google.android.material.R.attr.colorErrorContainer,
                ctx.getColor(R.color.cinema_error_container))
        card.setCardBackgroundColor(bgColor)

        val inner = LinearLayout(ctx)
        inner.orientation = LinearLayout.VERTICAL
        inner.setPadding(16, 16, 16, 16)
        inner.layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        )

        val statusRow = LinearLayout(ctx)
        statusRow.orientation = LinearLayout.HORIZONTAL
        statusRow.gravity = Gravity.CENTER_VERTICAL
        statusRow.layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        )

        val statusIcon = TextView(ctx)
        statusIcon.text = if (compatible) "\u2713" else "\u2717"
        statusIcon.textSize = 28f
        statusIcon.setTextColor(if (compatible) ctx.getColor(R.color.cinema_success) else ctx.getColor(R.color.cinema_error))
        statusIcon.setPadding(0, 0, 12, 0)
        statusRow.addView(statusIcon)

        val statusText = TextView(ctx)
        statusText.text = if (compatible) "Compatible" else "Incompatible"
        statusText.textSize = 18f
        statusText.setTextColor(if (compatible) ctx.getColor(R.color.cinema_success) else ctx.getColor(R.color.cinema_error))
        statusText.setTypeface(null, android.graphics.Typeface.BOLD)
        statusText.layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        statusRow.addView(statusText)

        inner.addView(statusRow)

        val details = LinearLayout(ctx)
        details.orientation = LinearLayout.VERTICAL
        details.layoutParams = ViewGroup.MarginLayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = 12 }

        val hashRow = createDetailRow(ctx, "Hash Match", if (compat.hashMatch) "\u2713" else "\u2717",
            if (compat.hashMatch) R.color.cinema_success else R.color.cinema_error)
        details.addView(hashRow)

        val nodeText = "${compat.nodesChecked}/${compat.nodesTotal}"
        val nodeColor = if (compat.nodesChecked == compat.nodesTotal) R.color.cinema_success else R.color.cinema_error
        val nodesRow = createDetailRow(ctx, "Nodes Checked", nodeText, nodeColor)
        nodesRow.layoutParams = ViewGroup.MarginLayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = 6 }
        details.addView(nodesRow)

        compat.workflowHash?.let { hash ->
            val hashRow2 = createDetailRow(ctx, "Workflow Hash", hash.take(16) + "\u2026", R.color.cinema_text_secondary)
            hashRow2.layoutParams = ViewGroup.MarginLayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = 6 }
            details.addView(hashRow2)
        }

        compat.lastValidated?.let { lv ->
            val dateStr = lv.take(10)
            val dateRow = createDetailRow(ctx, "Last Validated", dateStr, R.color.cinema_text_secondary)
            dateRow.layoutParams = ViewGroup.MarginLayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = 6 }
            details.addView(dateRow)
        }

        inner.addView(details)
        card.addView(inner)
        return card
    }

    private fun createWarningsCard(warnings: List<String>): View {
        val ctx = requireContext()
        val card = com.google.android.material.card.MaterialCardView(ctx)
        val lp = ViewGroup.MarginLayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        )
        card.layoutParams = lp
        card.radius = 12f
        card.cardElevation = 1f
        card.strokeWidth = 0
        card.setCardBackgroundColor(ctx.getColor(R.color.cinema_warning_container))

        val inner = LinearLayout(ctx)
        inner.orientation = LinearLayout.VERTICAL
        inner.setPadding(16, 12, 16, 12)
        inner.layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        )

        val header = TextView(ctx)
        header.text = "\u26A0  Warnings (${warnings.size})"
        header.textSize = 14f
        header.setTextColor(ctx.getColor(R.color.cinema_warning))
        header.setTypeface(null, android.graphics.Typeface.BOLD)
        inner.addView(header)

        for ((i, w) in warnings.withIndex()) {
            val wText = TextView(ctx)
            wText.text = "${i + 1}. $w"
            wText.textSize = 12f
            wText.setTextColor(
                MaterialColors.getColor(ctx, com.google.android.material.R.attr.colorOnSurfaceVariant,
                    ctx.getColor(R.color.cinema_text_secondary))
            )
            wText.layoutParams = ViewGroup.MarginLayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = 6 }
            inner.addView(wText)
        }

        card.addView(inner)
        return card
    }

    private fun createDetailRow(ctx: android.content.Context, label: String, value: String, valueColor: Int): LinearLayout {
        val row = LinearLayout(ctx)
        row.orientation = LinearLayout.HORIZONTAL
        row.layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        )

        val labelView = TextView(ctx)
        labelView.text = label
        labelView.textSize = 13f
        labelView.setTextColor(
            MaterialColors.getColor(ctx, com.google.android.material.R.attr.colorOnSurfaceVariant,
                ctx.getColor(R.color.cinema_text_secondary))
        )
        labelView.layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        row.addView(labelView)

        val valueView = TextView(ctx)
        valueView.text = value
        valueView.textSize = 13f
        valueView.setTextColor(ctx.getColor(valueColor))
        valueView.setTypeface(null, android.graphics.Typeface.BOLD)
        row.addView(valueView)

        return row
    }
}

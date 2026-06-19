package com.example.animastor.ui

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.fragment.app.Fragment
import androidx.fragment.app.activityViewModels
import androidx.lifecycle.lifecycleScope
import androidx.viewpager2.widget.ViewPager2
import com.example.animastor.R
import com.example.animastor.databinding.FragmentWorkflowDetailsBinding
import com.example.animastor.repository.CompatibilityStatus
import com.example.animastor.repository.ConnectorDetail
import com.example.animastor.ui.WorkflowDetailsViewModel.BindingDisplayItem
import com.google.android.material.tabs.TabLayout
import com.google.android.material.tabs.TabLayoutMediator
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

class WorkflowDetailsFragment : Fragment(R.layout.fragment_workflow_details) {

    private var binding: FragmentWorkflowDetailsBinding? = null
    private val detailsViewModel: WorkflowDetailsViewModel by activityViewModels {
        WorkflowDetailsViewModel.factory
    }

    private var connectorName: String = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        arguments?.let {
            connectorName = it.getString(ARG_CONNECTOR_NAME, "")
        }
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        binding = FragmentWorkflowDetailsBinding.bind(view)
        val b = binding ?: return

        b.toolbar.setNavigationOnClickListener {
            parentFragmentManager.popBackStack()
        }

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
                    // Show error in header
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

                // Use this fragment as the parent for FragmentStateAdapter
                val adapter = TabPagerAdapter(
                    this@WorkflowDetailsFragment,
                    tabData.inputs,
                    tabData.outputs,
                    tabData.parameters,
                    detailsViewModel.compatibility.value
                )
                b.viewPager.adapter = adapter

                // Link TabLayout with ViewPager2
                TabLayoutMediator(b.tabLayout, b.viewPager) { tab, position ->
                    tab.text = tabTitles[position]
                }.attach()
            }
        }
    }

    override fun onDestroyView() {
        binding = null
        super.onDestroyView()
    }

    companion object {
        private const val ARG_CONNECTOR_NAME = "connectorName"
        private const val ARG_LABEL = "label"

        fun newInstance(connectorName: String, label: String): WorkflowDetailsFragment {
            val fragment = WorkflowDetailsFragment()
            fragment.arguments = Bundle().apply {
                putString(ARG_CONNECTOR_NAME, connectorName)
                putString(ARG_LABEL, label)
            }
            return fragment
        }
    }
}

// ─── Pager Adapter ────────────────────────────────────

class TabPagerAdapter(
    fragment: Fragment,
    private val inputs: List<BindingDisplayItem>,
    private val outputs: List<BindingDisplayItem>,
    private val parameters: List<BindingDisplayItem>,
    private val compatibility: CompatibilityStatus?
) : androidx.viewpager2.adapter.FragmentStateAdapter(fragment) {
    override fun getItemCount() = 4

    override fun createFragment(position: Int): Fragment {
        return TabContentFragment.newInstance(position, inputs, outputs, parameters, compatibility)
    }
}

// ─── Tab Content Fragment ────────────────────────────

class TabContentFragment : Fragment() {

    companion object {
        private const val ARG_POSITION = "position"
        private const val ARG_INPUTS = "inputs"
        private const val ARG_OUTPUTS = "outputs"
        private const val ARG_PARAMETERS = "parameters"
        private const val ARG_COMPAT = "compatibility"

        fun newInstance(
            position: Int,
            inputs: List<BindingDisplayItem>,
            outputs: List<BindingDisplayItem>,
            parameters: List<BindingDisplayItem>,
            compatibility: CompatibilityStatus?
        ): TabContentFragment {
            val f = TabContentFragment()
            f.arguments = Bundle().apply {
                putInt(ARG_POSITION, position)
                putString(ARG_INPUTS, serializeItems(inputs))
                putString(ARG_OUTPUTS, serializeItems(outputs))
                putString(ARG_PARAMETERS, serializeItems(parameters))
                if (compatibility != null) {
                    putString(ARG_COMPAT, serializeCompat(compatibility))
                }
            }
            return f
        }

        private fun serializeItems(items: List<BindingDisplayItem>): String {
            return items.joinToString("|||") { item ->
                "${item.key}\n${item.label}\n${item.nodeId}\n${item.field}\n${item.required}\n${item.dataType}"
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
                    dataType = parts.getOrElse(5) { "" }
                )
            }
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

        val view = inflater.inflate(android.R.layout.simple_list_item_1, container, false) as TextView
        view.setPadding(32, 16, 32, 16)

        view.text = when (position) {
            0 -> formatBindings(inputs, "No inputs")
            1 -> formatBindings(outputs, "No outputs")
            2 -> formatBindings(parameters, "No parameters")
            3 -> formatCompat(compatibility)
            else -> ""
        }
        view.setTextColor(requireContext().getColor(R.color.cinema_text_secondary))
        view.textSize = 14f

        return view
    }

    private fun formatBindings(items: List<BindingDisplayItem>, emptyMsg: String): String {
        if (items.isEmpty()) return emptyMsg
        return items.joinToString("\n\n") { item ->
            buildString {
                append("• ${item.label}")
                if (item.nodeId.isNotBlank()) {
                    append("\n  Node: ${item.nodeId}")
                }
                if (item.field.isNotBlank()) {
                    append("\n  Field: ${item.field}")
                }
                if (item.required) {
                    append("\n  Required")
                }
                if (item.dataType.isNotBlank()) {
                    append("\n  Type: ${item.dataType}")
                }
            }
        }
    }

    private fun formatCompat(c: CompatibilityStatus?): String {
        if (c == null) return "No compatibility data available"
        return buildString {
            append("Compatibility: ${if (c.compatible) "✓ Compatible" else "✗ Incompatible"}")
            append("\nHash Match: ${if (c.hashMatch) "✓" else "✗"}")
            append("\nNodes Checked: ${c.nodesChecked}/${c.nodesTotal}")
            append("\nHash: ${c.workflowHash?.take(12) ?: "N/A"}…")
            if (c.warnings.isNotEmpty()) {
                append("\n\nWarnings:")
                c.warnings.forEach { append("\n  ⚠ $it") }
            }
            c.lastValidated?.let { append("\n\nLast validated: $it") }
        }
    }
}

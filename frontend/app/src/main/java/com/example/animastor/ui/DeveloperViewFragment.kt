package com.example.animastor.ui

import android.os.Bundle
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.fragment.app.viewModels
import androidx.lifecycle.lifecycleScope
import com.example.animastor.R
import com.example.animastor.databinding.FragmentDeveloperViewBinding
import com.example.animastor.network.RetrofitClient
import com.google.android.material.card.MaterialCardView
import com.google.android.material.color.MaterialColors
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

private const val TAG = "DeveloperView"

class DeveloperViewFragment : Fragment(R.layout.fragment_developer_view) {

    private var binding: FragmentDeveloperViewBinding? = null
    private val viewModel: DeveloperViewViewModel by viewModels {
        DeveloperViewViewModel.factory
    }

    private var connectorName: String = ""
    private var workflowNodeTypes: Map<String, String> = emptyMap()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        arguments?.let {
            connectorName = it.getString(ARG_CONNECTOR_NAME, "")
        }
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        binding = FragmentDeveloperViewBinding.bind(view)
        val b = binding ?: return

        b.toolbar.setNavigationOnClickListener {
            parentFragmentManager.popBackStack()
        }

        // ── Chip toggle: switch between JSON and Bindings ──
        fun selectTab(isJson: Boolean) {
            val showView = if (isJson) b.jsonScrollView else b.bindingsScrollView
            val hideView = if (isJson) b.bindingsScrollView else b.jsonScrollView

            // Skip if already showing this tab
            if (showView.visibility == View.VISIBLE && showView.alpha == 1f) return

            // Crossfade between views
            hideView.animate()
                .alpha(0f)
                .setDuration(200)
                .withEndAction {
                    hideView.visibility = View.GONE
                }
                .start()

            showView.apply {
                visibility = View.VISIBLE
                alpha = 0f
            }
            showView.animate()
                .alpha(1f)
                .setDuration(200)
                .start()
        }

        // Sync view visibility with chip checked state
        b.jsonChip.post {
            b.jsonChip.setOnCheckedChangeListener { _, isChecked ->
                if (isChecked) {
                    b.bindingsChip.isChecked = false
                    selectTab(true)
                }
            }
            b.bindingsChip.setOnCheckedChangeListener { _, isChecked ->
                if (isChecked) {
                    b.jsonChip.isChecked = false
                    selectTab(false)
                }
            }
        }

        // Observe loading
        lifecycleScope.launch {
            viewModel.loading.collectLatest { loading ->
                b.loadingIndicator.visibility = if (loading) View.VISIBLE else View.GONE
            }
        }

        // Observe raw JSON
        lifecycleScope.launch {
            viewModel.rawJson.collectLatest { json ->
                if (json != null) {
                    b.jsonText.text = json
                }
            }
        }

        // Observe bindings table
        lifecycleScope.launch {
            viewModel.bindingRows.collectLatest { rows ->
                if (rows.isNotEmpty() && b.bindingsContainer.childCount == 0) {
                    buildBindingsTable(b.bindingsContainer, rows)
                }
            }
        }

        // Observe error
        lifecycleScope.launch {
            viewModel.error.collectLatest { err ->
                if (err != null && binding != null) {
                    Toast.makeText(requireContext(), "Dev Error: $err", Toast.LENGTH_LONG).show()
                }
            }
        }

        // Load workflow node types for Edit Mode
        lifecycleScope.launch {
            try {
                val detail = com.example.animastor.network.RetrofitClient.api.getConnectorDetail(connectorName)
                val wfDetail = com.example.animastor.network.RetrofitClient.api.getWorkflowDetail(detail.workflow)
                workflowNodeTypes = wfDetail.nodeTypes
            } catch (_: Exception) { }
        }

        // Load data
        if (connectorName.isNotBlank()) {
            viewModel.loadConnector(connectorName)
        }
    }

    private fun buildBindingsTable(
        container: LinearLayout,
        rows: List<DeveloperViewViewModel.BindingTableRow>
    ) {
        val ctx = requireContext()

        // Group by section
        val sections = mapOf(
            "inputs" to "Inputs",
            "outputs" to "Outputs",
            "parameters" to "Parameters"
        )

        for ((sectionKey, sectionLabel) in sections) {
            val sectionRows = rows.filter { it.section == sectionKey }
            if (sectionRows.isEmpty()) continue

            // Section header
            val sectionHeader = TextView(ctx)
            sectionHeader.text = sectionLabel
            sectionHeader.textSize = 14f
            sectionHeader.setTypeface(null, android.graphics.Typeface.BOLD)
            sectionHeader.setTextColor(
                MaterialColors.getColor(ctx, com.google.android.material.R.attr.colorSecondary,
                    ctx.getColor(R.color.cinema_accent))
            )
            sectionHeader.layoutParams = ViewGroup.MarginLayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = 16; bottomMargin = 8 }
            container.addView(sectionHeader)

            for (row in sectionRows) {
                container.addView(createBindingTableRowCard(row))
            }
        }
    }

    private fun createBindingTableRowCard(row: DeveloperViewViewModel.BindingTableRow): View {
        val ctx = requireContext()
        val card = MaterialCardView(ctx)
        val lp = ViewGroup.MarginLayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        )
        lp.bottomMargin = 6
        card.layoutParams = lp
        card.radius = 10f
        card.cardElevation = 0.5f
        card.strokeWidth = 1
        card.strokeColor = MaterialColors.getColor(ctx, com.google.android.material.R.attr.colorOutlineVariant,
            ctx.getColor(R.color.cinema_text_secondary))
        card.setCardBackgroundColor(
            MaterialColors.getColor(ctx, com.google.android.material.R.attr.colorSurfaceVariant,
                ctx.getColor(R.color.cinema_surface_variant))
        )

        val inner = LinearLayout(ctx)
        inner.orientation = LinearLayout.VERTICAL
        inner.setPadding(12, 10, 12, 10)
        inner.layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        )

        // Row 1: entityKey + field
        val row1 = LinearLayout(ctx)
        row1.orientation = LinearLayout.HORIZONTAL
        row1.layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        )

        val keyBadge = TextView(ctx)
        keyBadge.text = row.entityKey
        keyBadge.textSize = 12f
        keyBadge.setTypeface(null, android.graphics.Typeface.BOLD)
        keyBadge.setTextColor(
            MaterialColors.getColor(ctx, com.google.android.material.R.attr.colorOnSurface,
                ctx.getColor(R.color.cinema_text_primary))
        )
        keyBadge.layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        row1.addView(keyBadge)

        if (row.required) {
            val reqBadge = TextView(ctx)
            reqBadge.text = "required"
            reqBadge.textSize = 10f
            reqBadge.setTextColor(ctx.getColor(R.color.cinema_accent))
            reqBadge.setPadding(4, 1, 4, 1)
            row1.addView(reqBadge)
        }

        inner.addView(row1)

        // Row 2: Node info
        val row2 = TextView(ctx)
        val classDisplay = row.nodeClass ?: row.expectedClass ?: "?"
        row2.text = "Node ${row.nodeId} ($classDisplay)  ·  ${row.field}"
        row2.textSize = 11f
        row2.setTextColor(ctx.getColor(R.color.cinema_accent))
        row2.layoutParams = ViewGroup.MarginLayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = 4 }
        inner.addView(row2)

        // Row 3: Section + type info
        if (row.section == "parameters" && row.defaultValue != null) {
            val row3 = TextView(ctx)
            val rangeInfo = if (row.min != null && row.max != null) {
                "  ·  Range: ${row.min} – ${row.max}"
            } else ""
            row3.text = "Default: ${row.defaultValue}$rangeInfo"
            row3.textSize = 10f
            row3.setTextColor(
                MaterialColors.getColor(ctx, com.google.android.material.R.attr.colorOnSurfaceVariant,
                    ctx.getColor(R.color.cinema_text_secondary))
            )
            row3.layoutParams = ViewGroup.MarginLayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = 2 }
            inner.addView(row3)
        }

        card.addView(inner)
        return card
    }

    override fun onDestroyView() {
        binding = null
        super.onDestroyView()
    }

    companion object {
        private const val ARG_CONNECTOR_NAME = "connectorName"

        fun newInstance(connectorName: String): DeveloperViewFragment {
            val fragment = DeveloperViewFragment()
            fragment.arguments = Bundle().apply {
                putString(ARG_CONNECTOR_NAME, connectorName)
            }
            return fragment
        }
    }
}

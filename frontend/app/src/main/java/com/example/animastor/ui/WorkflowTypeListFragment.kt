package com.example.animastor.ui

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.fragment.app.Fragment
import androidx.fragment.app.activityViewModels
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.RecyclerView
import com.example.animastor.R
import com.example.animastor.databinding.FragmentWorkflowTypeListBinding
import com.example.animastor.network.RetrofitClient
import com.example.animastor.repository.ConnectorStatusRequest
import com.example.animastor.repository.ConnectorSummary
import com.google.android.material.card.MaterialCardView
import com.google.android.material.switchmaterial.SwitchMaterial
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

class WorkflowTypeListFragment : Fragment(R.layout.fragment_workflow_type_list) {

    private var binding: FragmentWorkflowTypeListBinding? = null
    private val sharedViewModel: WorkflowManagerViewModel by activityViewModels {
        WorkflowManagerViewModel.factory
    }

    private var workflowType: String = "audio"
    private var typeTitle: String = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        arguments?.let {
            workflowType = it.getString(ARG_TYPE, "audio")
            typeTitle = it.getString(ARG_TITLE, "Workflows")
        }
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        binding = FragmentWorkflowTypeListBinding.bind(view)
        val b = binding ?: return

        // Toolbar
        b.toolbar.setNavigationOnClickListener {
            parentFragmentManager.popBackStack()
        }

        // Observe the correct workflow list
        val workflows = when (workflowType) {
            "audio" -> sharedViewModel.audioWorkflows
            "image" -> sharedViewModel.imageWorkflows
            "video" -> sharedViewModel.videoWorkflows
            else -> sharedViewModel.audioWorkflows
        }

        val adapter = WorkflowListAdapter(
            onItemClick = { connector ->
                if (connector.enabled) {
                    openDetails(connector.name, connector.label)
                }
            },
            onToggleEnabled = { connector, enabled ->
                toggleConnector(connector.name, enabled)
            }
        )
        b.workflowList.adapter = adapter

        lifecycleScope.launch {
            workflows.collectLatest { list ->
                adapter.submitList(list)
                b.toolbar.title = getString(R.string.workflow_type_title, typeTitle)
            }
        }

        lifecycleScope.launch {
            sharedViewModel.loading.collectLatest { loading ->
                b.loadingIndicator.visibility = if (loading) View.VISIBLE else View.GONE
            }
        }

        // Add workflow button (placeholder for future)
        b.addButton.setOnClickListener {
            // Future: file picker for workflow JSON + auto-connector creation
        }
    }

    private fun toggleConnector(name: String, enabled: Boolean) {
        lifecycleScope.launch {
            try {
                val api = RetrofitClient.api
                api.putConnectorStatus(name, ConnectorStatusRequest(enabled))
                // Refresh the list to reflect the change
                refreshWorkflows()
            } catch (_: Exception) {
                // Revert on error — handled by refresh
                refreshWorkflows()
            }
        }
    }

    private fun refreshWorkflows() {
        lifecycleScope.launch {
            sharedViewModel.loadConnectors()
        }
    }

    private fun openDetails(connectorName: String, label: String) {
        val fragment = WorkflowDetailsFragment.newInstance(connectorName, label)
        parentFragmentManager.beginTransaction()
            .add(R.id.nav_host_container, fragment, "WorkflowDetailsFragment")
            .addToBackStack(null)
            .commit()
    }

    override fun onDestroyView() {
        binding = null
        super.onDestroyView()
    }

    companion object {
        private const val ARG_TYPE = "type"
        private const val ARG_TITLE = "title"

        fun newInstance(type: String, title: String): WorkflowTypeListFragment {
            val fragment = WorkflowTypeListFragment()
            fragment.arguments = Bundle().apply {
                putString(ARG_TYPE, type)
                putString(ARG_TITLE, title)
            }
            return fragment
        }
    }
}

// ─── Adapter ──────────────────────────────────────────

class WorkflowListAdapter(
    private val onItemClick: (ConnectorSummary) -> Unit,
    private val onToggleEnabled: (ConnectorSummary, Boolean) -> Unit
) : RecyclerView.Adapter<WorkflowListAdapter.ViewHolder>() {

    private var items: List<ConnectorSummary> = emptyList()

    fun submitList(list: List<ConnectorSummary>) {
        items = list
        notifyDataSetChanged()
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): ViewHolder {
        val view = LayoutInflater.from(parent.context)
            .inflate(R.layout.item_workflow_entry, parent, false)
        return ViewHolder(view)
    }

    override fun onBindViewHolder(holder: ViewHolder, position: Int) {
        holder.bind(items[position])
    }

    override fun getItemCount() = items.size

    inner class ViewHolder(itemView: View) : RecyclerView.ViewHolder(itemView) {
        private val labelText: TextView = itemView.findViewById(R.id.workflowLabel)
        private val connectorText: TextView = itemView.findViewById(R.id.workflowConnector)
        private val statusText: TextView = itemView.findViewById(R.id.workflowStatus)
        private val detailsButton: View = itemView.findViewById(R.id.detailsButton)
        private val enableSwitch: SwitchMaterial = itemView.findViewById(R.id.enableSwitch)
        private val card: MaterialCardView = itemView.findViewById(R.id.workflowCard)

        fun bind(item: ConnectorSummary) {
            val ctx = itemView.context

            labelText.text = item.label
            connectorText.text = ctx.getString(R.string.workflow_connector, item.name)

            val statusRes = when (item.status) {
                "compatible" -> R.string.workflow_status_compatible
                "incompatible" -> R.string.workflow_status_incompatible
                "registered" -> R.string.workflow_status_registered
                else -> R.string.workflow_status_unknown
            }
            statusText.text = ctx.getString(statusRes)

            when (item.status) {
                "compatible" -> {
                    statusText.setTextColor(ctx.getColor(R.color.cinema_success))
                }
                "incompatible" -> {
                    statusText.setTextColor(ctx.getColor(R.color.cinema_error))
                }
                else -> {
                    statusText.setTextColor(ctx.getColor(R.color.cinema_text_secondary))
                }
            }

            // Enable/Disable toggle
            // ⚠️ Remove listener before setting isChecked to prevent spurious API calls on bind()
            enableSwitch.setOnCheckedChangeListener(null)
            enableSwitch.isChecked = item.enabled
            enableSwitch.setOnCheckedChangeListener { _, isChecked ->
                onToggleEnabled(item, isChecked)
            }

            // Grayed-out style for disabled workflows
            val alpha = if (item.enabled) 1.0f else 0.45f
            card.alpha = alpha
            labelText.alpha = alpha
            connectorText.alpha = alpha
            statusText.alpha = alpha

            // Details button only works for enabled workflows
            detailsButton.setOnClickListener {
                if (item.enabled) onItemClick(item)
            }
            itemView.setOnClickListener {
                if (item.enabled) onItemClick(item)
            }
        }
    }
}

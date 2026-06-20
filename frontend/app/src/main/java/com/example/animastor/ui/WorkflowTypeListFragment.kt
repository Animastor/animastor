package com.example.animastor.ui

import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.util.Log
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.fragment.app.Fragment
import androidx.fragment.app.activityViewModels
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.RecyclerView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import com.example.animastor.R
import com.example.animastor.databinding.FragmentWorkflowTypeListBinding
import com.example.animastor.network.RetrofitClient
import com.example.animastor.repository.AddConnectorRequest
import com.example.animastor.repository.ConnectorStatusRequest
import com.example.animastor.repository.ConnectorSummary
import com.google.android.material.card.MaterialCardView
import com.google.android.material.switchmaterial.SwitchMaterial
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

private const val TAG = "WorkflowTypeList"

class WorkflowTypeListFragment : Fragment(R.layout.fragment_workflow_type_list) {

    private var binding: FragmentWorkflowTypeListBinding? = null
    private val sharedViewModel: WorkflowManagerViewModel by activityViewModels {
        WorkflowManagerViewModel.factory
    }

    private var workflowType: String = "audio"
    private var typeTitle: String = ""

    // File picker for "Add Workflow" — opens JSON files
    private val openWorkflowLauncher = registerForActivityResult(
        ActivityResultContracts.OpenDocument()
    ) { uri: Uri? ->
        if (uri == null) return@registerForActivityResult
        uploadConnectorFile(uri)
    }

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
                // Open details; pass editMode=true when connector is disabled
                if (connector.enabled) {
                    openDetails(connector.name, connector.label)
                } else {
                    openDetailsEditMode(connector.name, connector.label)
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

        // Add workflow button — opens file picker for connector JSON
        b.addButton.setOnClickListener {
            Log.d(TAG, "Add Workflow button clicked, launching file picker")
            openWorkflowLauncher.launch(arrayOf("application/json", "*/*"))
        }
    }

    /**
     * Read a selected connector JSON file and upload it to the backend.
     */
    private fun uploadConnectorFile(uri: Uri) {
        Log.d(TAG, "Connector file selected: $uri")
        lifecycleScope.launch {
            try {
                // Read file on IO dispatcher
                val rawContent = withContext(Dispatchers.IO) {
                    try {
                        val inputStream = requireContext().contentResolver.openInputStream(uri)
                        inputStream?.bufferedReader()?.use { it.readText() } ?: ""
                    } catch (e: Exception) {
                        Log.e(TAG, "Error reading file", e)
                        ""
                    }
                }

                if (rawContent.isBlank()) {
                    Log.w(TAG, "Could not read connector file or file is empty")
                    Toast.makeText(requireContext(), "Cannot read file or file is empty", Toast.LENGTH_SHORT).show()
                    return@launch
                }

                Log.d(TAG, "Connector JSON read, size=${rawContent.length}")

                // Parse connector map on IO
                val (connectorName, connectorMap) = withContext(Dispatchers.IO) {
                    @Suppress("UNCHECKED_CAST")
                    val map = com.google.gson.Gson().fromJson(rawContent, Map::class.java) as Map<String, Any?>
                    val name = (map["name"] as? String)
                        ?.takeIf { it.isNotBlank() }
                        ?: guessConnectorName(uri)
                    name to map
                }

                if (connectorName.isBlank()) {
                    Log.w(TAG, "Could not determine connector name from JSON or filename")
                    Toast.makeText(requireContext(), "Connector name not found in JSON", Toast.LENGTH_SHORT).show()
                    return@launch
                }

                Log.d(TAG, "Sending connector to backend: name=$connectorName")
                val api = RetrofitClient.api
                val request = AddConnectorRequest(name = connectorName, connector = connectorMap)
                val response = api.addConnector(request)

                if (response.ok) {
                    Log.i(TAG, "Connector added successfully: $connectorName")
                    Toast.makeText(requireContext(), "Workflow added: $connectorName", Toast.LENGTH_SHORT).show()
                    sharedViewModel.loadConnectors()
                } else {
                    val errorMsg = response.error ?: "Failed to add workflow"
                    Log.w(TAG, "Backend rejected connector: $errorMsg")
                    Toast.makeText(requireContext(), errorMsg, Toast.LENGTH_LONG).show()
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error adding connector", e)
                Toast.makeText(requireContext(), "Error: ${e.message}", Toast.LENGTH_LONG).show()
            }
        }
    }

    /**
     * Guess connector name from the file URI using OpenableColumns.DISPLAY_NAME.
     * Falls back to lastPathSegment.
     */
    private fun guessConnectorName(uri: Uri): String {
        val displayName = getDisplayFileName(uri) ?: (uri.lastPathSegment ?: return "")
        val name = displayName.substringBeforeLast(".").substringBeforeLast("_")
        return if (name.startsWith("conn-")) name else "conn-$name"
    }

    /**
     * Get the display file name from a content URI using OpenableColumns.
     */
    private fun getDisplayFileName(uri: Uri): String? {
        val cursor = requireContext().contentResolver.query(uri, null, null, null, null)
        return cursor?.use {
            if (it.moveToFirst()) {
                val idx = it.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (idx >= 0) it.getString(idx) else null
            } else null
        }
    }

    private fun toggleConnector(name: String, enabled: Boolean) {
        lifecycleScope.launch {
            try {
                Log.d(TAG, "Toggling connector '$name': enabled=$enabled")
                val api = RetrofitClient.api
                api.putConnectorStatus(name, ConnectorStatusRequest(enabled))
                refreshWorkflows()
            } catch (e: Exception) {
                Log.e(TAG, "Failed to toggle connector '$name'", e)
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

    /**
     * Open the details screen in edit mode (when workflow is disabled).
     */
    private fun openDetailsEditMode(connectorName: String, label: String) {
        val fragment = WorkflowDetailsFragment.newInstance(connectorName, label, editMode = true)
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

            if (item.enabled) {
                // ── Enabled mode: show compatibility status ──
                val statusRes = when (item.status) {
                    "compatible" -> R.string.workflow_status_compatible
                    "incompatible" -> R.string.workflow_status_incompatible
                    "registered" -> R.string.workflow_status_registered
                    else -> R.string.workflow_status_unknown
                }
                statusText.text = ctx.getString(statusRes)

                val statusColor = when (item.status) {
                    "compatible" -> ctx.getColor(R.color.cinema_success)
                    "incompatible" -> ctx.getColor(R.color.cinema_error)
                    else -> ctx.getColor(R.color.cinema_text_secondary)
                }
                statusText.setTextColor(statusColor)

                // Full alpha — normal display
                card.alpha = 1.0f
                labelText.alpha = 1.0f
                connectorText.alpha = 1.0f
                statusText.alpha = 1.0f
            } else {
                // ── Edit mode: show editing hint ──
                statusText.text = ctx.getString(R.string.workflow_status_edit_mode)
                statusText.setTextColor(ctx.getColor(R.color.cinema_accent))

                // Keep card fully visible (don't gray out)
                card.alpha = 1.0f
                labelText.alpha = 1.0f
                connectorText.alpha = 1.0f
                statusText.alpha = 1.0f
            }

            // Enable/Disable toggle
            // ⚠️ Remove listener before setting isChecked to prevent spurious API calls on bind()
            enableSwitch.setOnCheckedChangeListener(null)
            enableSwitch.isChecked = item.enabled
            enableSwitch.setOnCheckedChangeListener { _, isChecked ->
                onToggleEnabled(item, isChecked)
            }

            // Details button works for both enabled and disabled states
            detailsButton.setOnClickListener {
                onItemClick(item)
            }
            itemView.setOnClickListener {
                onItemClick(item)
            }
        }
    }
}

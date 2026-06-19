package com.example.animastor.ui

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.fragment.app.activityViewModels
import androidx.lifecycle.lifecycleScope
import com.example.animastor.R
import com.example.animastor.databinding.FragmentWorkflowManagerBinding
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

class WorkflowManagerFragment : Fragment(R.layout.fragment_workflow_manager) {

    private var binding: FragmentWorkflowManagerBinding? = null
    private val viewModel: WorkflowManagerViewModel by activityViewModels {
        WorkflowManagerViewModel.factory
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        binding = FragmentWorkflowManagerBinding.bind(view)
        val b = binding ?: return

        // Toolbar back navigation
        b.toolbar.setNavigationOnClickListener {
            parentFragmentManager.popBackStack()
        }

        // Observe loading state
        lifecycleScope.launch {
            viewModel.loading.collectLatest { loading ->
                b.loadingIndicator.visibility = if (loading) View.VISIBLE else View.GONE
            }
        }

        // Observe errors
        lifecycleScope.launch {
            viewModel.error.collectLatest { err ->
                b.errorText.visibility = if (err != null) View.VISIBLE else View.GONE
                b.errorText.text = err
            }
        }

        // Observe audio workflows
        lifecycleScope.launch {
            viewModel.audioWorkflows.collectLatest { list ->
                val active = list.count { it.status == "compatible" || it.status == "registered" }
                b.audioCount.text = if (active == 1)
                    getString(R.string.workflow_manager_active, active)
                else
                    getString(R.string.workflow_manager_active_plural, active)
                b.audioSubtitle.text = if (list.isNotEmpty())
                    list.first().label
                else
                    getString(R.string.workflow_manager_no_workflows)
            }
        }

        // Observe image workflows
        lifecycleScope.launch {
            viewModel.imageWorkflows.collectLatest { list ->
                val active = list.count { it.status == "compatible" || it.status == "registered" }
                b.imageCount.text = if (active == 1)
                    getString(R.string.workflow_manager_active, active)
                else
                    getString(R.string.workflow_manager_active_plural, active)
                b.imageSubtitle.text = if (list.isNotEmpty())
                    list.first().label
                else
                    getString(R.string.workflow_manager_no_workflows)
            }
        }

        // Observe video workflows
        lifecycleScope.launch {
            viewModel.videoWorkflows.collectLatest { list ->
                val active = list.count { it.status == "compatible" || it.status == "registered" }
                b.videoCount.text = if (active == 1)
                    getString(R.string.workflow_manager_active, active)
                else
                    getString(R.string.workflow_manager_active_plural, active)
                b.videoSubtitle.text = if (list.isNotEmpty())
                    list.first().label
                else
                    getString(R.string.workflow_manager_no_workflows)
            }
        }

        // Card click listeners — open type list
        b.audioCard.setOnClickListener {
            openTypeList("audio", getString(R.string.workflow_manager_audio))
        }
        b.audioManageButton.setOnClickListener {
            openTypeList("audio", getString(R.string.workflow_manager_audio))
        }

        b.imageCard.setOnClickListener {
            openTypeList("image", getString(R.string.workflow_manager_image))
        }
        b.imageManageButton.setOnClickListener {
            openTypeList("image", getString(R.string.workflow_manager_image))
        }

        b.videoCard.setOnClickListener {
            openTypeList("video", getString(R.string.workflow_manager_video))
        }
        b.videoManageButton.setOnClickListener {
            openTypeList("video", getString(R.string.workflow_manager_video))
        }

        // Reload button
        b.reloadButton.setOnClickListener {
            viewModel.reloadConnectors()
            Toast.makeText(requireContext(), "Reloading connectors...", Toast.LENGTH_SHORT).show()
        }
    }

    private fun openTypeList(type: String, title: String) {
        val fragment = WorkflowTypeListFragment.newInstance(type, title)
        parentFragmentManager.beginTransaction()
            .add(R.id.nav_host_container, fragment, "WorkflowTypeListFragment")
            .addToBackStack(null)
            .commit()
    }

    override fun onDestroyView() {
        binding = null
        super.onDestroyView()
    }
}

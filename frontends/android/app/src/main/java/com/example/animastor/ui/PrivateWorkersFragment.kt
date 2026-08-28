package com.example.animastor.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.example.animastor.BuildConfig
import com.example.animastor.R
import com.example.animastor.databinding.FragmentPrivateWorkersBinding
import com.example.animastor.network.RetrofitClient
import com.example.animastor.repository.PrivateWorker
import com.google.android.material.button.MaterialButton
import com.google.android.material.color.MaterialColors
import kotlinx.coroutines.launch
import org.json.JSONObject
import retrofit2.HttpException

/**
 * Private Worker management (Experimental Beta — Phase 3 / 3.1). Web parity:
 * frontends/app /settings/private-workers (PrivateWorkersSection.tsx).
 *
 * List + details + rotate + revoke + purge (permanent delete of a revoked
 * worker) for the CALLER's workspace workers, served by /api/v1/workers
 * (server-resolves workspace_id — never from the client). Worker CREATION
 * lives in the Setup Center wizard (WorkerSetupWizardFragment — web parity:
 * SetupWizard), which drives the unified Setup Contract. Registered users
 * only: guests get 401/403 by design (a temporary workspace must never own
 * long-lived GPU credentials).
 *
 * SECURITY: the plaintext worker credential (token) is a ONE-TIME disclosure
 * from the server. It lives ONLY transiently in fragment memory while the
 * disclosure dialog is open and is NEVER written to SharedPreferences,
 * files, URLs or logs. Closing the dialog drops it.
 */
class PrivateWorkersFragment : Fragment(R.layout.fragment_private_workers) {

    private var binding: FragmentPrivateWorkersBinding? = null
    private var busy = false

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        binding = FragmentPrivateWorkersBinding.bind(view)
        val b = binding ?: return

        b.toolbar.setNavigationOnClickListener {
            parentFragmentManager.popBackStack()
        }
        // Setup Center (Phase 3.1) — canonical onboarding flow. The wizard
        // owns worker creation + one-time key disclosure + install artifacts.
        b.addWorkerButton.setOnClickListener { openSetupCenter() }

        load()
    }

    private fun openSetupCenter() {
        if (busy) return
        val fragment = WorkerSetupWizardFragment()
        fragment.onWizardDone = { load() }
        parentFragmentManager.beginTransaction()
            .add(R.id.nav_host_container, fragment, "WorkerSetupWizardFragment")
            .addToBackStack(null)
            .commit()
    }

    private fun load() {
        val b = binding ?: return
        b.errorLabel.visibility = View.GONE
        b.listHint.text = getString(R.string.play_loading)
        b.workersContainer.removeAllViews()
        lifecycleScope.launch {
            try {
                val res = RetrofitClient.api.listWorkers()
                renderList(res.workers)
            } catch (e: Throwable) {
                b.listHint.text = ""
                showError(humanError(e))
            }
        }
    }

    private fun renderList(workers: List<PrivateWorker>) {
        val b = binding ?: return
        b.workersContainer.removeAllViews()
        if (workers.isEmpty()) {
            b.listHint.text = getString(R.string.worker_empty)
            return
        }
        b.listHint.text = ""
        for (w in workers) {
            b.workersContainer.addView(buildRow(w))
        }
    }

    private fun buildRow(w: PrivateWorker): View {
        val ctx = requireContext()
        val row = LayoutInflater.from(ctx).inflate(R.layout.item_private_worker, binding!!.workersContainer, false)

        val name = row.findViewById<TextView>(R.id.workerName)
        val status = row.findViewById<TextView>(R.id.workerStatus)
        val meta = row.findViewById<TextView>(R.id.workerMeta)
        val trouble = row.findViewById<TextView>(R.id.workerTrouble)
        val details = row.findViewById<MaterialButton>(R.id.detailsButton)
        val rotate = row.findViewById<MaterialButton>(R.id.rotateButton)
        val revoke = row.findViewById<MaterialButton>(R.id.revokeButton)
        val delete = row.findViewById<MaterialButton>(R.id.deleteButton)

        name.text = w.name ?: ""

        // Status pill — the SINGLE status badge (web parity 8117efc3: the
        // duplicate 'Revoked' label is gone). ONLINE green, OFFLINE muted,
        // REVOKED error.
        val statusText = when (w.status) {
            "ONLINE" -> getString(R.string.worker_status_online)
            "REVOKED" -> getString(R.string.worker_status_revoked)
            else -> getString(R.string.worker_status_offline)
        }
        val statusColor = when (w.status) {
            "ONLINE" -> ctx.getColor(R.color.cinema_success)
            "REVOKED" -> MaterialColors.getColor(status, com.google.android.material.R.attr.colorError)
            else -> MaterialColors.getColor(status, com.google.android.material.R.attr.colorOnSurfaceVariant)
        }
        status.text = statusText
        status.setTextColor(statusColor)
        status.background = GradientDrawable().apply {
            cornerRadius = 10 * resources.displayMetrics.density
            setStroke((1 * resources.displayMetrics.density).toInt(), statusColor)
        }

        val typeLabel = when (w.worker_type) {
            "audio" -> getString(R.string.layer_audio)
            "image" -> getString(R.string.layer_image)
            else -> getString(R.string.layer_video)
        }
        meta.text = "$typeLabel \u00B7 ${getString(R.string.worker_last_seen)} ${BetaSettingsHelpers.formatLastSeen(w.last_seen)}"

        if (w.status == "OFFLINE") {
            trouble.text = listOf(
                getString(R.string.worker_offline_hint),
                getString(R.string.worker_trouble_hub_url),
                getString(R.string.worker_trouble_token),
                getString(R.string.worker_trouble_process),
                getString(R.string.worker_trouble_network)
            ).joinToString("\n\u2022 ", prefix = "\u2022 ")
            trouble.visibility = View.VISIBLE
        }

        // Details for EVERY worker (extended Setup Contract status model +
        // capabilities). Rotate/Revoke only while active; permanent Delete
        // only once revoked (web parity 8117efc3).
        details.setOnClickListener { showDetailsDialog(w) }
        if (w.status == "REVOKED") {
            rotate.visibility = View.GONE
            revoke.visibility = View.GONE
            delete.visibility = View.VISIBLE
            delete.setOnClickListener { onDelete(w) }
        } else {
            rotate.setOnClickListener { onRotate(w) }
            revoke.setOnClickListener { onRevoke(w) }
        }
        return row
    }

    // ── Permanent delete of an ALREADY REVOKED worker (web parity 8117efc3) ──
    // The backend hard-deletes the registry row and clears every derived state
    // (auth mirror, heartbeat, hub GPU registry), so the worker can never
    // resurface (reload/re-login). Active workers are never purgeable (409).

    private fun onDelete(w: PrivateWorker) {
        if (busy) return
        val workerId = w.worker_id ?: return
        val ctx = requireContext()

        val notice = LayoutInflater.from(ctx).inflate(R.layout.dialog_delete_vbook, null)
        notice.findViewById<TextView>(R.id.dialogMessage).text = getString(R.string.worker_delete_confirm)

        AppDialogs.action(
            ctx = ctx,
            title = getString(R.string.worker_delete),
            content = notice,
            cancelText = getString(R.string.dialog_cancel),
            actionText = getString(android.R.string.ok),
            destructive = true,
        ) { dlg ->
            dlg.dismiss()
            busy = true
            setBusy(true)
            lifecycleScope.launch {
                try {
                    RetrofitClient.api.purgeWorker(workerId)
                    Toast.makeText(requireContext(), R.string.worker_deleted, Toast.LENGTH_SHORT).show()
                    load()
                } catch (e: Throwable) {
                    showError(humanError(e))
                } finally {
                    busy = false
                    setBusy(false)
                }
            }
        }.show()
    }

    // ── Worker details (Setup Contract extended status + capabilities) ────
    // Web parity: WorkerDetailsModal — shows ONLY real backend fields from
    // GET /private-worker/setup/workers/:id (extended status, last seen,
    // GPU/VRAM/profiles/workflows when reported). Null data is never invented.
    // The uninstall action exists ONLY if the backend reports the uninstaller
    // artifact as actually available (Phase 3.1 §19 — no fake actions).

    private fun showDetailsDialog(w: PrivateWorker) {
        val workerId = w.worker_id ?: return
        val activity = requireActivity()
        fun dp(v: Int) = (v * resources.displayMetrics.density + 0.5f).toInt()

        val root = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }

        val statusView = TextView(activity).apply {
            textSize = 13f
            setTypeface(Typeface.DEFAULT_BOLD)
        }
        val metaView = TextView(activity).apply {
            textSize = 12f
            setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurfaceVariant))
            setPadding(0, dp(4), 0, 0)
        }
        val capsView = TextView(activity).apply {
            textSize = 12f
            setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurfaceVariant))
            setLineSpacing(0f, 1.3f)
            setPadding(0, dp(10), 0, 0)
            visibility = View.GONE
        }
        val loadingView = TextView(activity).apply {
            text = getString(R.string.play_loading)
            textSize = 12f
            setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurfaceVariant))
            setPadding(0, dp(10), 0, 0)
        }
        val errorTextView = TextView(activity).apply {
            textSize = 12f
            setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorError))
            setPadding(0, dp(10), 0, 0)
            visibility = View.GONE
        }
        val uninstallBtn = MaterialButton(activity, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(40)).apply { topMargin = dp(12) }
            text = getString(R.string.worker_details_uninstall)
            visibility = View.GONE
        }

        root.addView(statusView)
        root.addView(metaView)
        root.addView(loadingView)
        root.addView(errorTextView)
        root.addView(capsView)
        root.addView(uninstallBtn)

        val typeLabel = when (w.worker_type) {
            "audio" -> getString(R.string.layer_audio)
            "image" -> getString(R.string.layer_image)
            else -> getString(R.string.layer_video)
        }

        fun renderBaseStatus(statusText: String, color: Int, lastSeen: Long?) {
            statusView.text = statusText
            statusView.setTextColor(color)
            metaView.text = "$typeLabel \u00B7 ${getString(R.string.worker_last_seen)} ${BetaSettingsHelpers.formatLastSeen(lastSeen)}"
        }
        renderBaseStatus(
            when (w.status) {
                "ONLINE" -> getString(R.string.worker_status_online)
                "REVOKED" -> getString(R.string.worker_status_revoked)
                else -> getString(R.string.worker_status_offline)
            },
            when (w.status) {
                "ONLINE" -> activity.getColor(R.color.cinema_success)
                "REVOKED" -> MaterialColors.getColor(statusView, com.google.android.material.R.attr.colorError)
                else -> MaterialColors.getColor(statusView, com.google.android.material.R.attr.colorOnSurfaceVariant)
            },
            w.last_seen
        )

        val dialog = AppDialogs.action(
            ctx = activity,
            title = getString(R.string.worker_details_title),
            content = root,
            cancelText = getString(R.string.dialog_cancel),
            actionText = getString(R.string.worker_done),
        ) { dlg -> dlg.dismiss() }

        lifecycleScope.launch {
            var detail: com.example.animastor.repository.SetupWorkerDetail? = null
            try {
                detail = RetrofitClient.api.setupWorkerStatus(workerId).worker
            } catch (e: Throwable) {
                if (isAdded) {
                    errorTextView.text = humanError(e)
                    errorTextView.visibility = View.VISIBLE
                }
            }
            if (!isAdded) return@launch
            loadingView.visibility = View.GONE
            val d = detail
            if (d != null) {
                // Extended status model (CONNECTING/ERROR/INSTALLING/…) — the
                // pill tone degrades to offline for anything unknown.
                val extText = getString(stringResForSetupStatus(WorkerSetupHelpers.setupStatusKey(d.status)))
                val extColor = when (WorkerSetupHelpers.setupStatusTone(d.status)) {
                    "online" -> activity.getColor(R.color.cinema_success)
                    "revoked" -> MaterialColors.getColor(statusView, com.google.android.material.R.attr.colorError)
                    else -> MaterialColors.getColor(statusView, com.google.android.material.R.attr.colorOnSurfaceVariant)
                }
                renderBaseStatus(extText, extColor, d.last_seen)

                val caps = d.capabilities
                if (caps != null) {
                    val lines = mutableListOf<String>()
                    caps.gpu?.let { gpu ->
                        if (gpu.name != null || gpu.vram_gb != null) {
                            val vram = if (gpu.vram_gb != null) " \u00B7 ${getString(R.string.worker_details_vram)}: ${gpu.vram_gb} GB" else ""
                            lines.add("${getString(R.string.worker_details_gpu)}: ${gpu.name ?: "\u2014"}$vram")
                        }
                    }
                    if (!caps.profiles.isNullOrEmpty()) {
                        lines.add("${getString(R.string.worker_details_profiles)}: ${caps.profiles.joinToString(", ")}")
                    }
                    if (!caps.workflows.isNullOrEmpty()) {
                        lines.add("${getString(R.string.worker_details_workflows)}: ${caps.workflows.joinToString(", ")}")
                    }
                    capsView.text = if (lines.isEmpty()) getString(R.string.worker_details_capabilities_empty)
                                    else lines.joinToString("\n")
                    capsView.visibility = View.VISIBLE
                } else {
                    capsView.text = getString(R.string.worker_details_capabilities_empty)
                    capsView.visibility = View.VISIBLE
                }
            }
            // Uninstall action ONLY when the backend really serves the artifact.
            try {
                val methods = RetrofitClient.api.setupMethods().methods
                val linux = methods.find { it.platform == "linux" }
                if (isAdded && linux != null && linux.uninstaller.available) {
                    val url = WorkerSetupHelpers.resolveArtifactUrl(linux.uninstaller.download_url, BuildConfig.BASE_URL)
                    if (url != null) {
                        uninstallBtn.setOnClickListener {
                            try {
                                startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url)))
                            } catch (_: Exception) {
                                Toast.makeText(requireContext(), R.string.worker_copy_failed, Toast.LENGTH_SHORT).show()
                            }
                        }
                        uninstallBtn.visibility = View.VISIBLE
                    }
                }
            } catch (_: Throwable) { /* stay hidden — no fake actions */ }
        }

        dialog.show()
    }

    private fun stringResForSetupStatus(key: String): Int = when (key) {
        "worker_status_online" -> R.string.worker_status_online
        "worker_status_revoked" -> R.string.worker_status_revoked
        "worker_status_connecting" -> R.string.worker_status_connecting
        "worker_status_error" -> R.string.worker_status_error
        "worker_status_installing" -> R.string.worker_status_installing
        "worker_status_not_configured" -> R.string.worker_status_not_configured
        else -> R.string.worker_status_offline
    }

    private fun onRotate(w: PrivateWorker) {
        if (busy) return
        val workerId = w.worker_id ?: return
        val ctx = requireContext()

        val notice = LayoutInflater.from(ctx).inflate(R.layout.dialog_delete_vbook, null)
        notice.findViewById<TextView>(R.id.dialogMessage).text = getString(R.string.worker_rotate_confirm)

        AppDialogs.action(
            ctx = ctx,
            title = getString(R.string.worker_rotate),
            content = notice,
            cancelText = getString(R.string.dialog_cancel),
            actionText = getString(android.R.string.ok),
        ) { dlg ->
            dlg.dismiss()
            busy = true
            setBusy(true)
            lifecycleScope.launch {
                try {
                    val res = RetrofitClient.api.rotateWorker(workerId, emptyMap())
                    showCredentialDisclosure(res.token, res.worker)
                    load()
                } catch (e: Throwable) {
                    showError(humanError(e))
                } finally {
                    busy = false
                    setBusy(false)
                }
            }
        }.show()
    }

    private fun onRevoke(w: PrivateWorker) {
        if (busy) return
        val workerId = w.worker_id ?: return
        val ctx = requireContext()

        val notice = LayoutInflater.from(ctx).inflate(R.layout.dialog_delete_vbook, null)
        notice.findViewById<TextView>(R.id.dialogMessage).text = getString(R.string.worker_revoke_confirm)

        AppDialogs.action(
            ctx = ctx,
            title = getString(R.string.worker_revoke),
            content = notice,
            cancelText = getString(R.string.dialog_cancel),
            actionText = getString(android.R.string.ok),
            destructive = true,
        ) { dlg ->
            dlg.dismiss()
            busy = true
            setBusy(true)
            lifecycleScope.launch {
                try {
                    RetrofitClient.api.revokeWorker(workerId)
                    Toast.makeText(requireContext(), R.string.worker_revoked, Toast.LENGTH_SHORT).show()
                    load()
                } catch (e: Throwable) {
                    showError(humanError(e))
                } finally {
                    busy = false
                    setBusy(false)
                }
            }
        }.show()
    }

    // ── One-time credential disclosure ──────────────────────────────────
    // The token is shown ONCE. Copy uses the transient in-memory string only.
    // Closing this dialog drops the token (never persisted anywhere).

    private fun showCredentialDisclosure(token: String?, worker: PrivateWorker?) {
        if (!BetaSettingsHelpers.looksLikeWorkerToken(token)) return
        val activity = requireActivity()
        fun dp(v: Int) = (v * resources.displayMetrics.density + 0.5f).toInt()

        val contract = BetaSettingsHelpers.buildSetupContract(
            baseUrl = BuildConfig.BASE_URL,
            token = token!!,
            workerType = worker?.worker_type ?: "audio",
            workerName = worker?.name ?: ""
        )
        val envBlock = BetaSettingsHelpers.renderEnvBlock(contract)

        val root = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
        }

        fun label(text: String) = TextView(activity).apply {
            this.text = text
            textSize = 13f
            setTypeface(Typeface.DEFAULT_BOLD)
            setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurface))
            setPadding(0, dp(12), 0, dp(4))
        }
        fun hint(text: String) = TextView(activity).apply {
            this.text = text
            textSize = 12f
            setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurfaceVariant))
            setLineSpacing(0f, 1.3f)
        }
        fun codeBlock(text: String) = TextView(activity).apply {
            this.text = text
            textSize = 12f
            setTypeface(Typeface.MONOSPACE)
            setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurface))
            background = androidx.core.content.ContextCompat.getDrawable(activity, R.drawable.bg_dialog_notice)
            setPadding(dp(10), dp(8), dp(10), dp(8))
        }

        // Warning notice
        root.addView(TextView(activity).apply {
            text = getString(R.string.worker_credential_warning)
            textSize = 12f
            setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurfaceVariant))
            background = androidx.core.content.ContextCompat.getDrawable(activity, R.drawable.bg_dialog_notice)
            setPadding(dp(12), dp(10), dp(12), dp(10))
            setLineSpacing(0f, 1.3f)
        })

        // Credential + copy
        root.addView(label(getString(R.string.worker_credential)))
        root.addView(codeBlock(token))
        val copyToken = MaterialButton(activity, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(40)).apply { topMargin = dp(6) }
            text = getString(R.string.worker_copy)
            setOnClickListener {
                copyToClipboard("animastor-worker-token", token)
                text = getString(R.string.worker_copied)
                postDelayed({ text = getString(R.string.worker_copy) }, 1800)
            }
        }
        root.addView(copyToken)

        // Setup steps (5-step contract, web parity)
        root.addView(label(getString(R.string.worker_setup_title)))
        val steps = listOf(
            getString(R.string.worker_setup_step_1) + "\n" + contract.downloadCommand +
                "\n" + getString(R.string.worker_source_label, contract.sourceUrl),
            getString(R.string.worker_setup_step_2),
            getString(R.string.worker_setup_step_3),
            getString(R.string.worker_setup_step_4) + "\n" + contract.runCommand,
            getString(R.string.worker_setup_step_5)
        )
        root.addView(hint(steps.mapIndexed { i, s -> "${i + 1}. $s" }.joinToString("\n")))

        // Prerequisites
        root.addView(label(getString(R.string.worker_prereq_title)))
        root.addView(hint(listOf(
            getString(R.string.worker_prereq_node),
            getString(R.string.worker_prereq_comfy),
            getString(R.string.worker_prereq_models)
        ).joinToString("\n\u2022 ", prefix = "\u2022 ")))

        // Env block + copy
        root.addView(label(getString(R.string.worker_run_label)))
        root.addView(codeBlock(envBlock))
        val copyEnv = MaterialButton(activity, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(40)).apply { topMargin = dp(6) }
            text = getString(R.string.worker_copy_env)
            setOnClickListener {
                copyToClipboard("animastor-worker-env", envBlock)
                text = getString(R.string.worker_env_copied)
                postDelayed({ text = getString(R.string.worker_copy_env) }, 1800)
            }
        }
        root.addView(copyEnv)
        root.addView(hint(getString(R.string.worker_setup_hint)).apply {
            setPadding(0, dp(8), 0, 0)
        })

        val dialog = AlertDialog.Builder(activity).create()
        val scroll = ScrollView(activity).apply { addView(root) }
        dialog.setView(scroll)
        dialog.window?.setBackgroundDrawable(
            GradientDrawable().apply {
                cornerRadius = dp(18).toFloat()
                setColor(MaterialColors.getColor(root, com.google.android.material.R.attr.colorSurface))
                setStroke(dp(1), MaterialColors.getColor(root, com.google.android.material.R.attr.colorOutlineVariant))
            }
        )

        val done = MaterialButton(activity).apply {
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(44)).apply { topMargin = dp(16) }
            text = getString(R.string.worker_done)
            setOnClickListener { dialog.dismiss() }
        }
        root.addView(done)

        // Dismissing the dialog is the ONLY exit — the token reference dies
        // with this scope and is never persisted.
        dialog.show()
    }
    private fun copyToClipboard(label: String, text: String) {
        val cm = requireContext().getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText(label, text))
    }

    // ── helpers ─────────────────────────────────────────────────────────

    private fun setBusy(v: Boolean) {
        val b = binding ?: return
        b.addWorkerButton.isEnabled = !v
    }

    private fun showError(msg: String) {
        val b = binding ?: return
        b.errorLabel.text = msg
        b.errorLabel.visibility = View.VISIBLE
    }

    /** Map an API error to a user-facing localized message (web parity:
     *  humanError — hide DB/Redis internals). */
    private fun humanError(e: Throwable): String {
        if (e is HttpException) {
            return when (e.code()) {
                401 -> getString(R.string.worker_err_auth_required)
                403 -> getString(R.string.worker_err_forbidden)
                404 -> getString(R.string.worker_err_not_found)
                in 500..599 -> getString(R.string.worker_err_unavailable)
                else -> {
                    val body = try { e.response()?.errorBody()?.string() } catch (_: Exception) { null }
                    val msg = body?.let {
                        runCatching { JSONObject(it).optString("error").ifEmpty { null } }.getOrNull()
                    }
                    msg ?: getString(R.string.worker_err_unavailable)
                }
            }
        }
        return e.message ?: getString(R.string.worker_err_unavailable)
    }

    override fun onDestroyView() {
        binding = null
        super.onDestroyView()
    }
}

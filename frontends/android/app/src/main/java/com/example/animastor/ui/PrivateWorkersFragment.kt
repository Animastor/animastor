package com.example.animastor.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.view.Gravity
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
import com.example.animastor.repository.AddShareUsersRequest
import com.example.animastor.repository.LookupUser
import com.example.animastor.repository.PrivateWorker
import com.example.animastor.repository.RemoveShareUserRequest
import com.example.animastor.repository.ShareGrant
import com.example.animastor.repository.SharePolicy
import com.example.animastor.repository.ShareStateResponse
import com.example.animastor.repository.SharedWithMeWorker
import com.example.animastor.repository.StartShareRequest
import com.google.android.material.button.MaterialButton
import com.google.android.material.color.MaterialColors
import kotlinx.coroutines.async
import kotlinx.coroutines.joinAll
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
 * SH-2 Worker Sharing (web parity: WorkerSharingUI.tsx + sharing.ts):
 * three tabs — My Workers / Shared with me / Community — plus the owner
 * Sharing modal (off → public/users, recipient management, stop). Gated by
 * the kill-switch mirror (GET /config → features.share, read ONCE, fail
 * CLOSED): when off, the tabs never render and NO V2 endpoint is called.
 * The backend is the single source of truth — every mutation re-reads
 * GET /workers/:id/share (owner) or /workers/shared-with-me (recipient)
 * and replaces local state wholesale; nothing is cached or fabricated.
 *
 * SECURITY: the plaintext worker credential (token) is a ONE-TIME disclosure
 * from the server. It lives ONLY transiently in fragment memory while the
 * disclosure dialog is open and is NEVER written to SharedPreferences,
 * files, URLs or logs. Closing the dialog drops it.
 */
class PrivateWorkersFragment : Fragment(R.layout.fragment_private_workers) {

    private var binding: FragmentPrivateWorkersBinding? = null
    private var busy = false

    // ── SH-2 sharing state (kill-switch aware) ───────────────────────────
    private var shareOn: Boolean = false
    private var tab: String = TAB_MY
    private var shareStates: MutableMap<String, String> = mutableMapOf()
    private var sharedWithMe: List<SharedWithMeWorker> = emptyList()

    private companion object {
        const val TAB_MY = "my"
        const val TAB_SHARED = "shared"
        const val TAB_COMMUNITY = "community"
    }

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

        // SH-2 tabs (visibility set by the kill-switch probe below).
        b.tabMyButton.setOnClickListener { switchTab(TAB_MY) }
        b.tabSharedButton.setOnClickListener { switchTab(TAB_SHARED) }
        b.tabCommunityButton.setOnClickListener { switchTab(TAB_COMMUNITY) }

        // Kill-switch FIRST, then the list — per-row share badges are only
        // read when the capability is confirmed (fail CLOSED).
        probeShareFeature()
    }

    /** One-time capability probe (web parity: probeShareFeature). Fail
     *  CLOSED: config unavailable ⇒ no sharing UI, no V2 requests. */
    private fun probeShareFeature() {
        lifecycleScope.launch {
            shareOn = try {
                RetrofitClient.api.getConfig().features?.share == true
            } catch (_: Throwable) {
                false
            }
            val b = binding ?: return@launch
            if (shareOn) {
                b.shareTabs.visibility = View.VISIBLE
                selectTab(TAB_MY)
                loadSharedWithMe(markSeen = false)
            } else {
                b.shareTabs.visibility = View.GONE
            }
            load()
        }
    }

    private fun switchTab(t: String) {
        if (tab == t) return
        selectTab(t)
        if (t == TAB_SHARED) loadSharedWithMe(markSeen = true)
        if (t == TAB_COMMUNITY) renderCommunity()
    }

    private fun selectTab(t: String) {
        tab = t
        val b = binding ?: return
        b.tabMyButton.isSelected = t == TAB_MY
        b.tabSharedButton.isSelected = t == TAB_SHARED
        b.tabCommunityButton.isSelected = t == TAB_COMMUNITY
        if (t == TAB_SHARED) {
            b.addWorkerButton.visibility = View.GONE
            renderSharedWithMe()
        } else if (t == TAB_COMMUNITY) {
            b.addWorkerButton.visibility = View.GONE
            renderCommunity()
        } else {
            b.addWorkerButton.visibility = View.VISIBLE
        }
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
        if (tab != TAB_MY) return
        b.listHint.text = getString(R.string.play_loading)
        b.workersContainer.removeAllViews()
        lifecycleScope.launch {
            try {
                val res = RetrofitClient.api.listWorkers()
                // SH-2 row badges: read the active policy per private worker
                // (a personal list is small — bounded parallel reads, all
                // owner-scoped; server truth, re-read on every load).
                shareStates.clear()
                if (shareOn) {
                    val jobs = res.workers.filter { WorkerSharingHelpers.canBeShared(it) }
                        .map { w ->
                            async {
                                val id = w.worker_id ?: return@async
                                shareStates[id] = try {
                                    WorkerSharingHelpers.shareModeOf(
                                        RetrofitClient.api.getShareState(id).policy
                                    )
                                } catch (_: Throwable) {
                                    WorkerSharingHelpers.MODE_OFF
                                }
                            }
                        }
                    jobs.joinAll()
                }
                if (tab != TAB_MY) return@launch
                renderList(res.workers)
            } catch (e: Throwable) {
                if (tab != TAB_MY) return@launch
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

    // ── SH-2: "Shared with me" (§14.2) — always a FRESH server read ─────
    // Revocation and expiry simply stop the entry from arriving (server
    // truth); no notification feed, no cached grant state.
    private fun loadSharedWithMe(markSeen: Boolean) {
        if (!shareOn) return
        lifecycleScope.launch {
            try {
                val list = RetrofitClient.api.sharedWithMe().workers
                if (!isAdded) return@launch
                sharedWithMe = list
                if (tab == TAB_SHARED) renderSharedWithMe()
            } catch (e: Throwable) {
                if (!isAdded || tab != TAB_SHARED) return@launch
                sharedWithMe = emptyList()
                renderSharedWithMe(humanError(e))
            }
        }
    }

    private fun renderSharedWithMe(error: String = "") {
        val b = binding ?: return
        b.workersContainer.removeAllViews()
        val ctx = requireContext()
        fun dp(v: Int) = (v * resources.displayMetrics.density + 0.5f).toInt()

        if (sharedWithMe.isEmpty()) {
            b.listHint.text = if (error.isNotEmpty()) error else getString(R.string.share_swm_empty)
            if (error.isEmpty()) {
                val hint = TextView(ctx).apply {
                    text = getString(R.string.share_swm_hint)
                    textSize = 12f
                    setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurfaceVariant))
                    setLineSpacing(0f, 1.3f)
                }
                b.workersContainer.addView(hint)
            }
            return
        }
        b.listHint.text = ""
        for (w in sharedWithMe) {
            b.workersContainer.addView(buildSharedWithMeRow(w, ::dp))
        }
    }

    private fun buildSharedWithMeRow(w: SharedWithMeWorker, dp: (Int) -> Int): View {
        val ctx = requireContext()
        val row = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(12), 0, dp(12))
        }

        // Name + online pill
        val top = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        top.addView(TextView(ctx).apply {
            text = w.name ?: ""
            textSize = 14f
            setTypeface(Typeface.DEFAULT_BOLD)
            setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurface))
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        })
        val online = WorkerSharingHelpers.sharedStatusOf(w, System.currentTimeMillis()) == "online"
        val pillColor = if (online) ctx.getColor(R.color.cinema_success)
            else MaterialColors.getColor(top, com.google.android.material.R.attr.colorOnSurfaceVariant)
        top.addView(TextView(ctx).apply {
            text = getString(if (online) R.string.worker_status_online else R.string.worker_status_offline)
            textSize = 12f
            setTypeface(Typeface.DEFAULT_BOLD)
            setTextColor(pillColor)
            setPadding(dp(8), dp(2), dp(8), dp(2))
            background = GradientDrawable().apply {
                cornerRadius = 10 * resources.displayMetrics.density
                setStroke(dp(1), pillColor)
            }
        })
        row.addView(top)

        // Access reason + expiry (§14.2: WHY this resource is listed)
        val meta = TextView(ctx).apply {
            textSize = 12f
            setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurfaceVariant))
            setLineSpacing(0f, 1.3f)
            val parts = mutableListOf<String>()
            val by = WorkerSharingHelpers.sharedByLabel(w.access_reason)
            if (by.isNotEmpty()) parts.add(getString(R.string.share_shared_by, by))
            val policy = w.share_policy
            val exp = policy?.expires_at
            if (exp != null && !WorkerSharingHelpers.isPolicyExpired(policy, System.currentTimeMillis())) {
                parts.add(getString(R.string.share_expires_until,
                    WorkerSharingHelpers.formatExpiry(exp, System.currentTimeMillis())))
            }
            parts.add(getString(R.string.worker_last_seen) + " " + BetaSettingsHelpers.formatLastSeen(w.last_seen))
            text = parts.joinToString(" \u00B7 ")
        }
        row.addView(meta)

        // Type
        row.addView(TextView(ctx).apply {
            textSize = 12f
            setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurfaceVariant))
            text = typeLabel(w.worker_type)
            setPadding(0, dp(2), 0, dp(12))
        })

        row.addView(View(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(1)).apply {
                topMargin = dp(2)
            }
            setBackgroundColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOutlineVariant))
        })
        return row
    }

    // ── SH-2: Community — the shared system pool (D3: a CAPACITY ────────
    // indicator, not a physical inventory; no browsable directory).
    private fun renderCommunity() {
        val b = binding ?: return
        b.workersContainer.removeAllViews()
        b.listHint.text = getString(R.string.play_loading)
        val ctx = requireContext()
        lifecycleScope.launch {
            val rows = mutableListOf<View>()
            var error = ""
            try {
                val counts = RetrofitClient.api.getWorkerCounts()
                val entries = listOf(
                    Triple("audio", counts.audio, counts.active_audio),
                    Triple("image", counts.image, counts.active_image),
                    Triple("video", counts.video, counts.active_video),
                ).filter { it.second > 0 }
                fun dp(v: Int) = (v * resources.displayMetrics.density + 0.5f).toInt()
                for ((type, total, active) in entries) {
                    rows.add(LinearLayout(ctx).apply {
                        orientation = LinearLayout.HORIZONTAL
                        gravity = Gravity.CENTER_VERTICAL
                        setPadding(0, dp(12), 0, dp(12))
                        addView(TextView(ctx).apply {
                            text = typeLabel(type)
                            textSize = 14f
                            setTypeface(Typeface.DEFAULT_BOLD)
                            setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurface))
                            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                        })
                        addView(TextView(ctx).apply {
                            text = getString(R.string.worker_counts_fmt, total, active)
                            textSize = 12f
                            setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurfaceVariant))
                        })
                        addView(View(ctx).apply {
                            layoutParams = LinearLayout.LayoutParams(dp(1), dp(1))
                        })
                    })
                }
                if (entries.isEmpty()) {
                    b.listHint.text = getString(R.string.share_community_empty)
                } else {
                    b.listHint.text = getString(R.string.share_community_hint)
                }
            } catch (e: Throwable) {
                if (!isAdded) return@launch
                error = humanError(e)
                b.listHint.text = error
            }
            if (!isAdded || tab != TAB_COMMUNITY) return@launch
            if (error.isEmpty()) {
                b.workersContainer.removeAllViews()
                for (r in rows) b.workersContainer.addView(r)
            }
        }
    }

    private fun typeLabel(type: String?): String = when (type) {
        "audio" -> getString(R.string.layer_audio)
        "image" -> getString(R.string.layer_image)
        else -> getString(R.string.layer_video)
    }

    private fun buildRow(w: PrivateWorker): View {
        val ctx = requireContext()
        val row = LayoutInflater.from(ctx).inflate(R.layout.item_private_worker, binding!!.workersContainer, false)

        val name = row.findViewById<TextView>(R.id.workerName)
        val status = row.findViewById<TextView>(R.id.workerStatus)
        val access = row.findViewById<TextView>(R.id.workerAccess)
        val meta = row.findViewById<TextView>(R.id.workerMeta)
        val trouble = row.findViewById<TextView>(R.id.workerTrouble)
        val details = row.findViewById<MaterialButton>(R.id.detailsButton)
        val share = row.findViewById<MaterialButton>(R.id.shareButton)
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

        // SH-2 access-mode badge (web parity: .worker__badge) — immediately
        // LEFT of the status pill. Private (default) vs Public/Users sharing.
        // Never rendered from local belief — shareStates is server truth.
        // Visual: solid pale pill + dark on-accent text (same as web:
        // Private #E4D0AC, Public #90CAF9, text cinema_on_accent).
        val mode = if (shareOn) shareStates[w.worker_id] else WorkerSharingHelpers.MODE_OFF
        val isPublic = mode == WorkerSharingHelpers.MODE_PUBLIC
        val isUsers = mode == WorkerSharingHelpers.MODE_USERS
        access.text = getString(
            when {
                isPublic -> R.string.share_public_badge
                isUsers -> R.string.share_users_badge
                else -> R.string.worker_access_private
            }
        )
        val bg = ctx.getColor(
            when {
                isPublic -> R.color.worker_badge_public_bg
                else -> R.color.worker_badge_private_bg
            }
        )
        access.setTextColor(ctx.getColor(R.color.cinema_on_accent))
        access.background = GradientDrawable().apply {
            cornerRadius = 10 * resources.displayMetrics.density
            setColor(bg)
        }
        access.visibility = View.VISIBLE

        val typeLabel = typeLabel(w.worker_type)
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
        // capabilities). SH-2 Sharing control — private non-revoked workers
        // only when the kill-switch is on (ownership/mode are never
        // editable here; the backend enforces the same predicates — D7).
        details.setOnClickListener { showDetailsDialog(w) }
        if (shareOn && WorkerSharingHelpers.canBeShared(w)) {
            share.visibility = View.VISIBLE
            share.setOnClickListener { showSharingDialog(w) }
        } else {
            share.visibility = View.GONE
        }
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
        // SH-2 access-mode badge (web parity: WorkerDetailsModal renders the
        // SAME badge pair as the worker row — access mode LEFT of status).
        val accessView = TextView(activity).apply {
            textSize = 12f
            setTypeface(Typeface.DEFAULT_BOLD)
            setPadding(dp(8), dp(2), dp(8), dp(2))
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(6) }
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
        root.addView(accessView)
        root.addView(metaView)
        root.addView(loadingView)
        root.addView(errorTextView)
        root.addView(capsView)
        root.addView(uninstallBtn)

        fun renderAccessBadge() {
            val isPublic = shareOn && shareStates[workerId] == WorkerSharingHelpers.MODE_PUBLIC
            accessView.text = getString(
                if (isPublic) R.string.share_public_badge else R.string.worker_access_private
            )
            // Web parity: solid pale pill + dark on-accent text
            // (Private #E4D0AC, Public #90CAF9).
            val bg = activity.getColor(
                if (isPublic) R.color.worker_badge_public_bg
                else R.color.worker_badge_private_bg
            )
            accessView.setTextColor(activity.getColor(R.color.cinema_on_accent))
            accessView.background = GradientDrawable().apply {
                cornerRadius = 10 * resources.displayMetrics.density
                setColor(bg)
            }
        }
        renderAccessBadge()

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

    // ── SH-2: Owner Sharing modal (web parity: SharingModal) ────────────
    // Full lifecycle of a share policy, driven entirely by the server
    // state: off → public/users (recipients staged BEFORE start — the
    // backend rejects a users policy with an empty audience), recipient
    // add/remove on an active users policy, stop (all recipients lose
    // access instantly). Every mutation re-reads GET /workers/:id/share
    // and REPLACES the local state — the UI never "knows better".
    private fun showSharingDialog(w: PrivateWorker) {
        if (!shareOn) return
        val workerId = w.worker_id ?: return
        val activity = requireActivity()
        fun dp(v: Int) = (v * resources.displayMetrics.density + 0.5f).toInt()

        val root = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }

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
        fun errorView() = TextView(activity).apply {
            textSize = 12f
            setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorError))
            setPadding(0, dp(8), 0, 0)
            visibility = View.GONE
        }
        fun show(tv: TextView, msg: String) {
            tv.text = msg
            tv.visibility = if (msg.isEmpty()) View.GONE else View.VISIBLE
        }

        val modalError = errorView()

        // Mode + expiry summary (always rendered from the fetched state).
        root.addView(label(getString(R.string.share_mode_label)))
        val modeHint = hint("")
        root.addView(modeHint)
        root.addView(modalError)

        // Body container rebuilt per render pass (off / public / users).
        val body = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
        root.addView(body)

        // Staged recipients for the off → users flow.
        val staged = mutableListOf<LookupUser>()

        fun refreshBody(state: ShareStateResponse) {
            body.removeAllViews()
            val policy = state.policy
            val mode = WorkerSharingHelpers.shareModeOf(policy)
            val now = System.currentTimeMillis()
            modeHint.text = when (mode) {
                WorkerSharingHelpers.MODE_PUBLIC ->
                    getString(R.string.share_mode_public) + (policy?.expires_at?.let {
                        if (WorkerSharingHelpers.isPolicyExpired(policy, now)) "" else
                            " \u00B7 " + getString(R.string.share_expires_until,
                                WorkerSharingHelpers.formatExpiry(it, now))
                    } ?: "")
                WorkerSharingHelpers.MODE_USERS ->
                    getString(R.string.share_mode_users) + (policy?.expires_at?.let {
                        if (WorkerSharingHelpers.isPolicyExpired(policy, now)) "" else
                            " \u00B7 " + getString(R.string.share_expires_until,
                                WorkerSharingHelpers.formatExpiry(it, now))
                    } ?: "")
                else -> getString(R.string.share_mode_off)
            }
            when (mode) {
                WorkerSharingHelpers.MODE_OFF -> renderOffBody(body, workerId, staged) { load() }
                WorkerSharingHelpers.MODE_PUBLIC -> renderPublicBody(body, workerId, policy) { load() }
                WorkerSharingHelpers.MODE_USERS -> renderUsersBody(body, workerId, state.grants) { load() }
            }
        }

        var dialog: AlertDialog? = null

        fun loadState() {
            lifecycleScope.launch {
                try {
                    val state = RetrofitClient.api.getShareState(workerId)
                    if (!isAdded) return@launch
                    modalError.visibility = View.GONE
                    refreshBody(state)
                } catch (e: Throwable) {
                    if (!isAdded) return@launch
                    show(modalError, shareErrorText(e))
                }
            }
        }

        dialog = AppDialogs.action(
            ctx = activity,
            title = getString(R.string.share_modal_title),
            content = ScrollView(activity).apply { addView(root) },
            cancelText = getString(R.string.dialog_cancel),
            actionText = getString(R.string.worker_done),
        ) { dlg -> dlg.dismiss() }
        dialog.show()
        loadState()
    }

    private fun shareErrorText(e: Throwable): String {
        if (e is HttpException) {
            val body = try { e.response()?.errorBody()?.string() } catch (_: Exception) { null }
            val msg = body?.let {
                runCatching { JSONObject(it).optString("error").ifEmpty { null } }.getOrNull()
            }
            val key = WorkerSharingHelpers.shareErrorKey(e.code(), msg)
            return runCatching { getString(stringResByName(key)) }.getOrDefault(
                msg ?: getString(R.string.share_err_unavailable)
            )
        }
        return e.message ?: getString(R.string.share_err_unavailable)
    }

    private fun stringResByName(name: String): Int =
        resources.getIdentifier(name, "string", requireContext().packageName)

    /** Off view: scope radio (public / users), staged recipients
     *  (exact-username lookup BEFORE start — never an empty audience),
     *  expiry presets (1h / 4h / until stopped — §10). */
    private fun renderOffBody(body: LinearLayout, workerId: String, staged: MutableList<LookupUser>, onChanged: () -> Unit) {
        val activity = requireActivity()
        fun dp(v: Int) = (v * resources.displayMetrics.density + 0.5f).toInt()
        var scope = WorkerSharingHelpers.MODE_USERS
        var expiryPreset = WorkerSharingHelpers.EXPIRY_NONE
        val localError = TextView(activity).apply {
            textSize = 12f
            setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorError))
            setPadding(0, dp(8), 0, 0)
            visibility = View.GONE
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

        fun showErr(tv: TextView, msg: String) {
            tv.text = msg
            tv.visibility = if (msg.isEmpty()) View.GONE else View.VISIBLE
        }

        fun radioRow(title: String, desc: String, selected: Boolean, onSelect: () -> Unit): View {
            val row = LinearLayout(activity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(0, dp(6), 0, dp(6))
            }
            val rb = android.widget.RadioButton(activity).apply {
                isChecked = selected
                setOnClickListener { onSelect() }
            }
            row.addView(rb)
            row.addView(TextView(activity).apply {
                textSize = 13f
                setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurface))
                text = "$title\n$desc"
                setLineSpacing(0f, 1.25f)
                setOnClickListener { onSelect() }
            })
            return row
        }

        var startButton: MaterialButton? = null

        fun renderStagedAndStart() {
            startButton?.isEnabled = scope != WorkerSharingHelpers.MODE_USERS || staged.isNotEmpty()
        }

        // Scope radios — rebuilt on selection (staged recipients show only
        // for the users scope).
        val radioContainer = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
        body.addView(radioContainer)

        // Staged recipients list (users scope only).
        val stagedLabel = label(getString(R.string.share_recipients_label))
        val stagedHint = TextView(activity).apply {
            text = getString(R.string.share_recipients_empty)
            textSize = 12f
            setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurfaceVariant))
            setLineSpacing(0f, 1.3f)
        }
        val stagedList = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
        body.addView(stagedLabel)
        body.addView(stagedList)
        body.addView(stagedHint)

        // Add-user input (exact username lookup).
        body.addView(label(getString(R.string.share_add_user_label)))
        val addUserInputContainer = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
        body.addView(addUserInputContainer)
        val usernameInput = android.widget.EditText(activity).apply {
            hint = getString(R.string.share_add_user_placeholder)
            textSize = 13f
            maxLines = 1
            setPadding(dp(12), dp(10), dp(12), dp(10))
        }
        val lookupBtn = MaterialButton(activity, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(40)).apply { topMargin = dp(6) }
            text = getString(R.string.share_lookup_btn)
        }
        addUserInputContainer.addView(usernameInput)
        addUserInputContainer.addView(lookupBtn)
        // Found row: lookup result + Add (two-step — web parity: StagedRecipients).
        val foundRow = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(6), 0, 0)
            visibility = View.GONE
        }
        val foundText = TextView(activity).apply {
            textSize = 12f
            setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurfaceVariant))
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        val addFoundBtn = MaterialButton(activity, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
            text = getString(R.string.share_add_btn)
            textSize = 12f
            minWidth = 0
        }
        foundRow.addView(foundText)
        foundRow.addView(addFoundBtn)
        body.addView(foundRow)
        body.addView(localError)

        fun renderRadios() {
            radioContainer.removeAllViews()
            radioContainer.addView(radioRow(
                getString(R.string.share_mode_public), getString(R.string.share_mode_public_desc),
                scope == WorkerSharingHelpers.MODE_PUBLIC,
            ) {
                scope = WorkerSharingHelpers.MODE_PUBLIC
                renderRadios()
                stagedLabel.visibility = View.GONE
                stagedList.visibility = View.GONE
                stagedHint.visibility = View.GONE
                addUserInputContainer.visibility = View.GONE
                renderStagedAndStart()
            })
            radioContainer.addView(radioRow(
                getString(R.string.share_mode_users), getString(R.string.share_mode_users_desc),
                scope == WorkerSharingHelpers.MODE_USERS,
            ) {
                scope = WorkerSharingHelpers.MODE_USERS
                renderRadios()
                stagedLabel.visibility = View.VISIBLE
                stagedList.visibility = View.VISIBLE
                stagedHint.visibility = if (staged.isEmpty()) View.VISIBLE else View.GONE
                addUserInputContainer.visibility = View.VISIBLE
                renderStagedAndStart()
            })
        }

        fun renderStagedList() {
            stagedList.removeAllViews()
            if (staged.isEmpty()) {
                stagedHint.visibility = View.VISIBLE
            } else {
                stagedHint.visibility = View.GONE
                for (u in staged.toList()) {
                    val uid = u.user_id ?: continue
                    stagedList.addView(LinearLayout(activity).apply {
                        orientation = LinearLayout.HORIZONTAL
                        gravity = Gravity.CENTER_VERTICAL
                        setPadding(0, dp(4), 0, dp(4))
                        addView(TextView(activity).apply {
                            text = u.username + (u.display_name?.let { " \u00B7 $it" } ?: "")
                            textSize = 13f
                            setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurface))
                            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                        })
                        addView(MaterialButton(activity, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                            text = getString(R.string.worker_revoke)
                            textSize = 12f
                            minWidth = 0
                            setOnClickListener {
                                staged.removeAll { it.user_id == uid }
                                renderStagedList()
                                renderStagedAndStart()
                            }
                        })
                    })
                }
            }
            renderStagedAndStart()
        }

        lookupBtn.setOnClickListener {
            val v = WorkerSharingHelpers.normalizeUsername(usernameInput.text.toString())
            if (v is WorkerSharingHelpers.UsernameValidation.Fail) {
                showErr(localError, getString(stringResByName(v.errorKey)))
                return@setOnClickListener
            }
            val username = (v as WorkerSharingHelpers.UsernameValidation.Ok).username
            if (staged.any { it.username == username }) {
                showErr(localError, getString(R.string.share_err_duplicate))
                return@setOnClickListener
            }
            showErr(localError, "")
            foundRow.visibility = View.GONE
            lookupBtn.isEnabled = false
            lifecycleScope.launch {
                try {
                    val user = RetrofitClient.api.lookupUser(username)?.user
                    if (!isAdded) return@launch
                    if (user == null) {
                        showErr(localError, getString(R.string.share_lookup_not_found))
                    } else {
                        foundText.text = getString(R.string.share_lookup_ok,
                            user.display_name?.let { "${user.username} \u00B7 $it" } ?: user.username)
                        foundRow.visibility = View.VISIBLE
                        addFoundBtn.setOnClickListener {
                            if (staged.any { it.username == username }) return@setOnClickListener
                            staged.add(user)
                            usernameInput.setText("")
                            foundRow.visibility = View.GONE
                            renderStagedList()
                        }
                    }
                } catch (e: Throwable) {
                    if (isAdded) showErr(localError, shareErrorText(e))
                } finally {
                    if (isAdded) lookupBtn.isEnabled = true
                }
            }
        }

        // Expiry presets (1h / 4h / until stopped — §10 presets).
        body.addView(label(getString(R.string.share_expires_label)))
        val presetRow = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
        }
        val presetButtons = mutableListOf<MaterialButton>()
        for (p in listOf(WorkerSharingHelpers.EXPIRY_NONE, WorkerSharingHelpers.EXPIRY_1H, WorkerSharingHelpers.EXPIRY_4H)) {
            presetRow.addView(MaterialButton(activity, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                layoutParams = LinearLayout.LayoutParams(0, dp(38), 1f).apply { marginEnd = dp(6) }
                text = getString(when (p) {
                    WorkerSharingHelpers.EXPIRY_1H -> R.string.share_expires_1h
                    WorkerSharingHelpers.EXPIRY_4H -> R.string.share_expires_4h
                    else -> R.string.share_expires_none
                })
                textSize = 12f
                minWidth = 0
                isChecked = p == expiryPreset
                presetButtons.add(this)
                setOnClickListener {
                    expiryPreset = p
                    for (pb in presetButtons) pb.isChecked = pb == this
                }
            })
        }
        body.addView(presetRow)
        body.addView(hint(getString(R.string.share_expires_none)).apply { setPadding(0, dp(6), 0, 0) })

        // Start sharing.
        val startBtn = MaterialButton(activity).apply {
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(44)).apply { topMargin = dp(16) }
            text = getString(R.string.share_btn)
        }
        body.addView(startBtn)
        startButton = startBtn

        startBtn.setOnClickListener {
            if (busy) return@setOnClickListener
            if (scope == WorkerSharingHelpers.MODE_USERS && staged.isEmpty()) {
                showErr(localError, getString(R.string.share_err_invalid_users))
                return@setOnClickListener
            }
            busy = true
            startBtn.text = getString(R.string.play_loading)
            startBtn.isEnabled = false
            lifecycleScope.launch {
                try {
                    val expiresAt = WorkerSharingHelpers.expiryEpochForPreset(expiryPreset, System.currentTimeMillis())
                    RetrofitClient.api.startShare(workerId, StartShareRequest(
                        scope = scope,
                        users = if (scope == WorkerSharingHelpers.MODE_USERS) staged.mapNotNull { it.username } else null,
                        expires_at = expiresAt,
                    ))
                    if (!isAdded) return@launch
                    Toast.makeText(requireContext(),
                        getString(if (scope == WorkerSharingHelpers.MODE_PUBLIC) R.string.share_started_public else R.string.share_started_users),
                        Toast.LENGTH_SHORT).show()
                    onChanged()
                } catch (e: Throwable) {
                    if (isAdded) showErr(localError, shareErrorText(e))
                } finally {
                    if (isAdded) {
                        busy = false
                        startBtn.text = getString(R.string.share_btn)
                        startBtn.isEnabled = true
                        renderStagedAndStart()
                    }
                }
            }
        }

        renderStagedList()
        renderRadios()
    }

    /** Stop-sharing confirmation (web parity: share_stop_confirm) — the
     *  standard destructive dialog pattern (same as onDelete). */
    private fun confirmStopSharing(onResult: (Boolean) -> Unit) {
        if (!isAdded) return
        val ctx = requireContext()
        val notice = LayoutInflater.from(ctx).inflate(R.layout.dialog_delete_vbook, null)
        notice.findViewById<TextView>(R.id.dialogMessage).text = getString(R.string.share_stop_confirm)
        AppDialogs.action(
            ctx = ctx,
            title = getString(R.string.share_stop_btn),
            content = notice,
            cancelText = getString(R.string.dialog_cancel),
            actionText = getString(android.R.string.ok),
            destructive = true,
        ) { dlg ->
            dlg.dismiss()
            onResult(true)
        }.setOnCancelListener { onResult(false) }
    }

    /** Public view: notice + expiry + stop. */
    private fun renderPublicBody(body: LinearLayout, workerId: String, policy: SharePolicy?, onChanged: () -> Unit) {
        val activity = requireActivity()
        fun dp(v: Int) = (v * resources.displayMetrics.density + 0.5f).toInt()
        val localError = TextView(activity).apply {
            textSize = 12f
            setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorError))
            setPadding(0, dp(8), 0, 0)
            visibility = View.GONE
        }
        body.addView(TextView(activity).apply {
            text = getString(R.string.share_mode_public_desc)
            textSize = 12f
            setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurfaceVariant))
            background = androidx.core.content.ContextCompat.getDrawable(activity, R.drawable.bg_dialog_notice)
            setPadding(dp(12), dp(10), dp(12), dp(10))
            setLineSpacing(0f, 1.3f)
        })
        val now = System.currentTimeMillis()
        if (policy?.expires_at != null && !WorkerSharingHelpers.isPolicyExpired(policy, now)) {
            body.addView(TextView(activity).apply {
                text = getString(R.string.share_expires_until,
                    WorkerSharingHelpers.formatExpiry(policy.expires_at, now))
                textSize = 12f
                setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurfaceVariant))
                setPadding(0, dp(8), 0, 0)
            })
        }
        body.addView(localError)
        val stopBtn = MaterialButton(activity, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(44)).apply { topMargin = dp(16) }
            text = getString(R.string.share_stop_btn)
        }
        body.addView(stopBtn)
        stopBtn.setOnClickListener {
            if (busy) return@setOnClickListener
            confirmStopSharing { doStop ->
                if (!doStop) return@confirmStopSharing
                busy = true
                stopBtn.text = getString(R.string.play_loading)
                stopBtn.isEnabled = false
                lifecycleScope.launch {
                    try {
                        RetrofitClient.api.stopShare(workerId)
                        if (!isAdded) return@launch
                        Toast.makeText(requireContext(), R.string.share_stopped, Toast.LENGTH_SHORT).show()
                        onChanged()
                    } catch (e: Throwable) {
                        if (isAdded) {
                            localError.text = shareErrorText(e)
                            localError.visibility = View.VISIBLE
                        }
                    } finally {
                        if (isAdded) {
                            busy = false
                            stopBtn.text = getString(R.string.share_stop_btn)
                            stopBtn.isEnabled = true
                        }
                    }
                }
            }
        }
    }

    /** Users view: recipients of the ACTIVE policy + add/remove + stop. */
    private fun renderUsersBody(body: LinearLayout, workerId: String, grants: List<ShareGrant>, onChanged: () -> Unit) {
        val activity = requireActivity()
        fun dp(v: Int) = (v * resources.displayMetrics.density + 0.5f).toInt()
        val localError = TextView(activity).apply {
            textSize = 12f
            setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorError))
            setPadding(0, dp(8), 0, 0)
            visibility = View.GONE
        }
        fun showErr(msg: String) {
            localError.text = msg
            localError.visibility = if (msg.isEmpty()) View.GONE else View.VISIBLE
        }
        fun label(text: String) = TextView(activity).apply {
            this.text = text
            textSize = 13f
            setTypeface(Typeface.DEFAULT_BOLD)
            setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurface))
            setPadding(0, dp(12), 0, dp(4))
        }

        // Recipients of the active policy.
        body.addView(label(getString(R.string.share_recipients_label)))
        if (grants.isEmpty()) {
            body.addView(TextView(activity).apply {
                text = getString(R.string.share_recipients_empty)
                textSize = 12f
                setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurfaceVariant))
            })
        } else {
            for (g in grants) {
                val uname = g.username ?: continue
                body.addView(LinearLayout(activity).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding(0, dp(4), 0, dp(4))
                    addView(TextView(activity).apply {
                        text = uname + (g.display_name?.let { " \u00B7 $it" } ?: "")
                        textSize = 13f
                        setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurface))
                        layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                    })
                    addView(MaterialButton(activity, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                        text = getString(R.string.worker_revoke)
                        textSize = 12f
                        minWidth = 0
                        setOnClickListener {
                            if (busy) return@setOnClickListener
                            busy = true
                            lifecycleScope.launch {
                                try {
                                    RetrofitClient.api.removeShareUser(workerId, RemoveShareUserRequest(username = uname))
                                    if (!isAdded) return@launch
                                    Toast.makeText(requireContext(), R.string.share_user_removed, Toast.LENGTH_SHORT).show()
                                    onChanged()
                                } catch (e: Throwable) {
                                    if (isAdded) showErr(shareErrorText(e))
                                } finally {
                                    if (isAdded) busy = false
                                }
                            }
                        }
                    })
                })
            }
        }

        // Add a user (exact lookup → POST /share/users).
        body.addView(label(getString(R.string.share_add_user_label)))
        val usernameInput = android.widget.EditText(activity).apply {
            hint = getString(R.string.share_add_user_placeholder)
            textSize = 13f
            maxLines = 1
            setPadding(dp(12), dp(10), dp(12), dp(10))
        }
        val lookupBtn = MaterialButton(activity, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(40)).apply { topMargin = dp(6) }
            text = getString(R.string.share_add_btn)
        }
        body.addView(usernameInput)
        body.addView(lookupBtn)
        body.addView(localError)

        lookupBtn.setOnClickListener {
            if (busy) return@setOnClickListener
            val v = WorkerSharingHelpers.normalizeUsername(usernameInput.text.toString())
            if (v is WorkerSharingHelpers.UsernameValidation.Fail) {
                showErr(getString(stringResByName(v.errorKey)))
                return@setOnClickListener
            }
            val username = (v as WorkerSharingHelpers.UsernameValidation.Ok).username
            if (WorkerSharingHelpers.isDuplicateRecipient(username, grants)) {
                showErr(getString(R.string.share_err_duplicate))
                return@setOnClickListener
            }
            showErr("")
            lookupBtn.isEnabled = false
            lifecycleScope.launch {
                try {
                    // Two-step (web parity): lookup resolves the recipient
                    // server-side, then Add commits the grant.
                    val user = RetrofitClient.api.lookupUser(username)?.user
                    if (!isAdded) return@launch
                    if (user == null) {
                        showErr(getString(R.string.share_lookup_not_found))
                        return@launch
                    }
                    val uname = user.username
                    if (uname.isNullOrEmpty()) return@launch
                    RetrofitClient.api.addShareUsers(workerId, AddShareUsersRequest(users = listOf(uname)))
                    if (!isAdded) return@launch
                    Toast.makeText(requireContext(), R.string.share_user_added, Toast.LENGTH_SHORT).show()
                    usernameInput.setText("")
                    onChanged()
                } catch (e: Throwable) {
                    if (isAdded) showErr(shareErrorText(e))
                } finally {
                    if (isAdded) {
                        lookupBtn.isEnabled = true
                    }
                }
            }
        }

        // Stop sharing — all recipients lose access instantly.
        body.addView(MaterialButton(activity, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(44)).apply { topMargin = dp(16) }
            text = getString(R.string.share_stop_btn)
            setOnClickListener {
                if (busy) return@setOnClickListener
                confirmStopSharing { doStop ->
                    if (!doStop) return@confirmStopSharing
                    busy = true
                    lifecycleScope.launch {
                        try {
                            RetrofitClient.api.stopShare(workerId)
                            if (!isAdded) return@launch
                            Toast.makeText(requireContext(), R.string.share_stopped, Toast.LENGTH_SHORT).show()
                            onChanged()
                        } catch (e: Throwable) {
                            if (isAdded) showErr(shareErrorText(e))
                        } finally {
                            if (isAdded) busy = false
                        }
                    }
                }
            }
        })
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

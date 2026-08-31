package com.example.animastor.ui

import android.content.Context
import android.graphics.BitmapFactory
import android.media.MediaPlayer
import android.os.Bundle
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.view.isVisible
import androidx.fragment.app.Fragment
import androidx.fragment.app.activityViewModels
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.example.animastor.R
import com.example.animastor.databinding.FragmentEditBinding
import com.example.animastor.repository.*
import com.google.android.material.card.MaterialCardView
import com.google.android.material.color.MaterialColors
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.File
import java.util.Locale
import kotlin.random.Random

class EditFragment : Fragment(R.layout.fragment_edit) {

    private var binding: FragmentEditBinding? = null
    private val viewModel: GenerateViewModel by activityViewModels()
    private val playbackViewModel: PlaybackViewModel by activityViewModels {
        PlaybackViewModel.factory
    }

    private var bookData: BookData? = null
    private var chapters: List<Chapter> = emptyList()
    private var currentChIndex = 0
    private var currentScIndex = 0
    private val fieldValues = mutableMapOf<String, String>()
    /** Backend-served frame-prompt limit (image.prompt / video.action) — fetched once. */
    private var imagePromptMaxChars: Int? = null
    private var errorText: TextView? = null
    private var dirtyIndicator: TextView? = null

    private var mediaPlayer: MediaPlayer? = null
    private var audioFile: File? = null
    private var waveformData: WaveformData? = null
    private var timingData: SceneTiming? = null
    private var originalTimings: Map<String, Pair<Long, Long>>? = null
    private var audioDurationMs: Long = 0L
    private var isPlaying = false
    private var playbackJob: Job? = null
    private var timelineDirty = false
    /** Units-tab section header — «Модуль 2/5» left, clock + duration right, live-updated. */
    private var unitHeaderLabel: TextView? = null
    private var unitHeaderDuration: TextView? = null
    /** Collapsible panels (web parity) — carousel + waveform collapse to a thin title strip. */
    private var carouselCollapsed = false
    private var timelineCollapsed = false
    /** Full-size image zoom dialog (web parity) — dismissed on fragment teardown. */
    private var zoomDialog: android.app.Dialog? = null

    // ── Manual entity add/delete (characters / voices / locations tables) ──
    // One schema-driven pattern (EntityKind + EntityDef) so Add/Delete for the
    // entity types — and later Unit/Scene — never fork into near-identical
    // implementations. The id stays free-form: the server transliterates
    // non-canonical input (its own cyrToLatin util), so no client-side copy.
    // BEHAVIOR is the exception on the add path: behavior.json is keyed by an
    // EXISTING character_id, so its add dialog (showAddBehaviorDialog) picks a
    // character instead of a free-form id; delete/reuse flows are shared.
    private enum class EntityKind { CHARACTER, LOCATION, VOICE, BEHAVIOR }

    private class EntityField(val key: String, val labelRes: Int, val multiline: Boolean = false)

    private class EntityDef(
        val kind: EntityKind,
        val addTitleRes: Int,
        val deleteTitleRes: Int,
        val deleteConfirmRes: Int,
        val fields: List<EntityField>
    )

    private fun entityDef(kind: EntityKind): EntityDef = when (kind) {
        EntityKind.CHARACTER -> EntityDef(
            kind,
            R.string.entity_add_character,
            R.string.entity_delete_character,
            R.string.entity_delete_character_confirm,
            listOf(
                EntityField("passport.appearance", R.string.field_appearance, multiline = true),
                EntityField("passport.clothes", R.string.field_clothes, multiline = true),
                EntityField("passport.video_tokens", R.string.field_video_tokens, multiline = true),
            )
        )
        EntityKind.LOCATION -> EntityDef(
            kind,
            R.string.entity_add_location,
            R.string.entity_delete_location,
            R.string.entity_delete_location_confirm,
            listOf(
                EntityField("description", R.string.field_description, multiline = true),
                EntityField("environment.time", R.string.field_time),
                EntityField("environment.season", R.string.field_season),
                EntityField("environment.lighting", R.string.field_lighting),
                EntityField("environment.weather", R.string.field_weather),
                EntityField("environment.mood", R.string.field_mood),
                EntityField("environment.atmosphere", R.string.field_atmosphere),
            )
        )
        EntityKind.VOICE -> EntityDef(
            kind,
            R.string.entity_add_voice,
            R.string.entity_delete_voice,
            R.string.entity_delete_voice_confirm,
            listOf(
                EntityField("instruction", R.string.field_instruction, multiline = true),
            )
        )
        EntityKind.BEHAVIOR -> EntityDef(
            kind,
            R.string.entity_add_behavior,
            R.string.entity_delete_behavior,
            R.string.entity_delete_behavior_confirm,
            listOf(
                EntityField("instruction", R.string.field_instruction, multiline = true),
            )
        )
    }

    /** Editor tab positions that render entity tables (characters/voices/locations/behavior). */
    private val ENTITY_TABS = setOf(5, 6, 7, 8)

    // ======================================================
    // Structure add/delete (chapters / scenes / units)
    // ======================================================
    // Same add/delete pattern as the entity tables, applied to the structure
    // tabs: 0=chapter, 1=scene, 3=unit. The id shown in the dialog is a readonly
    // preview — the server keeps it when unique, otherwise it regenerates.

    private enum class StructureKind { CHAPTER, SCENE, UNIT }

    private class StructureDef(
        val kind: StructureKind,
        val addTitleRes: Int,
        val deleteTitleRes: Int,
        val deleteConfirmRes: Int
    )

    /** Editor tab positions that render structure content (global=0, chapter=1, scene=2, unit=4). */
    private val STRUCTURE_TABS = setOf(1, 2, 4)

    private fun structureDef(kind: StructureKind): StructureDef = when (kind) {
        StructureKind.CHAPTER -> StructureDef(
            kind,
            R.string.structure_add_chapter,
            R.string.structure_delete_chapter,
            R.string.structure_delete_chapter_confirm
        )
        StructureKind.SCENE -> StructureDef(
            kind,
            R.string.structure_add_scene,
            R.string.structure_delete_scene,
            R.string.structure_delete_scene_confirm
        )
        StructureKind.UNIT -> StructureDef(
            kind,
            R.string.structure_add_unit,
            R.string.structure_delete_unit,
            R.string.structure_delete_unit_confirm
        )
    }

    /** Readonly hex-style id preview mirroring the server's idgen format
     *  (server-side cyrToLatin transliteration stays server-only). */
    private fun previewStructureId(kind: StructureKind): String {
        val prefix = when (kind) {
            StructureKind.CHAPTER -> "ch"
            StructureKind.SCENE -> "sc"
            StructureKind.UNIT -> "iu"
        }
        val hex = (0 until 4).joinToString("") { "%02x".format(Random.nextInt(256)) }
        return "$prefix-$hex"
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        binding = FragmentEditBinding.bind(view)
        val b = binding ?: return
        barBinding = b.positionBar

        errorText = b.errorText
        dirtyIndicator = b.dirtyIndicator

        b.propertyTabs.addOnTabSelectedListener(object : com.google.android.material.tabs.TabLayout.OnTabSelectedListener {
            override fun onTabSelected(tab: com.google.android.material.tabs.TabLayout.Tab) {
                rebuildContent(tab.position)
                // Update scroll indicators after tab switch; the scroll position
                // changes asynchronously so we post to the next frame.
                b.propertyTabs.post { updateTabScrollIndicators() }
            }
            override fun onTabUnselected(tab: com.google.android.material.tabs.TabLayout.Tab) {}
            override fun onTabReselected(tab: com.google.android.material.tabs.TabLayout.Tab) {
                b.propertyTabs.post { updateTabScrollIndicators() }
            }
        })

        b.saveButton.setOnClickListener { saveToBackend() }
        b.positionBar.root.setOnClickListener {
            (requireActivity() as? MainActivity)?.switchToNavigateTab()
        }

        // Tab scroll indicators
        b.tabScrollLeft.setOnClickListener { scrollTabs(-1) }
        b.tabScrollRight.setOnClickListener { scrollTabs(1) }

        // Floating "+" — manual add. Structure tabs (chapter/scene/unit) open
        // the structure dialogs; entity tabs (characters/voices/locations) open
        // the entity tables' add form. Only visible on those tabs (rebuildContent).
        b.entityAddButton.setOnClickListener {
            when (b.propertyTabs.selectedTabPosition) {
                1 -> showAddStructureDialog(StructureKind.CHAPTER)
                2 -> showAddStructureDialog(StructureKind.SCENE)
                4 -> showAddStructureDialog(StructureKind.UNIT)
                5 -> showAddEntityDialog(EntityKind.CHARACTER)
                6 -> showAddEntityDialog(EntityKind.VOICE)
                7 -> showAddBehaviorDialog()
                else -> showAddEntityDialog(EntityKind.LOCATION)
            }
        }

        // Reliable scroll position tracking — fires on every scroll pixel change
        b.propertyTabs.viewTreeObserver.addOnScrollChangedListener {
            updateTabScrollIndicators()
        }

        // Sync scroll indicators after the user finishes a touch gesture (fling settles)
        b.propertyTabs.setOnTouchListener { _, event ->
            if (event.action == android.view.MotionEvent.ACTION_UP ||
                event.action == android.view.MotionEvent.ACTION_CANCEL) {
                b.propertyTabs.postDelayed({ updateTabScrollIndicators() }, 80)
            }
            false // don't consume — let TabLayout handle the touch normally
        }

        // Carousel navigation — current card opens the full-size image zoom
        b.currentUnitCard.setOnClickListener { showImageZoom() }
        b.prevUnitCard.setOnClickListener { navigateUnit(-1) }
        b.nextUnitCard.setOnClickListener { navigateUnit(1) }

        // Collapsible panels (web parity)
        b.carouselStrip.setOnClickListener { setCarouselCollapsed(false) }
        b.carouselCollapseButton.setOnClickListener { setCarouselCollapsed(true) }
        b.timelineStrip.setOnClickListener { setTimelineCollapsed(false) }
        b.timelineCollapseButton.setOnClickListener {
            // Collapsing stops playback so audio never plays without the visible waveform
            stopPlayback()
            setTimelineCollapsed(true)
        }

        // Web parity: 6% side insets on the carousel row
        applyCarouselPadding()

        b.timelinePlayButton.setOnClickListener { togglePlayback() }
        b.timelineResetButton.setOnClickListener { resetCurrentUnitTiming() }
        b.timelineWaveform.onRangeChangeListener = { startMs, endMs -> handleRangeChange(startMs, endMs) }
        b.timelineWaveform.onRangeChangeEndListener = { _, _ -> handleRangeChangeEnd() }

        // Default to Units tab (index 4 — Global is now the first tab)
        b.propertyTabs.getTabAt(4)?.select()

        // Center the default-selected tab in the scrollable strip: TabLayout's
        // select() scrolls it into view but pins it to the right edge; wait out
        // that scroll animation, then center the selected tab (web parity — the
        // strip is scrollable and the initially selected tab must be centered).
        b.propertyTabs.postDelayed({ centerSelectedTab() }, 350L)

        // Initial scroll indicator state
        b.propertyTabs.post { updateTabScrollIndicators() }

        observePosition()
        observeViewModel()

        // Backend-served editor limits (frame-prompt char limit). The fetch races
        // with the first loadAndSync — if it lands after the first build, rebuild
        // the current tab so the counter shows up (fieldValues are preserved).
        lifecycleScope.launch {
            val limit = runCatching {
                viewModel.repository.getConfig().limits?.image_prompt_max_chars
            }.getOrNull()
            if (limit != null && limit > 0 && imagePromptMaxChars == null) {
                imagePromptMaxChars = limit
                binding?.let { rebuildContent(it.propertyTabs.selectedTabPosition.coerceAtLeast(0)) }
            }
        }
    }

    private fun observePosition() {
        viewLifecycleOwner.lifecycleScope.launch {
            viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                SharedPositionManager.current.collect { pos ->
                    if (pos.chapterId != null) {
                        loadAndSync(pos)
                    } else if (viewModel.bookId.isNotBlank()) {
                        loadBookAndAutoPosition()
                    } else {
                        clearEditor()
                    }
                }
            }
        }
    }

    private fun observeViewModel() {
        viewLifecycleOwner.lifecycleScope.launch {
            viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                launch {
                    viewModel.dirtySummary.collect { summary: DiffSummary? ->
                        updateDirtyIndicator(summary)
                    }
                }
            }
        }
    }

    private fun updateDirtyIndicator(summary: DiffSummary?) {
        val b = binding ?: return
        if (summary != null && (summary.changed > 0 || summary.added > 0 || summary.removed > 0)) {
            val parts = mutableListOf<String>()
            if (summary.changed > 0) parts.add("${summary.changed} changed")
            if (summary.added > 0) parts.add("${summary.added} added")
            if (summary.removed > 0) parts.add("${summary.removed} removed")
            b.dirtyIndicator.text = "Dirty: ${parts.joinToString(", ")}"
            b.dirtyIndicator.visibility = View.VISIBLE
        } else {
            b.dirtyIndicator.visibility = View.GONE
        }
    }

    private var barBinding: com.example.animastor.databinding.IncludePositionBarBinding? = null

    private fun positionLabel(): TextView? = barBinding?.positionLabel

    private fun unitCount(): TextView? = barBinding?.unitCount

    private fun clearEditor() {
        bookData = null
        chapters = emptyList()
        currentChIndex = 0
        currentScIndex = 0
        fieldValues.clear()
        passportOverrideBlocks.clear()
        passportBlocksSceneKey = null
        val b = binding ?: return
        positionLabel()?.text = getString(R.string.navigate_no_position)
        b.errorText.visibility = View.GONE
        b.emptyState.visibility = View.VISIBLE
        b.contentFrame.removeAllViews()
        b.entityAddButton.visibility = View.GONE
        b.prevUnitCard.visibility = View.INVISIBLE
        b.currentUnitCard.visibility = View.INVISIBLE
        b.nextUnitCard.visibility = View.INVISIBLE
        b.prevUnitImage.setImageBitmap(null)
        b.currentUnitImage.setImageBitmap(null)
        b.nextUnitImage.setImageBitmap(null)
        b.currentIuLabel.text = ""
        unitCount()?.visibility = View.GONE
        b.timelinePanel.visibility = View.GONE
        stopPlayback()
        waveformData = null
        timingData = null
        originalTimings = null
        unitHeaderLabel = null
        unitHeaderDuration = null
        setCarouselCollapsed(false)
        setTimelineCollapsed(false)
    }

    private fun loadBookAndAutoPosition() {
        binding?.emptyState?.visibility = View.GONE
        setSaveLoading(busy = true, isSaving = false)
        lifecycleScope.launch {
            try {
                val bd = viewModel.repository.getBook(viewModel.bookId)
                val chs = bd.chapters ?: emptyList()
                val firstCh = chs.firstOrNull()
                val firstSc = firstCh?.scenes?.firstOrNull()
                setSaveLoading(busy = false)
                if (firstCh != null && firstSc != null) {
                    SharedPositionManager.navigateTo(
                        chapterId = firstCh.chapter_id,
                        sceneId = firstSc.scene_id,
                        unitId = firstSc.units?.firstOrNull()?.id,
                        chunkId = null,
                        unitIndex = 0
                    )
                }
            } catch (_: Exception) {
                setSaveLoading(busy = false)
                saveButtonSetError(getString(R.string.edit_load_failed))
            }
        }
    }

    private fun loadAndSync(pos: ActivePosition) {
        if (viewModel.bookId.isBlank()) {
            bookData = null
            chapters = emptyList()
            positionLabel()?.text = getString(R.string.navigate_no_position)
            binding?.errorText?.visibility = View.GONE
            binding?.emptyState?.visibility = View.VISIBLE
            setSaveLoading(false)
            binding?.contentFrame?.removeAllViews()
            return
        }
        binding?.emptyState?.visibility = View.GONE
        setSaveLoading(busy = true, isSaving = false)
        lifecycleScope.launch {
            try {
                bookData = viewModel.repository.getBook(viewModel.bookId)
                chapters = bookData?.chapters ?: emptyList()
                viewModel.snapshotCurrentBook()
            } catch (_: Exception) {
                setSaveLoading(busy = false)
                saveButtonSetError(getString(R.string.edit_load_failed))
                return@launch
            }

            val nc = chapters.indexOfFirst { it.chapter_id == pos.chapterId }.coerceAtLeast(0)
            val scenes = chapters.getOrNull(nc)?.scenes ?: emptyList()
            val ns = scenes.indexOfFirst { it.scene_id == pos.sceneId }.coerceAtLeast(0)

            if (nc != currentChIndex || ns != currentScIndex) {
                currentChIndex = nc
                currentScIndex = ns
                fieldValues.clear()
            }

            setSaveLoading(busy = false)
            updateCarousel()
            updatePositionLabel()
            rebuildContent(binding?.propertyTabs?.selectedTabPosition ?: 0)
            loadTimelineData()
        }
    }

    private fun updatePositionLabel() {
        if (binding == null) return
        val pos = SharedPositionManager.current.value
        val ch = chapters.getOrNull(currentChIndex)
        val sc = currentScene()
        val totalUnits = sc?.units?.size ?: 0
        val isSpecial = ch?.is_special == true
        val chTitle = ch?.chapter_title?.takeIf { it.isNotBlank() }
        val scTitle = sc?.scene_title?.takeIf { it.isNotBlank() }
        val chLabel = if (isSpecial) {
            chTitle ?: (ch?.type?.replaceFirstChar { it.uppercase() } ?: "—")
        } else if (chTitle != null) {
            chTitle
        } else if (ch?.display_number != null) {
            "${getString(R.string.navigate_chapter)} ${ch.display_number}"
        } else "—"
        val scNum = sc?.display_index ?: (currentScIndex + 1)
        val scLabel = if (sc != null) "${getString(R.string.navigate_scene)} $scNum" else "—"
        val unitLabel = if (totalUnits > 0) "${getString(R.string.navigate_unit)} ${pos.unitIndex + 1}" else pos.formatUnitLabel()
        val fullLabel = if (isSpecial) {
            if (scTitle != null) "$chLabel / $scLabel — $scTitle / $unitLabel"
            else "$chLabel / $scLabel / $unitLabel"
        } else if (chTitle != null && scTitle != null) {
            // chTitle already in chLabel, use chLabel directly
            "$chLabel / $scLabel — $scTitle / $unitLabel"
        } else if (scTitle != null) {
            "$chLabel / $scLabel — $scTitle / $unitLabel"
        } else {
            "$chLabel / $scLabel / $unitLabel"
        }
        positionLabel()?.text = fullLabel
        val uc = unitCount()
        uc?.text = getString(R.string.navigate_units_count, totalUnits)
        uc?.visibility = if (totalUnits > 0) View.VISIBLE else View.GONE
    }

    /** Collapsed panels (web parity): thin title strip, tap to re-expand. */
    private fun setCarouselCollapsed(collapsed: Boolean) {
        carouselCollapsed = collapsed
        val b = binding ?: return
        b.carouselStrip.visibility = if (collapsed) View.VISIBLE else View.GONE
        b.carouselRow.visibility = if (collapsed) View.GONE else View.VISIBLE
        b.carouselCollapseButton.visibility = if (collapsed) View.GONE else View.VISIBLE
    }

    private fun setTimelineCollapsed(collapsed: Boolean) {
        timelineCollapsed = collapsed
        val b = binding ?: return
        b.timelineStrip.visibility = if (collapsed) View.VISIBLE else View.GONE
        b.timelineRow.visibility = if (collapsed) View.GONE else View.VISIBLE
        b.timelineCollapseButton.visibility = if (collapsed) View.GONE else View.VISIBLE
    }

    /** Web parity: carousel row has 6% side insets (like `.edit-carousel { padding: 0 6% }`).
     *  Relative to the row's own width (screen minus the 8dp panel margins), not the screen. */
    private fun applyCarouselPadding() {
        val b = binding ?: return
        val dm = resources.displayMetrics
        val rowDp = dm.widthPixels / dm.density - 16f
        val insetPx = (rowDp * 0.06f * dm.density).toInt()
        b.carouselRow.setPadding(insetPx, 0, insetPx, 0)
    }

    /** Full-size image zoom dialog (web parity) — opens from the current carousel card. */
    private fun showImageZoom() {
        val pos = SharedPositionManager.current.value
        val idx = pos.unitIndex
        val sc = currentScene() ?: return
        val units = sc.units ?: emptyList()
        val current = units.getOrNull(idx) ?: return
        val bookId = viewModel.bookId.takeIf { it.isNotBlank() } ?: return
        val chId = chapters.getOrNull(currentChIndex)?.chapter_id ?: return
        val scId = sc.scene_id ?: return
        val iuId = current.id ?: "iu${String.format("%04d", idx)}"

        val dialog = android.app.Dialog(requireContext())
        dialog.requestWindowFeature(android.view.Window.FEATURE_NO_TITLE)
        dialog.setContentView(R.layout.dialog_edit_zoom)
        val wnd = dialog.window
        wnd?.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(android.graphics.Color.TRANSPARENT))
        // Web parity: no extra dim behind the opaque scrim backdrop
        wnd?.clearFlags(android.view.WindowManager.LayoutParams.FLAG_DIM_BEHIND)
        wnd?.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)

        val img = dialog.findViewById<ImageView>(R.id.zoomImage)
        val fallback = dialog.findViewById<View>(R.id.zoomFallback)
        val label = dialog.findViewById<TextView>(R.id.zoomLabel)
        label.text = "${getString(R.string.navigate_unit)} ${idx + 1}"
        dialog.findViewById<View>(R.id.zoomBackdrop)?.setOnClickListener { dialog.dismiss() }
        dialog.findViewById<View>(R.id.zoomClose)?.setOnClickListener { dialog.dismiss() }
        dialog.findViewById<View>(R.id.zoomImage)?.setOnClickListener { /* consume — no dismiss on image tap */ }
        dialog.setOnDismissListener { if (zoomDialog === dialog) zoomDialog = null }

        zoomDialog = dialog
        dialog.show()
        lifecycleScope.launch {
            val bytes = try {
                viewModel.repository.getIuImage(bookId, chId, scId, iuId, viewModel.buildId)
            } catch (_: Exception) {
                null
            }
            if (bytes == null) {
                fallback.visibility = View.VISIBLE
                img.visibility = View.GONE
                return@launch
            }
            val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            if (bmp != null) {
                img.setImageBitmap(bmp)
                fallback.visibility = View.GONE
                img.visibility = View.VISIBLE
            } else {
                fallback.visibility = View.VISIBLE
                img.visibility = View.GONE
            }
        }
    }

    // ======================================================
    // Manual entity add/delete (characters / voices / locations)
    // ======================================================

    /** Card header row — delete button left, entity id (bold, truncated) right.
     *  The delete sits on the LEFT so the floating "+" (top-right corner of the
     *  table) never covers the first row's delete button. */
    private fun entityCardHead(ctx: Context, id: String, onDelete: () -> Unit): View {
        val row = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER_VERTICAL
            setPadding(0, 0, 0, 2)
        }
        val dm = resources.displayMetrics
        val sz = (28 * dm.density + 0.5f).toInt()
        val pad = (6 * dm.density + 0.5f).toInt()
        val del = ImageButton(ctx).apply {
            contentDescription = getString(R.string.entity_delete)
            setImageResource(R.drawable.ic_remove)
            // Soft destructive accent: error icon on error-container rounded square
            // (square-ish, small corner radius — not an aggressive bright-red control).
            // Thin 1dp error stroke keeps the button readable against the card
            // (web parity: .entity-del-btn border) — without it the light theme
            // blends the pale error-container square into the card.
            val errorColor = MaterialColors.getColor(this, com.google.android.material.R.attr.colorError)
            val errorContainerColor = MaterialColors.getColor(this, com.google.android.material.R.attr.colorErrorContainer)
            imageTintList = android.content.res.ColorStateList.valueOf(errorColor)
            background = android.graphics.drawable.GradientDrawable().apply {
                shape = android.graphics.drawable.GradientDrawable.RECTANGLE
                cornerRadius = (6 * dm.density + 0.5f).toInt().toFloat()
                setColor(errorContainerColor)
                setStroke((1 * dm.density + 0.5f).toInt(), errorColor)
            }
            layoutParams = LinearLayout.LayoutParams(sz, sz)
            setPadding(pad, pad, pad, pad)
            stateListAnimator = null
            setOnClickListener { onDelete() }
        }
        val title = TextView(ctx).apply {
            text = id
            textSize = 14f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurface))
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                marginStart = (8 * dm.density + 0.5f).toInt()
            }
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
        }
        row.addView(del)
        row.addView(title)
        return row
    }

    /** Existing entity ids of the given kind — for the add-dialog uniqueness check. */
    private fun existingEntityIds(kind: EntityKind): Set<String> = when (kind) {
        EntityKind.CHARACTER -> (bookData?.characters ?: emptyList()).mapNotNull { it.id }.toSet()
        EntityKind.LOCATION -> (bookData?.locations ?: emptyMap()).keys.toSet()
        EntityKind.VOICE -> (bookData?.voices ?: emptyMap()).keys.toSet()
        EntityKind.BEHAVIOR -> (bookData?.behaviors ?: emptyMap()).keys.toSet()
    }

    /** Flat form values → the backend create payload (mirror of the web builder). */
    private fun buildCreateBody(kind: EntityKind, values: Map<String, String>): Map<String, Any?> {
        val body = mutableMapOf<String, Any?>()
        values["id"]?.takeIf { it.isNotBlank() }?.let { body["id"] = it }
        values["name"]?.takeIf { it.isNotBlank() }?.let { body["name"] = it }
        when (kind) {
            EntityKind.CHARACTER -> {
                val passport = mutableMapOf<String, String>()
                listOf("appearance", "clothes", "video_tokens").forEach { f ->
                    values["passport.$f"]?.takeIf { it.isNotBlank() }?.let { passport[f] = it }
                }
                if (passport.isNotEmpty()) body["passport"] = passport
            }
            EntityKind.LOCATION -> {
                values["description"]?.takeIf { it.isNotBlank() }?.let { body["description"] = it }
                val env = mutableMapOf<String, String>()
                listOf("time", "season", "lighting", "weather", "mood", "atmosphere").forEach { f ->
                    values["environment.$f"]?.takeIf { it.isNotBlank() }?.let { env[f] = it }
                }
                if (env.isNotEmpty()) body["environment"] = env
            }
            EntityKind.VOICE -> {
                values["instruction"]?.takeIf { it.isNotBlank() }?.let { body["instruction"] = it }
            }
            EntityKind.BEHAVIOR -> {
                // Not reached via showAddEntityDialog (behavior add uses
                // showAddBehaviorDialog); kept for schema completeness.
                values["instruction"]?.takeIf { it.isNotBlank() }?.let { body["instruction"] = it }
            }
        }
        return body
    }

    /** Add dialog — schema-driven form (id + name + entity fields). Validation of
     *  the required name and id uniqueness happens before the API call; the id
     *  is left free-form so the server transliterates it. */
    private fun showAddEntityDialog(kind: EntityKind) {
        val ctx = requireContext()
        val def = entityDef(kind)
        val bookId = viewModel.bookId.takeIf { it.isNotBlank() } ?: return
        val existingIds = existingEntityIds(kind)

        val container = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            // No own padding — AppDialogs' scroll container provides the body
            // insets (12 top / 20 sides) like the web .modal__body.
        }
        val inputs = mutableMapOf<String, TextInputEditText>()
        val errorText = TextView(ctx).apply {
            textSize = 12f
            setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorError))
            visibility = View.GONE
            setPadding(0, 8, 0, 0)
        }

        fun addField(label: String, key: String, multiline: Boolean, hint: String? = null) {
            val til = TextInputLayout(ctx).apply {
                this.hint = label
                isHintEnabled = true
                boxBackgroundMode = TextInputLayout.BOX_BACKGROUND_OUTLINE
                if (hint != null) helperText = hint
            }
            val et = TextInputEditText(ctx).apply {
                textSize = 14f
                if (multiline) {
                    minLines = 3
                    gravity = android.view.Gravity.TOP or android.view.Gravity.START
                }
                setPadding(12, 10, 12, 10)
            }
            til.addView(et)
            inputs[key] = et
            container.addView(til)
        }

        addField(getString(R.string.entity_id), "id", false, getString(R.string.entity_id_hint))
        addField("${getString(R.string.field_name)} *", "name", false)
        def.fields.forEach { f -> addField(getString(f.labelRes), f.key, f.multiline) }
        container.addView(errorText)

        AppDialogs.action(
            ctx = ctx,
            title = getString(def.addTitleRes),
            content = container,
            cancelText = getString(R.string.dialog_cancel),
            actionText = getString(R.string.edit_save),
        ) { dlg ->
            val values = inputs.mapValues { (_, et) -> et.text?.toString()?.trim() ?: "" }
            val name = values["name"] ?: ""
            if (name.isBlank()) {
                errorText.text = getString(R.string.entity_name_required)
                errorText.visibility = View.VISIBLE
                return@action
            }
            val id = values["id"] ?: ""
            if (id.isNotBlank() && id in existingIds) {
                errorText.text = getString(R.string.entity_id_exists)
                errorText.visibility = View.VISIBLE
                return@action
            }
            errorText.visibility = View.GONE
            dlg.dismiss()
            createEntity(kind, values, bookId)
        }.show()
    }

    private fun createEntity(kind: EntityKind, values: Map<String, String>, bookId: String) {
        lifecycleScope.launch {
            try {
                val body = buildCreateBody(kind, values)
                when (kind) {
                    EntityKind.CHARACTER -> viewModel.repository.createCharacter(bookId, body)
                    EntityKind.LOCATION -> viewModel.repository.createLocation(bookId, body)
                    EntityKind.VOICE -> viewModel.repository.createVoice(bookId, body)
                    // Not reached via showAddEntityDialog — behavior add goes
                    // through showAddBehaviorDialog/createBehavior below.
                    EntityKind.BEHAVIOR -> viewModel.repository.createBehavior(bookId, body)
                }
                reloadEntityTable()
            } catch (e: Exception) {
                Log.e("EditFragment", "entity create failed", e)
                showSaveError("${e::class.simpleName}: ${e.message ?: "unknown"}")
            }
        }
    }

    /** Behavior add dialog — a behavior belongs to an EXISTING character
     *  (behavior.json is keyed by character_id), so the dialog offers a
     *  character spinner (characters without a behavior yet) + instruction
     *  field instead of the generic free-form id + name form. Same visual
     *  pattern (TextInputLayout, AppDialogs) as the entity add dialog. */
    private fun showAddBehaviorDialog() {
        val ctx = requireContext()
        val bookId = viewModel.bookId.takeIf { it.isNotBlank() } ?: return
        val behaviors = bookData?.behaviors ?: emptyMap()
        val options = (bookData?.characters ?: emptyList())
            .filter { !it.id.isNullOrBlank() && it.id !in behaviors }
            .map { ch ->
                val id = ch.id ?: ""
                val label = if (ch.name.isNullOrBlank()) id else "${ch.name} ($id)"
                id to label
            }
        if (options.isEmpty()) {
            showSaveError(getString(R.string.behavior_no_characters_available))
            return
        }

        val container = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
        }
        val errorText = TextView(ctx).apply {
            textSize = 12f
            setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorError))
            visibility = View.GONE
            setPadding(0, 8, 0, 0)
        }

        // Character spinner (required — the server rejects unknown ids with 404).
        val tilChar = TextInputLayout(ctx).apply {
            hint = getString(R.string.behavior_character)
            isHintEnabled = true
            boxBackgroundMode = TextInputLayout.BOX_BACKGROUND_OUTLINE
            helperText = getString(R.string.behavior_character_hint)
        }
        val sp = android.widget.Spinner(ctx)
        val adapter = android.widget.ArrayAdapter(ctx, android.R.layout.simple_spinner_item, options.map { it.second })
        adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        sp.adapter = adapter
        var selectedCharId = options.first().first
        sp.onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: android.widget.AdapterView<*>?, view: View?, position: Int, id: Long) {
                selectedCharId = options.getOrNull(position)?.first ?: ""
            }
            override fun onNothingSelected(parent: android.widget.AdapterView<*>?) {
                selectedCharId = ""
            }
        }
        tilChar.addView(sp)
        container.addView(tilChar)

        // Instruction (single free-text Behavior field, pass 1).
        val tilInstruction = TextInputLayout(ctx).apply {
            hint = getString(R.string.field_instruction)
            isHintEnabled = true
            boxBackgroundMode = TextInputLayout.BOX_BACKGROUND_OUTLINE
        }
        val etInstruction = TextInputEditText(ctx).apply {
            textSize = 14f
            minLines = 3
            gravity = android.view.Gravity.TOP or android.view.Gravity.START
            setPadding(12, 10, 12, 10)
        }
        tilInstruction.addView(etInstruction)
        container.addView(tilInstruction)
        container.addView(errorText)

        AppDialogs.action(
            ctx = ctx,
            title = getString(R.string.entity_add_behavior),
            content = container,
            cancelText = getString(R.string.dialog_cancel),
            actionText = getString(R.string.edit_save),
        ) { dlg ->
            val instruction = etInstruction.text?.toString()?.trim() ?: ""
            if (selectedCharId.isBlank()) {
                errorText.text = getString(R.string.behavior_character_required)
                errorText.visibility = View.VISIBLE
                return@action
            }
            errorText.visibility = View.GONE
            dlg.dismiss()
            lifecycleScope.launch {
                try {
                    val body = mutableMapOf<String, Any?>("character_id" to selectedCharId)
                    if (instruction.isNotBlank()) body["instruction"] = instruction
                    viewModel.repository.createBehavior(bookId, body)
                    reloadEntityTable()
                } catch (e: Exception) {
                    Log.e("EditFragment", "behavior create failed", e)
                    showSaveError("${e::class.simpleName}: ${e.message ?: "unknown"}")
                }
            }
        }.show()
    }

    /** Delete confirmation — destructive action never fires without confirmation. */
    private fun showDeleteConfirmDialog(kind: EntityKind, id: String) {
        val def = entityDef(kind)
        val ctx = requireContext()
        val bookId = viewModel.bookId.takeIf { it.isNotBlank() } ?: return
        val message = TextView(ctx).apply {
            text = getString(def.deleteConfirmRes)
            textSize = 14f
            setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurfaceVariant))
            setLineSpacing(0f, 1.45f)
            // Web-parity notice panel (.modal__notice): surfaceVariant block
            // with a thin dashed outline around the warning text.
            setBackgroundResource(R.drawable.bg_dialog_notice)
            val dm = resources.displayMetrics
            val pad = (12 * dm.density + 0.5f).toInt()
            val padX = (16 * dm.density + 0.5f).toInt()
            setPadding(padX, pad, padX, pad)
        }
        AppDialogs.action(
            ctx = ctx,
            title = getString(def.deleteTitleRes),
            content = message,
            cancelText = getString(R.string.dialog_cancel),
            actionText = getString(R.string.entity_delete_btn),
            destructive = true,
        ) { dlg ->
            dlg.dismiss()
            lifecycleScope.launch {
                try {
                    when (kind) {
                        EntityKind.CHARACTER -> viewModel.repository.deleteCharacter(bookId, id)
                        EntityKind.LOCATION -> viewModel.repository.deleteLocation(bookId, id)
                        EntityKind.VOICE -> viewModel.repository.deleteVoice(bookId, id)
                        EntityKind.BEHAVIOR -> viewModel.repository.deleteBehavior(bookId, id)
                    }
                    reloadEntityTable()
                } catch (e: Exception) {
                    Log.e("EditFragment", "entity delete failed", e)
                    showSaveError("${e::class.simpleName}: ${e.message ?: "unknown"}")
                }
            }
        }.show()
    }

    /** Re-fetch the canonical book and rebuild the current tab — the table
     *  updates immediately, no manual page reload. */
    private fun reloadEntityTable() {
        val bookId = viewModel.bookId.takeIf { it.isNotBlank() } ?: return
        lifecycleScope.launch {
            bookData = runCatching { viewModel.repository.getBook(bookId) }.getOrNull()
            chapters = bookData?.chapters ?: emptyList()
            rebuildContent(binding?.propertyTabs?.selectedTabPosition ?: 0)
        }
    }

    // ======================================================
    // Structure add/delete (chapters / scenes / units)
    // ======================================================

    /** Chapter picker option for the scene-add dialog (Глава N — «Title»). */
    private data class StructureParentOption(val id: String, val label: String)

    private fun chapterOptions(): List<StructureParentOption> =
        chapters.mapIndexed { i, ch ->
            StructureParentOption(
                id = ch.chapter_id ?: "",
                label = if (ch.is_special) {
                    ch.chapter_title ?: (ch.chapter_id ?: "")
                } else {
                    val n = ch.display_number ?: (i + 1)
                    val t = ch.chapter_title?.takeIf { it.isNotBlank() } ?: (ch.chapter_id ?: "")
                    getString(R.string.structure_chapter_option, n, t)
                }
            )
        }

    private fun sceneOptions(): List<StructureParentOption> =
        chapters.flatMap { ch ->
            (ch.scenes ?: emptyList()).map { sc ->
                StructureParentOption(
                    id = sc.scene_id ?: "",
                    label = sc.scene_title?.takeIf { it.isNotBlank() } ?: (sc.scene_id ?: "")
                )
            }
        }

    private fun chapterIdForScene(sceneId: String): String? =
        chapters.firstOrNull { ch ->
            (ch.scenes ?: emptyList()).any { it.scene_id == sceneId }
        }?.chapter_id

    private fun showAddStructureDialog(kind: StructureKind) {
        val ctx = requireContext()
        val def = structureDef(kind)
        val bookId = viewModel.bookId.takeIf { it.isNotBlank() } ?: return
        val previewId = previewStructureId(kind)

        val container = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        val errorText = TextView(ctx).apply {
            textSize = 12f
            setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorError))
            visibility = View.GONE
            setPadding(0, 8, 0, 0)
        }

        val inputEt = mutableMapOf<String, TextInputEditText>()
        var selectedChapterId: String? = null
        var selectedSceneId: String? = null

        fun addField(label: String, key: String, multiline: Boolean = false) {
            val til = TextInputLayout(ctx).apply {
                this.hint = label
                isHintEnabled = true
                boxBackgroundMode = TextInputLayout.BOX_BACKGROUND_OUTLINE
            }
            val et = TextInputEditText(ctx).apply {
                textSize = 14f
                if (multiline) {
                    minLines = 3
                    gravity = android.view.Gravity.TOP or android.view.Gravity.START
                }
                setPadding(12, 10, 12, 10)
            }
            til.addView(et)
            inputEt[key] = et
            container.addView(til)
        }

        // Id — readonly preview (the server is the id authority).
        val idEt = TextInputEditText(ctx).apply {
            setText(previewId)
            isEnabled = false
            textSize = 14f
            setPadding(12, 10, 12, 10)
        }
        val tilId = TextInputLayout(ctx).apply {
            hint = getString(R.string.entity_id)
            isHintEnabled = true
            boxBackgroundMode = TextInputLayout.BOX_BACKGROUND_OUTLINE
            helperText = getString(R.string.structure_id_hint)
        }
        tilId.addView(idEt)
        container.addView(tilId)

        fun addSpinner(label: String, options: List<StructureParentOption>, initial: String?, onSelected: (String?) -> Unit) {
            if (options.isEmpty()) return
            val til = TextInputLayout(ctx).apply {
                hint = label
                isHintEnabled = true
                boxBackgroundMode = TextInputLayout.BOX_BACKGROUND_OUTLINE
            }
            val sp = android.widget.Spinner(ctx)
            val items = options.map { it.label }
            val adapter = android.widget.ArrayAdapter(ctx, android.R.layout.simple_spinner_item, items)
            adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
            sp.adapter = adapter
            val initIdx = options.indexOfFirst { it.id == initial }.takeIf { it >= 0 } ?: 0
            sp.setSelection(initIdx)
            onSelected(options.getOrNull(initIdx)?.id)
            sp.onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
                override fun onItemSelected(parent: android.widget.AdapterView<*>?, view: View?, position: Int, id: Long) {
                    onSelected(options.getOrNull(position)?.id)
                }
                override fun onNothingSelected(parent: android.widget.AdapterView<*>?) {
                    onSelected(null)
                }
            }
            til.addView(sp)
            container.addView(til)
        }

        when (kind) {
            StructureKind.CHAPTER -> addField(getString(R.string.field_chapter_title), "title")
            StructureKind.SCENE -> {
                val cur = SharedPositionManager.current.value
                addSpinner(getString(R.string.structure_parent_chapter), chapterOptions(), cur.chapterId) { selectedChapterId = it }
                addField(getString(R.string.field_scene_title), "title")
            }
            StructureKind.UNIT -> {
                val cur = SharedPositionManager.current.value
                addSpinner(getString(R.string.structure_parent_scene), sceneOptions(), cur.sceneId) { selectedSceneId = it }
            }
        }
        // Onboarding hint — explains that a child entity is created automatically.
        when (kind) {
            StructureKind.CHAPTER -> {
                val hint = TextView(ctx).apply {
                    text = getString(R.string.chapter_auto_create_hint)
                    textSize = 12f
                    setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurfaceVariant))
                    setPadding(0, 8, 0, 0)
                }
                container.addView(hint)
            }
            StructureKind.SCENE -> {
                val hint = TextView(ctx).apply {
                    text = getString(R.string.scene_auto_create_hint)
                    textSize = 12f
                    setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurfaceVariant))
                    setPadding(0, 8, 0, 0)
                }
                container.addView(hint)
            }
            else -> {}
        }
        container.addView(errorText)

        AppDialogs.action(
            ctx = ctx,
            title = getString(def.addTitleRes),
            content = container,
            cancelText = getString(R.string.dialog_cancel),
            actionText = getString(R.string.edit_save),
        ) { dlg ->
            val title = inputEt["title"]?.text?.toString()?.trim() ?: ""
            when (kind) {
                StructureKind.SCENE -> if (selectedChapterId == null) {
                    errorText.text = getString(R.string.structure_parent_required)
                    errorText.visibility = View.VISIBLE
                    return@action
                }
                StructureKind.UNIT -> if (selectedSceneId == null) {
                    errorText.text = getString(R.string.structure_parent_required)
                    errorText.visibility = View.VISIBLE
                    return@action
                }
                StructureKind.CHAPTER -> {}
            }
            errorText.visibility = View.GONE
            dlg.dismiss()
            createStructure(kind, selectedChapterId, selectedSceneId, title, previewId, bookId)
        }.show()
    }

    private fun createStructure(kind: StructureKind, chapterId: String?, sceneId: String?, title: String, previewId: String, bookId: String) {
        lifecycleScope.launch {
            try {
                val res: StructureCreateResponse = when (kind) {
                    StructureKind.CHAPTER -> {
                        val body = mutableMapOf<String, Any?>("id" to previewId, "title" to title)
                        SharedPositionManager.current.value.chapterId?.let { body["after_chapter_id"] = it }
                        viewModel.repository.createChapter(bookId, body)
                    }
                    StructureKind.SCENE -> {
                        val body = mutableMapOf<String, Any?>("id" to previewId, "title" to title)
                        viewModel.repository.createScene(bookId, chapterId ?: "", body)
                    }
                    StructureKind.UNIT -> {
                        val body = mutableMapOf<String, Any?>("id" to previewId)
                        viewModel.repository.createUnit(bookId, chapterIdForScene(sceneId ?: "") ?: "", sceneId ?: "", body)
                    }
                }
                // Reposition to the created element — the position observer's
                // loadAndSync re-fetches the book and rebuilds the tab.
                when (kind) {
                    StructureKind.CHAPTER -> SharedPositionManager.navigateTo(
                        chapterId = res.chapter_id,
                        sceneId = res.scene_id,
                        unitId = res.unit_id,
                        chunkId = null,
                        unitIndex = 0
                    )
                    StructureKind.SCENE -> SharedPositionManager.navigateTo(
                        chapterId = chapterId,
                        sceneId = res.scene_id,
                        unitId = res.unit_id,
                        chunkId = null,
                        unitIndex = 0
                    )
                    StructureKind.UNIT -> SharedPositionManager.navigateTo(
                        chapterId = chapterIdForScene(sceneId ?: "") ?: SharedPositionManager.current.value.chapterId,
                        sceneId = sceneId,
                        unitId = res.unit_id,
                        chunkId = null,
                        unitIndex = res.unit_index
                    )
                }
            } catch (e: Exception) {
                Log.e("EditFragment", "structure create failed", e)
                showSaveError("${e::class.simpleName}: ${e.message ?: "unknown"}")
            }
        }
    }

    /** Delete confirmation — destructive structure actions never fire without
     *  confirmation (mirror of the web DeleteConfirmDialog). */
    private fun showDeleteStructureConfirm(kind: StructureKind, chapterId: String, sceneId: String?, id: String) {
        val def = structureDef(kind)
        val ctx = requireContext()
        val bookId = viewModel.bookId.takeIf { it.isNotBlank() } ?: return
        val message = TextView(ctx).apply {
            text = getString(def.deleteConfirmRes)
            textSize = 14f
            setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurfaceVariant))
            setLineSpacing(0f, 1.45f)
            setBackgroundResource(R.drawable.bg_dialog_notice)
            val dm = resources.displayMetrics
            val pad = (12 * dm.density + 0.5f).toInt()
            val padX = (16 * dm.density + 0.5f).toInt()
            setPadding(padX, pad, padX, pad)
        }
        AppDialogs.action(
            ctx = ctx,
            title = getString(def.deleteTitleRes),
            content = message,
            cancelText = getString(R.string.dialog_cancel),
            actionText = getString(R.string.entity_delete_btn),
            destructive = true,
        ) { dlg ->
            dlg.dismiss()
            lifecycleScope.launch {
                try {
                    // Collect scene keys of the entity being deleted BEFORE
                    // the API call so we can invalidate the player queue.
                    val deletedSceneKeys = mutableListOf<String>()
                    when (kind) {
                        StructureKind.CHAPTER -> {
                            // All scenes in this chapter
                            val ch = chapters.find { it.chapter_id == id }
                            ch?.scenes?.forEach { sc ->
                                if (sc.scene_id != null) deletedSceneKeys.add("$id:${sc.scene_id}")
                            }
                            viewModel.repository.deleteChapter(bookId, id)
                        }
                        StructureKind.SCENE -> {
                            deletedSceneKeys.add("$chapterId:$id")
                            viewModel.repository.deleteScene(bookId, chapterId, id)
                        }
                        StructureKind.UNIT -> {
                            // Unit delete invalidates parent scene's media cache
                            deletedSceneKeys.add("$chapterId:${sceneId ?: ""}")
                            viewModel.repository.deleteUnit(bookId, chapterId, sceneId ?: "", id)
                        }
                    }
                    // Local Cache Invalidation: remove deleted scenes from the
                    // player queue so they cannot be played from stale state.
                    playbackViewModel.removeDeletedScenesFromQueue(deletedSceneKeys)
                    reloadStructureAndReposition()
                } catch (e: Exception) {
                    Log.e("EditFragment", "structure delete failed", e)
                    showSaveError("${e::class.simpleName}: ${e.message ?: "unknown"}")
                }
            }
        }.show()
    }

    /** After a structure delete: re-fetch, re-anchor the shared position to a
     *  still-existing neighbor (clamp indexes; fall back to the first remaining
     *  chapter's first scene when the current chapter is gone), and rebuild. */
    private fun reloadStructureAndReposition() {
        val bookId = viewModel.bookId.takeIf { it.isNotBlank() } ?: return
        lifecycleScope.launch {
            val fresh = runCatching { viewModel.repository.getBook(bookId) }.getOrNull() ?: return@launch
            bookData = fresh
            chapters = fresh.chapters ?: emptyList()
            val pos = SharedPositionManager.current.value
            val chs = chapters
            if (chs.isNotEmpty()) {
                var chIdx = chs.indexOfFirst { it.chapter_id == pos.chapterId }
                if (chIdx < 0) chIdx = 0
                val ch = chs[chIdx]
                var scIdx = (ch.scenes ?: emptyList()).indexOfFirst { it.scene_id == pos.sceneId }
                if (scIdx < 0) scIdx = 0
                val sc = ch.scenes?.getOrNull(scIdx)
                val units = sc?.units ?: emptyList()
                val unitIndex = pos.unitIndex.coerceIn(0, maxOf(0, units.size - 1))
                SharedPositionManager.navigateTo(
                    chapterId = ch.chapter_id,
                    sceneId = sc?.scene_id,
                    unitId = units.getOrNull(unitIndex)?.id,
                    chunkId = null,
                    unitIndex = unitIndex
                )
            }
            rebuildContent(binding?.propertyTabs?.selectedTabPosition ?: 0)
        }
    }

    private fun updateCarousel() {
        val b = binding ?: return
        val pos = SharedPositionManager.current.value
        val idx = pos.unitIndex

        val sc = currentScene() ?: return
        val units = sc.units ?: emptyList()
        val scenes = chapters.getOrNull(currentChIndex)?.scenes ?: emptyList()

        if (idx > 0 && idx - 1 < units.size) {
            val prev = units[idx - 1]
            b.prevUnitCard.visibility = View.VISIBLE
            loadPreviewImage(b.prevUnitImage, b.prevUnitCard, prev, idx - 1)
        } else if (idx == 0 && currentScIndex > 0) {
            val prevSc = scenes.getOrNull(currentScIndex - 1)
            val prevUnits = prevSc?.units ?: emptyList()
            if (prevUnits.isNotEmpty()) {
                b.prevUnitCard.visibility = View.VISIBLE
                loadPreviewImageForScene(b.prevUnitImage, b.prevUnitCard, currentChIndex, prevSc, prevUnits.last(), prevUnits.size - 1)
            } else {
                b.prevUnitCard.visibility = View.INVISIBLE
                b.prevUnitImage.setImageBitmap(null)
            }
        } else if (idx == 0 && currentScIndex == 0 && currentChIndex > 0) {
            val prevCh = chapters.getOrNull(currentChIndex - 1)
            val prevChScenes = prevCh?.scenes ?: emptyList()
            val prevSc = prevChScenes.lastOrNull()
            val prevUnits = prevSc?.units ?: emptyList()
            if (prevUnits.isNotEmpty()) {
                b.prevUnitCard.visibility = View.VISIBLE
                loadPreviewImageForScene(b.prevUnitImage, b.prevUnitCard, currentChIndex - 1, prevSc, prevUnits.last(), prevUnits.size - 1)
            } else {
                b.prevUnitCard.visibility = View.INVISIBLE
                b.prevUnitImage.setImageBitmap(null)
            }
        } else {
            b.prevUnitCard.visibility = View.INVISIBLE
            b.prevUnitImage.setImageBitmap(null)
        }

        val current = units.getOrNull(idx)
        if (current != null) {
            b.currentUnitCard.visibility = View.VISIBLE
            loadPreviewImage(b.currentUnitImage, b.currentUnitCard, current, idx)
            b.currentIuLabel.text = "${getString(R.string.navigate_unit)} ${idx + 1}"
        } else {
            b.currentUnitImage.setImageBitmap(null)
            b.currentIuLabel.text = ""
        }

        if (idx + 1 < units.size) {
            val next = units[idx + 1]
            b.nextUnitCard.visibility = View.VISIBLE
            loadPreviewImage(b.nextUnitImage, b.nextUnitCard, next, idx + 1)
        } else if (idx >= units.size - 1 && currentScIndex < scenes.size - 1) {
            val nextSc = scenes.getOrNull(currentScIndex + 1)
            val nextUnits = nextSc?.units ?: emptyList()
            if (nextUnits.isNotEmpty()) {
                b.nextUnitCard.visibility = View.VISIBLE
                loadPreviewImageForScene(b.nextUnitImage, b.nextUnitCard, currentChIndex, nextSc, nextUnits.first(), 0)
            } else {
                b.nextUnitCard.visibility = View.INVISIBLE
                b.nextUnitImage.setImageBitmap(null)
            }
        } else if (idx >= units.size - 1 && currentScIndex >= scenes.size - 1 && currentChIndex < chapters.size - 1) {
            val nextCh = chapters.getOrNull(currentChIndex + 1)
            val nextChScenes = nextCh?.scenes ?: emptyList()
            val nextSc = nextChScenes.firstOrNull()
            val nextUnits = nextSc?.units ?: emptyList()
            if (nextUnits.isNotEmpty()) {
                b.nextUnitCard.visibility = View.VISIBLE
                loadPreviewImageForScene(b.nextUnitImage, b.nextUnitCard, currentChIndex + 1, nextSc, nextUnits.first(), 0)
            } else {
                b.nextUnitCard.visibility = View.INVISIBLE
                b.nextUnitImage.setImageBitmap(null)
            }
        } else {
            b.nextUnitCard.visibility = View.INVISIBLE
            b.nextUnitImage.setImageBitmap(null)
        }
    }

    private fun loadPreviewImage(imageView: ImageView, card: MaterialCardView, unit: SceneUnit, index: Int) {
        val bookId = viewModel.bookId.takeIf { it.isNotBlank() } ?: return
        val chId = chapters.getOrNull(currentChIndex)?.chapter_id ?: return
        val scId = currentScene()?.scene_id ?: return
        val iuId = unit.id ?: "iu${String.format("%04d", index)}"
        lifecycleScope.launch {
            val bytes = viewModel.repository.getIuPreview(bookId, chId, scId, iuId, viewModel.buildId)
            if (bytes == null) {
                showPreviewMissing(imageView, card)
                return@launch
            }
            val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            if (bmp != null) {
                imageView.setImageBitmap(bmp)
                // Reset properties that showPreviewMissing may have changed
                imageView.scaleType = ImageView.ScaleType.CENTER_CROP
                imageView.imageTintList = null
                hidePreviewMissing(card)
                val dm = resources.displayMetrics
                val scrDp = dm.widthPixels / dm.density
                // Web parity: 6% side insets, 20dp gaps, weights 1/1.2/1.
                // Row width = screen minus 8dp panel margins on each side.
                val availDp = (scrDp - 16f) * 0.88f - 40f
                val weight = if (card.id == R.id.currentUnitCard) 1.2f else 1.0f
                val cardWDp = availDp * weight / 3.2f
                val hDp = cardWDp * bmp.height / bmp.width
                // Web parity: min-height 140dp floor on every card
                val minHPx = (140 * dm.density + 0.5f).toInt()
                val hPx = maxOf((hDp * dm.density + 0.5f).toInt(), minHPx)
                val lp = card.layoutParams
                lp.height = hPx
                card.layoutParams = lp
            } else {
                showPreviewMissing(imageView, card)
            }
        }
    }

    private fun loadPreviewImageForScene(imageView: ImageView, card: MaterialCardView, chIndex: Int, scene: Scene?, unit: SceneUnit, index: Int) {
        val bookId = viewModel.bookId.takeIf { it.isNotBlank() } ?: return
        val chId = chapters.getOrNull(chIndex)?.chapter_id ?: return
        val scId = scene?.scene_id ?: return
        val iuId = unit.id ?: "iu${String.format("%04d", index)}"
        lifecycleScope.launch {
            val bytes = viewModel.repository.getIuPreview(bookId, chId, scId, iuId, viewModel.buildId)
            if (bytes == null) {
                showPreviewMissing(imageView, card)
                return@launch
            }
            val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            if (bmp != null) {
                imageView.setImageBitmap(bmp)
                // Reset properties that showPreviewMissing may have changed
                imageView.scaleType = ImageView.ScaleType.CENTER_CROP
                imageView.imageTintList = null
                hidePreviewMissing(card)
                val dm = resources.displayMetrics
                val scrDp = dm.widthPixels / dm.density
                // Web parity: 6% side insets, 20dp gaps, weights 1/1.2/1.
                // Row width = screen minus 8dp panel margins on each side.
                val availDp = (scrDp - 16f) * 0.88f - 40f
                val weight = if (card.id == R.id.currentUnitCard) 1.2f else 1.0f
                val cardWDp = availDp * weight / 3.2f
                val hDp = cardWDp * bmp.height / bmp.width
                // Web parity: min-height 140dp floor on every card
                val minHPx = (140 * dm.density + 0.5f).toInt()
                val hPx = maxOf((hDp * dm.density + 0.5f).toInt(), minHPx)
                val lp = card.layoutParams
                lp.height = hPx
                card.layoutParams = lp
            } else {
                showPreviewMissing(imageView, card)
            }
        }
    }

    private fun showPreviewMissing(imageView: ImageView, card: MaterialCardView) {
        imageView.setImageResource(R.drawable.ic_image_off)
        imageView.scaleType = ImageView.ScaleType.CENTER_INSIDE
        imageView.imageTintList = android.content.res.ColorStateList.valueOf(
            MaterialColors.getColor(imageView, com.google.android.material.R.attr.colorOnSurfaceVariant)
        )
        val label = getString(R.string.iu_not_generated)
        val b = binding
        when (card.id) {
            R.id.currentUnitCard -> {
                b?.currentIuLabel?.text = label
                b?.currentIuLabel?.visibility = View.VISIBLE
            }
            R.id.prevUnitCard -> {
                b?.prevIuLabel?.text = label
                b?.prevIuLabel?.visibility = View.VISIBLE
            }
            R.id.nextUnitCard -> {
                b?.nextIuLabel?.text = label
                b?.nextIuLabel?.visibility = View.VISIBLE
            }
        }
        // Don't override card height — keep whatever height the card already has
        // (XML default 140dp for prev/next, match_parent for current, or the
        // aspect-ratio-based height from a previously loaded image).
        // This prevents the card from visually snapping to a different proportion.
    }

    private fun hidePreviewMissing(card: MaterialCardView) {
        val b = binding
        when (card.id) {
            R.id.currentUnitCard -> {
                // currentIuLabel text is managed by updateCarousel —
                // don't clear it, just revert visibility if showPreviewMissing set it.
                // Next updateCarousel will set the correct "Unit X" label.
                b?.currentIuLabel?.visibility = View.VISIBLE
            }
            R.id.prevUnitCard -> {
                b?.prevIuLabel?.visibility = View.GONE
            }
            R.id.nextUnitCard -> {
                b?.nextIuLabel?.visibility = View.GONE
            }
        }
    }

    private fun navigateUnit(delta: Int) {
        val pos = SharedPositionManager.current.value
        val idx = pos.unitIndex

        val sc = currentScene() ?: return
        val units = sc.units ?: emptyList()
        val scenes = chapters.getOrNull(currentChIndex)?.scenes ?: emptyList()

        val atStart = idx == 0
        val atEnd = idx >= units.size - 1

        when {
            delta < 0 && atStart && currentScIndex > 0 -> {
                val prevScIndex = currentScIndex - 1
                val prevSc = scenes.getOrNull(prevScIndex)
                if (prevSc != null) {
                    val prevUnits = prevSc.units ?: emptyList()
                    val prevUnitIndex = (if (prevUnits.isEmpty()) 0 else prevUnits.size - 1).coerceAtLeast(0)
                    currentScIndex = prevScIndex
                    fieldValues.clear()
                    SharedPositionManager.navigateTo(
                        chapterId = chapters.getOrNull(currentChIndex)?.chapter_id,
                        sceneId = prevSc.scene_id,
                        unitId = prevUnits.getOrNull(prevUnitIndex)?.id,
                        chunkId = null,
                        unitIndex = prevUnitIndex
                    )
                    updatePositionLabel()
                    updateCarousel()
                    rebuildContent(binding?.propertyTabs?.selectedTabPosition ?: 0)
                    val chId = chapters.getOrNull(currentChIndex)?.chapter_id
                    if (chId != null && prevSc.scene_id != null) {
                        playbackViewModel.seekToPosition(chId, prevSc.scene_id, prevUnitIndex, prevUnits.getOrNull(prevUnitIndex)?.id)
                    }
                }
            }
            delta < 0 && atStart && currentScIndex == 0 && currentChIndex > 0 -> {
                val prevChIndex = currentChIndex - 1
                val prevCh = chapters.getOrNull(prevChIndex)
                val prevChScenes = prevCh?.scenes ?: emptyList()
                val prevSc = prevChScenes.lastOrNull()
                if (prevSc != null) {
                    val prevUnits = prevSc.units ?: emptyList()
                    val prevUnitIndex = (if (prevUnits.isEmpty()) 0 else prevUnits.size - 1).coerceAtLeast(0)
                    currentChIndex = prevChIndex
                    currentScIndex = prevChScenes.size - 1
                    fieldValues.clear()
                    SharedPositionManager.navigateTo(
                        chapterId = prevCh?.chapter_id,
                        sceneId = prevSc.scene_id,
                        unitId = prevUnits.getOrNull(prevUnitIndex)?.id,
                        chunkId = null,
                        unitIndex = prevUnitIndex
                    )
                    updatePositionLabel()
                    updateCarousel()
                    rebuildContent(binding?.propertyTabs?.selectedTabPosition ?: 0)
                    val chId = prevCh?.chapter_id
                    if (chId != null && prevSc.scene_id != null) {
                        playbackViewModel.seekToPosition(chId, prevSc.scene_id, prevUnitIndex, prevUnits.getOrNull(prevUnitIndex)?.id)
                    }
                }
            }
            delta > 0 && atEnd && currentScIndex < scenes.size - 1 -> {
                val nextScIndex = currentScIndex + 1
                val nextSc = scenes.getOrNull(nextScIndex)
                if (nextSc != null) {
                    val nextUnits = nextSc.units ?: emptyList()
                    currentScIndex = nextScIndex
                    fieldValues.clear()
                    SharedPositionManager.navigateTo(
                        chapterId = chapters.getOrNull(currentChIndex)?.chapter_id,
                        sceneId = nextSc.scene_id,
                        unitId = nextUnits.firstOrNull()?.id,
                        chunkId = null,
                        unitIndex = 0
                    )
                    updatePositionLabel()
                    updateCarousel()
                    rebuildContent(binding?.propertyTabs?.selectedTabPosition ?: 0)
                    val chId = chapters.getOrNull(currentChIndex)?.chapter_id
                    if (chId != null && nextSc.scene_id != null) {
                        playbackViewModel.seekToPosition(chId, nextSc.scene_id, 0, nextUnits.firstOrNull()?.id)
                    }
                }
            }
            delta > 0 && atEnd && currentScIndex >= scenes.size - 1 && currentChIndex < chapters.size - 1 -> {
                val nextChIndex = currentChIndex + 1
                val nextCh = chapters.getOrNull(nextChIndex)
                val nextChScenes = nextCh?.scenes ?: emptyList()
                val nextSc = nextChScenes.firstOrNull()
                if (nextSc != null) {
                    val nextUnits = nextSc.units ?: emptyList()
                    currentChIndex = nextChIndex
                    currentScIndex = 0
                    fieldValues.clear()
                    SharedPositionManager.navigateTo(
                        chapterId = nextCh?.chapter_id,
                        sceneId = nextSc.scene_id,
                        unitId = nextUnits.firstOrNull()?.id,
                        chunkId = null,
                        unitIndex = 0
                    )
                    updatePositionLabel()
                    updateCarousel()
                    rebuildContent(binding?.propertyTabs?.selectedTabPosition ?: 0)
                    val chId = nextCh?.chapter_id
                    if (chId != null && nextSc.scene_id != null) {
                        playbackViewModel.seekToPosition(chId, nextSc.scene_id, 0, nextUnits.firstOrNull()?.id)
                    }
                }
            }
            else -> {
                if (delta < 0) {
                    SharedPositionManager.previousUnit(units)
                } else {
                    SharedPositionManager.nextUnit(units)
                }
                fieldValues.clear()
                updateCarousel()
                updatePositionLabel()
                rebuildContent(binding?.propertyTabs?.selectedTabPosition ?: 0)
                updateTimelineSelection()
                val chId = chapters.getOrNull(currentChIndex)?.chapter_id
                val scId = sc.scene_id
                val newIndex = SharedPositionManager.current.value.unitIndex
                if (chId != null && scId != null) {
                    playbackViewModel.seekToPosition(chId, scId, newIndex, units.getOrNull(newIndex)?.id)
                }
            }
        }
    }

    private fun currentScene(): Scene? {
        return chapters.getOrNull(currentChIndex)?.scenes?.getOrNull(currentScIndex)
    }

    private fun rebuildContent(tab: Int) {
        try {
            val frame = binding?.contentFrame ?: return
            frame.removeAllViews()
            when (tab) {
                0 -> buildGlobalFields(frame)
                1 -> buildChapterFields(frame)
                2 -> buildSceneFields(frame)
                3 -> buildFields(frame, listOf("voice", "full_text"))
                4 -> buildUnitFields(frame)
                5 -> buildCharactersFields(frame)
                6 -> buildVoicesFields(frame)
                7 -> buildBehaviorsFields(frame)
                8 -> buildLocationsFields(frame)
            }
            // Entity tables (characters/voices/locations) and structure tabs
            // (chapters/scenes/units) get the floating "+" overlay button —
            // hidden on every other tab.
            binding?.entityAddButton?.visibility =
                if (tab in ENTITY_TABS || tab in STRUCTURE_TABS) View.VISIBLE else View.GONE
            // Update scroll indicators after rebuilding
            updateTabScrollIndicators()
        } catch (e: Exception) {
            Log.e("EditFragment", "rebuildContent error", e)
            val ctx = binding?.contentFrame?.context ?: return
            binding?.contentFrame?.addView(TextView(ctx).apply {
                text = "Error: ${e.message}"
                setPadding(0, 24, 0, 0)
            })
        }
    }

    private fun buildUnitFields(parent: ViewGroup) {
        val sc = currentScene() ?: return
        val units = sc.units ?: emptyList()
        val pos = SharedPositionManager.current.value
        if (units.isEmpty()) return
        val idx = pos.unitIndex.coerceIn(0, units.size - 1)
        val u = units.getOrNull(idx) ?: return
        val ctx = parent.context

        val ll = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, 0, 0, 8)
        }

        // Unit metadata section — balanced header: module counter (2/5) on the
        // left, clock icon + duration (end − start from timings) on the right,
        // live-updated on timing changes (web parity).
        val header = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER_VERTICAL
            // End padding aligns the right-side duration with the VISIBLE chevron
            // icon of the property tabs (web parity — the web aligns by the SVG
            // glyph, not the button box): tabScrollRight is 36dp with a 24dp icon
            // centered (6dp inset each side), and the chevron glyph's rightmost
            // point is at x=16 of its 24dp viewport, i.e. 8dp in from the icon's
            // right edge → the glyph ends 6 + 8 = 14dp in from the tabs panel
            // (which itself is 8dp from the screen edge). contentScroll has an 8dp
            // end margin, so 14dp end padding puts the duration's right edge on
            // the glyph line (22dp from the edge).
            setPadding(0, 16, 14, 4)
        }
        val title = TextView(ctx).apply {
            textSize = 14f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorSecondary))
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        val meta = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                val dm = resources.displayMetrics
                marginStart = (4 * dm.density + 0.5f).toInt()
            }
        }
        // Unit delete — sits at the right of the header, before the clock/duration
        // (web parity: the delete button leads the section label group).
        val delBtn = ImageButton(ctx).apply {
            contentDescription = getString(R.string.structure_delete_unit)
            setImageResource(R.drawable.ic_remove)
            val dm = resources.displayMetrics
            val sz = (24 * dm.density + 0.5f).toInt()
            val pad = (5 * dm.density + 0.5f).toInt()
            layoutParams = LinearLayout.LayoutParams(sz, sz).apply {
                marginEnd = (6 * dm.density + 0.5f).toInt()
            }
            val errorColor = MaterialColors.getColor(this, com.google.android.material.R.attr.colorError)
            val errorContainerColor = MaterialColors.getColor(this, com.google.android.material.R.attr.colorErrorContainer)
            imageTintList = android.content.res.ColorStateList.valueOf(errorColor)
            background = android.graphics.drawable.GradientDrawable().apply {
                shape = android.graphics.drawable.GradientDrawable.RECTANGLE
                cornerRadius = (5 * dm.density + 0.5f).toInt().toFloat()
                setColor(errorContainerColor)
                setStroke((1 * dm.density + 0.5f).toInt(), errorColor)
            }
            setPadding(pad, pad, pad, pad)
            stateListAnimator = null
            setOnClickListener {
                val chId = chapters.getOrNull(currentChIndex)?.chapter_id ?: return@setOnClickListener
                val scId = sc.scene_id ?: return@setOnClickListener
                val iuId = u.id ?: return@setOnClickListener
                showDeleteStructureConfirm(StructureKind.UNIT, chId, scId, iuId)
            }
        }
        val clock = ImageView(ctx).apply {
            setImageResource(R.drawable.ic_clock)
            val dm = resources.displayMetrics
            val sz = (14 * dm.density + 0.5f).toInt()
            layoutParams = LinearLayout.LayoutParams(sz, sz)
            imageTintList = android.content.res.ColorStateList.valueOf(
                MaterialColors.getColor(this, com.google.android.material.R.attr.colorSecondary)
            )
            importantForAccessibility = android.view.View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }
        val dur = TextView(ctx).apply {
            textSize = 14f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorSecondary))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                val dm = resources.displayMetrics
                marginStart = (2 * dm.density + 0.5f).toInt()
            }
        }
        meta.addView(delBtn)
        meta.addView(clock)
        meta.addView(dur)
        header.addView(title)
        header.addView(meta)
        unitHeaderLabel = title
        unitHeaderDuration = dur
        ll.addView(header)
        updateUnitHeaderLabel()
        // id is a read-only system field (kept in JSON style);
        // type is translated (user asked: "type" → "тип"/"type")
        ll.addView(readOnlyCard(ctx, "id", u.id ?: ""))
        ll.addView(readOnlyCard(ctx, getString(R.string.field_type), u.type ?: ""))
        // text is editable
        val textKey = "text"
        val textVal = u.text ?: ""
        if (!fieldValues.containsKey(textKey)) fieldValues[textKey] = textVal
        ll.addView(inputCard(ctx, fieldLabel(textKey), fieldValues[textKey] ?: textVal, textVal.length > 80, storeKey = textKey))

        // Audio section
        ll.addView(sectionLabel(ctx, getString(R.string.edit_section_audio)))
        listOf("audio.speaker", "audio.text").forEach { key ->
            val v = readUnitField(u, key)
            if (!fieldValues.containsKey(key)) fieldValues[key] = v
            ll.addView(inputCard(ctx, fieldLabel(key), fieldValues[key] ?: v, (key == "audio.text" && (fieldValues[key]?.length ?: 0) > 80), storeKey = key))
        }

        // Image section
        ll.addView(sectionLabel(ctx, getString(R.string.edit_section_image)))
        listOf("image.shot", "image.prompt", "image.negative").forEach { key ->
            val v = readUnitField(u, key)
            if (!fieldValues.containsKey(key)) fieldValues[key] = v
            ll.addView(inputCard(ctx, fieldLabel(key), fieldValues[key] ?: v, (key == "image.prompt" && (fieldValues[key]?.length ?: 0) > 80), storeKey = key,
                maxLength = if (key == "image.prompt") imagePromptMaxChars else null))
        }

        // Video section
        ll.addView(sectionLabel(ctx, getString(R.string.edit_section_video)))
        listOf("video.action").forEach { key ->
            val v = readUnitField(u, key)
            if (!fieldValues.containsKey(key)) fieldValues[key] = v
            ll.addView(inputCard(ctx, fieldLabel(key), fieldValues[key] ?: v, (fieldValues[key]?.length ?: 0) > 80, storeKey = key, maxLength = imagePromptMaxChars))
        }

        parent.addView(ll)
    }

    /** Units-tab header text: «Модуль {idx}/{total} • {dur} с» — the duration is
     *  the current unit's timing (end − start) and is recomputed on every timing
     *  change (drag preview, save, reset, reload). */
    private fun updateUnitHeaderLabel() {
        val title = unitHeaderLabel ?: return
        val dur = unitHeaderDuration ?: return
        val sc = currentScene() ?: return
        val units = sc.units ?: emptyList()
        if (units.isEmpty()) return
        val pos = SharedPositionManager.current.value
        val idx = pos.unitIndex.coerceIn(0, units.size - 1)
        val timing = timingData?.units?.getOrNull(idx)
        // Match the waveform labels exactly (they truncate tenths — WaveformView
        // formatMs uses ms % 1000 / 100), so the header duration equals what the
        // user reads as end − start on the waveform. Rounding here caused a 0.1 gap.
        val durTenths = if (timing != null)
            (timing.end_ms / 100 - timing.start_ms / 100).coerceAtLeast(0) else 0L
        val durSec = String.format(Locale.US, "%.1f", durTenths / 10.0)
        title.text = getString(R.string.edit_unit_label, idx + 1, units.size)
        dur.text = getString(R.string.edit_unit_duration, durSec)
    }

    private fun buildCharactersFields(parent: ViewGroup) {
        val ctx = parent.context
        val bd = bookData
        val characters = bd?.characters ?: emptyList()

        val ll = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, 0, 0, 8)
        }

        if (characters.isEmpty()) {
            ll.addView(TextView(ctx).apply {
                text = getString(R.string.edit_no_characters)
                textSize = 13f
                setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurfaceVariant))
                setPadding(0, 8, 0, 8)
            })
        } else {
            characters.forEach { ch ->
                val card = MaterialCardView(ctx).apply {
                    layoutParams = ViewGroup.MarginLayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT
                    ).also { it.setMargins(0, 0, 0, 6) }
                    radius = 12f
                    cardElevation = 1f
                    setContentPadding(12, 8, 12, 8)
                }

                val inner = LinearLayout(ctx).apply {
                    orientation = LinearLayout.VERTICAL
                }

                val charId = ch.id ?: "char_unknown"
                // Header row: entity id (read-only, bold) + delete button (web parity)
                inner.addView(entityCardHead(ctx, charId) {
                    showDeleteConfirmDialog(EntityKind.CHARACTER, charId)
                })
                // Name key is scoped per character (web parity) — the old bare
                // "name" key made every character's name field share one slot.
                inner.addView(inputCard(ctx, getString(R.string.field_name), ch.name ?: "", false, boldValue = true, storeKey = "char.${charId}.name"))

                // Passport fields — always rendered (web parity): a character
                // without a passport can still get one from the editor.
                val passport = ch.passport
                val passportLabel = TextView(ctx).apply {
                    text = getString(R.string.field_passport)
                    textSize = 12f
                    typeface = android.graphics.Typeface.DEFAULT_BOLD
                    setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorSecondary))
                    setPadding(0, 8, 0, 4)
                }
                inner.addView(passportLabel)

                val passportPrefix = "char.${charId}.passport"
                val passportKeys = listOf(
                    "${passportPrefix}.appearance",
                    "${passportPrefix}.clothes",
                    "${passportPrefix}.video_tokens"
                )
                val pf = mapOf(
                    "${passportPrefix}.appearance" to (passport?.appearance ?: ""),
                    "${passportPrefix}.clothes" to (passport?.clothes ?: ""),
                    "${passportPrefix}.video_tokens" to (passport?.videoTokensAsText() ?: "")
                )

                passportKeys.forEach { key ->
                    val v = pf[key] ?: ""
                    if (!fieldValues.containsKey(key)) fieldValues[key] = v
                    inner.addView(inputCard(ctx, passportFieldLabel(key), fieldValues[key] ?: v, (v.length > 80), storeKey = key))
                }

                card.addView(inner)
                ll.addView(card)
            }
        }

        parent.addView(ll)
    }

    // ── Behavior structured fields (schema v2) — line-based editor text ⇆ JSON ──
    // Identical rules on web and Android: quirks — one per line; reactions —
    // one pattern per line "trigger → reaction" ("→" or "->", earliest
    // separator wins; a line without a separator keeps the whole text as
    // trigger with an empty reaction). Untouched text never produces a PATCH.

    private fun behaviorQuirksToText(quirks: List<String>?): String =
        (quirks ?: emptyList()).joinToString("\n")

    private fun behaviorReactionsToText(reactions: List<BehaviorReaction>?): String =
        (reactions ?: emptyList()).joinToString("\n") { r ->
            val trigger = r.trigger?.trim() ?: ""
            val reaction = r.reaction?.trim() ?: ""
            if (reaction.isEmpty()) trigger else "$trigger → $reaction"
        }

    private fun behaviorReactionsFromText(text: String): List<Map<String, String?>> =
        text.split('\n')
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .map { line ->
                val separators = listOfNotNull(
                    line.indexOf("→").takeIf { it >= 0 },
                    line.indexOf("->").takeIf { it >= 0 },
                )
                if (separators.isEmpty()) {
                    mapOf("trigger" to line, "reaction" to null)
                } else {
                    val at = separators.min()
                    val sepLen = if (line[at] == '→') 1 else 2
                    mapOf(
                        "trigger" to line.substring(0, at).trim(),
                        "reaction" to line.substring(at + sepLen).trim().takeIf { it.isNotEmpty() },
                    )
                }
            }

    /** Behaviors tab — one card per behavior keyed by character_id
     *  (behavior.json mirrors voices.json); the header shows the character's
     *  name when known, delete follows the shared entity flow. */
    private fun buildBehaviorsFields(parent: ViewGroup) {
        val ctx = parent.context
        val bd = bookData
        val behaviors = bd?.behaviors ?: emptyMap()
        val characters = bd?.characters ?: emptyList()

        val ll = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, 0, 0, 8)
        }

        if (behaviors.isEmpty()) {
            ll.addView(TextView(ctx).apply {
                text = getString(R.string.edit_no_behaviors)
                textSize = 13f
                setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurfaceVariant))
                setPadding(0, 8, 0, 8)
            })
        } else {
            behaviors.forEach { (charId, entry) ->
                val card = MaterialCardView(ctx).apply {
                    layoutParams = ViewGroup.MarginLayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT
                    ).also { it.setMargins(0, 0, 0, 6) }
                    radius = 12f
                    cardElevation = 1f
                    setContentPadding(12, 8, 12, 8)
                }

                val inner = LinearLayout(ctx).apply {
                    orientation = LinearLayout.VERTICAL
                }

                // Header row: character id (+name) + delete button (web parity)
                val ch = characters.find { it.id == charId }
                val headTitle = if (ch?.name.isNullOrBlank()) charId else "$charId — ${ch?.name}"
                inner.addView(entityCardHead(ctx, headTitle) {
                    showDeleteConfirmDialog(EntityKind.BEHAVIOR, charId)
                })

                // Schema v2: instruction/baseline are plain text; quirks/reactions
                // round-trip through line-based text (behaviorQuirksToText /
                // behaviorReactionsToText — same rules as the web editor).
                listOf(
                    Triple("behavior.$charId.instruction", entry.instruction ?: "", R.string.field_instruction),
                    Triple("behavior.$charId.baseline", entry.baseline ?: "", R.string.field_baseline),
                    Triple("behavior.$charId.quirks", behaviorQuirksToText(entry.quirks), R.string.field_quirks),
                    Triple("behavior.$charId.reactions", behaviorReactionsToText(entry.reactions), R.string.field_reactions),
                ).forEach { (key, v, labelRes) ->
                    val multiline = key.endsWith(".quirks") || key.endsWith(".reactions")
                    if (!fieldValues.containsKey(key)) fieldValues[key] = v
                    inner.addView(inputCard(ctx, getString(labelRes), fieldValues[key] ?: v, multiline || v.length > 80, storeKey = key))
                }

                card.addView(inner)
                ll.addView(card)
            }
        }

        parent.addView(ll)
    }

    private fun buildVoicesFields(parent: ViewGroup) {
        val ctx = parent.context
        val bd = bookData
        val voices = bd?.voices ?: emptyMap()

        val ll = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, 0, 0, 8)
        }

        if (voices.isEmpty()) {
            ll.addView(TextView(ctx).apply {
                text = getString(R.string.edit_no_voices)
                textSize = 13f
                setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurfaceVariant))
                setPadding(0, 8, 0, 8)
            })
        } else {
            voices.forEach { (voiceId, entry) ->
                val card = MaterialCardView(ctx).apply {
                    layoutParams = ViewGroup.MarginLayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT
                    ).also { it.setMargins(0, 0, 0, 6) }
                    radius = 12f
                    cardElevation = 1f
                    setContentPadding(12, 8, 12, 8)
                }

                val inner = LinearLayout(ctx).apply {
                    orientation = LinearLayout.VERTICAL
                }

                // Header row: voice id (bold) + delete button (web parity)
                inner.addView(entityCardHead(ctx, voiceId) {
                    showDeleteConfirmDialog(EntityKind.VOICE, voiceId)
                })

                val instruction = entry.instruction ?: ""
                val voiceKey = "voice.${voiceId}.instruction"
                if (!fieldValues.containsKey(voiceKey)) fieldValues[voiceKey] = instruction
                inner.addView(inputCard(ctx, getString(R.string.field_instruction), fieldValues[voiceKey] ?: instruction, instruction.length > 80, storeKey = voiceKey))

                card.addView(inner)
                ll.addView(card)
            }
        }

        parent.addView(ll)
    }

    private fun buildLocationsFields(parent: ViewGroup) {
        val ctx = parent.context
        val bd = bookData
        // Locations come at the top level from the API (separate locations.json),
        // not from bible.locations. Fallback to bible.locations for legacy data.
        val locations = bd?.locations ?: bd?.bible?.locations ?: emptyMap()

        val ll = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, 0, 0, 8)
        }

        if (locations.isEmpty()) {
            ll.addView(TextView(ctx).apply {
                text = getString(R.string.edit_no_locations)
                textSize = 13f
                setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurfaceVariant))
                setPadding(0, 8, 0, 8)
            })
        } else {
            locations.forEach { (key, loc) ->
                val card = MaterialCardView(ctx).apply {
                    layoutParams = ViewGroup.MarginLayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT
                    ).also { it.setMargins(0, 0, 0, 6) }
                    radius = 12f
                    cardElevation = 1f
                    setContentPadding(12, 8, 12, 8)
                }

                val inner = LinearLayout(ctx).apply {
                    orientation = LinearLayout.VERTICAL
                }

                // Use the map key (== location id) consistently — the backend
                // PATCH indexes locations by the locations.json map key.
                val locId = key
                // Header row: location id (read-only, bold) + delete button (web parity)
                inner.addView(entityCardHead(ctx, locId) {
                    showDeleteConfirmDialog(EntityKind.LOCATION, locId)
                })

                // storeKey prefixes with the location id so per-location fields
                // don't collide in the shared fieldValues map.
                val prefix = "loc.$locId."
                inner.addView(inputCard(ctx, getString(R.string.field_name), loc.name ?: "", false, boldValue = true, storeKey = "${prefix}name"))
                inner.addView(inputCard(ctx, getString(R.string.field_description), loc.description ?: "", (loc.description?.length ?: 0) > 80, storeKey = "${prefix}description"))

                // ── Global environment template ──
                val env = loc.environment
                val envLabel = TextView(ctx).apply {
                    text = getString(R.string.field_environment)
                    textSize = 12f
                    typeface = android.graphics.Typeface.DEFAULT_BOLD
                    setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorSecondary))
                    setPadding(0, 8, 0, 4)
                }
                inner.addView(envLabel)

                val envKeys = listOf(
                    "time" to getString(R.string.field_time),
                    "season" to getString(R.string.field_season),
                    "lighting" to getString(R.string.field_lighting),
                    "weather" to getString(R.string.field_weather),
                    "mood" to getString(R.string.field_mood),
                    "atmosphere" to getString(R.string.field_atmosphere)
                )
                envKeys.forEach { (envKey, envLabelText) ->
                    val v = when (envKey) {
                        "time" -> env?.time ?: ""
                        "season" -> env?.season ?: ""
                        "lighting" -> env?.lighting ?: ""
                        "weather" -> env?.weather ?: ""
                        "mood" -> env?.mood ?: ""
                        "atmosphere" -> env?.atmosphere ?: ""
                        else -> ""
                    }
                    inner.addView(inputCard(ctx, envLabelText, v, v.length > 80, storeKey = "${prefix}environment.$envKey"))
                }

                card.addView(inner)
                ll.addView(card)
            }
        }

        parent.addView(ll)
    }

    private fun buildGlobalFields(parent: ViewGroup) {
        val ctx = parent.context
        val bd = bookData

        val ll = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, 0, 0, 8)
        }

        // ── Section: Manifest (read-only info) ──
        ll.addView(sectionLabel(ctx, getString(R.string.field_book_id)))

        val manifest = bd?.manifest
        if (manifest != null) {
            ll.addView(readOnlyCard(ctx, "book_id", manifest.book_id ?: "—"))
            ll.addView(readOnlyCard(ctx, "vbook_version", manifest.vbook_version ?: "—"))
            ll.addView(readOnlyCard(ctx, "created_at", manifest.created_at ?: "—"))
        } else {
            ll.addView(readOnlyCard(ctx, "book_id", bd?.book?.book_id ?: "—"))
        }

        // ── Section: Book Metadata ──
        ll.addView(sectionLabel(ctx, getString(R.string.edit_tabs_global_book)))

        val bookMeta = bd?.book
        val bookKeys = listOf("title", "author", "language")
        val bookValues = mapOf(
            "title" to (bookMeta?.title ?: ""),
            "author" to (bookMeta?.author ?: ""),
            "language" to (bookMeta?.language ?: "")
        )
        bookKeys.forEach { key ->
            if (!fieldValues.containsKey(key)) fieldValues[key] = bookValues[key] ?: ""
            ll.addView(inputCard(ctx, fieldLabel(key), fieldValues[key] ?: "", false, storeKey = key))
        }

        // ── Section: World (Bible) ──
        ll.addView(sectionLabel(ctx, getString(R.string.edit_tabs_global_world)))

        val bible = bd?.bible
        val worldKeys = listOf("country", "epoch", "render_style", "lighting_default")
        val worldValues = mapOf(
            "country" to (bible?.country ?: ""),
            "epoch" to (bible?.epoch ?: ""),
            "render_style" to (bible?.render_rules?.style ?: ""),
            "lighting_default" to (bible?.render_rules?.lighting_default ?: "")
        )
        worldKeys.forEach { key ->
            if (!fieldValues.containsKey(key)) fieldValues[key] = worldValues[key] ?: ""
            ll.addView(inputCard(ctx, fieldLabel(key), fieldValues[key] ?: "", false, storeKey = key))
        }

        // ── Section: Audio / Narration Voice ──
        ll.addView(sectionLabel(ctx, getString(R.string.edit_section_audio)))

        val narrationVoice = bookMeta?.defaults?.narration_voice ?: ""
        val voiceKey = "narration_voice"
        if (!fieldValues.containsKey(voiceKey)) fieldValues[voiceKey] = narrationVoice
        ll.addView(inputCard(ctx, getString(R.string.field_narrator_instruction), fieldValues[voiceKey] ?: "", false, storeKey = voiceKey))

        parent.addView(ll)
    }

    private fun scrollTabs(direction: Int) {
        val tabLayout = binding?.propertyTabs ?: return
        val selectedTab = tabLayout.selectedTabPosition
        val newPos = (selectedTab + direction).coerceIn(0, tabLayout.tabCount - 1)
        tabLayout.getTabAt(newPos)?.select()
    }

    /** Center the selected tab in the scrollable tab strip. TabLayout's own
     *  scroll-to-selected pins the tab to the viewport edge; this scrolls the
     *  strip so the selected tab sits in the horizontal center. If the strip
     *  isn't laid out yet (tab/viewport width 0), retry on the next frame. */
    private fun centerSelectedTab() {
        val tabLayout = binding?.propertyTabs ?: return
        val tab = tabLayout.getTabAt(tabLayout.selectedTabPosition)?.view ?: return
        if (tab.width <= 0 || tabLayout.width <= 0) {
            tabLayout.post { centerSelectedTab() }
            return
        }
        // tab.left is relative to the scrollable strip, so the scroll position
        // that puts the tab's center at the viewport's center is:
        //   tab.left + tab.width/2 − viewport/2 = tab.left − (viewport − tab.width)/2
        val target = tab.left - (tabLayout.width - tab.width) / 2
        tabLayout.smoothScrollTo(target.coerceAtLeast(0), 0)
        updateTabScrollIndicators()
    }

    private fun updateTabScrollIndicators() {
        val b = binding ?: return
        val tabLayout = b.propertyTabs
        val canScrollLeft = tabLayout.canScrollHorizontally(-1)
        val canScrollRight = tabLayout.canScrollHorizontally(1)
        b.tabScrollLeft.isEnabled = canScrollLeft
        b.tabScrollLeft.alpha = if (canScrollLeft) 1.0f else 0.3f
        b.tabScrollRight.isEnabled = canScrollRight
        b.tabScrollRight.alpha = if (canScrollRight) 1.0f else 0.3f
    }

    /** Chapter tab — a dedicated chapter-level component. Currently shows the
     *  chapter id + title; future chapter-level data (passport overrides, other
     *  chapter parameters) belongs here, NOT in the Scene tab. */
    private fun buildChapterFields(parent: ViewGroup) {
        val ctx = parent.context
        val ch = chapters.getOrNull(currentChIndex)
        val ll = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, 0, 0, 8)
        }

        // ── Section: General chapter parameters ──
        ll.addView(sectionLabel(ctx, getString(R.string.edit_section_chapter_general)))
        // chapter_id is a read-only system field (kept in JSON style)
        ll.addView(readOnlyCard(ctx, "chapter_id", ch?.chapter_id ?: "—"))
        if (ch != null) {
            // Header row with delete (chapter may not be removed while it is
            // the only chapter — the backend guards that).
            ll.addView(entityCardHead(ctx, ch.chapter_id ?: "") {
                val chId = ch.chapter_id ?: return@entityCardHead
                showDeleteStructureConfirm(StructureKind.CHAPTER, chId, null, chId)
            })
            val chTitleKey = "chapter_title"
            if (!fieldValues.containsKey(chTitleKey)) fieldValues[chTitleKey] = ch.chapter_title ?: ""
            ll.addView(inputCard(ctx, fieldLabel(chTitleKey), fieldValues[chTitleKey] ?: "", false, storeKey = chTitleKey))
        }

        parent.addView(ll)
    }

    private fun buildSceneFields(parent: ViewGroup) {
        val ctx = parent.context
        val sc = currentScene() ?: return
        val ll = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, 0, 0, 8)
        }

        // ── Section: General scene parameters ──
        ll.addView(sectionLabel(ctx, getString(R.string.edit_section_scene_general)))
        // Header row with delete (scene may not be removed while it is the only
        // scene of its chapter — the backend guards that).
        val chId = chapters.getOrNull(currentChIndex)?.chapter_id
        val scId = sc.scene_id
        if (chId != null && scId != null) {
            ll.addView(entityCardHead(ctx, scId) {
                showDeleteStructureConfirm(StructureKind.SCENE, chId, null, scId)
            })
        }
        // scene_id is a read-only system field (kept in JSON style)
        ll.addView(readOnlyCard(ctx, "scene_id", sc.scene_id ?: "—"))
        listOf("scene_title", "type", "style").forEach { key ->
            val v = readField(sc, key)
            if (!fieldValues.containsKey(key)) fieldValues[key] = v
            ll.addView(inputCard(ctx, fieldLabel(key), fieldValues[key] ?: v, (fieldValues[key]?.length ?: 0) > 80, storeKey = key))
        }

        // ── Section: Characters (participants + scene character overrides) ──
        ll.addView(sectionLabel(ctx, getString(R.string.edit_section_scene_characters)))
        val participantsKey = "participants"
        val participantsVal = readField(sc, participantsKey)
        if (!fieldValues.containsKey(participantsKey)) fieldValues[participantsKey] = participantsVal
        ll.addView(inputCard(ctx, fieldLabel(participantsKey), fieldValues[participantsKey] ?: participantsVal, false, storeKey = participantsKey))
        buildPassportOverrideSection(ll, sc)

        // ── Section: Location ──
        ll.addView(sectionLabel(ctx, getString(R.string.edit_section_scene_location)))
        listOf("location.id", "env.time", "env.lighting", "env.weather", "env.mood", "env.atmosphere", "env.country", "env.epoch").forEach { key ->
            val v = readField(sc, key)
            if (!fieldValues.containsKey(key)) fieldValues[key] = v
            ll.addView(inputCard(ctx, fieldLabel(key), fieldValues[key] ?: v, (fieldValues[key]?.length ?: 0) > 80, storeKey = key))
        }

        parent.addView(ll)
    }

    // ======================================================
    // Scene Character Overrides
    // ======================================================
    // Per-scene passport overrides — each block binds a character id to a set of
    // passport fields that override the GLOBAL passport for THIS scene only.
    // A block is "used" when a character id AND at least one field are filled —
    // used blocks auto-append a fresh empty block below. The number of used
    // blocks is capped by the scene's participants count.

    private val passportOverrideFields = listOf(
        "appearance", "clothes", "video_tokens"
    )

    private class PassportOverrideBlock(var charId: String = "") {
        val fields = mutableMapOf<String, String>()
        fun isUsed(): Boolean = charId.isNotBlank() && fields.values.any { it.isNotBlank() }
        /** Truly empty — no charId AND no field values (safe to trim away). */
        fun isEmpty(): Boolean = charId.isBlank() && fields.values.all { it.isBlank() }
    }

    private val passportOverrideBlocks = mutableListOf<PassportOverrideBlock>()
    private var passportBlocksSceneKey: String? = null

    /** (Re)build the override blocks from the current scene on scene change. */
    private fun ensurePassportBlocks(sc: Scene) {
        val key = "${currentChIndex}/${currentScIndex}"
        if (passportBlocksSceneKey == key) return
        passportBlocksSceneKey = key
        passportOverrideBlocks.clear()
        (sc.passport ?: emptyMap()).forEach { (charId, p) ->
            val block = PassportOverrideBlock(charId)
            p.appearance?.let { block.fields["appearance"] = it }
            p.clothes?.let { block.fields["clothes"] = it }
            if (p.video_tokens != null) block.fields["video_tokens"] = p.videoTokensAsText()
            passportOverrideBlocks.add(block)
        }
        // Always keep at least one (possibly empty) free block
        if (passportOverrideBlocks.isEmpty()) passportOverrideBlocks.add(PassportOverrideBlock())
    }

    /** Max usable blocks = scene participants count (unlimited when empty). */
    private fun passportOverrideLimit(sc: Scene): Int {
        val raw = fieldValues["participants"]?.takeIf { it.isNotBlank() }
            ?: sc.participants?.joinToString(", ") ?: ""
        if (raw.isBlank()) return Int.MAX_VALUE
        return raw.split(",").map { it.trim() }.count { it.isNotEmpty() }
    }

    private fun buildPassportOverrideSection(parent: ViewGroup, sc: Scene) {
        val ctx = parent.context
        ensurePassportBlocks(sc)

        val limit = passportOverrideLimit(sc)
        if (limit != Int.MAX_VALUE) {
            parent.addView(TextView(ctx).apply {
                text = getString(R.string.overrides_limit_hint, limit)
                textSize = 12f
                setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurfaceVariant))
                setPadding(0, 0, 0, 4)
            })
        }

        val container = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        parent.addView(container)

        passportOverrideBlocks.forEach { block ->
            container.addView(buildPassportBlockCard(ctx, container, sc, block))
        }
        // Ensure one trailing free block after the used ones
        if (passportOverrideBlocks.lastOrNull()?.isUsed() == true) {
            maybeAppendPassportBlock(container, sc)
        }
    }

    private fun buildPassportBlockCard(ctx: Context, container: LinearLayout, sc: Scene, block: PassportOverrideBlock): View {
        val card = MaterialCardView(ctx).apply {
            layoutParams = ViewGroup.MarginLayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).also { it.setMargins(0, 0, 0, 6) }
            radius = 12f
            cardElevation = 1f
            setContentPadding(12, 8, 12, 8)
        }
        val inner = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }

        inner.addView(overrideFieldCard(ctx, getString(R.string.field_character_id), block.charId, false) { v ->
            block.charId = v.trim()
            maybeAppendPassportBlock(container, sc)
            markDirty()
        })

        passportOverrideFields.forEach { field ->
            val v = block.fields[field] ?: ""
            inner.addView(overrideFieldCard(ctx, passportFieldLabel(field), v, v.length > 80) { newVal ->
                block.fields[field] = newVal
                maybeAppendPassportBlock(container, sc)
                markDirty()
            })
        }

        card.addView(inner)
        return card
    }

    /** Input card that writes into a PassportOverrideBlock (no shared storeKey). */
    private fun overrideFieldCard(ctx: Context, label: String, value: String, multiline: Boolean, onChange: (String) -> Unit): View {
        val til = TextInputLayout(ctx).apply {
            hint = label
            isHintEnabled = true
            boxBackgroundMode = TextInputLayout.BOX_BACKGROUND_OUTLINE
        }
        val et = TextInputEditText(ctx).apply {
            setText(value)
            textSize = 14f
            if (multiline) {
                minLines = 3
                gravity = android.view.Gravity.TOP or android.view.Gravity.START
            }
            setPadding(12, 10, 12, 10)
            addTextChangedListener(simpleWatcher { onChange(it) })
        }
        til.addView(et)
        return MaterialCardView(ctx).apply {
            layoutParams = ViewGroup.MarginLayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).also { it.setMargins(0, 0, 0, 8) }
            radius = 12f
            cardElevation = 2f
            addView(til)
        }
    }

    /**
     * Called after every edit in an override block. Keeps the block list tidy per spec:
     *   - trims trailing empty blocks so at most ONE free block remains;
     *   - when the last block becomes used, appends a fresh empty block
     *     (within the participants limit).
     */
    private fun maybeAppendPassportBlock(container: LinearLayout, sc: Scene) {
        // Collapse multiple trailing TRULY-empty blocks into a single free block.
        // Only remove blocks with no charId and no field values — never yank a block
        // the user is currently typing into (e.g. charId filled but fields not yet).
        while (passportOverrideBlocks.size >= 2 &&
            passportOverrideBlocks.last().isEmpty() &&
            passportOverrideBlocks[passportOverrideBlocks.size - 2].isEmpty()) {
            passportOverrideBlocks.removeAt(passportOverrideBlocks.size - 1)
            if (container.childCount > 0) container.removeViewAt(container.childCount - 1)
        }
        val last = passportOverrideBlocks.lastOrNull() ?: return
        if (!last.isUsed()) return
        val usedCount = passportOverrideBlocks.count { it.isUsed() }
        if (usedCount >= passportOverrideLimit(sc)) return
        passportOverrideBlocks.add(PassportOverrideBlock())
        container.addView(buildPassportBlockCard(container.context, container, sc, passportOverrideBlocks.last()))
    }

    /**
     * Build the flat passport.<charId>.<field> keys for the PATCH — diffed against the
     * scene's existing overrides so cleared fields are removed server-side (setDeep '' → null).
     */
    private fun buildPassportOverrideFields(sc: Scene): Map<String, String> {
        val result = mutableMapOf<String, String>()
        val desired = linkedMapOf<String, MutableMap<String, String>>()
        for (block in passportOverrideBlocks) {
            if (!block.isUsed()) continue
            val charId = block.charId.trim()
            if (charId.isEmpty()) continue
            val m = desired.getOrPut(charId) { mutableMapOf() }
            for (f in passportOverrideFields) {
                val v = block.fields[f]?.trim() ?: ""
                if (v.isNotEmpty()) m[f] = v
            }
        }
        val existing = sc.passport ?: emptyMap()
        val allCharIds = desired.keys + existing.keys
        for (charId in allCharIds) {
            val want = desired[charId]
            val have = existing[charId]
            for (f in passportOverrideFields) {
                val newVal = want?.get(f) ?: ""
                val oldVal = passportFieldOf(have, f) ?: ""
                if (newVal != oldVal) {
                    result["passport.$charId.$f"] = newVal
                }
            }
        }
        return result
    }

    private fun passportFieldOf(p: CharPassport?, field: String): String? = when (field) {
        "appearance" -> p?.appearance
        "clothes" -> p?.clothes
        "video_tokens" -> p?.videoTokensAsText()
        else -> null
    }

    private fun sectionLabel(ctx: Context, text: String): View = TextView(ctx).apply {
        this.text = text
        textSize = 14f
        typeface = android.graphics.Typeface.DEFAULT_BOLD
        setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorSecondary))
        setPadding(0, 16, 0, 4)
    }

    private fun buildFields(parent: ViewGroup, keys: List<String>) {
        val ctx = parent.context
        val sc = currentScene() ?: return
        val sceneValues = keys.associateWith { key -> readField(sc, key) }
        val ll = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, 0, 0, 8)
        }
        keys.forEach { key ->
            val v = sceneValues[key] ?: ""
            if (!fieldValues.containsKey(key)) fieldValues[key] = v
            ll.addView(inputCard(ctx, fieldLabel(key), fieldValues[key] ?: v, (fieldValues[key]?.length ?: 0) > 80, storeKey = key))
        }
        parent.addView(ll)
    }

    private fun readField(sc: Scene, key: String): String {
        val env = sc.location?.environment
        return when (key) {
            "scene_id" -> sc.scene_id ?: ""
            "scene_title" -> sc.scene_title ?: ""
            "type" -> sc.type ?: ""
            "style" -> sc.style ?: ""
            "location.id" -> sc.location?.id ?: ""
            "env.time" -> env?.time ?: ""
            "env.lighting" -> env?.lighting ?: ""
            "env.weather" -> env?.weather ?: ""
            "env.mood" -> env?.mood ?: ""
            "env.atmosphere" -> env?.atmosphere ?: ""
            "env.country" -> env?.country ?: ""
            "env.epoch" -> env?.epoch ?: ""
            "participants" -> sc.participants?.joinToString(", ") ?: ""
            "voice" -> sc.audio?.voice ?: ""
            "full_text" -> sc.audio?.full_text ?: ""
            else -> ""
        }
    }

    private fun readUnitField(u: SceneUnit, key: String): String {
        return when (key) {
            "id" -> u.id ?: ""
            "type" -> u.type ?: ""
            "text" -> u.text ?: ""
            "audio.speaker" -> u.audio?.speaker ?: ""
            "audio.text" -> u.audio?.text ?: ""
            "image.shot" -> u.image?.shot ?: ""
            "image.prompt" -> u.image?.prompt ?: ""
            "image.negative" -> u.image?.negative ?: ""
            "video.action" -> u.video?.action ?: ""
            else -> ""
        }
    }

    /**
     * Localized hint label for an editor field key. Technical keys (id, type,
     * *_id, *_version, created_at, location.id, ...) intentionally stay in raw
     * JSON style — only user-facing fields are translated. The key itself is
     * always preserved as the storeKey — labels are display-only.
     */
    private fun fieldLabel(key: String): String = when (key) {
        "type" -> getString(R.string.field_type)
        "text" -> getString(R.string.field_text)
        "audio.speaker" -> getString(R.string.field_speaker)
        "audio.text" -> getString(R.string.field_audio_text)
        "image.shot" -> getString(R.string.field_shot)
        "image.prompt" -> getString(R.string.field_prompt)
        "image.negative" -> getString(R.string.field_negative)
        "video.action" -> getString(R.string.field_action)
        "chapter_title" -> getString(R.string.field_chapter_title)
        "scene_title" -> getString(R.string.field_scene_title)
        "style" -> getString(R.string.field_style)
        "env.time" -> getString(R.string.field_time)
        "env.lighting" -> getString(R.string.field_lighting)
        "env.weather" -> getString(R.string.field_weather)
        "env.mood" -> getString(R.string.field_mood)
        "env.atmosphere" -> getString(R.string.field_atmosphere)
        "env.country" -> getString(R.string.field_country)
        "env.epoch" -> getString(R.string.field_epoch)
        "participants" -> getString(R.string.field_participants)
        "voice" -> getString(R.string.field_voice)
        "full_text" -> getString(R.string.field_full_text)
        "title" -> getString(R.string.field_title)
        "author" -> getString(R.string.field_author)
        "language" -> getString(R.string.field_language)
        "country" -> getString(R.string.field_country)
        "epoch" -> getString(R.string.field_epoch)
        "render_style" -> getString(R.string.field_render_style)
        "lighting_default" -> getString(R.string.field_lighting_default)
        "narration_voice" -> getString(R.string.field_narrator_instruction)
        else -> key
    }

    /**
     * Localized label for a passport field key (e.g.
     * "char.<id>.passport.appearance" → localized Appearance).
     */
    private fun passportFieldLabel(key: String): String = when (key.substringAfterLast('.')) {
        "appearance" -> getString(R.string.field_appearance)
        "clothes" -> getString(R.string.field_clothes)
        "video_tokens" -> getString(R.string.field_video_tokens)
        else -> key
    }

    /**
     * Render a passport field value as editable text (web parity).
     * video_tokens may be a legacy string OR an array of features —
     * videoTokensAsText() joins arrays with ", ".
     */
    private fun passportFieldText(p: CharPassport?, field: String): String {
        if (p == null) return ""
        return when (field) {
            "appearance" -> p.appearance ?: ""
            "clothes" -> p.clothes ?: ""
            "video_tokens" -> p.videoTokensAsText()
            else -> ""
        }
    }

    private fun markDirty() {
        binding?.saveButton?.text = "${getString(R.string.edit_save)} *"
    }

    private fun saveButtonSetError(message: String) {
        binding?.saveButton?.apply {
            text = getString(R.string.edit_save)
            isEnabled = true
            alpha = 1.0f
        }
        binding?.errorText?.apply {
            text = message
            visibility = View.VISIBLE
        }
    }

    private fun readOnlyCard(ctx: Context, label: String, value: String, boldValue: Boolean = false): View {
        val til = TextInputLayout(ctx).apply {
            hint = label
            isHintEnabled = true
            boxBackgroundMode = TextInputLayout.BOX_BACKGROUND_OUTLINE
        }
        val et = TextInputEditText(ctx).apply {
            setText(value)
            textSize = 14f
            if (boldValue) {
                setTypeface(null, android.graphics.Typeface.BOLD)
            }
            setPadding(12, 10, 12, 10)
            setTextIsSelectable(true)
            isLongClickable = true
            showSoftInputOnFocus = false
        }
        til.addView(et)
        return MaterialCardView(ctx).apply {
            layoutParams = ViewGroup.MarginLayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).also { it.setMargins(0, 0, 0, 8) }
            radius = 12f
            cardElevation = 2f
            addView(til)
        }
    }

    private fun inputCard(ctx: Context, label: String, value: String, multiline: Boolean, boldValue: Boolean = false, storeKey: String? = null, maxLength: Int? = null): View {
        val key = storeKey ?: label
        fieldValues[key] = value
        val til = TextInputLayout(ctx).apply {
            hint = label
            isHintEnabled = true
            boxBackgroundMode = TextInputLayout.BOX_BACKGROUND_OUTLINE
            // Backend-served frame-prompt limit (image.prompt / video.action): live
            // character counter + hard length filter — the user sees the limit
            // before pressing Save (the server rejects over-limit saves).
            if (maxLength != null) {
                setCounterEnabled(true)
                setCounterMaxLength(maxLength)
            }
        }
        val et = TextInputEditText(ctx).apply {
            setText(value)
            textSize = 14f
            if (multiline) {
                minLines = 3
                gravity = android.view.Gravity.TOP or android.view.Gravity.START
            }
            if (boldValue) {
                setTypeface(null, android.graphics.Typeface.BOLD)
            }
            if (maxLength != null) {
                filters = arrayOf(android.text.InputFilter.LengthFilter(maxLength))
            }
            setPadding(12, 10, 12, 10)
            addTextChangedListener(simpleWatcher {
                fieldValues[key] = it
                markDirty()
            })
        }
        til.addView(et)
        return MaterialCardView(ctx).apply {
            layoutParams = ViewGroup.MarginLayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).also { it.setMargins(0, 0, 0, 8) }
            radius = 12f
            cardElevation = 2f
            addView(til)
        }
    }

    private fun simpleWatcher(onChange: (String) -> Unit): android.text.TextWatcher {
        return object : android.text.TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: android.text.Editable?) {
                onChange(s?.toString() ?: "")
            }
        }
    }

    private fun saveToBackend() {
        try {
            val bd = bookData
            if (bd == null) {
                showSaveError("No book data")
                return
            }

            val bookId = viewModel.bookId.takeIf { it.isNotBlank() }
            if (bookId == null) {
                showSaveError("No bookId")
                return
            }

            val selectedTab = binding?.propertyTabs?.selectedTabPosition ?: 0

            // Global tab (0) — save book-level metadata via lightweight PATCH
            if (selectedTab == 0) {
                setSaveLoading(true)
                lifecycleScope.launch {
                    try {
                        // Build a map of only the fields that actually changed.
                        // - If value differs and is non-blank → put the value (set)
                        // - If value is blank but original was non-blank → put null (clear)
                        // - If value unchanged → skip (don't touch)
                        val orig = bd
                        val body = mutableMapOf<String, Any?>()
                        fieldValues.forEach { (key, value) ->
                            val originalValue = when (key) {
                                "title" -> orig.book?.title ?: ""
                                "author" -> orig.book?.author ?: ""
                                "language" -> orig.book?.language ?: ""
                                "country" -> orig.bible?.country ?: ""
                                "epoch" -> orig.bible?.epoch ?: ""
                                "render_style" -> orig.bible?.render_rules?.style ?: ""
                                "lighting_default" -> orig.bible?.render_rules?.lighting_default ?: ""
                                "narration_voice" -> orig.book?.defaults?.narration_voice ?: ""
                                else -> null
                            }
                            if (originalValue != null && value != originalValue) {
                                if (value.isNotBlank()) {
                                    body[key] = value
                                } else {
                                    body[key] = null  // explicitly clear the field
                                }
                            }
                        }

                        if (body.isEmpty()) {
                            // Nothing actually changed — skip the save
                            setSaveLoading(false)
                            return@launch
                        }

                        viewModel.repository.patchBookMetadata(bookId, body)

                        // Thin-client: re-fetch canonical book data instead of
                        // reconstructing it locally (server is the source of truth).
                        // A refresh failure must not be reported as a save failure.
                        bookData = runCatching { viewModel.repository.getBook(bookId) }.getOrNull()
                        viewModel.markUnsavedChanges()
                        setSaveLoading(false)
                        errorText?.visibility = View.GONE
                    } catch (e: Exception) {
                        Log.e("EditFragment", "global save failed", e)
                        showSaveError("${e::class.simpleName}: ${e.message ?: "unknown"}")
                    }
                }
                return
            }

            // Locations tab (8) — save per-location fields via dedicated PATCH
            if (selectedTab == 8) {
                setSaveLoading(true)
                lifecycleScope.launch {
                    try {
                        // Group loc.* keys from the shared fieldValues map
                        val byLoc = mutableMapOf<String, MutableMap<String, Any?>>()
                        fieldValues.forEach { (key, value) ->
                            if (key.startsWith("loc.")) {
                                val rest = key.removePrefix("loc.")
                                val dot = rest.indexOf('.')
                                if (dot > 0) {
                                    val locId = rest.substring(0, dot)
                                    val fieldKey = rest.substring(dot + 1)
                                    byLoc.getOrPut(locId) { mutableMapOf() }[fieldKey] = value
                                }
                            }
                        }

                        if (byLoc.isEmpty()) {
                            setSaveLoading(false)
                            return@launch
                        }

                        val existingLocs = (bd.locations ?: emptyMap()).keys + (bd.bible?.locations ?: emptyMap()).keys
                        byLoc.forEach { (locId, fields) ->
                            // Skip entities deleted since the editor rendered
                            // (stale fieldValues must not PATCH a 404).
                            if (locId !in existingLocs) return@forEach
                            viewModel.repository.patchLocation(bookId, locId, fields)
                        }

                        // Thin-client: re-fetch canonical book data instead of
                        // reconstructing it locally (server is the source of truth).
                        // A refresh failure must not be reported as a save failure.
                        bookData = runCatching { viewModel.repository.getBook(bookId) }.getOrNull()
                        viewModel.markUnsavedChanges()
                        setSaveLoading(false)
                        errorText?.visibility = View.GONE
                    } catch (e: Exception) {
                        Log.e("EditFragment", "locations save failed", e)
                        showSaveError("${e::class.simpleName}: ${e.message ?: "unknown"}")
                    }
                }
                return
            }

            // Characters tab (5) — dedicated PATCH per changed character
            // (name + passport), mirroring the web EditPage CHARS_TAB branch.
            // Without this branch Android's generic save below pushed char.*
            // keys into the scene/unit object as junk that never reached
            // characters.json (the generator reads characters.json).
            if (selectedTab == 5) {
                setSaveLoading(true)
                lifecycleScope.launch {
                    try {
                        // Group char.* keys from the shared fieldValues map
                        val byChar = mutableMapOf<String, MutableMap<String, String>>()
                        fieldValues.forEach { (key, value) ->
                            if (key.startsWith("char.")) {
                                val rest = key.removePrefix("char.")
                                val dot = rest.indexOf('.')
                                if (dot > 0) {
                                    val charId = rest.substring(0, dot)
                                    val fieldKey = rest.substring(dot + 1)
                                    byChar.getOrPut(charId) { mutableMapOf() }[fieldKey] = value
                                }
                            }
                        }

                        if (byChar.isEmpty()) {
                            setSaveLoading(false)
                            return@launch
                        }

                        val chars = bd.characters ?: emptyList()
                        var anyChanged = false
                        byChar.forEach { (charId, fields) ->
                            // Diff vs canonical data — skip untouched entities.
                            val orig = chars.find { it.id == charId }
                            // Skip entities deleted since the editor rendered
                            // (stale fieldValues must not PATCH a 404).
                            if (orig == null) return@forEach
                            val changed = mutableMapOf<String, String>()
                            fields.forEach { (k, v) ->
                                val oldVal = when {
                                    k == "name" -> orig.name ?: ""
                                    k.startsWith("passport.") -> passportFieldText(orig.passport, k.removePrefix("passport."))
                                    else -> ""
                                }
                                if (v != oldVal) changed[k] = v
                            }
                            if (changed.isEmpty()) return@forEach
                            anyChanged = true
                            viewModel.repository.patchCharacter(bookId, charId, changed)
                        }

                        if (!anyChanged) {
                            setSaveLoading(false)
                            return@launch
                        }

                        // Thin-client: re-fetch canonical book data instead of
                        // reconstructing it locally (server is the source of truth).
                        bookData = runCatching { viewModel.repository.getBook(bookId) }.getOrNull()
                        chapters = bookData?.chapters ?: emptyList()
                        viewModel.markUnsavedChanges()
                        setSaveLoading(false)
                        errorText?.visibility = View.GONE
                    } catch (e: Exception) {
                        Log.e("EditFragment", "characters save failed", e)
                        showSaveError("${e::class.simpleName}: ${e.message ?: "unknown"}")
                    }
                }
                return
            }

            // Voices tab (6) — dedicated PATCH per changed voice (instruction),
            // mirroring the web EditPage VOICES_TAB branch. Same reasoning as
            // the characters branch: voice.* keys must not leak into scenes.
            if (selectedTab == 6) {
                setSaveLoading(true)
                lifecycleScope.launch {
                    try {
                        val byVoice = mutableMapOf<String, MutableMap<String, String>>()
                        fieldValues.forEach { (key, value) ->
                            if (key.startsWith("voice.")) {
                                val rest = key.removePrefix("voice.")
                                val dot = rest.indexOf('.')
                                if (dot > 0) {
                                    val voiceId = rest.substring(0, dot)
                                    val fieldKey = rest.substring(dot + 1)
                                    byVoice.getOrPut(voiceId) { mutableMapOf() }[fieldKey] = value
                                }
                            }
                        }

                        if (byVoice.isEmpty()) {
                            setSaveLoading(false)
                            return@launch
                        }

                        val voices = bd.voices ?: emptyMap()
                        var anyChanged = false
                        byVoice.forEach { (voiceId, fields) ->
                            // Skip entities deleted since the editor rendered
                            // (stale fieldValues must not PATCH a 404).
                            if (!voices.containsKey(voiceId)) return@forEach
                            val orig = voices[voiceId]?.instruction ?: ""
                            val changed = mutableMapOf<String, String>()
                            fields.forEach { (k, v) -> if (v != orig) changed[k] = v }
                            if (changed.isEmpty()) return@forEach
                            anyChanged = true
                            viewModel.repository.patchVoice(bookId, voiceId, changed)
                        }

                        if (!anyChanged) {
                            setSaveLoading(false)
                            return@launch
                        }

                        bookData = runCatching { viewModel.repository.getBook(bookId) }.getOrNull()
                        chapters = bookData?.chapters ?: emptyList()
                        viewModel.markUnsavedChanges()
                        setSaveLoading(false)
                        errorText?.visibility = View.GONE
                    } catch (e: Exception) {
                        Log.e("EditFragment", "voices save failed", e)
                        showSaveError("${e::class.simpleName}: ${e.message ?: "unknown"}")
                    }
                }
                return
            }

            // Behaviors tab (7) — dedicated PATCH per changed behavior
            // (instruction), mirroring the web EditPage BEHAVIORS_TAB branch.
            // behavior.* keys must not leak into the scene PATCH below.
            if (selectedTab == 7) {
                setSaveLoading(true)
                lifecycleScope.launch {
                    try {
                        val byChar = mutableMapOf<String, MutableMap<String, String>>()
                        fieldValues.forEach { (key, value) ->
                            if (key.startsWith("behavior.")) {
                                val rest = key.removePrefix("behavior.")
                                val dot = rest.indexOf('.')
                                if (dot > 0) {
                                    val charId = rest.substring(0, dot)
                                    val fieldKey = rest.substring(dot + 1)
                                    byChar.getOrPut(charId) { mutableMapOf() }[fieldKey] = value
                                }
                            }
                        }

                        if (byChar.isEmpty()) {
                            setSaveLoading(false)
                            return@launch
                        }

                        val behaviors = bd.behaviors ?: emptyMap()
                        var anyChanged = false
                        byChar.forEach { (charId, fields) ->
                            // Skip entities deleted since the editor rendered
                            // (stale fieldValues must not PATCH a 404).
                            if (!behaviors.containsKey(charId)) return@forEach
                            val entry = behaviors[charId]
                            // Diff vs canonical entry: plain fields compare as
                            // text; quirks/reactions compare after round-tripping
                            // the stored JSON through the same line-based text
                            // the editor renders. An untouched card (the text
                            // equals the rendered form of the stored data) never
                            // PATCHes — future per-reaction keys written by other
                            // tools survive.
                            val changed = mutableMapOf<String, Any?>()
                            fields.forEach { (k, v) ->
                                when (k) {
                                    "instruction" -> if (v != (entry?.instruction ?: "")) changed[k] = v
                                    "baseline" -> if (v != (entry?.baseline ?: "")) changed[k] = v
                                    "quirks" -> if (v != behaviorQuirksToText(entry?.quirks)) {
                                        changed[k] = v.split('\n').map { it.trim() }.filter { it.isNotEmpty() }
                                    }
                                    "reactions" -> if (v != behaviorReactionsToText(entry?.reactions)) {
                                        changed[k] = behaviorReactionsFromText(v)
                                    }
                                }
                            }
                            if (changed.isEmpty()) return@forEach
                            anyChanged = true
                            viewModel.repository.patchBehavior(bookId, charId, changed)
                        }

                        if (!anyChanged) {
                            setSaveLoading(false)
                            return@launch
                        }

                        bookData = runCatching { viewModel.repository.getBook(bookId) }.getOrNull()
                        chapters = bookData?.chapters ?: emptyList()
                        viewModel.markUnsavedChanges()
                        setSaveLoading(false)
                        errorText?.visibility = View.GONE
                    } catch (e: Exception) {
                        Log.e("EditFragment", "behaviors save failed", e)
                        showSaveError("${e::class.simpleName}: ${e.message ?: "unknown"}")
                    }
                }
                return
            }

            val ch = chapters.getOrNull(currentChIndex) ?: run {
                showSaveError("No chapter data")
                return
            }
            val sc = currentScene() ?: run {
                showSaveError("No scene data")
                return
            }
            val chapterId = ch.chapter_id ?: run {
                showSaveError("No chapter ID")
                return
            }
            val sceneId = sc.scene_id ?: run {
                showSaveError("No scene ID")
                return
            }

            val pos = SharedPositionManager.current.value
            val sceneUnits = sc.units
            val hasUnit = sceneUnits != null && pos.unitIndex < sceneUnits.size

            setSaveLoading(true)

            lifecycleScope.launch {
                try {
                    val patchBody = mutableMapOf<String, Any?>()
                    val chapterTitleValue = fieldValues["chapter_title"]?.takeIf { it.isNotBlank() }

                    // F8: send flat fields map — server merges via setDeep()
                    // The server handles:
                    //   - unit_id + fields → apply to unit
                    //   - fields only → apply to scene (with env.* → location.environment.* mapping)
                    //   - participants string → array
                    //   - empty string → null
                    // Exclude chapter_title from fields (sent separately below).
                    // Characters/Voices/Behaviors are saved through their dedicated
                    // PATCH endpoints (tabs 5/6/8 above) — char.* / voice.* /
                    // behavior.* keys must NOT reach the scene PATCH here: setDeep
                    // would write them into the unit/scene object as junk keys that
                    // never persist to characters.json / voices.json / behavior.json.
                    val sendFields = fieldValues
                        .filterKeys {
                            it != "chapter_title" && !it.startsWith("char.") &&
                                !it.startsWith("voice.") && !it.startsWith("behavior.")
                        }
                    patchBody["fields"] = sendFields

                    if (hasUnit && sceneUnits != null) {
                        patchBody["unit_id"] = sceneUnits[pos.unitIndex].id
                    }

                    if (chapterTitleValue != null) {
                        patchBody["chapter_title"] = chapterTitleValue
                    }

                    viewModel.repository.patchScene(bookId, chapterId, sceneId, patchBody)

                    // Scene character passport overrides are SCENE-level data. Because
                    // the main PATCH above carries unit_id (which routes ALL fields to
                    // the unit), the passport.* keys must go out in a separate PATCH
                    // WITHOUT unit_id — the server then applies them to the scene itself.
                    val passportFields = buildPassportOverrideFields(sc)
                    if (passportFields.isNotEmpty()) {
                        viewModel.repository.patchScene(bookId, chapterId, sceneId, mapOf("fields" to passportFields))
                    }

                    // Thin-client: re-fetch canonical book data instead of
                    // reconstructing it locally (server is the source of truth).
                    // A refresh failure must not be reported as a save failure.
                    bookData = runCatching { viewModel.repository.getBook(bookId) }.getOrNull()
                    chapters = bookData?.chapters ?: emptyList()
                    viewModel.markUnsavedChanges()
                    setSaveLoading(false)
                    errorText?.visibility = View.GONE
                } catch (e: Exception) {
                    Log.e("EditFragment", "save failed", e)
                    showSaveError("${e::class.simpleName}: ${e.message ?: "unknown"}")
                }
            }
        } catch (e: Exception) {
            Log.e("EditFragment", "saveToBackend exception", e)
            showSaveError("${e::class.simpleName}: ${e.message ?: "unknown"}")
        }
    }

    /**
     * Toggle the save button between loading/saving and idle states.
     * @param busy true when an operation is in progress, false when idle
     * @param isSaving true if the operation is saving, false if it's loading
     */
    private fun setSaveLoading(busy: Boolean, isSaving: Boolean = true) {
        binding?.saveButton?.apply {
            text = when {
                busy && isSaving -> getString(R.string.edit_saving)
                busy && !isSaving -> getString(R.string.edit_loading)
                else -> getString(R.string.edit_save)
            }
            isEnabled = !busy
            alpha = if (busy) 0.5f else 1.0f
        }
    }

    private fun showSaveError(message: String) {
        binding?.saveButton?.apply {
            text = getString(R.string.edit_save)
            isEnabled = true
            alpha = 1.0f
        }
        binding?.errorText?.apply {
            text = message
            visibility = View.VISIBLE
        }
    }

    override fun onDestroyView() {
        stopPlayback()
        playbackJob?.cancel()
        mediaPlayer?.release()
        mediaPlayer = null
        audioFile?.delete()
        audioFile = null
        zoomDialog?.dismiss()
        zoomDialog = null
        binding = null
        super.onDestroyView()
    }

    private suspend fun loadTimelineData() {
        val b = binding ?: return
        val bookId = viewModel.bookId.takeIf { it.isNotBlank() } ?: return
        val buildId = viewModel.buildId.takeIf { it.isNotBlank() } ?: return

        val sc = currentScene() ?: return
        val ch = chapters.getOrNull(currentChIndex) ?: return
        val chId = ch.chapter_id ?: ""
        val scId = sc.scene_id ?: ""

        try {
            val waveformJob = lifecycleScope.launch {
                try {
                    waveformData = viewModel.repository.getSceneWaveform(bookId, chId, scId, buildId)
                } catch (_: Exception) {
                    waveformData = null
                }
            }
            val timingsJob = lifecycleScope.launch {
                try {
                    timingData = viewModel.repository.getSceneTimings(bookId, chId, scId, buildId)
                } catch (_: Exception) {
                    timingData = null
                }
            }
            waveformJob.join()
            timingsJob.join()

            val wd = waveformData
            val td = timingData

            if (wd != null && td != null) {
                audioDurationMs = (wd.duration_sec * 1000).toLong()
                val computedUnits = computeInitialTimings(td, audioDurationMs)
                timingData = td.copy(units = computedUnits)
                originalTimings = computedUnits.associate { it.unit_id to (it.start_ms to it.end_ms) }

                b.timelineWaveform.setPeaks(wd.peaks)
                b.timelineWaveform.setDurationMs(audioDurationMs)
                updateTimelineSelection()
                updateUnitHeaderLabel()
                b.timelinePanel.isVisible = true
                setTimelineCollapsed(timelineCollapsed) // re-apply collapsed strip state

                stopPlayback()
                mediaPlayer?.release()
                mediaPlayer = null
                audioFile?.delete()
                audioFile = null
                loadAudioFileSync()
            } else {
                b.timelinePanel.isVisible = false
            }
        } catch (_: Exception) {
            b.timelinePanel.isVisible = false
        }
    }

    private fun loadAudioFileSync() {
        val bookId = viewModel.bookId.takeIf { it.isNotBlank() } ?: return
        val buildId = viewModel.buildId.takeIf { it.isNotBlank() } ?: return

        val sc = currentScene() ?: return
        val ch = chapters.getOrNull(currentChIndex) ?: return
        val chId = ch.chapter_id ?: ""
        val scId = sc.scene_id ?: ""

        lifecycleScope.launch {
            try {
                val bytes = viewModel.repository.getSceneAudio(bookId, chId, scId, buildId)
                val file = File(requireContext().cacheDir, "scene-${bookId}-${chId}-${scId}.mp3")
                file.writeBytes(bytes)
                audioFile = file
                Log.i("EditFragment", "Audio loaded: ${file.absolutePath} (${bytes.size} bytes)")
            } catch (e: Exception) {
                audioFile = null
                Log.w("EditFragment", "Audio load failed: ${e.message}")
            }
        }
    }

    private fun computeInitialTimings(data: SceneTiming, audioDurationMs: Long): List<IuTimingBoundary> {
        return data.units.sortedBy { it.scene_order }.map { u ->
            val startMs = u.start_ms.coerceAtLeast(0)
            val endMs = u.end_ms.coerceIn(startMs, audioDurationMs)
            u.copy(start_ms = startMs, end_ms = endMs)
        }
    }

    private fun updateTimelineSelection() {
        val b = binding ?: return
        val td = timingData ?: return
        val pos = SharedPositionManager.current.value
        val unit = td.units.getOrNull(pos.unitIndex) ?: return
        b.timelineWaveform.setSelectionRange(unit.start_ms, unit.end_ms, unit.unit_id)
    }

    private fun togglePlayback() {
        if (isPlaying) {
            stopPlayback()
        } else {
            startPlayback()
        }
    }

    private fun startPlayback() {
        val b = binding ?: return
        val pos = SharedPositionManager.current.value
        val unit = timingData?.units?.getOrNull(pos.unitIndex) ?: return

        val file = audioFile
        if (file == null) {
            Log.w("EditFragment", "Audio file not yet loaded, retrying...")
            viewLifecycleOwner.lifecycleScope.launch {
                loadAudioFileSync()
                if (audioFile != null) startPlayback()
            }
            return
        }

        val player = mediaPlayer
        if (player == null) {
            try {
                val newPlayer = MediaPlayer()
                newPlayer.setDataSource(file.absolutePath)
                newPlayer.prepare()
                newPlayer.setOnCompletionListener { stopPlayback() }
                mediaPlayer = newPlayer
            } catch (e: Exception) {
                Log.e("EditFragment", "MediaPlayer create error: ${e.message}")
                return
            }
        } else {
            player.setOnCompletionListener { stopPlayback() }
        }

        val p = mediaPlayer ?: return
        val audioDurationMs = try { p.duration.toLong() } catch (_: Exception) { Long.MAX_VALUE }
        try {
            p.seekTo(unit.start_ms.toInt())
            p.start()
            isPlaying = true
            b.timelinePlayButton.setImageResource(R.drawable.ic_stop)
            b.timelinePlayButton.contentDescription = getString(R.string.timeline_stop)

            playbackJob?.cancel()
            playbackJob = lifecycleScope.launch {
                while (isActive && isPlaying) {
                    try {
                        val cur = p.currentPosition.toLong()
                        b.timelineWaveform.setPlaybackPosition(cur)
                        if (cur >= unit.end_ms || cur >= audioDurationMs) {
                            stopPlayback()
                        }
                    } catch (_: Exception) {
                        stopPlayback()
                    }
                    delay(50)
                }
            }
        } catch (e: Exception) {
            Log.e("EditFragment", "Playback error: ${e.message}")
        }
    }

    private fun stopPlayback() {
        isPlaying = false
        playbackJob?.cancel()
        playbackJob = null
        try {
            mediaPlayer?.pause()
        } catch (_: Exception) {}

        val b = binding ?: return
        b.timelinePlayButton.setImageResource(R.drawable.ic_play)
        b.timelinePlayButton.contentDescription = getString(R.string.timeline_play)
        b.timelineWaveform.clearPlaybackPosition()
    }

    // N2: local drag PREVIEW only. Moves the dragged unit and keeps BOTH
    // neighboring boundaries contiguous so the handle tracks the finger smoothly:
    // the left handle is also the previous unit's end, the right handle is also the
    // next unit's start. The full cascade (shift downstream units, enforce min gap,
    // clamp to scene duration) is the server's job — it recalculates
    // authoritatively in PUT /timings on release (see saveTimings), and the
    // returned units overwrite this preview.
    private fun handleRangeChange(startMs: Long, endMs: Long) {
        val td = timingData ?: return
        val pos = SharedPositionManager.current.value
        val updated = td.units.toMutableList()
        if (pos.unitIndex in updated.indices) {
            updated[pos.unitIndex] = updated[pos.unitIndex].copy(start_ms = startMs, end_ms = endMs)
            // The handles are SHARED boundaries: the left handle is also the
            // previous unit's end, the right handle is also the next unit's start.
            if (pos.unitIndex > 0) {
                val prev = updated[pos.unitIndex - 1]
                updated[pos.unitIndex - 1] = prev.copy(end_ms = startMs)
            }
            if (pos.unitIndex + 1 < updated.size) {
                val next = updated[pos.unitIndex + 1]
                updated[pos.unitIndex + 1] = next.copy(start_ms = endMs)
            }
            timingData = td.copy(units = updated)
            updateUnitHeaderLabel()
        }
    }

    private fun handleRangeChangeEnd() {
        timelineDirty = true
        viewLifecycleOwner.lifecycleScope.launch {
            saveTimings()
        }
    }

    private suspend fun saveTimings() {
        val td = timingData ?: return
        val sc = currentScene() ?: return
        val ch = chapters.getOrNull(currentChIndex) ?: return
        val bookId = viewModel.bookId.takeIf { it.isNotBlank() } ?: return
        val buildId = viewModel.buildId.takeIf { it.isNotBlank() } ?: return

        try {
            val boundaries = td.units.map { TimingBoundary(it.unit_id, it.start_ms, it.end_ms) }
            val response = viewModel.repository.updateSceneTimings(
                bookId, ch.chapter_id ?: "", sc.scene_id ?: "", buildId, boundaries
            )
            val responseMap = response.units.associateBy { it.unit_id }
            val updatedUnits = td.units.map { u ->
                val r = responseMap[u.unit_id]
                if (r != null) u.copy(start_ms = r.start_ms, end_ms = r.end_ms) else u
            }
            timingData = td.copy(units = updatedUnits)
            updateUnitHeaderLabel()
            updateTimelineSelection()
            timelineDirty = false
        } catch (e: Exception) {
        }
    }

    private fun resetCurrentUnitTiming() {
        val orig = originalTimings ?: return
        val td = timingData ?: return
        val pos = SharedPositionManager.current.value

        val updated = td.units.toMutableList()
        if (pos.unitIndex in updated.indices) {
            val unit = updated[pos.unitIndex]
            val origPair = orig[unit.unit_id] ?: return
            updated[pos.unitIndex] = unit.copy(start_ms = origPair.first, end_ms = origPair.second)
            timingData = td.copy(units = updated)
            updateUnitHeaderLabel()
            updateTimelineSelection()
        }

        viewLifecycleOwner.lifecycleScope.launch {
            saveTimings()
        }
    }
}

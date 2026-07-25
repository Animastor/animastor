package com.example.animastor.ui

import android.content.Context
import android.graphics.BitmapFactory
import android.media.MediaPlayer
import android.os.Bundle
import android.util.Log
import android.view.View
import android.view.ViewGroup
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

        // Carousel navigation
        b.currentUnitCard.setOnClickListener { }  // no-op, shows current
        b.prevUnitCard.setOnClickListener { navigateUnit(-1) }
        b.nextUnitCard.setOnClickListener { navigateUnit(1) }

        b.timelinePlayButton.setOnClickListener { togglePlayback() }
        b.timelineResetButton.setOnClickListener { resetCurrentUnitTiming() }
        b.timelineWaveform.onRangeChangeListener = { startMs, endMs -> handleRangeChange(startMs, endMs) }
        b.timelineWaveform.onRangeChangeEndListener = { _, _ -> handleRangeChangeEnd() }

        // Default to Units tab
        b.propertyTabs.getTabAt(2)?.select()

        // Initial scroll indicator state
        b.propertyTabs.post { updateTabScrollIndicators() }

        observePosition()
        observeViewModel()
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
        val b = binding ?: return
        positionLabel()?.text = getString(R.string.navigate_no_position)
        b.errorText.visibility = View.GONE
        b.contentFrame.removeAllViews()
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
    }

    private fun loadBookAndAutoPosition() {
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
                        chapterId = firstCh.chapter,
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
            setSaveLoading(false)
            binding?.contentFrame?.removeAllViews()
            return
        }
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

            val nc = chapters.indexOfFirst { it.chapter == pos.chapterId }.coerceAtLeast(0)
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
        val chId = chapters.getOrNull(currentChIndex)?.chapter ?: return
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
                val availDp = scrDp - 32f
                val weight = if (card.id == R.id.currentUnitCard) 1.5f else 1.0f
                val cardWDp = availDp * weight / 3.5f
                val hDp = cardWDp * bmp.height / bmp.width
                val hPx = (hDp * dm.density + 0.5f).toInt()
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
        val chId = chapters.getOrNull(chIndex)?.chapter ?: return
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
                val availDp = scrDp - 32f
                val weight = if (card.id == R.id.currentUnitCard) 1.5f else 1.0f
                val cardWDp = availDp * weight / 3.5f
                val hDp = cardWDp * bmp.height / bmp.width
                val hPx = (hDp * dm.density + 0.5f).toInt()
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
                        chapterId = chapters.getOrNull(currentChIndex)?.chapter,
                        sceneId = prevSc.scene_id,
                        unitId = prevUnits.getOrNull(prevUnitIndex)?.id,
                        chunkId = null,
                        unitIndex = prevUnitIndex
                    )
                    updatePositionLabel()
                    updateCarousel()
                    rebuildContent(binding?.propertyTabs?.selectedTabPosition ?: 0)
                    val chId = chapters.getOrNull(currentChIndex)?.chapter
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
                        chapterId = prevCh?.chapter,
                        sceneId = prevSc.scene_id,
                        unitId = prevUnits.getOrNull(prevUnitIndex)?.id,
                        chunkId = null,
                        unitIndex = prevUnitIndex
                    )
                    updatePositionLabel()
                    updateCarousel()
                    rebuildContent(binding?.propertyTabs?.selectedTabPosition ?: 0)
                    val chId = prevCh?.chapter
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
                        chapterId = chapters.getOrNull(currentChIndex)?.chapter,
                        sceneId = nextSc.scene_id,
                        unitId = nextUnits.firstOrNull()?.id,
                        chunkId = null,
                        unitIndex = 0
                    )
                    updatePositionLabel()
                    updateCarousel()
                    rebuildContent(binding?.propertyTabs?.selectedTabPosition ?: 0)
                    val chId = chapters.getOrNull(currentChIndex)?.chapter
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
                        chapterId = nextCh?.chapter,
                        sceneId = nextSc.scene_id,
                        unitId = nextUnits.firstOrNull()?.id,
                        chunkId = null,
                        unitIndex = 0
                    )
                    updatePositionLabel()
                    updateCarousel()
                    rebuildContent(binding?.propertyTabs?.selectedTabPosition ?: 0)
                    val chId = nextCh?.chapter
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
                val chId = chapters.getOrNull(currentChIndex)?.chapter
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
                0 -> buildSceneFields(frame)
                1 -> buildFields(frame, listOf("voice", "full_text"))
                2 -> buildUnitFields(frame)
                3 -> buildCharactersFields(frame)
                4 -> buildVoicesFields(frame)
                5 -> buildLocationsFields(frame)
            }
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

        // Unit metadata section
        val metaSectionLabel = TextView(ctx).apply {
            text = getString(R.string.edit_section_unit)
            textSize = 14f
            setPadding(0, 16, 0, 4)
        }
        ll.addView(metaSectionLabel)
        // id and type are read-only system fields
        ll.addView(readOnlyCard(ctx, "id", u.id ?: ""))
        ll.addView(readOnlyCard(ctx, "type", u.type ?: ""))
        // text is editable
        val textKey = "text"
        val textVal = u.text ?: ""
        if (!fieldValues.containsKey(textKey)) fieldValues[textKey] = textVal
        ll.addView(inputCard(ctx, textKey, fieldValues[textKey] ?: textVal, textVal.length > 80))

        // Audio section
        val audioSectionLabel = TextView(ctx).apply {
            text = getString(R.string.edit_section_audio)
            textSize = 14f
            setPadding(0, 16, 0, 4)
        }
        ll.addView(audioSectionLabel)
        listOf("audio.speaker", "audio.text").forEach { key ->
            val v = readUnitField(u, key)
            if (!fieldValues.containsKey(key)) fieldValues[key] = v
            ll.addView(inputCard(ctx, key, fieldValues[key] ?: v, (key == "audio.text" && (fieldValues[key]?.length ?: 0) > 80)))
        }

        // Image section
        val imageSectionLabel = TextView(ctx).apply {
            text = getString(R.string.edit_section_image)
            textSize = 14f
            setPadding(0, 16, 0, 4)
        }
        ll.addView(imageSectionLabel)
        listOf("image.shot", "image.prompt", "image.negative").forEach { key ->
            val v = readUnitField(u, key)
            if (!fieldValues.containsKey(key)) fieldValues[key] = v
            ll.addView(inputCard(ctx, key, fieldValues[key] ?: v, (key == "image.prompt" && (fieldValues[key]?.length ?: 0) > 80)))
        }

        // Video section
        val videoSectionLabel = TextView(ctx).apply {
            text = getString(R.string.edit_section_video)
            textSize = 14f
            setPadding(0, 16, 0, 4)
        }
        ll.addView(videoSectionLabel)
        listOf("video.action").forEach { key ->
            val v = readUnitField(u, key)
            if (!fieldValues.containsKey(key)) fieldValues[key] = v
            ll.addView(inputCard(ctx, key, fieldValues[key] ?: v, (fieldValues[key]?.length ?: 0) > 80))
        }

        parent.addView(ll)
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

                inner.addView(TextView(ctx).apply {
                    text = ch.name ?: ch.id ?: "—"
                    textSize = 14f
                    typeface = android.graphics.Typeface.DEFAULT_BOLD
                })

                inner.addView(readOnlyCard(ctx, "id", ch.id ?: ""))

                inner.addView(inputCard(ctx, "name", ch.name ?: "", false))

                inner.addView(inputCard(ctx, "voice_id", ch.voice_id ?: "", false))

                // Passport fields
                val passport = ch.passport
                if (passport != null) {
                    val passportLabel = TextView(ctx).apply {
                        text = getString(R.string.field_passport)
                        textSize = 12f
                        typeface = android.graphics.Typeface.DEFAULT_BOLD
                        setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorSecondary))
                        setPadding(0, 8, 0, 4)
                    }
                    inner.addView(passportLabel)

                    val charId = ch.id ?: "char_unknown"
                    val passportPrefix = "char.${charId}.passport"
                    val passportKeys = listOf(
                        "${passportPrefix}.base_appearance",
                        "${passportPrefix}.detailed_appearance",
                        "${passportPrefix}.clothing_base",
                        "${passportPrefix}.clothing_details",
                        "${passportPrefix}.video_tokens"
                    )
                    val pf = mapOf(
                        "${passportPrefix}.base_appearance" to (passport.base_appearance ?: ""),
                        "${passportPrefix}.detailed_appearance" to (passport.detailed_appearance ?: ""),
                        "${passportPrefix}.clothing_base" to (passport.clothing_base ?: ""),
                        "${passportPrefix}.clothing_details" to (passport.clothing_details ?: ""),
                        "${passportPrefix}.video_tokens" to (passport.video_tokens ?: "")
                    )

                    passportKeys.forEach { key ->
                        val v = pf[key] ?: ""
                        if (!fieldValues.containsKey(key)) fieldValues[key] = v
                        inner.addView(inputCard(ctx, key, fieldValues[key] ?: v, (v.length > 80)))
                    }
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

                inner.addView(TextView(ctx).apply {
                    text = voiceId
                    textSize = 14f
                    typeface = android.graphics.Typeface.DEFAULT_BOLD
                })

                val instruction = entry.instruction ?: ""
                val voiceKey = "voice.${voiceId}.instruction"
                if (!fieldValues.containsKey(voiceKey)) fieldValues[voiceKey] = instruction
                inner.addView(inputCard(ctx, "instruction", fieldValues[voiceKey] ?: instruction, instruction.length > 80))

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

                inner.addView(TextView(ctx).apply {
                    text = loc.name ?: loc.id ?: key
                    textSize = 14f
                    typeface = android.graphics.Typeface.DEFAULT_BOLD
                })

                inner.addView(readOnlyCard(ctx, "id", loc.id ?: key))

                inner.addView(inputCard(ctx, "name", loc.name ?: "", false))
                inner.addView(inputCard(ctx, "description", loc.description ?: "", (loc.description?.length ?: 0) > 80))
                inner.addView(inputCard(ctx, "visual_style", loc.visual_style ?: "", false))
                inner.addView(inputCard(ctx, "cinematic_space", loc.cinematic_space ?: "", false))
                inner.addView(inputCard(ctx, "default_mood", loc.default_mood ?: "", false))

                card.addView(inner)
                ll.addView(card)
            }
        }

        parent.addView(ll)
    }

    private fun scrollTabs(direction: Int) {
        val tabLayout = binding?.propertyTabs ?: return
        val selectedTab = tabLayout.selectedTabPosition
        val newPos = (selectedTab + direction).coerceIn(0, tabLayout.tabCount - 1)
        tabLayout.getTabAt(newPos)?.select()
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

    private fun buildSceneFields(parent: ViewGroup) {
        val ctx = parent.context
        val sc = currentScene() ?: return
        val ch = chapters.getOrNull(currentChIndex)
        val ll = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, 0, 0, 8)
        }

        // JSON order: chapter → chapter_title → scene_id → ...
        ll.addView(readOnlyCard(ctx, "chapter", ch?.chapter ?: "—"))
        if (ch != null) {
            val chTitleKey = "chapter_title"
            if (!fieldValues.containsKey(chTitleKey)) fieldValues[chTitleKey] = ch.chapter_title ?: ""
            ll.addView(inputCard(ctx, chTitleKey, fieldValues[chTitleKey] ?: "", false))
        }
        ll.addView(readOnlyCard(ctx, "scene_id", sc.scene_id ?: "—"))

        // Editable scene fields
        val editableKeys = listOf("scene_title", "type", "style", "location.id", "env.time", "env.lighting", "env.weather", "env.mood", "env.atmosphere", "participants")
        val sceneValues = editableKeys.associateWith { key -> readField(sc, key) }
        editableKeys.forEach { key ->
            val v = sceneValues[key] ?: ""
            if (!fieldValues.containsKey(key)) fieldValues[key] = v
            ll.addView(inputCard(ctx, key, fieldValues[key] ?: v, (fieldValues[key]?.length ?: 0) > 80))
        }
        parent.addView(ll)
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
            ll.addView(inputCard(ctx, key, fieldValues[key] ?: v, (fieldValues[key]?.length ?: 0) > 80))
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

    private fun readOnlyCard(ctx: Context, label: String, value: String): View {
        val til = TextInputLayout(ctx).apply {
            hint = label
            isHintEnabled = true
            boxBackgroundMode = TextInputLayout.BOX_BACKGROUND_OUTLINE
        }
        val et = TextInputEditText(ctx).apply {
            setText(value)
            textSize = 14f
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

    private fun inputCard(ctx: Context, label: String, value: String, multiline: Boolean): View {
        fieldValues[label] = value
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
            addTextChangedListener(simpleWatcher {
                fieldValues[label] = it
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

    private fun applyFieldValues(scene: Scene, values: Map<String, String>): Scene {
        val s = values
        var modified = scene
        s["scene_title"]?.let { modified = modified.copy(scene_title = it.ifEmpty { null }) }
        s["type"]?.let { modified = modified.copy(type = it.ifEmpty { null }) }
        s["style"]?.let { modified = modified.copy(style = it.ifEmpty { null }) }
        s["location.id"]?.let {
            val v = it.ifEmpty { null }
            val loc = modified.location
            modified = modified.copy(location = if (v == null && loc?.environment == null) null
                else LocationData(id = v, environment = loc?.environment))
        }
        s["env.time"]?.let { v ->
            val loc = modified.location
            val env = (loc?.environment ?: EnvironmentData()).copy(time = v.ifEmpty { null })
            modified = modified.copy(location = LocationData(id = loc?.id, environment = env))
        }
        s["env.lighting"]?.let { v ->
            val loc = modified.location
            val env = (loc?.environment ?: EnvironmentData()).copy(lighting = v.ifEmpty { null })
            modified = modified.copy(location = LocationData(id = loc?.id, environment = env))
        }
        s["env.weather"]?.let { v ->
            val loc = modified.location
            val env = (loc?.environment ?: EnvironmentData()).copy(weather = v.ifEmpty { null })
            modified = modified.copy(location = LocationData(id = loc?.id, environment = env))
        }
        s["env.mood"]?.let { v ->
            val loc = modified.location
            val env = (loc?.environment ?: EnvironmentData()).copy(mood = v.ifEmpty { null })
            modified = modified.copy(location = LocationData(id = loc?.id, environment = env))
        }
        s["env.atmosphere"]?.let { v ->
            val loc = modified.location
            val env = (loc?.environment ?: EnvironmentData()).copy(atmosphere = v.ifEmpty { null })
            modified = modified.copy(location = LocationData(id = loc?.id, environment = env))
        }
        s["participants"]?.let { v ->
            modified = modified.copy(participants = if (v.isBlank()) null else v.split(", ").map { it.trim() })
        }
        s["voice"]?.let { v ->
            val audio = modified.audio ?: AudioConfig()
            modified = modified.copy(audio = audio.copy(voice = v.ifEmpty { null }))
        }
        s["full_text"]?.let { v ->
            val audio = modified.audio ?: AudioConfig()
            modified = modified.copy(audio = audio.copy(full_text = v.ifEmpty { null }))
        }            // Unit-level fields
        val sceneUnits = modified.units
        val pos = SharedPositionManager.current.value
        if (sceneUnits != null && pos.unitIndex < sceneUnits.size) {
            val modifiedUnits = sceneUnits.toMutableList()
            val u = sceneUnits[pos.unitIndex]
            var mu = u
            if (s.containsKey("text")) mu = mu.copy(text = s["text"]?.ifEmpty { null })
            // Audio section
            if (s.containsKey("audio.speaker") || s.containsKey("audio.text")) {
                val speaker = s["audio.speaker"]?.ifEmpty { null }
                val text = s["audio.text"]?.ifEmpty { null }
                mu = mu.copy(audio = AudioSection(speaker = speaker, text = text))
            }
            // Image section — preserve non-UI fields (quality, style, lighting, character_binding)
            if (s.containsKey("image.shot") || s.containsKey("image.prompt") || s.containsKey("image.negative")) {
                val existing = mu.image
                val shot = s["image.shot"]?.ifEmpty { mu.image?.shot }
                val prompt = s["image.prompt"]?.ifEmpty { null }
                val negative = s["image.negative"]?.ifEmpty { null }
                mu = mu.copy(image = ImageSection(
                    shot = shot, prompt = prompt, negative = negative,
                    quality = existing?.quality,
                    style = existing?.style,
                    lighting = existing?.lighting,
                    character_binding = existing?.character_binding
                ))
            }
            // Video section
            if (s.containsKey("video.action")) {
                val action = s["video.action"]?.ifEmpty { null }
                mu = mu.copy(video = VideoSection(action = action))
            }
            modifiedUnits[pos.unitIndex] = mu
            modified = modified.copy(units = modifiedUnits.toList())
        }
        return modified
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

            val ch = chapters.getOrNull(currentChIndex) ?: run {
                showSaveError("No chapter data")
                return
            }
            val sc = currentScene() ?: run {
                showSaveError("No scene data")
                return
            }
            val chapterId = ch.chapter ?: run {
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
                    val sendFields = fieldValues - "chapter_title"
                    patchBody["fields"] = sendFields

                    if (hasUnit && sceneUnits != null) {
                        patchBody["unit_id"] = sceneUnits[pos.unitIndex].id
                    }

                    if (chapterTitleValue != null) {
                        patchBody["chapter_title"] = chapterTitleValue
                    }

                    viewModel.repository.patchScene(bookId, chapterId, sceneId, patchBody)

                    // Apply changes locally for UI consistency (optimistic update)
                    val modifiedScene = applyFieldValues(sc, fieldValues)
                    val modifiedChapters = chapters.toMutableList()
                    val modifiedCh = if (chapterTitleValue != null || fieldValues.containsKey("chapter_title"))
                        ch.copy(chapter_title = chapterTitleValue) else ch
                    val scenes = modifiedCh.scenes?.toMutableList() ?: return@launch
                    scenes[currentScIndex] = modifiedScene
                    modifiedChapters[currentChIndex] = modifiedCh.copy(scenes = scenes.toList())
                    val modifiedBookData = bd.copy(chapters = modifiedChapters.toList())

                    bookData = modifiedBookData
                    chapters = modifiedBookData.chapters ?: emptyList()
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
        binding = null
        super.onDestroyView()
    }

    private suspend fun loadTimelineData() {
        val b = binding ?: return
        val bookId = viewModel.bookId.takeIf { it.isNotBlank() } ?: return
        val buildId = viewModel.buildId.takeIf { it.isNotBlank() } ?: return

        val sc = currentScene() ?: return
        val ch = chapters.getOrNull(currentChIndex) ?: return
        val chId = ch.chapter ?: ""
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
                b.timelinePanel.isVisible = true

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
        val chId = ch.chapter ?: ""
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

    // N2: local drag PREVIEW only. Moves the dragged unit and keeps the previous
    // boundary contiguous so the handle tracks the finger smoothly. The full cascade
    // (shift downstream units, enforce min gap, clamp to scene duration) is the
    // server's job — it recalculates authoritatively in PUT /timings on release
    // (see saveTimings), and the returned units overwrite this preview. We no longer
    // re-derive that business logic on the client.
    private fun handleRangeChange(startMs: Long, endMs: Long) {
        val td = timingData ?: return
        val pos = SharedPositionManager.current.value
        val updated = td.units.toMutableList()
        if (pos.unitIndex in updated.indices) {
            updated[pos.unitIndex] = updated[pos.unitIndex].copy(start_ms = startMs, end_ms = endMs)
            if (pos.unitIndex > 0) {
                val prev = updated[pos.unitIndex - 1]
                updated[pos.unitIndex - 1] = prev.copy(end_ms = startMs)
            }
            timingData = td.copy(units = updated)
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
                bookId, ch.chapter ?: "", sc.scene_id ?: "", buildId, boundaries
            )
            val responseMap = response.units.associateBy { it.unit_id }
            val updatedUnits = td.units.map { u ->
                val r = responseMap[u.unit_id]
                if (r != null) u.copy(start_ms = r.start_ms, end_ms = r.end_ms) else u
            }
            timingData = td.copy(units = updatedUnits)
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
            updateTimelineSelection()
        }

        viewLifecycleOwner.lifecycleScope.launch {
            saveTimings()
        }
    }
}

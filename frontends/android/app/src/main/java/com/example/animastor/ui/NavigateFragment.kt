package com.example.animastor.ui

import android.graphics.BitmapFactory
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.fragment.app.Fragment
import androidx.fragment.app.activityViewModels
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ItemTouchHelper
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.example.animastor.R
import com.example.animastor.databinding.FragmentNavigateBinding
import com.example.animastor.repository.BookData
import com.example.animastor.repository.ResourceInvalidations
import com.example.animastor.repository.unitIndex

import com.example.animastor.repository.Chapter
import com.example.animastor.repository.ReorderChapter
import com.example.animastor.repository.Scene
import com.example.animastor.repository.SceneUnit
import com.google.android.material.card.MaterialCardView
import com.google.android.material.color.MaterialColors
import kotlinx.coroutines.launch

class NavigateFragment : Fragment(R.layout.fragment_navigate) {

    private var binding: FragmentNavigateBinding? = null
    private val viewModel: GenerateViewModel by activityViewModels {
        GenerateViewModel.factory
    }
    private val playbackViewModel: PlaybackViewModel by activityViewModels {
        PlaybackViewModel.factory
    }

    private var bookData: BookData? = null
    private val expandedScenes = mutableSetOf<String>()
    // Persistent user overrides for chapter expansion (chapterId → explicitly
    // expanded/collapsed). Absent entries follow the default rule below. Without
    // this map the manual toggle is lost: rebuildStructure() recomputed `expanded`
    // from the hard rule on every click (06 §14 no-op bug) — chapters in a book
    // with more than 3 chapters could never be expanded by tap.
    private val chapterExpandedOverrides = mutableMapOf<String, Boolean>()
    private var lastPositionKey: String? = null
    private var isLoading = false
    private val adapter = BookStructureAdapter(
        onClick = { item ->
            when (item) {
                is StructureItem.UnitItem -> {
                    SharedPositionManager.navigateTo(
                        chapterId = item.chapterId,
                        sceneId = item.sceneId,
                        unitId = item.unit.id,
                        unitIndex = item.index
                    )
                    if (item.chapterId != null && item.sceneId != null) {
                        playbackViewModel.seekToPosition(item.chapterId, item.sceneId, item.index, item.unit.id)
                    }

                    (requireActivity() as? MainActivity)?.switchToPlayTab()
                }
                is StructureItem.SceneItem -> {
                    if (item.chapterId != null && item.sceneId != null) {
                        val key = "${item.chapterId}|${item.sceneId}"
                        if (expandedScenes.contains(key)) expandedScenes.remove(key)
                        else expandedScenes.add(key)
                    }
                    rebuildStructure()
                }
                is StructureItem.ChapterItem -> {
                    if (item.chapterId != null) {
                        chapterExpandedOverrides[item.chapterId] = !item.expanded
                    }
                    rebuildStructure()
                }
            }
        },
        previewLoader = { item, imageView ->
            loadUnitPreview(item, imageView)
        },
        onReorder = { _ ->
        }
    )

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        binding = FragmentNavigateBinding.bind(view)
        barBinding = binding?.positionBar

        binding?.structureList?.layoutManager = LinearLayoutManager(requireContext())
        binding?.structureList?.adapter = adapter

        var wasDragged = false
        val touchHelper = ItemTouchHelper(object : ItemTouchHelper.SimpleCallback(
            ItemTouchHelper.UP or ItemTouchHelper.DOWN, 0
        ) {
            override fun getDragDirs(recyclerView: RecyclerView, vh: RecyclerView.ViewHolder): Int {
                val pos = vh.bindingAdapterPosition
                if (pos in adapter.items.indices && adapter.items[pos] is StructureItem.SceneItem) {
                    return ItemTouchHelper.UP or ItemTouchHelper.DOWN
                }
                return 0
            }

            override fun onMove(
                recyclerView: RecyclerView,
                viewHolder: RecyclerView.ViewHolder,
                target: RecyclerView.ViewHolder
            ): Boolean {
                val from = viewHolder.bindingAdapterPosition
                val to = target.bindingAdapterPosition
                if (from !in adapter.items.indices || to !in adapter.items.indices) return false
                val fromItem = adapter.items[from] as? StructureItem.SceneItem ?: return false
                val toItem = adapter.items[to] as? StructureItem.SceneItem ?: return false
                if (fromItem.chapterId != toItem.chapterId) return false
                wasDragged = true
                adapter.moveItem(from, to)
                return true
            }

            override fun onSwiped(viewHolder: RecyclerView.ViewHolder, direction: Int) {}

            override fun onSelectedChanged(vh: RecyclerView.ViewHolder?, actionState: Int) {
                super.onSelectedChanged(vh, actionState)
                if (actionState == ItemTouchHelper.ACTION_STATE_DRAG) {
                    vh?.itemView?.alpha = 0.6f
                }
            }

            override fun clearView(recyclerView: RecyclerView, vh: RecyclerView.ViewHolder) {
                super.clearView(recyclerView, vh)
                vh.itemView.alpha = 1f
                if (wasDragged) {
                    wasDragged = false
                    val chapters = mutableListOf<ReorderChapter>()
                    var currentChapter: String? = null
                    var currentScenes = mutableListOf<String>()
                    for (item in adapter.items) {
                        when (item) {
                            is StructureItem.ChapterItem -> {
                                if (currentChapter != null) {
                                    chapters.add(ReorderChapter(currentChapter, currentScenes.toList()))
                                }
                                currentChapter = item.id
                                currentScenes = mutableListOf()
                            }
                            is StructureItem.SceneItem -> {
                                item.sceneId?.let { currentScenes.add(it) }
                            }
                            else -> {}
                        }
                    }
                    if (currentChapter != null) {
                        chapters.add(ReorderChapter(currentChapter, currentScenes.toList()))
                    }
                    viewModel.reorderChapters(chapters)
                }
            }
        })
        touchHelper.attachToRecyclerView(binding?.structureList)

        observePosition()
        observeGenerationCompletion()
        loadBook()
    }

    private fun observePosition() {
        viewLifecycleOwner.lifecycleScope.launch {
            viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                SharedPositionManager.current.collect { pos ->
                    updatePositionBar(pos)
                    rebuildStructure()
                }
            }
        }
    }

    private var barBinding: com.example.animastor.databinding.IncludePositionBarBinding? = null

    private fun positionLabel(): TextView? = barBinding?.positionLabel

    private fun updatePositionBar(pos: ActivePosition) {
        if (binding == null) return
        if (pos.chapterId != null) {
            val ch = bookData?.chapters?.firstOrNull { it.chapter_id == pos.chapterId }
            val sc = ch?.scenes?.firstOrNull { it.scene_id == pos.sceneId }

            val isSpecial = ch?.is_special == true
            val scIdx = sc?.display_index ?: 0
            val uIdx = bookData?.unitIndex(pos.chapterId, pos.sceneId, pos.unitIndex) ?: 0
            val chTitle = ch?.chapter_title?.takeIf { it.isNotBlank() }
            val scTitle = sc?.scene_title?.takeIf { it.isNotBlank() }
            val chLabel = if (isSpecial) {
                when (ch?.type?.lowercase()) {
                    "cover" -> getString(R.string.navigate_cover)
                    "prologue" -> getString(R.string.navigate_prologue)
                    else -> chTitle ?: (ch?.type?.replaceFirstChar { it.uppercase() } ?: "")
                }
            } else if (ch?.display_number != null) {
                val prefix = "${getString(R.string.navigate_chapter)} ${ch.display_number}"
                if (chTitle != null && chTitle.isNotBlank() && !chTitle.matches(Regex("""^\p{L}+\s+\d+$"""))) {
                    if (chTitle.contains(Regex("""\d"""))) chTitle else "$prefix — $chTitle"
                } else {
                    prefix
                }
            } else if (chTitle != null) {
                chTitle
            } else {
                ""
            }
            val scLabel = if (scIdx > 0) "${getString(R.string.navigate_scene)} $scIdx" else ""
            val unitLabel = if (uIdx > 0) "${getString(R.string.navigate_unit)} $uIdx" else ""
            if (chLabel.isEmpty()) { positionLabel()?.text = ""; return }
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
        } else {
            positionLabel()?.text = getString(R.string.navigate_no_position)
        }
    }

    private fun observeGenerationCompletion() {
        viewLifecycleOwner.lifecycleScope.launch {
            viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                viewModel.playbackPrepared.collect { prep ->
                    // Reload book structure when new content is available.
                    // The isLoading guard prevents redundant fetches:
                    //   - Replay emission (replay=1) arrives while loadBook() from
                    //     onViewCreated is still running → isLoading=true → skip
                    //   - First real emission with no prior replay → isLoading=false → fetch
                    //   - Subsequent generation completions → isLoading=false → fetch
                    if (viewModel.bookId.isNotBlank() && viewModel.bookId == prep.bookId) {
                        loadBook()
                    }
                }
                // ── Invalidation pipeline (view layer) ──────────────────
                // The book JSON changed outside this screen (AI Assistant
                // patch, another device) — re-read the structure so the tree
                // shows new/renamed chapters, scenes and units without a
                // manual refresh. Same resource-key contract as EditFragment.
                launch {
                    ResourceInvalidations.events.collect { event ->
                        val currentBook = viewModel.bookId
                        if (event.kind != ResourceInvalidations.Kind.EXTERNAL) return@collect
                        if (currentBook.isBlank() || event.resource != ResourceInvalidations.Keys.book(currentBook)) return@collect
                        loadBook()
                    }
                }
            }
        }
    }

    private fun loadBook() {
        val bookId = viewModel.bookId.takeIf { it.isNotBlank() }
        if (bookId == null) {
            bookData = null
            adapter.submitList(emptyList())
            binding?.emptyState?.visibility = View.VISIBLE
            binding?.loadingIndicator?.visibility = View.GONE
            return
        }
        if (isLoading) return
        isLoading = true
        binding?.emptyState?.visibility = View.GONE
        binding?.loadingIndicator?.visibility = View.VISIBLE
        lifecycleScope.launch {
            try {
                bookData = viewModel.repository.getBook(bookId)
                rebuildStructure()
                updatePositionBar(SharedPositionManager.current.value)
                binding?.loadingIndicator?.visibility = View.GONE
            } catch (e: Exception) {
                binding?.loadingIndicator?.visibility = View.GONE
                if (bookData == null) {
                    binding?.emptyState?.visibility = View.VISIBLE
                }
            } finally {
                isLoading = false
            }
        }
    }

    private fun rebuildStructure() {
        val data = bookData ?: return
        val chapters = data.chapters ?: emptyList()
        val pos = SharedPositionManager.current.value
        val items = mutableListOf<StructureItem>()

        // Auto-expand only the current position's scene, collapse others on scene change
        val posKey = if (pos.chapterId != null && pos.sceneId != null) "${pos.chapterId}|${pos.sceneId}" else null
        if (posKey != null && posKey != lastPositionKey) {
            expandedScenes.clear()
            expandedScenes.add(posKey)
            lastPositionKey = posKey
        }

        for ((chIdx, ch) in chapters.withIndex()) {
            val chTitle = ch.chapter_title?.take(60)?.replace('\n', ' ')?.trim()
            val isSpecial = ch.is_special
            val chLabel = if (isSpecial) {
                when (ch.type?.lowercase()) {
                    "cover" -> getString(R.string.navigate_cover)
                    "prologue" -> getString(R.string.navigate_prologue)
                    else -> chTitle ?: (ch.type?.replaceFirstChar { it.uppercase() } ?: "")
                }
            } else if (ch.display_number != null) {
                val prefix = "${getString(R.string.navigate_chapter)} ${ch.display_number}"
                if (chTitle != null && chTitle.isNotBlank() && !chTitle.matches(Regex("""^\p{L}+\s+\d+$"""))) {
                    if (chTitle.contains(Regex("""\d"""))) chTitle else "$prefix — $chTitle"
                } else {
                    prefix
                }
            } else if (chTitle != null) {
                chTitle
            } else {
                "${getString(R.string.navigate_chapter)} ${chIdx + 1}"
            }
            val chKey = ch.chapter_id
            val defaultExpanded = chKey == pos.chapterId || chapters.size <= 3
            val expanded = if (chKey != null && chapterExpandedOverrides.containsKey(chKey)) {
                chapterExpandedOverrides[chKey] == true
            } else {
                defaultExpanded
            }
            val chItem = StructureItem.ChapterItem(
                id = ch.chapter_id ?: "ch$chIdx",
                label = chLabel,
                type = ch.type,
                expanded = expanded,
                scenes = ch.scenes ?: emptyList(),
                chapterId = ch.chapter_id
            )
            items.add(chItem)

            if (chItem.expanded) {
                val scenes = ch.scenes ?: emptyList()
                for ((scIdx, sc) in scenes.withIndex()) {
                    val scTitle = sc.scene_title?.take(60)?.replace('\n', ' ')?.trim()
                    val scNum = sc.display_index ?: (scIdx + 1)
                    val scLabel = if (scTitle != null) "${getString(R.string.navigate_scene)} $scNum — $scTitle"
                        else "${getString(R.string.navigate_scene)} $scNum"
                    val isCurrentScene = ch.chapter_id == pos.chapterId && sc.scene_id == pos.sceneId
                    val scItem = StructureItem.SceneItem(
                        id = sc.scene_id ?: "sc$scIdx",
                        label = scLabel,
                        type = sc.type,
                        style = sc.style,
                        expanded = ch.chapter_id != null && sc.scene_id != null &&
                                expandedScenes.contains("${ch.chapter_id}|${sc.scene_id}"),
                        units = sc.units ?: emptyList(),
                        chapterId = ch.chapter_id,
                        sceneId = sc.scene_id
                    )
                    items.add(scItem)

                    if (scItem.expanded) {
                        for ((uIdx, u) in sc.units.orEmpty().withIndex()) {
                            val textPreview = u.text?.replace('\n', ' ')?.trim()
                            val uLabel = if (textPreview != null) "${getString(R.string.navigate_unit)} ${uIdx + 1} — $textPreview" else "${getString(R.string.navigate_unit)} ${uIdx + 1}"
                            val isActive = isCurrentScene && uIdx == pos.unitIndex
                            items.add(
                                StructureItem.UnitItem(
                                    id = u.id ?: "u$uIdx",
                                    label = uLabel,
                                    type = u.type,
                                    isActive = isActive,
                                    unit = u,
                                    index = uIdx,
                                    chapterId = ch.chapter_id,
                                    sceneId = sc.scene_id
                                )
                            )
                        }
                    }
                }
            }
        }

        adapter.submitList(items)
        scrollToActivePosition()
    }

    private fun scrollToActivePosition() {
        val pos = SharedPositionManager.current.value
        if (pos.chapterId == null) return
        val activeIndex = adapter.items.indexOfFirst {
            it is StructureItem.UnitItem && it.isActive
        }
        if (activeIndex >= 0) {
            binding?.structureList?.post {
                binding?.structureList?.smoothScrollToPosition(activeIndex)
            }
        }
    }



    override fun onHiddenChanged(hidden: Boolean) {
        super.onHiddenChanged(hidden)
        if (!hidden) {
            lastPositionKey = null
            // Chapters collapse back to the default rule (current chapter or ≤3
            // chapters expanded) on re-entry — the fragment instance survives tab
            // switches, so the override map must be reset explicitly. Scenes are
            // already reset via lastPositionKey=null below; web parity: the web
            // page remounts on entry and starts with an empty override map.
            chapterExpandedOverrides.clear()
            loadBook()
        }
    }

    private fun loadUnitPreview(item: StructureItem.UnitItem, imageView: ImageView) {
        val bookId = viewModel.bookId.takeIf { it.isNotBlank() } ?: return
        val chId = item.chapterId ?: return
        val scId = item.sceneId ?: return
        val iuId = item.unit.id ?: "iu${String.format("%04d", item.index)}"
        lifecycleScope.launch {
            val bytes = viewModel.repository.getIuPreview(bookId, chId, scId, iuId, viewModel.buildId)
            if (bytes != null) {
                val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                if (bmp != null) {
                    imageView.setImageBitmap(bmp)
                } else {
                    imageView.setImageResource(R.drawable.ic_image_off)
                }
            } else {
                imageView.setImageResource(R.drawable.ic_image_off)
                imageView.imageTintList = android.content.res.ColorStateList.valueOf(
                    MaterialColors.getColor(imageView, com.google.android.material.R.attr.colorOnSurfaceVariant)
                )
            }
        }
    }

    override fun onDestroyView() {
        binding = null
        super.onDestroyView()
    }
}

sealed interface StructureItem {
    val id: String
    data class ChapterItem(
        override val id: String,
        val label: String,
        val type: String?,
        var expanded: Boolean,
        val scenes: List<Scene>,
        val chapterId: String? = null
    ) : StructureItem

    data class SceneItem(
        override val id: String,
        val label: String,
        val type: String?,
        val style: String?,
        var expanded: Boolean,
        val units: List<SceneUnit>,
        val chapterId: String?,
        val sceneId: String?
    ) : StructureItem

    data class UnitItem(
        override val id: String,
        val label: String,
        val type: String?,
        val isActive: Boolean,
        val unit: SceneUnit,
        val index: Int,
        val chapterId: String?,
        val sceneId: String?
    ) : StructureItem
}

class BookStructureAdapter(
    private val onClick: (StructureItem) -> Unit,
    private val previewLoader: (StructureItem.UnitItem, ImageView) -> Unit,
    private val onReorder: (List<ReorderChapter>) -> Unit
) : RecyclerView.Adapter<BookStructureAdapter.ViewHolder>() {

    var items: List<StructureItem> = emptyList()
        private set

    fun submitList(newItems: List<StructureItem>) {
        val old = items
        items = newItems
        val diff = DiffUtil.calculateDiff(object : DiffUtil.Callback() {
            override fun getOldListSize() = old.size
            override fun getNewListSize() = newItems.size
            override fun areItemsTheSame(oi: Int, ni: Int) = old[oi].id == newItems[ni].id
            override fun areContentsTheSame(oi: Int, ni: Int) = old[oi] == newItems[ni]
        })
        diff.dispatchUpdatesTo(this)
    }

    fun moveItem(from: Int, to: Int) {
        val mutable = items.toMutableList()
        val moved = mutable.removeAt(from)
        mutable.add(to, moved)
        items = mutable
        notifyItemMoved(from, to)
    }

    override fun getItemViewType(position: Int): Int {
        return when (items[position]) {
            is StructureItem.ChapterItem -> 0
            is StructureItem.SceneItem -> 1
            is StructureItem.UnitItem -> 2
        }
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): ViewHolder {
        val ctx = parent.context
        val card = MaterialCardView(ctx).apply {
            layoutParams = ViewGroup.MarginLayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).also { it.setMargins(0, 0, 0, 4) }
            radius = 12f
            cardElevation = 0f
            isClickable = true
            isFocusable = true
        }
        val ll = LinearLayout(ctx).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
            orientation = LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER_VERTICAL
        }
        val iv = ImageView(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(
                44, 44
            ).also { it.setMargins(0, 0, 0, 0) }
            scaleType = ImageView.ScaleType.CENTER_CROP
            visibility = View.GONE
        }
        ll.addView(iv)
        val text = TextView(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f
            )
            textSize = 14f
            setPadding(12, 14, 16, 14)
        }
        ll.addView(text)
        card.addView(ll)
        return ViewHolder(card, iv, text)
    }

    override fun onBindViewHolder(holder: ViewHolder, position: Int) {
        val item = items[position]
        val ctx = holder.itemView.context
        val secondary = MaterialColors.getColor(ctx, com.google.android.material.R.attr.colorSecondary, 0)
        val onSurface = MaterialColors.getColor(ctx, com.google.android.material.R.attr.colorOnSurface, 0)
        val onSurfaceVariant = MaterialColors.getColor(ctx, com.google.android.material.R.attr.colorOnSurfaceVariant, 0)

        when (item) {
            is StructureItem.ChapterItem -> {
                holder.imageView.visibility = View.GONE
                val indent = 8
                holder.textView.setPadding(indent * 2, 14, 16, 14)
                holder.textView.text = item.label
                holder.textView.setTextColor(secondary)
                holder.textView.textSize = 15f
                holder.textView.setTypeface(null, android.graphics.Typeface.BOLD)
                holder.card.setCardBackgroundColor(
                    MaterialColors.getColor(ctx, com.google.android.material.R.attr.colorSurface, 0)
                )
                holder.card.setOnClickListener { onClick(item) }
            }
            is StructureItem.SceneItem -> {
                holder.imageView.visibility = View.GONE
                val indent = 24
                holder.textView.setPadding(indent * 2, 12, 16, 12)
                holder.textView.text = if (item.style != null) "${item.label} — ${item.type} (${item.style})"
                    else "${item.label} (${item.type ?: ctx.getString(R.string.navigate_scene_type)})"
                holder.textView.setTextColor(onSurface)
                holder.textView.textSize = 14f
                holder.textView.setTypeface(null, android.graphics.Typeface.NORMAL)
                holder.card.setCardBackgroundColor(
                    MaterialColors.getColor(ctx, com.google.android.material.R.attr.colorSurfaceVariant, 0)
                )
                holder.card.setOnClickListener { onClick(item) }
            }
            is StructureItem.UnitItem -> {
                holder.textView.setPadding(12, 10, 16, 10)
                val typeTag = if (item.type != null) "[${item.type}] " else ""
                holder.textView.text = "$typeTag${item.label}"
                holder.textView.textSize = 13f
                holder.textView.maxLines = 1
                holder.textView.ellipsize = android.text.TextUtils.TruncateAt.END
                holder.textView.setTypeface(null, if (item.isActive) android.graphics.Typeface.BOLD else android.graphics.Typeface.NORMAL)
                holder.textView.setTextColor(if (item.isActive) secondary else onSurfaceVariant)
                holder.card.setCardBackgroundColor(
                    if (item.isActive) MaterialColors.getColor(ctx, com.google.android.material.R.attr.colorSecondaryContainer, 0)
                    else MaterialColors.getColor(ctx, com.google.android.material.R.attr.colorSurface, 0)
                )
                holder.imageView.visibility = View.VISIBLE
                holder.imageView.imageTintList = null
                holder.imageView.setImageResource(R.drawable.ic_image_off)
                previewLoader(item, holder.imageView)
                holder.card.setOnClickListener { onClick(item) }
            }
        }
    }

    override fun getItemCount() = items.size

    class ViewHolder(
        val card: MaterialCardView,
        val imageView: ImageView,
        val textView: TextView
    ) : RecyclerView.ViewHolder(card)
}

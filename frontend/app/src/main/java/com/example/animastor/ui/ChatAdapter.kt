package com.example.animastor.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.TextView
import android.widget.Toast
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.example.animastor.R
import com.google.android.material.color.MaterialColors
import android.graphics.drawable.GradientDrawable

class ChatAdapter : ListAdapter<ChatMessage, RecyclerView.ViewHolder>(DiffCallback()) {

    private companion object {
        private const val TYPE_USER = 0
        private const val TYPE_ASSISTANT = 1
        private const val TYPE_TYPING = 2
    }

    override fun getItemViewType(position: Int): Int {
        val msg = getItem(position)
        if (msg.isTyping) return TYPE_TYPING
        return if (msg.isUser) TYPE_USER else TYPE_ASSISTANT
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
        return when (viewType) {
            TYPE_TYPING -> {
                val view = LayoutInflater.from(parent.context)
                    .inflate(R.layout.item_chat_typing, parent, false)
                TypingViewHolder(view as FrameLayout)
            }
            else -> {
                val view = LayoutInflater.from(parent.context)
                    .inflate(R.layout.item_chat_message, parent, false)
                MessageViewHolder(view as FrameLayout)
            }
        }
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
        val msg = getItem(position)
        when (holder) {
            is MessageViewHolder -> holder.bind(msg)
            is TypingViewHolder -> holder.bind()
        }
    }

    class MessageViewHolder(private val container: FrameLayout) : RecyclerView.ViewHolder(container) {
        fun bind(msg: ChatMessage) {
            val ctx = container.context
            val wrapper = container.getChildAt(0) as FrameLayout
            val bubble = wrapper.getChildAt(0) as TextView
            val copyButton = wrapper.getChildAt(1) as ImageButton

            msg.applyMarkdownTo(bubble)

            val density = ctx.resources.displayMetrics.density
            val r = (16 * density).toFloat()

            val (bgColor, fgColor, corners) = if (msg.isUser) {
                val bg = MaterialColors.getColor(ctx, com.google.android.material.R.attr.colorSecondaryContainer, 0)
                val fg = MaterialColors.getColor(ctx, com.google.android.material.R.attr.colorOnSecondaryContainer, 0)
                Triple(bg, fg, floatArrayOf(r, r, r, r, r, r, 0f, 0f))
            } else {
                val bg = MaterialColors.getColor(ctx, com.google.android.material.R.attr.colorSurfaceVariant, 0)
                val fg = MaterialColors.getColor(ctx, com.google.android.material.R.attr.colorOnSurfaceVariant, 0)
                Triple(bg, fg, floatArrayOf(0f, 0f, r, r, r, r, r, r))
            }

            bubble.setTextColor(fgColor)
            bubble.background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadii = corners
                setColor(bgColor)
            }

            // Gravity on the wrapper, not the bubble — positions the entire group
            val lp = wrapper.layoutParams as FrameLayout.LayoutParams
            lp.gravity = if (msg.isUser) Gravity.END else Gravity.START
            wrapper.layoutParams = lp

            // ── Copy button (bottom-right corner INSIDE bubble) ────────
            copyButton.visibility = View.VISIBLE
            copyButton.setOnClickListener {
                val clipboard = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                clipboard.setPrimaryClip(ClipData.newPlainText("chat", msg.text))
                Toast.makeText(ctx, ctx.getString(R.string.copied_to_clipboard), Toast.LENGTH_SHORT).show()
            }

            // ── Text is selectable via standard Android long-press (textIsSelectable=true in XML) ──
            // No custom onLongClickListener — the default text selection handles it.
        }
    }

    class TypingViewHolder(private val container: FrameLayout) : RecyclerView.ViewHolder(container) {
        private val dots: List<View>
        private val handler = Handler(Looper.getMainLooper())
        private var animIndex = 0
        private var running = false

        init {
            val bubble = container.getChildAt(0) as ViewGroup
            dots = (0 until 3).map { bubble.getChildAt(it) }
        }

        fun bind() {
            running = true
            animIndex = 0
            handler.post(animationRunnable)
        }

        private val animationRunnable = object : Runnable {
            override fun run() {
                if (!running) return
                dots.forEachIndexed { i, dot ->
                    dot.alpha = if (i == animIndex % 3) 1.0f else 0.25f
                }
                animIndex = (animIndex + 1) % 4
                handler.postDelayed(this, 300)
            }
        }

        fun detach() {
            running = false
            handler.removeCallbacks(animationRunnable)
        }
    }

    private class DiffCallback : DiffUtil.ItemCallback<ChatMessage>() {
        override fun areItemsTheSame(a: ChatMessage, b: ChatMessage) = a === b
        override fun areContentsTheSame(a: ChatMessage, b: ChatMessage) = a == b
    }
}

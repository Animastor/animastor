package com.example.animastor.ui

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.util.AttributeSet
import android.util.TypedValue
import android.view.MotionEvent
import android.view.View
import androidx.core.content.ContextCompat
import com.example.animastor.R
import com.example.animastor.repository.WaveformPeak
import com.google.android.material.color.MaterialColors

class WaveformView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0
) : View(context, attrs, defStyleAttr) {

    private val waveformPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0x8890CAF9.toInt()
        strokeWidth = 1.5f
        strokeCap = Paint.Cap.ROUND
    }

    private val selectionPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0x3390CAF9.toInt()
        style = Paint.Style.FILL
    }

    private val handlePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFFFFB74D.toInt()
        strokeWidth = 3f
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
    }

    private val handleFillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFFFFB74D.toInt()
        style = Paint.Style.FILL
    }

    private val playheadPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFFFFFFFF.toInt()
        strokeWidth = 2.5f
    }

    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = themeTextColor()
        textSize = 24f
        textAlign = Paint.Align.CENTER
    }

    private val timeTextPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = themeTextColor()
        // 14sp — matches the edit content field text ("table under the tabs").
        textSize = TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_SP, 14f, resources.displayMetrics
        )
        textAlign = Paint.Align.CENTER
    }

    /** Waveform label color from the active theme (waveformTimingText): near-white
     *  in dark, accent gold #C9A15A in light (active property-tab text). */
    private fun themeTextColor(): Int = MaterialColors.getColor(
        context,
        R.attr.waveformTimingText,
        0xFFF2E9DC.toInt()
    )

    private val selectionBorderPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0x55FFB74D.toInt()
        style = Paint.Style.STROKE
        strokeWidth = 1f
    }

    private val touchSlop = 24f

    private var peaks: List<WaveformPeak> = emptyList()
    private var totalDurationMs: Long = 0L
    private var selectionStartMs: Long = 0L
    private var selectionEndMs: Long = 0L
    private var currentUnitId: String = ""
    private var playbackPositionMs: Long = -1L

    private enum class DragTarget { NONE, START, END }
    private var dragTarget = DragTarget.NONE

    var onRangeChangeListener: ((startMs: Long, endMs: Long) -> Unit)? = null
    var onRangeChangeEndListener: ((startMs: Long, endMs: Long) -> Unit)? = null

    fun setPeaks(newPeaks: List<WaveformPeak>) {
        peaks = newPeaks
        invalidate()
    }

    fun setDurationMs(durationMs: Long) {
        totalDurationMs = durationMs
        invalidate()
    }

    fun setSelectionRange(startMs: Long, endMs: Long, unitId: String = "") {
        selectionStartMs = startMs.coerceIn(0, totalDurationMs)
        selectionEndMs = endMs.coerceIn(selectionStartMs, totalDurationMs)
        if (selectionEndMs <= selectionStartMs) {
            selectionEndMs = (selectionStartMs + 1).coerceAtMost(totalDurationMs)
        }
        currentUnitId = unitId
        invalidate()
    }

    fun setPlaybackPosition(positionMs: Long) {
        playbackPositionMs = positionMs
        invalidate()
    }

    fun clearPlaybackPosition() {
        playbackPositionMs = -1L
        invalidate()
    }

    private fun msToX(ms: Long, drawWidth: Float): Float {
        if (totalDurationMs <= 0) return 0f
        return (ms.toFloat() / totalDurationMs.toFloat()) * drawWidth
    }

    private fun xToMs(x: Float, drawWidth: Float): Long {
        if (totalDurationMs <= 0) return 0L
        return ((x / drawWidth) * totalDurationMs.toFloat()).toLong().coerceIn(0, totalDurationMs)
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0 || h <= 0) return

        val pad = 12f
        val drawLeft = pad
        val drawRight = w - pad
        val drawWidth = drawRight - drawLeft
        val midY = h / 2f

        drawWaveform(canvas, drawLeft, drawWidth, midY)
        drawSelection(canvas, drawLeft, drawWidth, h)
        drawHandles(canvas, drawLeft, drawWidth, midY, h)
        drawPlayhead(canvas, drawLeft, drawWidth, h)
        drawTimeLabels(canvas, drawLeft, drawWidth, h)
    }

    private fun drawWaveform(canvas: Canvas, left: Float, drawWidth: Float, midY: Float) {
        if (peaks.isEmpty()) {
            canvas.drawText("No waveform data", width / 2f, midY, textPaint)
            return
        }

        val barCount = peaks.size
        val barWidth = drawWidth / barCount

        for (i in peaks.indices) {
            val peak = peaks[i]
            val x = left + i * barWidth + barWidth / 2f
            val posHeight = (peak.pos.toFloat() * midY * 0.9f).coerceAtMost(midY - 4f)
            val negHeight = (Math.abs(peak.neg.toFloat()) * midY * 0.9f).coerceAtMost(midY - 4f)

            canvas.drawLine(x, midY - posHeight, x, midY + negHeight, waveformPaint)
        }
    }

    private fun drawSelection(canvas: Canvas, left: Float, drawWidth: Float, h: Float) {
        val selLeft = left + msToX(selectionStartMs, drawWidth)
        var selRight = left + msToX(selectionEndMs, drawWidth)
        if (selRight <= selLeft) selRight = selLeft + 4f

        val rect = RectF(selLeft, 0f, selRight, h)
        canvas.drawRect(rect, selectionPaint)
        canvas.drawRect(selLeft, 0f, selRight, h, selectionBorderPaint)
    }

    private fun drawHandles(canvas: Canvas, left: Float, drawWidth: Float, midY: Float, h: Float) {
        val selLeft = left + msToX(selectionStartMs, drawWidth)
        var selRight = left + msToX(selectionEndMs, drawWidth)
        if (selRight <= selLeft) selRight = selLeft + 4f
        val handleRadius = 8f

        canvas.drawLine(selLeft, 0f, selLeft, h, handlePaint)
        canvas.drawCircle(selLeft, midY, handleRadius, handleFillPaint)
        canvas.drawCircle(selLeft, midY - 16f, 3f, handleFillPaint)
        canvas.drawCircle(selLeft, midY + 16f, 3f, handleFillPaint)

        canvas.drawLine(selRight, 0f, selRight, h, handlePaint)
        canvas.drawCircle(selRight, midY, handleRadius, handleFillPaint)
        canvas.drawCircle(selRight, midY - 16f, 3f, handleFillPaint)
        canvas.drawCircle(selRight, midY + 16f, 3f, handleFillPaint)
    }

    private fun drawPlayhead(canvas: Canvas, left: Float, drawWidth: Float, h: Float) {
        if (playbackPositionMs < 0) return

        val px = left + msToX(playbackPositionMs, drawWidth)
        canvas.drawLine(px, 0f, px, h, playheadPaint)

        val triangleSize = 8f
        canvas.drawLine(px, 0f, px - triangleSize, -triangleSize, playheadPaint)
        canvas.drawLine(px, 0f, px + triangleSize, -triangleSize, playheadPaint)
        canvas.drawLine(px - triangleSize, -triangleSize, px + triangleSize, -triangleSize, playheadPaint)
    }

    private fun drawTimeLabels(canvas: Canvas, left: Float, drawWidth: Float, h: Float) {
        val selLeft = left + msToX(selectionStartMs, drawWidth)
        val selRight = left + msToX(selectionEndMs, drawWidth)

        val startLabel = formatMs(selectionStartMs)
        val endLabel = formatMs(selectionEndMs)

        val labelY = h - 6f
        val w = width.toFloat()

        // Start label: outside the range, to the left of its left border
        // (right-aligned). Clamped so it never falls off the left edge when the
        // range is expanded over the whole audio.
        timeTextPaint.textAlign = Paint.Align.RIGHT
        val startX = Math.max(selLeft - 6f, timeTextPaint.measureText(startLabel))
        canvas.drawText(startLabel, startX, labelY, timeTextPaint)

        // End label: outside the range, to the right of its right border
        // (left-aligned). Clamped so it never falls off the right edge when the
        // range is expanded over the whole audio.
        timeTextPaint.textAlign = Paint.Align.LEFT
        val endX = Math.max(
            Math.min(selRight + 6f, w - timeTextPaint.measureText(endLabel)),
            startX
        )
        canvas.drawText(endLabel, endX, labelY, timeTextPaint)

        val totalLabel = formatMs(totalDurationMs)
        timeTextPaint.textAlign = Paint.Align.LEFT
        canvas.drawText(totalLabel, left + 2f, 16f, timeTextPaint)
    }

    private fun formatMs(ms: Long): String {
        val totalSec = ms / 1000
        val minutes = totalSec / 60
        val seconds = totalSec % 60
        val millis = ms % 1000 / 100
        return "%d:%02d.%d".format(minutes, seconds, millis)
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (totalDurationMs <= 0) return false

        val pad = 12f
        val drawLeft = pad
        val drawRight = width - pad
        val drawWidth = drawRight - drawLeft

        val selLeft = drawLeft + msToX(selectionStartMs, drawWidth)
        val selRight = drawLeft + msToX(selectionEndMs, drawWidth)

        when (event.action) {
            MotionEvent.ACTION_DOWN -> {
                val x = event.x
                val distToStart = Math.abs(x - selLeft)
                val distToEnd = Math.abs(x - selRight)

                dragTarget = when {
                    distToStart < touchSlop * 2 -> DragTarget.START
                    distToEnd < touchSlop * 2 -> DragTarget.END
                    else -> DragTarget.NONE
                }
                if (dragTarget != DragTarget.NONE) {
                    parent?.requestDisallowInterceptTouchEvent(true)
                }
                return dragTarget != DragTarget.NONE
            }
            MotionEvent.ACTION_MOVE -> {
                if (dragTarget == DragTarget.NONE) return false
                val x = event.x - drawLeft
                val ms = xToMs(x.coerceIn(0f, drawWidth), drawWidth)

                when (dragTarget) {
                    DragTarget.START -> {
                        val clampedMs = ms.coerceAtMost(selectionEndMs - 50)
                        if (clampedMs != selectionStartMs) {
                            selectionStartMs = clampedMs
                            onRangeChangeListener?.invoke(selectionStartMs, selectionEndMs)
                            invalidate()
                        }
                    }
                    DragTarget.END -> {
                        val clampedMs = ms.coerceIn(selectionStartMs + 50, totalDurationMs)
                        if (clampedMs != selectionEndMs) {
                            selectionEndMs = clampedMs
                            onRangeChangeListener?.invoke(selectionStartMs, selectionEndMs)
                            invalidate()
                        }
                    }
                    else -> {}
                }
                return true
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                if (dragTarget != DragTarget.NONE) {
                    onRangeChangeEndListener?.invoke(selectionStartMs, selectionEndMs)
                }
                dragTarget = DragTarget.NONE
                parent?.requestDisallowInterceptTouchEvent(false)
                return true
            }
        }
        return super.onTouchEvent(event)
    }
}

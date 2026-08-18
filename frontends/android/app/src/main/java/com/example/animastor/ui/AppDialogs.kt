package com.example.animastor.ui

import android.content.Context
import android.graphics.Typeface
import android.view.LayoutInflater
import android.view.View
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import com.example.animastor.R
import com.google.android.material.button.MaterialButton
import com.google.android.material.color.MaterialColors

/**
 * Web-parity action dialogs — the same composition as the web Modals
 * (title / body / right-aligned footer with compact full buttons), mirroring
 * the web's `.modal__title` / `.modal__body` / `.modal__footer` spacing:
 *
 *   title   16sp bold, padding 16/20/4/20 dp
 *   body    content padded 12 top / 20 sides (scrolls, capped)
 *   footer  outlined cancel + filled primary (save/start/ok) or filled
 *           destructive (delete), 8dp gap, padded 12 top / 20 sides / 20 bottom
 *
 * M3's AlertDialog gives custom views zero padding, so everything is laid out
 * explicitly here. Colors come from the platform theme (colorPrimary /
 * colorError + colorOnError), never from the web palette.
 */
object AppDialogs {

    /**
     * Builds an AlertDialog with [title], [content] and a bottom action row.
     * Cancel always dismisses; [onAction] receives the dialog so callers can
     * keep it open on validation errors (add form) or dismiss and act.
     */
    fun action(
        ctx: Context,
        title: String,
        content: View,
        cancelText: String,
        actionText: String,
        destructive: Boolean = false,
        onAction: (dialog: AlertDialog) -> Unit,
    ): AlertDialog {
        val dm = ctx.resources.displayMetrics
        fun dp(v: Int) = (v * dm.density + 0.5f).toInt()
        // Hard content cap — never let the body alone exceed half the screen.
        val contentMaxHeight = (ctx.resources.displayMetrics.heightPixels * 0.45f).toInt()

        val titleView = TextView(ctx).apply {
            text = title
            textSize = 16f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurface))
            setPadding(dp(20), dp(16), dp(20), dp(4))
        }

        val footer = LayoutInflater.from(ctx).inflate(R.layout.dialog_action_footer, null) as LinearLayout
        val cancel = footer.findViewById<MaterialButton>(R.id.dialogCancelButton)
        val actionBtn = footer.findViewById<MaterialButton>(R.id.dialogActionButton)
        cancel.text = cancelText
        actionBtn.text = actionText
        if (destructive) {
            // Filled destructive: colorError background + white label. The
            // theme's colorOnError is dark in the light theme (reads as black
            // on the rose fill), so the destructive label is explicitly white
            // for a clear "danger" hierarchy — same role as the web's dark-red
            // button with its near-white text.
            actionBtn.backgroundTintList = android.content.res.ColorStateList.valueOf(
                MaterialColors.getColor(actionBtn, com.google.android.material.R.attr.colorError),
            )
            actionBtn.setTextColor(android.graphics.Color.WHITE)
        }
        // Footer insets (web .modal__footer: 0.75rem 1.25rem 1.25rem) — the top
        // gap is the layout margin below, sides/bottom live on the row itself.
        // The bottom padding is generous so the outlined stroke never touches
        // the dialog's bottom edge / rounded corners.
        footer.setPadding(dp(20), 0, dp(20), dp(28))

        // Body insets (web .modal__body: 0.75rem 1.25rem) live on the scroll
        // container, so caller content (form / notice panel / list) carries no
        // outer padding of its own.
        val scroll = ScrollView(ctx).apply {
            setPadding(dp(20), dp(12), dp(20), 0)
            addView(content)
        }

        // The dialog window is height-constrained (and shrinks with the IME
        // open); AlertDialogLayout + LinearLayout clip overflow at the bottom,
        // which would slice the footer buttons. This root measures the title
        // and footer first, then caps the scroll to the remaining space so the
        // footer is ALWAYS fully visible.
        val footerTop = dp(12)
        val root = object : LinearLayout(ctx) {
            override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
                val w = MeasureSpec.getSize(widthMeasureSpec)
                fun measureWrap(v: View): Int {
                    v.measure(
                        MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY),
                        MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED),
                    )
                    return v.measuredHeight
                }
                val titleH = measureWrap(titleView)
                val footerH = measureWrap(footer)
                val extra = titleH + footerTop + footerH
                val avail = when (MeasureSpec.getMode(heightMeasureSpec)) {
                    MeasureSpec.UNSPECIFIED -> contentMaxHeight
                    else -> (MeasureSpec.getSize(heightMeasureSpec) - extra).coerceAtLeast(0)
                }
                val scrollMax = minOf(contentMaxHeight, avail)
                scroll.measure(
                    MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY),
                    MeasureSpec.makeMeasureSpec(scrollMax, MeasureSpec.AT_MOST),
                )
                setMeasuredDimension(w, resolveSize(extra + scroll.measuredHeight, heightMeasureSpec))
            }
        }
        root.orientation = LinearLayout.VERTICAL
        root.addView(titleView, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        root.addView(scroll, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        root.addView(
            footer,
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
                .apply { topMargin = footerTop },
        )

        val dialog = AlertDialog.Builder(ctx)
            .setView(root)
            .create()

        // Web-parity dialog surface: the theme's window background rendered a
        // flat greyish panel in the dark theme; the web modal instead uses the
        // theme surface (--surface ≈ colorSurface) with a thin outline border
        // (--outline-2 ≈ colorOutlineVariant) and --radius-md corners. Set the
        // window background explicitly so the surface relationship (app bg →
        // dialog surface → hairline border) matches the web in both themes.
        dialog.window?.setBackgroundDrawable(
            android.graphics.drawable.GradientDrawable().apply {
                cornerRadius = (18 * dm.density + 0.5f).toInt().toFloat()
                setColor(MaterialColors.getColor(root, com.google.android.material.R.attr.colorSurface))
                setStroke(dp(1), MaterialColors.getColor(root, com.google.android.material.R.attr.colorOutlineVariant))
            },
        )

        cancel.setOnClickListener { dialog.dismiss() }
        actionBtn.setOnClickListener { onAction(dialog) }
        return dialog
    }
}

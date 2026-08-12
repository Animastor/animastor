package com.example.animastor.ui

import android.text.Html
import android.widget.TextView

data class ChatMessage(
    val text: String,
    val isUser: Boolean,
    val downloadUrl: String? = null,
    val isTyping: Boolean = false
) : java.io.Serializable {
    fun applyMarkdownTo(textView: TextView) {
        if (isTyping) return
        var processed = text

        // Escape HTML entities first
        processed = processed.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

        // ```code block``` -> <pre><code>
        processed = processed.replace(Regex("```(\\w*)\\n?(.*?)```", RegexOption.DOT_MATCHES_ALL)) { match ->
            val code = match.groupValues[2]
            "<pre style=\"background:#25211E;padding:8dp;border-radius:8dp\"><code>${code.trim()}</code></pre>"
        }

        // `inline code` -> <code>
        processed = processed.replace(Regex("`([^`]*)`"), "<code>$1</code>")

        // **text** -> <b>text</b>
        processed = processed.replace(Regex("\\*\\*(.*?)\\*\\*"), "<b>$1</b>")

        // *text* -> <i>text</i> (not inside words)
        processed = processed.replace(Regex("(?<![\\w*])\\*(?!\\*)([^*]+)\\*(?![\\w*])"), "<i>$1</i>")

        // [text](url) -> <a href="url">text</a>
        processed = processed.replace(Regex("\\[([^]]+)\\]\\(([^)]+)\\)"), "<a href=\"$2\">$1</a>")

        // > quote -> blockquote
        processed = processed.replace(Regex("^&gt;\\s?(.*)$", RegexOption.MULTILINE)) { match ->
            "<blockquote style=\"border-left:3px solid gray;padding-left:8dp;margin:4dp 0\">${match.groupValues[1]}</blockquote>"
        }

        // - list item -> <ul><li>
        processed = processed.replace(Regex("^-\\s+(.*)$", RegexOption.MULTILINE)) { match ->
            "<li>${match.groupValues[1]}</li>"
        }

        // 1. ordered item -> <ol><li>
        processed = processed.replace(Regex("^\\d+\\.\\s+(.*)$", RegexOption.MULTILINE)) { match ->
            "<li>${match.groupValues[1]}</li>"
        }

        // Wrap consecutive <li> in <ul> or <ol>
        processed = processed.replace(Regex("(<li>.*?</li>\\s*)+")) { match ->
            "<ul>${match.value}</ul>"
        }

        // # heading -> plain text bold
        processed = processed.replace(Regex("^#{1,6}\\s+(.*)$", RegexOption.MULTILINE)) { match ->
            "<b>${match.groupValues[1]}</b><br/>"
        }

        // Double newline -> paragraph break
        processed = processed.replace(Regex("\\n\\n"), "<br/><br/>")
        // Single newline -> <br/>
        processed = processed.replace(Regex("\\n"), "<br/>")

        // Convert HTML to Spanned
        val spanned = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.N) {
            Html.fromHtml(processed, Html.FROM_HTML_MODE_LEGACY)
        } else {
            @Suppress("DEPRECATION")
            Html.fromHtml(processed)
        }

        textView.text = spanned
    }
}

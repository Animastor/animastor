package com.animastor.desktop

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.Bundle
import android.util.Base64
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.webkit.CookieManager
import android.webkit.HttpAuthHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebViewDatabase
import android.widget.EditText
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import java.io.ByteArrayInputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.util.zip.GZIPInputStream

/**
 * Animastor Desktop Tester — «эмулятор десктопа» для Android-планшета.
 *
 * Открывает ту же страницу, что и mobile-web-tester, но по-десктопному:
 *  - WebView занимает ВЕСЬ экран (без рамки «телефона»);
 *  - десктопный user-agent;
 *  - ширина CSS viewport принудительно задаётся 1280/1366/1440/1920 px
 *    (в HTML главного фрейма переписывается <meta name="viewport">),
 *    поэтому включается десктопный шелл (порог >= 1180px);
 *  - страница автоматически уменьшается, чтобы поместиться целиком
 *    (loadWithOverviewMode) — «мелко, но видно весь десктоп»; pinch-zoom
 *    доступен для разглядывания деталей.
 */
class MainActivity : Activity() {

    // Viewport presets: label, CSS px width
    private val viewports = listOf(
        Pair("1280", 1280),
        Pair("1366", 1366),
        Pair("1440", 1440),
        Pair("1920", 1920),
    )

    // Typical modern desktop Chrome UA — pure CSS/UA emulation, no hardware emulation.
    private val desktopUA =
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

    private lateinit var prefs: SharedPreferences
    private lateinit var webView: WebView
    private lateinit var urlInput: EditText
    private lateinit var progress: ProgressBar
    private lateinit var chipContainer: LinearLayout

    private val chips = mutableListOf<TextView>()
    private var currentViewport = 1 // 1366 by default

    // Read on the WebView interceptor thread, written on the UI thread.
    @Volatile
    private var currentCssWidth = BuildConfig.DEFAULT_WIDTH

    // Basic Auth для app.animastor.in (см. proxy/conf/.htpasswd) — те же креды,
    // что зашиты в mobile-web-tester.
    private val authHeader by lazy {
        "Basic " + Base64.encodeToString(
            "$AUTH_USER:$AUTH_PASS".toByteArray(StandardCharsets.UTF_8),
            Base64.NO_WRAP
        )
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        prefs = getSharedPreferences("desktop_web_tester", Context.MODE_PRIVATE)
        bindViews()
        buildViewportChips()
        setupWebView()
        wireActions()

        urlInput.setText(prefs.getString(PREF_URL, BuildConfig.DEFAULT_URL))
        val savedViewport = prefs.getInt(PREF_VIEWPORT, 1).coerceIn(0, viewports.lastIndex)
        applyViewport(savedViewport, reload = false)
        loadCurrentUrl()
    }

    // ═══════════════════════════════════════════════════════════════════
    //  UI wiring
    // ═══════════════════════════════════════════════════════════════════

    private fun bindViews() {
        webView = findViewById(R.id.webView)
        urlInput = findViewById(R.id.urlInput)
        progress = findViewById(R.id.progress)
        chipContainer = findViewById(R.id.chipContainer)
    }

    private fun buildViewportChips() {
        viewports.forEachIndexed { i, vp ->
            val chip = TextView(this).apply {
                text = vp.first
                textSize = 12f
                isClickable = true
                isFocusable = true
                gravity = Gravity.CENTER
                setPadding(dp(10), dp(6), dp(10), dp(6))
                setOnClickListener { applyViewport(i, reload = true) }
            }
            chipContainer.addView(
                chip,
                LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                    marginStart = dp(2); marginEnd = dp(2)
                }
            )
            chips.add(chip)
        }
    }

    private fun wireActions() {
        findViewById<ImageButton>(R.id.reloadBtn).setOnClickListener {
            loadCurrentUrl()
        }
        findViewById<ImageButton>(R.id.reloadBtn).setOnLongClickListener {
            clearWebViewData()
            Toast.makeText(this, R.string.toast_cleared, Toast.LENGTH_SHORT).show()
            true
        }
        findViewById<android.widget.Button>(R.id.openBtn).setOnClickListener {
            loadCurrentUrl()
            hideKeyboard()
        }
        urlInput.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_GO || actionId == EditorInfo.IME_ACTION_DONE) {
                loadCurrentUrl()
                hideKeyboard()
                true
            } else false
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Viewport / loading
    // ═══════════════════════════════════════════════════════════════════

    private fun applyViewport(index: Int, reload: Boolean) {
        currentViewport = index
        currentCssWidth = viewports[index].second
        updateChips()
        prefs.edit().putInt(PREF_VIEWPORT, index).apply()
        if (reload) loadCurrentUrl()
    }

    private fun updateChips() {
        chips.forEachIndexed { i, chip ->
            val selected = i == currentViewport
            chip.background = getDrawable(if (selected) R.drawable.bg_chip_selected else R.drawable.bg_chip)
            chip.setTextColor(getColor(if (selected) R.color.bg_root else R.color.text_primary))
        }
    }

    private fun loadCurrentUrl() {
        val raw = urlInput.text.toString().trim()
        if (raw.isEmpty()) return
        val url = if (raw.contains("://")) raw else "http://$raw"
        urlInput.setText(raw)
        prefs.edit().putString(PREF_URL, raw).apply()
        webView.loadUrl(url)
    }

    @Suppress("DEPRECATION")
    private fun clearWebViewData() {
        // removeAllCookies is async — reload only after the cookies are gone.
        CookieManager.getInstance().removeAllCookies {
            runOnUiThread {
                webView.clearCache(true)
                webView.clearHistory()
                webView.clearFormData()
                WebViewDatabase.getInstance(this).clearHttpAuthUsernamePassword()
                loadCurrentUrl()
            }
        }
        CookieManager.getInstance().flush()
    }

    private fun hideKeyboard() {
        val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        imm.hideSoftInputFromWindow(urlInput.windowToken, 0)
    }

    // ═══════════════════════════════════════════════════════════════════
    //  WebView
    // ═══════════════════════════════════════════════════════════════════

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        val s = webView.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true          // localStorage / IndexedDB
        s.mediaPlaybackRequiresUserGesture = false
        s.useWideViewPort = true            // honor the (rewritten) <meta viewport>
        s.loadWithOverviewMode = true       // fit the whole desktop layout into the screen
        s.setSupportZoom(true)              // pinch-zoom to inspect details
        s.builtInZoomControls = true
        s.displayZoomControls = false
        s.userAgentString = desktopUA
        s.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        s.javaScriptCanOpenWindowsAutomatically = true
        s.cacheMode = WebSettings.LOAD_DEFAULT
        s.defaultTextEncodingName = "utf-8"

        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)

        webView.webViewClient = object : WebViewClient() {

            /**
             * Перехватываем HTML главного фрейма и переписываем
             * <meta name="viewport" content="width=device-width, ...">
             * на width=<currentCssWidth>, чтобы страница отрендерилась
             * как на широком десктопном мониторе.
             */
            override fun shouldInterceptRequest(
                view: WebView?,
                request: WebResourceRequest?
            ): WebResourceResponse? {
                val req = request ?: return null
                if (!req.isForMainFrame) return null
                val scheme = req.url.scheme
                if (scheme != "https" && scheme != "http") return null
                val rewritten = fetchHtmlWithDesktopViewport(req.url.toString())
                    ?: return null
                return WebResourceResponse(
                    "text/html",
                    "utf-8",
                    ByteArrayInputStream(rewritten.toByteArray(StandardCharsets.UTF_8))
                )
            }

            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val scheme = request?.url?.scheme
                if (scheme == "http" || scheme == "https") return false // keep in the tester
                request?.url?.let {
                    runCatching { startActivity(Intent(Intent.ACTION_VIEW, it)) }
                }
                return true
            }

            override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
                progress.visibility = View.VISIBLE
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                progress.visibility = View.GONE
                injectFullscreenBlock()
            }

            override fun onReceivedHttpAuthRequest(
                view: WebView?,
                handler: HttpAuthHandler?,
                host: String?,
                realm: String?
            ) {
                // Fallback: если запрос не был перехвачен нами (asset и т.п.),
                // авторизуемся автоматически.
                handler?.proceed(AUTH_USER, AUTH_PASS)
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?
            ) {
                if (request?.isForMainFrame == true) {
                    showErrorPage(request.url.toString(), error?.description?.toString() ?: "network error")
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                if (newProgress < 100) {
                    progress.visibility = View.VISIBLE
                    progress.progress = newProgress
                } else {
                    progress.visibility = View.GONE
                }
            }

            override fun onShowCustomView(view: View?, callback: WebChromeClient.CustomViewCallback?) {
                // Fullscreen is disabled in this tester: reject any custom view
                // (video fullscreen) request immediately so it never covers the app.
                callback?.onCustomViewHidden()
            }

            override fun onHideCustomView() {
                // nothing to do — fullscreen is disabled
            }
        }
    }

    /**
     * Скачивает HTML главного фрейма (с Basic Auth и Accept-Encoding: identity)
     * и заменяет width=device-width в <meta name="viewport"> на нужную ширину.
     * Возвращает null при любой ошибке — тогда WebView загрузит страницу сам.
     */
    private fun fetchHtmlWithDesktopViewport(url: String): String? {
        var conn: HttpURLConnection? = null
        return try {
            conn = URL(url).openConnection() as HttpURLConnection
            conn.requestMethod = "GET"
            conn.connectTimeout = 10_000
            conn.readTimeout = 10_000
            conn.setRequestProperty("Accept-Encoding", "identity")
            conn.setRequestProperty("Authorization", authHeader)
            val code = conn.responseCode
            if (code !in 200..299) return null
            val body = if ("gzip".equals(conn.contentEncoding, ignoreCase = true)) {
                GZIPInputStream(conn.inputStream).use { it.readBytes() }
            } else {
                conn.inputStream.use { it.readBytes() }
            }
            val html = String(body, StandardCharsets.UTF_8)
            // Replace the WHOLE content attribute: dropping initial-scale is what
            // lets loadWithOverviewMode fit the wide layout to the tablet screen
            // (keeping initial-scale=1.0 would win over overview on some WebViews
            // and show only the left part of the page with horizontal scroll).
            val w = currentCssWidth
            html
                .replace("width=device-width, initial-scale=1.0, viewport-fit=cover", "width=$w")
                .replace("width=device-width, initial-scale=1.0", "width=$w")
                .replace("width=device-width", "width=$w")
        } catch (_: Exception) {
            null
        } finally {
            conn?.disconnect()
        }
    }

    /**
     * Disables the page's Fullscreen API: requestFullscreen becomes a no-op that
     * rejects, so the frontend's fullscreen button does nothing and the tester
     * can never get stuck in a fullscreen it cannot exit.
     */
    private fun injectFullscreenBlock() {
        val js = """
            (function() {
              var reject = function() { return Promise.reject(new Error('fullscreen disabled')); };
              Element.prototype.requestFullscreen = reject;
              Element.prototype.webkitRequestFullscreen = reject;
              HTMLMediaElement.prototype.webkitEnterFullscreen = function() {};
              document.exitFullscreen = function() { return Promise.resolve(); };
              document.webkitExitFullscreen = function() {};
            })();
        """.trimIndent()
        webView.evaluateJavascript(js, null)
    }

    private fun showErrorPage(url: String?, detail: String) {
        val safeDetail = android.text.TextUtils.htmlEncode(detail)
        val safeUrl = android.text.TextUtils.htmlEncode(url ?: "")
        val html = """
            <html><head><meta name="viewport" content="width=device-width,initial-scale=1">
            <style>
              body{margin:0;font-family:sans-serif;background:#101318;color:#e8ecf2;
                   display:flex;flex-direction:column;align-items:center;justify-content:center;
                   height:100vh;text-align:center;padding:24px;box-sizing:border-box}
              .e{font-size:38px;margin-bottom:14px}
              .m{color:#8a93a3;font-size:13px;line-height:1.5;word-break:break-all;margin-bottom:8px}
              a{color:#5b8cff}
            </style></head>
            <body>
              <div class="e">⚠️</div>
              <div class="m">Не удалось открыть страницу:<br>$safeDetail</div>
              <div class="m">Проверьте URL в строке сверху и доступность сервера<br>(vite dev на :5174 или https://app.animastor.in).</div>
              <a href="$safeUrl">Повторить</a>
            </body></html>
        """.trimIndent()
        webView.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Lifecycle
    // ═══════════════════════════════════════════════════════════════════

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    override fun onDestroy() {
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.destroy()
        super.onDestroy()
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    companion object {
        // Basic Auth для app.animastor.in (см. proxy/conf/.htpasswd).
        private const val AUTH_USER = "admin"
        private const val AUTH_PASS = "anm777"
        private const val PREF_URL = "url"
        private const val PREF_VIEWPORT = "viewport"
    }
}

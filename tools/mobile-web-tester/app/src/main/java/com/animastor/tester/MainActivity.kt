package com.animastor.tester

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.TextUtils
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
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebViewDatabase
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Animastor Mobile Tester — a minimal "phone preview" around the mobile web
 * frontend. Renders the page inside a phone-sized frame whose width equals
 * the CSS viewport we want (390dp wide WebView ⇒ 390 CSS px viewport, because
 * in Android WebView 1 CSS px == 1 dp), with a mobile user agent.
 */
class MainActivity : Activity() {

    // Viewport presets: label, width (dp = CSS px), height (dp = CSS px)
    private val viewports = listOf(
        Triple("360×800", 360, 800),
        Triple("390×844", 390, 844),
        Triple("430×932", 430, 932),
    )

    // Typical modern Android phone UA — pure CSS/UA emulation, no hardware emulation.
    private val mobileUA =
        "Mozilla/5.0 (Linux; Android 13; SM-A536B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"

    private lateinit var prefs: SharedPreferences
    private lateinit var frameContainer: FrameLayout
    private lateinit var phoneFrame: LinearLayout
    private lateinit var webView: WebView
    private lateinit var urlInput: EditText
    private lateinit var progress: ProgressBar
    private lateinit var timeText: TextView
    private lateinit var topBar1: LinearLayout
    private lateinit var topBar2: LinearLayout
    private lateinit var chipContainer: LinearLayout

    private val chips = mutableListOf<TextView>()
    private var currentViewport = 1 // 390×844 by default

    // Desired frame size in px (before clamping to the screen); re-clamped on
    // every container layout change (toolbar toggle, soft keyboard, ...).
    private var desiredFrameW = 0
    private var desiredFrameH = 0
    private var frameSizedOnce = false
    private var initialLoadPending = true

    private val handler = Handler(Looper.getMainLooper())

    private val timeRunnable = object : Runnable {
        override fun run() {
            timeText.text = SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date())
            handler.postDelayed(this, 30_000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        prefs = getSharedPreferences("mobile_web_tester", Context.MODE_PRIVATE)
        bindViews()
        buildViewportChips()
        setupWebView()
        wireActions()

        // Restore persisted state (URL, viewport) or defaults
        urlInput.setText(prefs.getString(PREF_URL, BuildConfig.DEFAULT_URL))
        val savedViewport = prefs.getInt(PREF_VIEWPORT, 1).coerceIn(0, viewports.lastIndex)

        // Size the phone frame and load the page once the container is laid out;
        // re-clamp the frame on every later container size change (toolbar
        // collapse/expand, soft keyboard) so nothing gets clipped.
        frameContainer.addOnLayoutChangeListener { _, l, t, r, b, ol, ot, or, ob ->
            val w = r - l
            val h = b - t
            val changed = w != (or - ol) || h != (ob - ot)
            if (changed || !frameSizedOnce) {
                frameSizedOnce = true
                clampFrameToContainer()
                if (initialLoadPending) {
                    initialLoadPending = false
                    loadCurrentUrl()
                }
            }
        }
        applyViewport(savedViewport, reload = false)
        updateTime()
    }

    // ═══════════════════════════════════════════════════════════════════
    //  UI wiring
    // ═══════════════════════════════════════════════════════════════════

    private fun bindViews() {
        frameContainer = findViewById(R.id.frameContainer)
        phoneFrame = findViewById(R.id.phoneFrame)
        webView = findViewById(R.id.webView)
        urlInput = findViewById(R.id.urlInput)
        progress = findViewById(R.id.progress)
        timeText = findViewById(R.id.timeText)
        topBar1 = findViewById(R.id.topBar1)
        topBar2 = findViewById(R.id.topBar2)
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

    private fun updateTime() {
        timeText.text = SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date())
        handler.removeCallbacks(timeRunnable)
        handler.postDelayed(timeRunnable, 30_000)
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Viewport / loading
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Sets the desired viewport size and reloads so CSS re-flows at the new
     * width. The actual frame size is (re-)clamped to the container by
     * [clampFrameToContainer] on every layout change.
     */
    private fun applyViewport(index: Int, reload: Boolean) {
        currentViewport = index
        updateChips()
        prefs.edit().putInt(PREF_VIEWPORT, index).apply()
        setDesiredFrameSize(index)
        if (reload) frameContainer.post { loadCurrentUrl() }
    }

    private fun setDesiredFrameSize(index: Int) {
        val (_, wDp, hDp) = viewports[index]
        val density = resources.displayMetrics.density
        desiredFrameW = (wDp * density).toInt()
        desiredFrameH = (hDp * density).toInt()
        clampFrameToContainer()
    }

    private fun clampFrameToContainer() {
        if (!frameSizedOnce) return
        val maxW = (frameContainer.width - frameContainer.paddingLeft - frameContainer.paddingRight).coerceAtLeast(1)
        val maxH = (frameContainer.height - frameContainer.paddingTop - frameContainer.paddingBottom).coerceAtLeast(1)
        val w = minOf(desiredFrameW, maxW)
        val h = minOf(desiredFrameH, maxH)
        val lp = phoneFrame.layoutParams
        if (lp.width != w || lp.height != h) {
            lp.width = w
            lp.height = h
            phoneFrame.layoutParams = lp
        }
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
        s.useWideViewPort = true            // honor <meta viewport>; device-width = frame width in dp
        s.loadWithOverviewMode = false      // no auto zoom-out
        s.setSupportZoom(false)
        s.builtInZoomControls = false
        s.displayZoomControls = false
        s.userAgentString = mobileUA
        s.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        s.javaScriptCanOpenWindowsAutomatically = true
        s.cacheMode = WebSettings.LOAD_DEFAULT
        s.defaultTextEncodingName = "utf-8"

        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)

        webView.webViewClient = object : WebViewClient() {
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
                // m.animastor.in защищён Basic Auth — авторизуемся автоматически.
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
     * Disables the page's Fullscreen API: requestFullscreen becomes a no-op that
     * rejects, so the mobile frontend's fullscreen button does nothing and the
     * tester can never get stuck in a fullscreen it cannot exit.
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
        val safeDetail = TextUtils.htmlEncode(detail)
        val safeUrl = TextUtils.htmlEncode(url ?: "")
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
              <div class="m">Проверьте URL в строке сверху и доступность сервера<br>(vite dev на :5174 или https://m.animastor.in).</div>
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
        handler.removeCallbacks(timeRunnable)
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.destroy()
        super.onDestroy()
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    companion object {
        // Basic Auth для m.animastor.in (см. proxy/conf/.htpasswd).
        private const val AUTH_USER = "admin"
        private const val AUTH_PASS = "anm777"
        private const val PREF_URL = "url"
        private const val PREF_VIEWPORT = "viewport"
    }
}

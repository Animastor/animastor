package com.example.animastor.ui

import android.annotation.SuppressLint
import android.os.Bundle
import android.view.View
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.addCallback
import androidx.fragment.app.Fragment
import com.example.animastor.R
import com.example.animastor.databinding.FragmentLibraryBinding

class LibraryFragment : Fragment(R.layout.fragment_library) {

    private var binding: FragmentLibraryBinding? = null

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        binding = FragmentLibraryBinding.bind(view)

        binding?.toolbar?.setNavigationOnClickListener {
            parentFragmentManager.popBackStack()
        }

        requireActivity().onBackPressedDispatcher.addCallback(viewLifecycleOwner) {
            val wv = binding?.webView
            if (wv != null && wv.canGoBack()) {
                wv.goBack()
            } else {
                parentFragmentManager.popBackStack()
            }
        }

        setupWebView()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        val wv = binding?.webView ?: return
        wv.settings.apply {
            javaScriptEnabled = true
            displayZoomControls = false
            builtInZoomControls = false
            useWideViewPort = true
            loadWithOverviewMode = true
            domStorageEnabled = true
        }
        wv.webViewClient = WebViewClient()
        wv.loadUrl("https://animastor.in")
    }

    override fun onDestroyView() {
        binding = null
        super.onDestroyView()
    }
}

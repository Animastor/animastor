package com.example.animastor

import android.app.Application
import com.example.animastor.network.PersistentCookieJar
import com.example.animastor.network.RetrofitClient

class AnimastorApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // Wire the auth cookie jar BEFORE any lazy-init network client is
        // requested. The backend authenticates via an HttpOnly session cookie
        // (`animastor_sid`) plus a guest cookie (`animastor_gid`); without a
        // jar the app drops identity on every cold start.
        authCookies = PersistentCookieJar(getSharedPreferences("animastor_settings", MODE_PRIVATE))
        RetrofitClient.setCookieJar(authCookies!!)
    }

    companion object {
        /** Live instance after [onCreate]; used for logout cookie clearing. */
        @JvmStatic var authCookies: PersistentCookieJar? = null
            private set
    }
}

package com.example.animastor.network

import android.util.Log
import com.example.animastor.BuildConfig
import com.example.animastor.repository.BackendApi
import com.google.gson.Gson
import com.google.gson.GsonBuilder
import okhttp3.CookieJar
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.util.concurrent.TimeUnit

object RetrofitClient {

    val gson: Gson = GsonBuilder()
        .create()

    // Injected by AnimastorApp (Application.onCreate) before any network use.
    // The backend authenticates via an HttpOnly session cookie (`animastor_sid`)
    // and a guest cookie (`animastor_gid`); OkHttp drops cookies by default, so
    // without a jar the app would lose its session on every cold start.
    private var cookieJar: CookieJar = CookieJar.NO_COOKIES

    fun setCookieJar(jar: CookieJar) {
        cookieJar = jar
    }

    val httpClient: OkHttpClient by lazy {
        val logging = HttpLoggingInterceptor { msg -> Log.i("HTTP", msg) }
        logging.level = HttpLoggingInterceptor.Level.BODY

        OkHttpClient.Builder()
            .connectTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(2, TimeUnit.MINUTES)
            .readTimeout(15, TimeUnit.MINUTES)
            .callTimeout(15, TimeUnit.MINUTES)
            .retryOnConnectionFailure(true)
            .cookieJar(cookieJar)
            .addInterceptor(logging)
            .build()
    }

    private val retrofit: Retrofit by lazy {
        Retrofit.Builder()
            .baseUrl(BuildConfig.BASE_URL)
            .client(httpClient)
            .addConverterFactory(GsonConverterFactory.create(gson))
            .build()
    }

    val api: BackendApi by lazy {
        retrofit.create(BackendApi::class.java)
    }

    val baseUrl: String get() = BuildConfig.BASE_URL
}

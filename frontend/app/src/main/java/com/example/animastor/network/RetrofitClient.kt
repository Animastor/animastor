package com.example.animastor.network

import android.util.Log
import com.example.animastor.BuildConfig
import com.example.animastor.repository.BackendApi
import com.google.gson.Gson
import com.google.gson.GsonBuilder
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.util.concurrent.TimeUnit

object RetrofitClient {

    private val gson: Gson = GsonBuilder()
        .create()

    val httpClient: OkHttpClient by lazy {
        val logging = HttpLoggingInterceptor { msg -> Log.i("HTTP", msg) }
        logging.level = HttpLoggingInterceptor.Level.BODY

        OkHttpClient.Builder()
            .connectTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(2, TimeUnit.MINUTES)
            .readTimeout(5, TimeUnit.MINUTES)
            .callTimeout(5, TimeUnit.MINUTES)
            .retryOnConnectionFailure(true)
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

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.animastor.tester"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.animastor.tester"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"

        // Default URL of the mobile web frontend. Override at build time:
        //   ./gradlew assembleDebug -PTESTER_URL=http://192.168.1.50:5174
        val defaultUrl = project.findProperty("TESTER_URL") as? String
            ?: "https://app.animastor.in"
        buildConfigField("String", "DEFAULT_URL", "\"$defaultUrl\"")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

// No third-party dependencies on purpose: this is a minimal framework-only tool.
dependencies {
}

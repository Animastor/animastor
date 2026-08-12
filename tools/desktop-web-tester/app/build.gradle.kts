plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.animastor.desktop"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.animastor.desktop"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"

        // Default URL of the (responsive) web frontend. Override at build time:
        //   ./gradlew assembleDebug -PTESTER_URL=http://192.168.1.50:5174
        val defaultUrl = project.findProperty("TESTER_URL") as? String
            ?: "https://m.animastor.in"
        buildConfigField("String", "DEFAULT_URL", "\"$defaultUrl\"")

        // Default CSS viewport width in px (desktop shell turns on at >= 1180).
        // Override at build time:
        //   ./gradlew assembleDebug -PTESTER_WIDTH=1440
        val defaultWidth = (project.findProperty("TESTER_WIDTH") as? String)?.toIntOrNull() ?: 1366
        buildConfigField("int", "DEFAULT_WIDTH", "$defaultWidth")
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

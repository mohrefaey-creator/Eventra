import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import java.net.URI

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

// Your deployment, from gradle.properties (or -PmirrorlinkServer=https://mirror.example.com).
val server = providers.gradleProperty("mirrorlinkServer").get().trimEnd('/')
val appId = providers.gradleProperty("mirrorlinkAppId").get()
val serverHost = URI(server).host
    ?: error("mirrorlinkServer must be a full URL such as https://mirror.example.com (got '$server')")

android {
    namespace = "app.mirrorlink"
    compileSdk = 36

    defaultConfig {
        applicationId = appId
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"

        buildConfigField("String", "DEFAULT_SERVER", "\"$server\"")
        // Lets a scanned https://<your server>/send?code=… QR open this app directly (Android App Links).
        manifestPlaceholders["mirrorlinkHost"] = serverHost

        // libwebrtc ships a native library per CPU; every phone and tablet that matters is ARM.
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a") }
    }

    // Optional release signing: pass -PmirrorlinkKeystore=/path/to.jks plus the three values below.
    val keystore = providers.gradleProperty("mirrorlinkKeystore").orNull
    signingConfigs {
        if (keystore != null) {
            create("release") {
                storeFile = file(keystore)
                storePassword = providers.gradleProperty("mirrorlinkKeystorePassword").get()
                keyAlias = providers.gradleProperty("mirrorlinkKeyAlias").get()
                keyPassword = providers.gradleProperty("mirrorlinkKeyPassword").get()
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false // libwebrtc is reflection/JNI heavy; keep v1 simple and safe
            signingConfigs.findByName("release")?.let { signingConfig = it }
        }
    }

    buildFeatures { buildConfig = true }

    testOptions { unitTests { isIncludeAndroidResources = true } }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

dependencies {
    implementation(project(":core"))
    implementation(libs.webrtc)

    testImplementation(libs.junit4)
    testImplementation(libs.robolectric)
}

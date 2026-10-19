plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val appVersionCode = providers.gradleProperty("appVersionCode").orElse("1").get().toInt()
val appVersionName = providers.gradleProperty("appVersionName").orElse("1.0.0").get()
val updateManifestUrl = "https://github.com/tz121212/AI-APP/releases/latest/download/update-manifest.json"
val releaseStorePath = providers.gradleProperty("releaseStoreFile").orNull
val releaseStorePassword = providers.gradleProperty("releaseStorePassword").orNull
val releaseKeyAlias = providers.gradleProperty("releaseKeyAlias").orNull
val releaseKeyPassword = providers.gradleProperty("releaseKeyPassword").orNull
val generatedWebAssets = layout.buildDirectory.dir("generated/assets/web")
val webSource = rootProject.projectDir.parentFile

android {
    namespace = "com.dailyassistant.mobile"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.dailyassistant.mobile"
        minSdk = 26
        targetSdk = 34
        versionCode = appVersionCode
        versionName = appVersionName
        buildConfigField("String", "UPDATE_MANIFEST_URL", "\"$updateManifestUrl\"")
    }

    buildFeatures {
        buildConfig = true
    }

    signingConfigs {
        create("internalRelease") {
            if (releaseStorePath != null) {
                storeFile = file(releaseStorePath)
                storeType = "PKCS12"
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        getByName("debug") {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
        getByName("release") {
            isMinifyEnabled = false
            if (releaseStorePath != null) signingConfig = signingConfigs.getByName("internalRelease")
        }
    }

    sourceSets.getByName("main").assets.srcDir(generatedWebAssets)
}

val copyWebAssets by tasks.registering(Copy::class) {
    from(webSource) {
        include("index.html", "styles.css", "app.js", "manifest.webmanifest", "service-worker.js", "assets/**")
    }
    into(generatedWebAssets.map { it.dir("web") })
}

tasks.named("preBuild") {
    dependsOn(copyWebAssets)
}

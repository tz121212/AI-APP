plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val updateManifestUrl = providers.gradleProperty("updateManifestUrl").orElse("").get()
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
        versionCode = 1
        versionName = "1.0.0"
        buildConfigField("String", "UPDATE_MANIFEST_URL", "\"$updateManifestUrl\"")
    }

    buildFeatures {
        buildConfig = true
    }

    signingConfigs {
        create("internalRelease") {
            if (releaseStorePath != null) {
                storeFile = file(releaseStorePath)
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

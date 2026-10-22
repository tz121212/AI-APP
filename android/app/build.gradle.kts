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
val cloudbasePublishableKey = providers.environmentVariable("VITE_PUBLISHABLE_KEY").orElse(
    providers.provider {
        webSource.resolve(".env.local").takeIf { it.isFile }?.readLines()
            ?.firstOrNull { it.trim().startsWith("VITE_PUBLISHABLE_KEY=") }
            ?.substringAfter('=')?.trim()?.trim('"', '\'') ?: ""
    }
).get()
if (gradle.startParameter.taskNames.any { it.contains("assemble", ignoreCase = true) } && cloudbasePublishableKey.isBlank()) {
    throw GradleException("Set VITE_PUBLISHABLE_KEY in .env.local or the build environment before building an APK")
}

android {
    namespace = "com.dailyassistant.mobile"
    compileSdk = 35

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "com.dailyassistant.mobile"
        minSdk = 26
        targetSdk = 34
        versionCode = appVersionCode
        versionName = appVersionName
        buildConfigField("String", "UPDATE_MANIFEST_URL", "\"$updateManifestUrl\"")
        val escapedPublishableKey = cloudbasePublishableKey.replace("\\", "\\\\").replace("\"", "\\\"")
        buildConfigField("String", "CLOUDBASE_PUBLISHABLE_KEY", "\"$escapedPublishableKey\"")
    }

    buildFeatures {
        buildConfig = true
    }

    kotlinOptions {
        jvmTarget = "17"
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

dependencies {
    implementation("androidx.webkit:webkit:1.12.1")
}

val copyWebAssets by tasks.registering(Copy::class) {
    from(webSource) {
        include("index.html", "styles.css", "app.js", "cloudbase-sync.js", "cloudbase-fetch-shim.js", "history-retention.js", "manifest.webmanifest", "service-worker.js", "assets/**")
    }
    into(generatedWebAssets.map { it.dir("web") })
    doLast {
        val escapedKey = cloudbasePublishableKey.replace("\\", "\\\\").replace("'", "\\'")
        generatedWebAssets.get().file("web/cloudbase-config.js").asFile.writeText(
            "window.CLOUDBASE_SYNC_CONFIG = { env: 'jandz-d7gyvxev845ba48a0', region: 'ap-shanghai', accessKey: '$escapedKey' };\n"
        )
    }
}

tasks.named("preBuild") {
    dependsOn(copyWebAssets)
}

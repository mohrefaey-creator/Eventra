pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
    }
}

rootProject.name = "mirrorlink-android"

include(":core")
// The app module needs the Android SDK and Google's Maven repository. Pass -PcoreOnly to build and
// test just the pure-Kotlin core (pairing + signaling), which runs on any JDK:
//   ./gradlew -PcoreOnly :core:test
if (!providers.gradleProperty("coreOnly").isPresent) include(":app")

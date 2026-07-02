# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# Capacitor loads plugins via reflection + annotations; keep them and our app package.
-keep public class * extends com.getcapacitor.Plugin { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keep class dev.pizzapi.app.** { *; }
# Keep @JavascriptInterface members callable from the WebView.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
# ponytail: conservative keeps only. R8 can still strip transitively-referenced
# Capacitor internals, so a release (minified) build MUST be device-tested before
# shipping. Tighten/loosen these rules from real crash logs if needed.

package dev.chakrawallet;

import android.app.ActivityManager;
import android.app.ApplicationExitInfo;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.RequiresApi;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;

/**
 * Crashes of the native app, kept on the device until the JavaScript side collects them at the next start
 * (src/shared/crash.js, which cleans them of personal data and adds them to the local error log). Nothing is sent.
 *  - uncaught Java exceptions: written to a file by the handler install() sets up, then handed on to Android's own
 *    handler (the app still closes as usual);
 *  - "app not responding" and crashes in native code: Android's record of how the process ended
 *    (ApplicationExitInfo, Android 11+), read at the next start;
 *  - the web renderer crashed: saved by MainActivity, which recovers from it.
 * JS: pending() -> { reports: [{ kind, at, message, stack, thread }] }, clear(). The iOS app has the same plugin name
 * and methods. test({ kind: 'java' | 'renderer' }) works only in debug builds.
 */
@CapacitorPlugin(name = "Crash")
public class CrashPlugin extends Plugin {
    private static final String TAG = "ChakraCrash";
    private static final String DIR = "crash";
    private static final String PREFS = "chakra_crash";
    private static final String SEEN = "exitsSeenUntil"; // Android's exit records up to here are already handled
    private static final int MAX_FILES = 10;               // a crash loop: the first ones are enough
    private static final int MAX_STACK = 16_000;
    private static boolean installed = false;

    /** Catch uncaught exceptions of the whole process (once). Called first thing by MainActivity. */
    static synchronized void install(Context ctx) {
        if (installed) return;
        installed = true;
        final Context app = ctx.getApplicationContext();
        final Thread.UncaughtExceptionHandler next = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, e) -> {
            try {
                save(app, "java", String.valueOf(e), Log.getStackTraceString(e), thread.getName());
            } catch (Throwable ignored) {
                // never fail while failing
            }
            if (next != null) next.uncaughtException(thread, e);
            else { android.os.Process.killProcess(android.os.Process.myPid()); System.exit(10); }
        });
        // first start with this plugin: Android's older exit records are not ours to report
        SharedPreferences p = prefs(app);
        if (!p.contains(SEEN)) p.edit().putLong(SEEN, System.currentTimeMillis()).apply();
    }

    /** Keep a report for the next start. */
    static void save(Context ctx, String kind, String message, String stack, String thread) {
        try {
            File dir = new File(ctx.getFilesDir(), DIR);
            if (!dir.exists() && !dir.mkdirs()) return;
            File[] old = dir.listFiles();
            if (old != null && old.length >= MAX_FILES) return;
            JSONObject o = new JSONObject();
            o.put("kind", kind);
            o.put("at", System.currentTimeMillis());
            o.put("message", message == null ? "" : message);
            o.put("stack", cut(stack));
            o.put("thread", thread == null ? "" : thread);
            File f = new File(dir, System.currentTimeMillis() + "-" + kind + ".json");
            try (FileOutputStream out = new FileOutputStream(f)) {
                out.write(o.toString().getBytes(StandardCharsets.UTF_8));
            }
        } catch (Exception e) {
            Log.w(TAG, "could not save a crash report", e);
        }
    }

    @PluginMethod
    public void pending(PluginCall call) {
        JSArray list = new JSArray();
        File[] files = new File(getContext().getFilesDir(), DIR).listFiles();
        if (files != null) {
            for (File f : files) {
                try {
                    list.put(new JSONObject(read(new FileInputStream(f), 64_000)));
                } catch (Exception ignored) {
                    // a half-written file (the process died while saving): skip it
                }
            }
        }
        if (Build.VERSION.SDK_INT >= 30) exits(list);
        JSObject res = new JSObject();
        res.put("reports", list);
        call.resolve(res);
    }

    @PluginMethod
    public void clear(PluginCall call) {
        File[] files = new File(getContext().getFilesDir(), DIR).listFiles();
        if (files != null) for (File f : files) //noinspection ResultOfMethodCallIgnored
            f.delete();
        prefs(getContext()).edit().putLong(SEEN, System.currentTimeMillis()).apply();
        call.resolve();
    }

    /** Debug builds only: make the app crash, to try the reports. 'java': an uncaught exception; 'renderer': the web renderer. */
    @PluginMethod
    public void test(PluginCall call) {
        if ((getContext().getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) == 0) {
            call.reject("debug builds only");
            return;
        }
        String kind = call.getString("kind", "java");
        call.resolve();
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            if ("renderer".equals(kind)) getBridge().getWebView().loadUrl("chrome://crash");
            else throw new RuntimeException("Crash test (debug build)");
        }, 300);
    }

    // ------------------------------------------------------------------ Android's exit records (11+)
    @RequiresApi(30)
    private void exits(JSArray list) {
        try {
            ActivityManager am = (ActivityManager) getContext().getSystemService(Context.ACTIVITY_SERVICE);
            long seen = prefs(getContext()).getLong(SEEN, System.currentTimeMillis());
            for (ApplicationExitInfo x : am.getHistoricalProcessExitReasons(null, 0, 10)) {
                if (x.getTimestamp() <= seen) continue;
                String kind;
                switch (x.getReason()) {
                    case ApplicationExitInfo.REASON_ANR: kind = "anr"; break;
                    case ApplicationExitInfo.REASON_CRASH_NATIVE: kind = "native"; break;
                    default: continue; // Java crashes come from the handler (with their stack); the rest isn't a bug
                }
                JSONObject o = new JSONObject();
                o.put("kind", kind);
                o.put("at", x.getTimestamp());
                String what = kind.equals("anr") ? "App not responding" : "Crash in native code";
                o.put("message", x.getDescription() != null ? what + ": " + x.getDescription() : what);
                o.put("stack", kind.equals("anr") ? mainThread(x) : "");
                o.put("thread", "main");
                list.put(o);
            }
        } catch (Exception e) {
            Log.w(TAG, "could not read the exit records", e);
        }
    }

    /** From an ANR's thread dump, the main thread's stack: the part that says what the app was stuck on. */
    @RequiresApi(30)
    private static String mainThread(ApplicationExitInfo x) {
        try (InputStream in = x.getTraceInputStream()) {
            if (in == null) return "";
            String dump = read(in, 512_000);
            int start = dump.indexOf("\"main\"");
            if (start < 0) return cut(dump);
            int end = dump.indexOf("\n\n", start);
            return cut(end > 0 ? dump.substring(start, end) : dump.substring(start));
        } catch (Exception e) {
            return "";
        }
    }

    private static String read(InputStream in, int max) throws Exception {
        StringBuilder sb = new StringBuilder();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            char[] buf = new char[8192];
            int n;
            while ((n = r.read(buf)) > 0 && sb.length() < max) sb.append(buf, 0, n);
        }
        return sb.toString();
    }

    private static String cut(String s) {
        if (s == null) return "";
        return s.length() > MAX_STACK ? s.substring(0, MAX_STACK) : s;
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}

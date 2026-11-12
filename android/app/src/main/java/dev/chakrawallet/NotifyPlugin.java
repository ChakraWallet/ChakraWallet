package dev.chakrawallet;

import android.Manifest;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/** Local notifications (no server): background checks (WatchWorker) and immediate ones while the app is in background. */
@CapacitorPlugin(name = "Notify", permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) })
public class NotifyPlugin extends Plugin {

    /** { enabled }: starts or stops the periodic background check. */
    @PluginMethod
    public void schedule(PluginCall call) {
        WatchWorker.schedule(getContext(), Boolean.TRUE.equals(call.getBoolean("enabled", true)));
        call.resolve();
    }

    /** { id, title, body, positive }: shown only if the app is not in the foreground. */
    @PluginMethod
    public void notify(PluginCall call) {
        WatchWorker.notify(getContext(), call.getString("id", "x").hashCode(), call.getString("title", ""), call.getString("body", ""), Boolean.TRUE.equals(call.getBoolean("positive", false)));
        call.resolve();
    }

    /** Runs the background check once now (diagnostics). */
    @PluginMethod
    public void runNow(PluginCall call) {
        androidx.work.WorkManager.getInstance(getContext()).enqueue(new androidx.work.OneTimeWorkRequest.Builder(WatchWorker.class).build());
        call.resolve();
    }

    @PluginMethod
    public void permission(PluginCall call) {
        JSObject r = new JSObject();
        r.put("granted", Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED);
        call.resolve(r);
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED) { permission(call); return; }
        requestPermissionForAlias("notifications", call, "afterPermission");
    }

    @PermissionCallback
    private void afterPermission(PluginCall call) { permission(call); }
}

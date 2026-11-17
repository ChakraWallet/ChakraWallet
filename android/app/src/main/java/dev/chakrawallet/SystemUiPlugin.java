package dev.chakrawallet;

import android.content.res.Configuration;
import android.graphics.Color;
import android.view.WindowManager;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Keeps the system bars in tune with the app theme (background behind the bars + light/dark icons), keeps the screen on.
 * The app's theme (light / dark / system) can differ from the system's: Capacitor's own System Bars plugin puts the
 * system's colours back at every configuration change (rotation, system theme, display size), so the last theme the
 * app asked for is applied again right after.
 */
@CapacitorPlugin(name = "SystemUi")
public class SystemUiPlugin extends Plugin {
    private Boolean dark = null; // the app's last theme (null: not set yet)
    private String background = null;

    @PluginMethod
    public void setTheme(PluginCall call) {
        boolean d = Boolean.TRUE.equals(call.getBoolean("dark", false));
        String bg = call.getString("background", d ? "#0B0F17" : "#F1F3F6");
        getActivity().runOnUiThread(() -> {
            dark = d;
            background = bg;
            apply();
            call.resolve();
        });
    }

    @Override
    protected void handleOnConfigurationChanged(Configuration newConfig) {
        super.handleOnConfigurationChanged(newConfig);
        // after every plugin has handled the change (System Bars included)
        if (dark != null) getActivity().getWindow().getDecorView().post(this::apply);
    }

    private void apply() {
        try { getActivity().getWindow().getDecorView().setBackgroundColor(Color.parseColor(background)); } catch (IllegalArgumentException ignored) { }
        WindowInsetsControllerCompat c = WindowCompat.getInsetsController(getActivity().getWindow(), getActivity().getWindow().getDecorView());
        c.setAppearanceLightStatusBars(!dark);
        c.setAppearanceLightNavigationBars(!dark);
    }

    /** Screen always on while a long task runs in the app (vanity address search): { on: true | false }. */
    @PluginMethod
    public void setKeepAwake(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            call.resolve();
        });
    }
}

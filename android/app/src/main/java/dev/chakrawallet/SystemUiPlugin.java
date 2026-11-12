package dev.chakrawallet;

import android.graphics.Color;
import android.view.WindowManager;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Keeps the system bars in tune with the app theme (background behind the bars + light/dark icons), keeps the screen on. */
@CapacitorPlugin(name = "SystemUi")
public class SystemUiPlugin extends Plugin {
    @PluginMethod
    public void setTheme(PluginCall call) {
        boolean dark = Boolean.TRUE.equals(call.getBoolean("dark", false));
        String bg = call.getString("background", dark ? "#0B0F17" : "#F1F3F6");
        getActivity().runOnUiThread(() -> {
            try { getActivity().getWindow().getDecorView().setBackgroundColor(Color.parseColor(bg)); } catch (IllegalArgumentException ignored) { }
            WindowInsetsControllerCompat c = WindowCompat.getInsetsController(getActivity().getWindow(), getActivity().getWindow().getDecorView());
            c.setAppearanceLightStatusBars(!dark);
            c.setAppearanceLightNavigationBars(!dark);
            call.resolve();
        });
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

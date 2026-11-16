package dev.chakrawallet;

import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DappBrowserPlugin.class);
        registerPlugin(BiometricPlugin.class);
        registerPlugin(SystemUiPlugin.class);
        registerPlugin(NotifyPlugin.class);
        registerPlugin(OsPlugin.class);
        super.onCreate(savedInstanceState);

        // Edge-to-edge: the app draws behind the system bars, so the WebView gets margins for them.
        // Unlike Capacitor's own handler, the bottom margin also covers the keyboard (IME): the WebView
        // shrinks above it, the page gets a resize, and inputs, sheets and footers stay visible.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        View web = getBridge().getWebView();
        ViewCompat.setOnApplyWindowInsetsListener(web, (v, wi) -> {
            Insets bars = wi.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = wi.getInsets(WindowInsetsCompat.Type.ime());
            ViewGroup.MarginLayoutParams mlp = (ViewGroup.MarginLayoutParams) v.getLayoutParams();
            mlp.leftMargin = bars.left;
            mlp.topMargin = bars.top;
            mlp.rightMargin = bars.right;
            mlp.bottomMargin = Math.max(bars.bottom, ime.bottom);
            v.setLayoutParams(mlp);
            return WindowInsetsCompat.CONSUMED;
        });
        ViewCompat.requestApplyInsets(web);
    }

    // background notifications are shown only while the app is not in the foreground
    @Override
    public void onResume() { super.onResume(); WatchWorker.setForeground(this, true); }

    @Override
    public void onPause() { WatchWorker.setForeground(this, false); super.onPause(); }
}

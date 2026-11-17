package dev.chakrawallet;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * What the system does better than the app: the share sheet (apps and recent contacts), links opened outside the
 * app, in the system browser (where the user is signed in, e.g. to GitHub), instead of the integrated dapp browser,
 * and going back to the app that opened Chakra with a TON Connect link (moveToBack, openLink).
 */
@CapacitorPlugin(name = "Os")
public class OsPlugin extends Plugin {
    /** System share sheet: { text, url?, title? }. Resolves once the sheet is shown. */
    @PluginMethod
    public void share(PluginCall call) {
        String text = call.getString("text", "");
        String url = call.getString("url", "");
        String title = call.getString("title", "");
        String body = url.isEmpty() ? text : (text.isEmpty() ? url : text + "\n" + url);
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType("text/plain");
        send.putExtra(Intent.EXTRA_TEXT, body);
        if (!title.isEmpty()) send.putExtra(Intent.EXTRA_SUBJECT, title);
        try {
            getActivity().startActivity(Intent.createChooser(send, title.isEmpty() ? null : title));
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("no app to share with");
        }
    }

    /** Opens an http(s) link in the system browser (or the app that handles it): { url }. */
    @PluginMethod
    public void openExternal(PluginCall call) {
        String url = call.getString("url", "");
        if (!url.startsWith("https://") && !url.startsWith("http://")) { call.reject("only http(s) links"); return; }
        Intent view = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        view.addCategory(Intent.CATEGORY_BROWSABLE);
        view.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getActivity().startActivity(view);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("no browser");
        }
    }

    /** Puts Chakra behind the app that opened it (TON Connect: ret=back), as the Back button would, keeping its state. */
    @PluginMethod
    public void moveToBack(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            getActivity().moveTaskToBack(true);
            call.resolve();
        });
    }

    /**
     * Opens a link of another app, given by a dapp to go back to it (TON Connect: ret=<url>, e.g. tg://...): { url }.
     * Only what a browser could open (BROWSABLE); never intents, files or local content.
     */
    @PluginMethod
    public void openLink(PluginCall call) {
        String url = call.getString("url", "");
        Uri uri = Uri.parse(url);
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
        if (scheme.isEmpty() || scheme.equals("intent") || scheme.equals("file") || scheme.equals("content") || scheme.equals("javascript")
                || scheme.equals("data") || scheme.equals("tc") || scheme.equals("chakra-tc")) { call.reject("link not allowed"); return; }
        Intent view = new Intent(Intent.ACTION_VIEW, uri);
        view.addCategory(Intent.CATEGORY_BROWSABLE);
        view.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getActivity().startActivity(view);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("no app for this link");
        }
    }
}

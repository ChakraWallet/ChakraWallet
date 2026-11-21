package dev.chakrawallet;

import android.annotation.SuppressLint;
import android.Manifest;
import android.app.DownloadManager;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.net.http.SslError;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SafeBrowsingResponse;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceError;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Rect;
import android.net.Uri;
import android.net.http.SslCertificate;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.os.SystemClock;
import android.util.Base64;
import android.view.MotionEvent;
import android.view.PixelCopy;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/**
 * In-app dapp browser with tabs. Each tab has its own native WebView (created lazily, on first load), placed over the
 * area of the app UI reserved for it; only the active tab is visible, the others are paused.
 * - Chakra's provider (inject.js) is added at document start in every frame-0 page.
 * - Page -> app messages go through a WebMessageListener: the page origin is provided by Android,
 *   so a page can never impersonate another site. Every message carries its tabId and pageId.
 * - App -> page messages are delivered only to the page (tabId + pageId) that is currently loaded in that tab.
 * - Pages may open new tabs (target=_blank / window.open) only from a user gesture.
 */
@CapacitorPlugin(name = "DappBrowser", permissions = {
        @Permission(alias = "camera", strings = { Manifest.permission.CAMERA }),
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }),
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION }),
})
public class DappBrowserPlugin extends Plugin {
    private static final int MAX_TABS = 10;

    private static class Tab {
        final int id;
        WebView web;
        volatile int pageId = 0;
        volatile String url = "";
        volatile String title = "";
        String favicon = "";
        SafeBrowsingResponse unsafe; // pending Safe Browsing decision (proceed / back)
        boolean errored = false;     // the main page failed: never shown (the app draws its own error page)
                                     // until the user retries, goes back or opens another address
        boolean loading = false;
        int progress = 0;
        long hiddenAt = 0;           // when it went to the background (0 = active)
        Tab(int id) { this.id = id; }
    }

    private final Map<Integer, Tab> tabs = new LinkedHashMap<>();
    private int nextTabId = 1;
    private int activeId = -1;
    private volatile int pageCounter = 0; // pageIds are unique across tabs
    private String script = "";
    private boolean visible = false;
    private long lastActivity = 0; // last tap reported to the app (auto-lock), uptime ms
    private int bx, by, bw, bh; // last bounds (device px, relative to android.R.id.content)

    // ---- file chooser (<input type="file">)
    private ValueCallback<Uri[]> pendingFiles;
    private ActivityResultLauncher<Intent> fileLauncher;

    // ------------------------------------------------------------------ idle background tabs are unloaded
    // Every WebView of the app shares one renderer thread with the wallet UI: a heavy site left open in another
    // tab (live prices, big pages) slows everything down. After a few minutes in the background its WebView is
    // destroyed; the tab keeps address, title and icon and loads again when it is opened (like Chrome).
    private static final long DISCARD_AFTER_MS = 5 * 60_000L;
    private final Handler idle = new Handler(Looper.getMainLooper());
    private final Runnable discardIdle = new Runnable() {
        @Override
        public void run() {
            long now = System.currentTimeMillis();
            for (Tab t : tabs.values()) {
                if (t.id == activeId || t.web == null || t.hiddenAt == 0 || t.url.isEmpty() || t.errored) continue;
                if (now - t.hiddenAt < DISCARD_AFTER_MS) continue;
                ViewGroup root = getActivity().findViewById(android.R.id.content);
                t.web.stopLoading();
                root.removeView(t.web);
                t.web.destroy();
                t.web = null;
                t.loading = false;
                t.progress = 0;
                lastNav.remove(t.id);
                JSObject ev = new JSObject();
                ev.put("tabId", t.id);
                notifyListeners("tabDiscarded", ev);
            }
            idle.postDelayed(this, 60_000L);
        }
    };

    @Override
    protected void handleOnDestroy() {
        idle.removeCallbacks(discardIdle);
        super.handleOnDestroy();
    }

    @Override
    public void load() {
        idle.postDelayed(discardIdle, 60_000L);
        fileLauncher = getActivity().registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), (res) -> {
            if (pendingFiles == null) return;
            pendingFiles.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res.getResultCode(), res.getData()));
            pendingFiles = null;
        });
        try (InputStream is = getContext().getAssets().open("public/inject.js")) {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
            script = bos.toString(StandardCharsets.UTF_8.name());
        } catch (Exception e) {
            script = "";
        }
    }

    // ------------------------------------------------------------------ desktop / mobile version per site
    // Mobile by default; hosts in desktopHosts (dapps, or chosen by the user; subdomains included) get the desktop UA.
    private String mobileUa, desktopUa;
    private final Set<String> desktopHosts = new java.util.HashSet<>();

    private String uaFor(String url) {
        String host = "";
        try { host = Uri.parse(url).getHost(); } catch (Exception ignored) { }
        if (host == null) host = "";
        for (String h : desktopHosts) if (host.equals(h) || host.endsWith("." + h)) return desktopUa;
        return mobileUa;
    }

    private void load(WebView w, String url) {
        if (desktopUa != null) w.getSettings().setUserAgentString(uaFor(url));
        w.loadUrl(url);
    }

    @PluginMethod
    public void setDesktopHosts(PluginCall call) {
        JSArray arr = call.getArray("hosts");
        getActivity().runOnUiThread(() -> {
            desktopHosts.clear();
            try { for (int i = 0; arr != null && i < arr.length(); i++) desktopHosts.add(arr.getString(i).toLowerCase().replaceFirst("^www\\.", "")); } catch (Exception ignored) { }
            call.resolve();
        });
    }

    // ------------------------------------------------------------------ tabs / WebViews
    private Tab active() { return tabs.get(activeId); }

    private Tab tabFor(PluginCall call) {
        Integer id = call.getInt("tabId");
        return id != null ? tabs.get(id) : active();
    }

    private Tab newTabRecord() {
        Tab t = new Tab(nextTabId++);
        tabs.put(t.id, t);
        return t;
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface", "ClickableViewAccessibility"})
    private WebView ensureWebView(Tab tab) {
        if (tab.web != null) return tab.web;
        // debug builds only: pages can be inspected from a computer (chrome://inspect) to diagnose dapp issues
        if ((getContext().getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true);
        WebView web = new WebView(getActivity());
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true); // (WebSQL, setDatabaseEnabled, is gone from current WebViews: not set)
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportMultipleWindows(true);            // target=_blank / window.open -> onCreateWindow -> new tab
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setGeolocationEnabled(true); // every request still goes through the app's prompt
        web.setDownloadListener((url, ua, disposition, mime, length) -> download(tab, url, ua, disposition, mime));
        // a tap on the page is activity for the wallet's auto-lock: reported at most every 2 s; the page still gets it
        web.setOnTouchListener((v, e) -> {
            if (e.getActionMasked() == MotionEvent.ACTION_DOWN) {
                long now = SystemClock.uptimeMillis();
                if (now - lastActivity >= 2000) { lastActivity = now; notifyListeners("activity", new JSObject()); }
            }
            return false;
        });
        if (mobileUa == null) { // computed once from the system WebView user agent
            String base = s.getUserAgentString();
            mobileUa = base + " Chakra/1.0";
            // same engine, desktop form: no "Android"/"Mobile"/"wv" (many dapps hide the in-page wallet on mobile)
            desktopUa = base.replaceFirst("\\([^)]*Android[^)]*\\)", "(X11; Linux x86_64)").replace(" Version/4.0", "").replace(" Mobile Safari", " Safari") + " Chakra/1.0";
        }
        s.setUserAgentString(mobileUa);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

        boolean docStart = false;
        Set<String> all = Collections.singleton("*");
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(web, script, all);
            docStart = true;
        }
        final boolean docStartInjection = docStart;
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            // blob: downloads are read by the page itself and handed over here as base64
            WebViewCompat.addWebMessageListener(web, "chakraDownload", all, (view, message, sourceOrigin, isMainFrame, replyProxy) -> {
                if (!isMainFrame || message.getData() == null) return;
                try {
                    JSObject o = new JSObject(message.getData());
                    String d = o.getString("data", "");
                    askDownload(tab, Base64.decode(d.substring(d.indexOf(',') + 1), Base64.DEFAULT), o.getString("name", "download"), o.getString("mime", "application/octet-stream"));
                } catch (Exception ignored) { }
            });
            WebViewCompat.addWebMessageListener(web, "chakraBridge", all, (view, message, sourceOrigin, isMainFrame, replyProxy) -> {
                if (!isMainFrame || message.getData() == null) return;
                onPageMessage(tab, message.getData(), originString(sourceOrigin));
            });
        } else {
            web.addJavascriptInterface(new Object() {
                @JavascriptInterface
                public void postMessage(String data) {
                    onPageMessage(tab, data, originOf(tab.url));
                }
            }, "chakraBridge");
        }

        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                tab.pageId = ++pageCounter;
                tab.url = url;
                tab.loading = true;
                tab.favicon = "";
                if (!docStartInjection && !script.isEmpty()) view.evaluateJavascript(script, null);
                emitNav(tab);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                tab.url = url;
                tab.title = view.getTitle() != null ? view.getTitle() : "";
                tab.loading = false;
                emitNav(tab);
            }

            @Override
            public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
                tab.url = url; // SPA navigation (pushState): same page, same pageId
                emitNav(tab);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme() == null ? "" : uri.getScheme();
                if (isTonConnectLink(uri)) { connectLink(tab, uri, "tonConnectLink"); return true; }
                if (isWalletConnectLink(uri)) { connectLink(tab, uri, "walletConnectLink"); return true; }
                if (scheme.equals("http") || scheme.equals("https")) {
                    // moving to a site that uses the other version (desktop/mobile): reload it with the right user agent
                    String ua = uaFor(uri.toString());
                    if (request.isForMainFrame() && !request.isRedirect() && !ua.equals(view.getSettings().getUserAgentString())) {
                        // not inside this callback: changing the settings while WebView is deciding a navigation
                        // makes Chromium abort the whole app (native CHECK, SIGTRAP). Cancel it and reload right after.
                        final String target = uri.toString();
                        view.post(() -> {
                            view.getSettings().setUserAgentString(ua);
                            view.loadUrl(target);
                        });
                        return true;
                    }
                    return false;
                }
                try { // mailto:, tel:, intent:, other apps
                    Intent i = scheme.equals("intent") ? Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME) : new Intent(Intent.ACTION_VIEW, uri);
                    i.addCategory(Intent.CATEGORY_BROWSABLE);
                    i.setComponent(null);
                    getActivity().startActivity(i);
                } catch (Exception ignored) { }
                return true;
            }
            // ---- errors of the main page: shown by the app as its own error page (see browser.jsx)
            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (!req.isForMainFrame()) return;
                String desc = err.getDescription() == null ? "" : err.getDescription().toString();
                emitError(tab, req.getUrl().toString(), kindOf(err.getErrorCode(), desc), err.getErrorCode(), desc);
            }

            /** Invalid certificates are always refused; the app explains why. */
            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
                String reason;
                switch (error.getPrimaryError()) {
                    case SslError.SSL_EXPIRED: reason = "expired"; break;
                    case SslError.SSL_NOTYETVALID: reason = "notYetValid"; break;
                    case SslError.SSL_IDMISMATCH: reason = "mismatch"; break;
                    case SslError.SSL_UNTRUSTED: reason = "untrusted"; break;
                    case SslError.SSL_DATE_INVALID: reason = "date"; break;
                    default: reason = "invalid";
                }
                emitError(tab, error.getUrl(), "cert", error.getPrimaryError(), reason);
            }

            /** Google Safe Browsing hit: the app warns, the user may go back or proceed (false positives happen). */
            @Override
            public void onSafeBrowsingHit(WebView view, WebResourceRequest req, int threat, SafeBrowsingResponse cb) {
                if (!req.isForMainFrame()) { cb.backToSafety(false); return; }
                tab.unsafe = cb;
                String t;
                switch (threat) {
                    case WebViewClient.SAFE_BROWSING_THREAT_MALWARE: t = "malware"; break;
                    case WebViewClient.SAFE_BROWSING_THREAT_PHISHING: t = "phishing"; break;
                    case WebViewClient.SAFE_BROWSING_THREAT_UNWANTED_SOFTWARE: t = "unwanted"; break;
                    case 4: t = "billing"; break; // SAFE_BROWSING_THREAT_BILLING (API 29)
                    default: t = "unknown";
                }
                emitError(tab, req.getUrl().toString(), "unsafe", threat, t);
            }

            /** The page's renderer crashed or was killed: drop this tab's WebView instead of crashing the app. */
            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                if (tab.web == view) {
                    ViewGroup root = getActivity().findViewById(android.R.id.content);
                    root.removeView(view);
                    view.destroy();
                    tab.web = null;
                    tab.loading = false;
                    emitError(tab, tab.url, "crashed", 0, detail != null && detail.didCrash() ? "crash" : "killed");
                }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                tab.progress = newProgress;
                emitNav(tab);
            }

            @Override
            public void onReceivedTitle(WebView view, String title) {
                tab.title = title != null ? title : "";
                emitNav(tab);
            }

            @Override
            public void onReceivedIcon(WebView view, Bitmap icon) {
                tab.favicon = toDataUrl(Bitmap.createScaledBitmap(icon, 48, 48, true), Bitmap.CompressFormat.PNG, 100);
                JSObject ev = new JSObject();
                ev.put("tabId", tab.id);
                ev.put("favicon", tab.favicon);
                notifyListeners("favicon", ev);
            }

            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
                if (!isUserGesture || tabs.size() >= MAX_TABS) return false;
                captureThumb(active());
                Tab t = newTabRecord();
                WebView w = ensureWebView(t);
                WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
                transport.setWebView(w);
                resultMsg.sendToTarget();
                activate(t);
                JSObject ev = new JSObject();
                ev.put("tabId", t.id);
                notifyListeners("tabOpened", ev);
                return true;
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingFiles != null) pendingFiles.onReceiveValue(null);
                pendingFiles = callback;
                try {
                    Intent pick = params.createIntent();
                    pick.addCategory(Intent.CATEGORY_OPENABLE);
                    fileLauncher.launch(Intent.createChooser(pick, null));
                } catch (Exception e) { pendingFiles = null; return false; }
                return true;
            }

            /** Camera / microphone asked by a page: the app asks the user (remember / only this time / deny). */
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                getActivity().runOnUiThread(() -> {
                    List<String> kinds = new ArrayList<>();
                    for (String r : request.getResources()) {
                        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) kinds.add("camera");
                        else if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) kinds.add("microphone");
                    }
                    if (kinds.isEmpty()) { request.deny(); return; }
                    askUser(tab, request.getOrigin() == null ? originOf(tab.url) : originString(request.getOrigin()), kinds, request, null);
                });
            }

            @Override
            public void onPermissionRequestCanceled(PermissionRequest request) {
                for (Map.Entry<Integer, Object[]> e : pendingPerms.entrySet()) {
                    if (e.getValue()[0] == request) { pendingPerms.remove(e.getKey()); notifyPermGone(e.getKey()); break; }
                }
            }

            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                String o = origin.endsWith("/") ? origin.substring(0, origin.length() - 1) : origin;
                askUser(tab, o, java.util.Collections.singletonList("location"), null, callback);
            }

            @Override
            public void onCloseWindow(WebView window) {
                for (Tab t : tabs.values()) {
                    if (t.web == window) {
                        JSObject ev = new JSObject();
                        ev.put("tabId", t.id);
                        notifyListeners("tabClosedByPage", ev);
                        break;
                    }
                }
            }
        });

        ViewGroup root = getActivity().findViewById(android.R.id.content);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(bw, bh);
        lp.leftMargin = bx;
        lp.topMargin = by;
        root.addView(web, lp);
        web.setVisibility(View.GONE);
        tab.web = web;
        return web;
    }

    /** Makes `t` the active tab: only it is visible (when the browser is shown), the others are paused. */
    private void activate(Tab t) {
        for (Tab o : tabs.values()) {
            if (o == t || o.web == null) continue;
            o.web.setVisibility(View.GONE);
            o.web.onPause();
            if (o.hiddenAt == 0) o.hiddenAt = System.currentTimeMillis();
        }
        if (t != null) t.hiddenAt = 0;
        activeId = t == null ? -1 : t.id;
        if (t != null && t.web != null) {
            t.web.onResume();
            applyBounds(t.web);
            boolean show = visible && !t.url.isEmpty() && !t.errored;
            t.web.setVisibility(show ? View.VISIBLE : View.GONE);
            if (show) raise(t.web);
        }
        if (t != null) emitNav(t);
    }

    /** Bring a page on top and make sure it is resumed and redrawn (a paused WebView would stay black). */
    private void raise(WebView w) {
        w.onResume();
        w.bringToFront();
        View parent = (View) w.getParent();
        if (parent != null) { parent.requestLayout(); parent.invalidate(); }
        w.invalidate();
    }

    private void destroy(Tab t) {
        if (t.web != null) {
            ViewGroup root = getActivity().findViewById(android.R.id.content);
            t.web.stopLoading();
            root.removeView(t.web);
            t.web.destroy();
            t.web = null;
        }
        tabs.remove(t.id); lastNav.remove(t.id);
    }

    private static String originString(Uri origin) {
        if (origin == null) return "null";
        String s = origin.toString();
        return s.endsWith("/") ? s.substring(0, s.length() - 1) : s;
    }

    private static String originOf(String url) {
        try {
            Uri u = Uri.parse(url);
            int port = u.getPort();
            return u.getScheme() + "://" + u.getHost() + (port > 0 ? ":" + port : "");
        } catch (Exception e) {
            return "null";
        }
    }

    private void onPageMessage(Tab tab, String data, String origin) {
        JSObject ev = new JSObject();
        ev.put("tabId", tab.id);
        ev.put("pageId", tab.pageId);
        ev.put("origin", origin);
        ev.put("url", tab.url);
        ev.put("title", tab.title);
        ev.put("favicon", tab.favicon);
        ev.put("data", data);
        notifyListeners("pageMessage", ev);
    }

    private JSObject state(Tab t) {
        JSObject o = new JSObject();
        if (t == null) { o.put("tabId", -1); o.put("url", ""); o.put("canGoBack", false); o.put("canGoForward", false); return o; }
        o.put("tabId", t.id);
        o.put("active", t.id == activeId);
        o.put("pageId", t.pageId);
        o.put("url", t.url);
        o.put("title", t.title);
        o.put("favicon", t.favicon);
        o.put("loading", t.loading);
        o.put("progress", t.progress);
        o.put("visible", visible);
        o.put("canGoBack", t.web != null && t.web.canGoBack());
        o.put("canGoForward", t.web != null && t.web.canGoForward());
        return o;
    }

    // only real changes reach JS: progress ticks, repeated titles and SPA history updates arrive in bursts
    private final java.util.Map<Integer, String> lastNav = new java.util.HashMap<>();
    private void emitNav(Tab t) {
        JSObject st = state(t);
        String sig = st.toString();
        if (t != null && sig.equals(lastNav.get(t.id))) return;
        if (t != null) lastNav.put(t.id, sig);
        notifyListeners("navigation", st);
    }

    private boolean online() {
        try {
            ConnectivityManager cm = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
            NetworkCapabilities nc = cm.getNetworkCapabilities(cm.getActiveNetwork());
            return nc != null && nc.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
        } catch (Exception e) { return true; }
    }

    /** WebView error code / Chromium net error text -> error kind shown by the app. */
    private String kindOf(int code, String desc) {
        String d = desc.toUpperCase();
        if (d.contains("INTERNET_DISCONNECTED") || ((code == WebViewClient.ERROR_HOST_LOOKUP || code == WebViewClient.ERROR_CONNECT) && !online())) return "offline";
        if (d.contains("CLEARTEXT_NOT_PERMITTED")) return "cleartext";
        if (d.contains("NAME_NOT_RESOLVED") || code == WebViewClient.ERROR_HOST_LOOKUP) return "dns";
        if (d.contains("ADDRESS_UNREACHABLE") || d.contains("ADDRESS_INVALID")) return "unreachable";
        if (d.contains("CONNECTION_REFUSED") || d.contains("CONNECTION_RESET") || d.contains("CONNECTION_CLOSED") || code == WebViewClient.ERROR_CONNECT) return "refused";
        if (d.contains("TIMED_OUT") || code == WebViewClient.ERROR_TIMEOUT) return "timeout";
        if (d.contains("TOO_MANY_REDIRECTS") || code == WebViewClient.ERROR_REDIRECT_LOOP) return "redirectLoop";
        if (d.contains("SSL") || d.contains("CERT") || code == WebViewClient.ERROR_FAILED_SSL_HANDSHAKE) return "sslHandshake";
        if (code == WebViewClient.ERROR_BAD_URL || d.contains("INVALID_URL")) return "badUrl";
        if (code == WebViewClient.ERROR_UNSUPPORTED_SCHEME || d.contains("UNKNOWN_URL_SCHEME")) return "scheme";
        if (code == WebViewClient.ERROR_TOO_MANY_REQUESTS) return "tooMany";
        if (code == WebViewClient.ERROR_AUTHENTICATION || code == WebViewClient.ERROR_PROXY_AUTHENTICATION || d.contains("PROXY")) return "proxy";
        if (d.contains("BLOCKED")) return "blocked";
        if (code == WebViewClient.ERROR_IO) return "io";
        return "other";
    }

    private void emitError(Tab t, String url, String kind, int code, String detail) {
        t.loading = false;
        t.errored = true;
        if (t.web != null) t.web.setVisibility(View.GONE); // Android's own error page is never shown
        JSObject ev = new JSObject();
        ev.put("tabId", t.id);
        ev.put("url", url == null ? t.url : url);
        ev.put("kind", kind);
        ev.put("code", code);
        ev.put("detail", detail);
        notifyListeners("loadError", ev);
        emitNav(t);
    }

    /** Answer to a Safe Browsing warning: proceed to the flagged page, or go back. */
    @PluginMethod
    public void resolveUnsafe(PluginCall call) {
        boolean proceed = Boolean.TRUE.equals(call.getBoolean("proceed", false));
        getActivity().runOnUiThread(() -> {
            Tab t = tabFor(call);
            if (t != null && t.unsafe != null) {
                if (proceed) { t.errored = false; t.unsafe.proceed(false); if (t.id == activeId) activate(t); } else t.unsafe.backToSafety(false);
                t.unsafe = null;
            }
            call.resolve();
        });
    }

    // ------------------------------------------------------------------ bounds / thumbnails
    /** CSS px of the app WebView -> device px, relative to android.R.id.content */
    private void readBounds(PluginCall call) {
        if (!call.getData().has("width")) return;
        float d = getActivity().getResources().getDisplayMetrics().density;
        View appWeb = getBridge().getWebView();
        ViewGroup root = getActivity().findViewById(android.R.id.content);
        int[] a = new int[2], r = new int[2];
        appWeb.getLocationInWindow(a);
        root.getLocationInWindow(r);
        bx = a[0] - r[0] + Math.round(call.getFloat("x", 0f) * d);
        by = a[1] - r[1] + Math.round(call.getFloat("y", 0f) * d);
        bw = Math.round(call.getFloat("width", 0f) * d);
        bh = Math.round(call.getFloat("height", 0f) * d);
    }

    private void applyBounds(WebView web) {
        FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) web.getLayoutParams();
        lp.leftMargin = bx;
        lp.topMargin = by;
        lp.width = bw;
        lp.height = bh;
        web.setLayoutParams(lp);
    }

    private static String toDataUrl(Bitmap b, Bitmap.CompressFormat f, int q) {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        b.compress(f, q, bos);
        String mime = f == Bitmap.CompressFormat.PNG ? "image/png" : "image/jpeg";
        return "data:" + mime + ";base64," + Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP);
    }

    /** Screenshot of a visible tab (scaled down), delivered as a "thumbnail" event. */
    private void captureThumb(Tab t) {
        if (t == null || t.web == null || t.web.getVisibility() != View.VISIBLE || t.web.getWidth() == 0 || t.url.isEmpty()) return;
        WebView w = t.web;
        int tw = 360, th = Math.max(1, Math.round(w.getHeight() * (360f / w.getWidth())));
        Bitmap full = Bitmap.createBitmap(w.getWidth(), w.getHeight(), Bitmap.Config.ARGB_8888);
        final int tabId = t.id;
        Runnable done = () -> {
            Bitmap small = Bitmap.createScaledBitmap(full, tw, th, true);
            JSObject ev = new JSObject();
            ev.put("tabId", tabId);
            ev.put("thumb", toDataUrl(small, Bitmap.CompressFormat.JPEG, 70));
            notifyListeners("thumbnail", ev);
            full.recycle();
        };
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            int[] loc = new int[2];
            w.getLocationInWindow(loc);
            Rect src = new Rect(loc[0], loc[1], loc[0] + w.getWidth(), loc[1] + w.getHeight());
            try {
                PixelCopy.request(getActivity().getWindow(), src, full, (res) -> { if (res == PixelCopy.SUCCESS) done.run(); }, new Handler(Looper.getMainLooper()));
                return;
            } catch (Exception ignored) { }
        }
        try { w.draw(new Canvas(full)); done.run(); } catch (Exception ignored) { }
    }

    // ------------------------------------------------------------------ plugin API: tabs
    /** Creates a tab (optionally loading `url`) and makes it active unless `background`. Returns its state. */
    @PluginMethod
    public void newTab(PluginCall call) {
        String url = call.getString("url", "");
        boolean background = Boolean.TRUE.equals(call.getBoolean("background", false));
        if (!url.isEmpty() && !url.startsWith("https://") && !url.startsWith("http://")) { call.reject(getContext().getString(R.string.browser_invalid_url)); return; }
        getActivity().runOnUiThread(() -> {
            if (tabs.size() >= MAX_TABS) { call.reject(getContext().getString(R.string.browser_max_tabs, MAX_TABS)); return; }
            readBounds(call);
            Tab t = newTabRecord();
            // restored tabs keep their url/title without loading anything until they are opened
            t.url = background ? url : "";
            t.title = call.getString("title", "");
            t.favicon = call.getString("favicon", "");
            if (!background) {
                captureThumb(active());
                activate(t);
                if (!url.isEmpty()) { ensureWebView(t); activate(t); load(t.web, url); }
            }
            call.resolve(state(t));
        });
    }

    @PluginMethod
    public void switchTab(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            Tab t = tabFor(call);
            if (t == null) { call.reject(getContext().getString(R.string.browser_tab_not_found)); return; }
            readBounds(call);
            if (t.id != activeId) captureThumb(active());
            boolean lazy = t.web == null && !t.url.isEmpty();
            if (lazy) ensureWebView(t);
            activate(t);
            if (lazy) load(t.web, t.url);
            call.resolve(state(t));
        });
    }

    /**
     * A TON Connect link (tc://, chakra-tc://, https://chakrawallet.dev/ton-connect?...) in a page of the in-app
     * browser: Chakra is the wallet here, so the app handles it (no app chooser, no other wallet, the user stays on
     * the page). Dapps open these links with window.open: a tab created only for the link has nothing to show and goes.
     */
    private static boolean isTonConnectLink(Uri uri) {
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
        if (scheme.equals("tc") || scheme.equals("chakra-tc")) return true;
        String path = uri.getPath() == null ? "" : uri.getPath();
        return scheme.equals("https") && "chakrawallet.dev".equalsIgnoreCase(uri.getHost()) && path.startsWith("/ton-connect");
    }

    /**
     * A WalletConnect link (wc:…, chakra-wc://…) in a page of the in-app browser: as for TON Connect, the app connects
     * the site itself (its pages also find Chakra injected, but some offer only WalletConnect).
     */
    private static boolean isWalletConnectLink(Uri uri) {
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
        return scheme.equals("wc") || scheme.equals("chakra-wc");
    }

    /** Hands a connection link to the app (event: tonConnectLink | walletConnectLink). */
    private void connectLink(Tab tab, Uri uri, String event) {
        JSObject ev = new JSObject();
        ev.put("url", uri.toString());
        ev.put("tabId", tab.id);
        notifyListeners(event, ev);
        if (tab.url == null || tab.url.isEmpty()) { // opened for this link only (window.open): no page in it
            JSObject c = new JSObject();
            c.put("tabId", tab.id);
            notifyListeners("tabClosedByPage", c);
        }
    }

    @PluginMethod
    public void closeTab(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            Tab t = tabFor(call);
            if (t != null) {
                boolean wasActive = t.id == activeId;
                destroy(t);
                if (wasActive) activeId = -1;
            }
            call.resolve();
        });
    }

    /** Loads `url` in a tab (default: the active one). */
    @PluginMethod
    public void navigate(PluginCall call) {
        String url = call.getString("url", "");
        if (!url.startsWith("https://") && !url.startsWith("http://")) { call.reject(getContext().getString(R.string.browser_invalid_url)); return; }
        getActivity().runOnUiThread(() -> {
            Tab t = tabFor(call);
            if (t == null) { call.reject(getContext().getString(R.string.browser_tab_not_found)); return; }
            readBounds(call);
            ensureWebView(t);
            t.errored = false;
            if (t.id == activeId) activate(t);
            load(t.web, url);
            call.resolve(state(t));
        });
    }

    /** Back to the start page in a tab: its page is unloaded. */
    @PluginMethod
    public void clearTab(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            Tab t = tabFor(call);
            if (t != null) {
                if (t.web != null) {
                    ViewGroup root = getActivity().findViewById(android.R.id.content);
                    t.web.stopLoading();
                    root.removeView(t.web);
                    t.web.destroy();
                    t.web = null;
                }
                t.url = ""; t.title = ""; t.favicon = ""; t.loading = false; t.progress = 0; t.pageId = ++pageCounter; t.errored = false;
                emitNav(t);
            }
            call.resolve();
        });
    }

    /** Takes a fresh thumbnail of the active tab (e.g. before showing the tab list). */
    @PluginMethod
    public void captureActive(PluginCall call) {
        getActivity().runOnUiThread(() -> { captureThumb(active()); call.resolve(); });
    }

    @PluginMethod
    public void listTabs(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            JSArray arr = new JSArray();
            for (Tab t : tabs.values()) arr.put(state(t));
            JSObject r = new JSObject();
            r.put("tabs", arr);
            r.put("activeId", activeId);
            call.resolve(r);
        });
    }

    // ------------------------------------------------------------------ plugin API: active view
    @PluginMethod
    public void setBounds(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            readBounds(call);
            Tab t = active();
            if (t != null && t.web != null) applyBounds(t.web);
            call.resolve();
        });
    }

    // app in background: the open page stops drawing and animating (its JavaScript keeps running, as in Chrome)
    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        for (Tab t : tabs.values()) if (t.web != null) t.web.onPause();
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        Tab t = active();
        if (visible && t != null && t.web != null) t.web.onResume();
    }

    @PluginMethod
    public void show(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            visible = true;
            Tab t = active();
            if (t != null && t.web != null && !t.url.isEmpty() && !t.errored) { t.web.setVisibility(View.VISIBLE); raise(t.web); }
            call.resolve();
        });
    }

    @PluginMethod
    public void hide(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            visible = false;
            for (Tab t : tabs.values()) if (t.web != null) { t.web.setVisibility(View.GONE); t.web.onPause(); }
            call.resolve();
        });
    }

    @PluginMethod
    public void goBack(PluginCall call) {
        getActivity().runOnUiThread(() -> { Tab t = tabFor(call); if (t != null && t.web != null && t.web.canGoBack()) { t.errored = false; t.web.goBack(); } call.resolve(); });
    }

    @PluginMethod
    public void goForward(PluginCall call) {
        getActivity().runOnUiThread(() -> { Tab t = tabFor(call); if (t != null && t.web != null && t.web.canGoForward()) { t.errored = false; t.web.goForward(); } call.resolve(); });
    }

    @PluginMethod
    public void reload(PluginCall call) {
        getActivity().runOnUiThread(() -> { Tab t = tabFor(call); if (t != null && t.web != null) { t.errored = false; t.web.reload(); } call.resolve(); });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getActivity().runOnUiThread(() -> { Tab t = tabFor(call); if (t != null && t.web != null) t.web.stopLoading(); call.resolve(); });
    }

    @PluginMethod
    public void getState(PluginCall call) {
        getActivity().runOnUiThread(() -> call.resolve(state(tabFor(call))));
    }

    /** TLS certificate of the page loaded in a tab (null fields when the page is not https). */
    @PluginMethod
    public void getCertificate(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            Tab t = tabFor(call);
            JSObject r = new JSObject();
            SslCertificate c = t != null && t.web != null ? t.web.getCertificate() : null;
            r.put("url", t != null ? t.url : "");
            r.put("secure", c != null && t.url.startsWith("https://"));
            if (c != null) {
                JSObject to = new JSObject(), by = new JSObject();
                to.put("cn", c.getIssuedTo().getCName()); to.put("o", c.getIssuedTo().getOName()); to.put("ou", c.getIssuedTo().getUName());
                by.put("cn", c.getIssuedBy().getCName()); by.put("o", c.getIssuedBy().getOName()); by.put("ou", c.getIssuedBy().getUName());
                r.put("issuedTo", to);
                r.put("issuedBy", by);
                if (c.getValidNotBeforeDate() != null) r.put("validFrom", c.getValidNotBeforeDate().getTime());
                if (c.getValidNotAfterDate() != null) r.put("validTo", c.getValidNotAfterDate().getTime());
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && c.getX509Certificate() != null) {
                    try {
                        byte[] h = MessageDigest.getInstance("SHA-256").digest(c.getX509Certificate().getEncoded());
                        StringBuilder sb = new StringBuilder();
                        for (int i = 0; i < h.length; i++) sb.append(i > 0 ? ":" : "").append(String.format("%02X", h[i]));
                        r.put("sha256", sb.toString());
                        r.put("serial", c.getX509Certificate().getSerialNumber().toString(16).toUpperCase());
                    } catch (Exception ignored) { }
                }
            }
            call.resolve(r);
        });
    }

    /**
     * Deletes what the site stored on the device: cookies (for its host and parent domains), localStorage,
     * sessionStorage, IndexedDB, Cache Storage and service workers; then reloads the page.
     * The HTTP cache is shared by all sites in Android WebView and cannot be cleared for a single site.
     */
    @PluginMethod
    public void clearSiteData(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            Tab t = tabFor(call);
            if (t == null || t.url.isEmpty()) { call.reject(getContext().getString(R.string.browser_no_site)); return; }
            Uri u = Uri.parse(t.url);
            String host = u.getHost() == null ? "" : u.getHost();
            String origin = originOf(t.url);
            if (t.web != null) {
                t.web.evaluateJavascript("(async()=>{try{localStorage.clear()}catch(e){}try{sessionStorage.clear()}catch(e){}"
                        + "try{if(indexedDB.databases)for(const d of await indexedDB.databases())if(d.name)indexedDB.deleteDatabase(d.name)}catch(e){}"
                        + "try{for(const k of await caches.keys())await caches.delete(k)}catch(e){}"
                        + "try{for(const r of await navigator.serviceWorker.getRegistrations())await r.unregister()}catch(e){}})()", null);
            }
            WebStorage.getInstance().deleteOrigin(origin);
            CookieManager cm = CookieManager.getInstance();
            int removed = 0;
            String[] labels = host.split("\\.");
            for (int i = 0; i < labels.length - 1; i++) { // host and parent domains (not the bare TLD)
                StringBuilder d = new StringBuilder();
                for (int j = i; j < labels.length; j++) d.append(j > i ? "." : "").append(labels[j]);
                String domain = d.toString();
                String cookies = cm.getCookie("https://" + domain);
                if (cookies == null) continue;
                for (String part : cookies.split(";")) {
                    String name = part.split("=", 2)[0].trim();
                    if (name.isEmpty()) continue;
                    String gone = name + "=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/";
                    cm.setCookie("https://" + domain, gone);
                    cm.setCookie("https://" + domain, gone + "; Domain=." + domain);
                    removed++;
                }
            }
            cm.flush();
            if (t.web != null) { WebView w = t.web; new Handler(Looper.getMainLooper()).postDelayed(w::reload, 600); }
            JSObject r = new JSObject();
            r.put("cookies", removed);
            call.resolve(r);
        });
    }

    // ------------------------------------------------------------------ site icons (HD, from the site's metadata)
    private final ExecutorService iconPool = Executors.newFixedThreadPool(3);
    private static final Pattern LINK = Pattern.compile("<link\\b[^>]*>", Pattern.CASE_INSENSITIVE);

    private static String attr(String tag, String name) {
        Matcher m = Pattern.compile(name + "\\s*=\\s*[\"']([^\"']+)[\"']", Pattern.CASE_INSENSITIVE).matcher(tag);
        return m.find() ? m.group(1) : null;
    }

    private static int sizeOf(String sizes) {
        int best = 0;
        if (sizes == null) return 0;
        for (String p : sizes.trim().split("\\s+")) {
            if (p.equalsIgnoreCase("any")) return 512;
            try { best = Math.max(best, Integer.parseInt(p.toLowerCase().split("x")[0])); } catch (Exception ignored) { }
        }
        return best;
    }

    private static class Fetched { byte[] body; String url; String type; }

    private Fetched httpGet(String url, int maxBytes) throws Exception {
        String ua = WebSettings.getDefaultUserAgent(getContext());
        for (int hop = 0; hop < 5; hop++) {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(8000);
            c.setReadTimeout(8000);
            c.setRequestProperty("User-Agent", ua);
            c.setRequestProperty("Accept", "text/html,application/json,image/*,*/*");
            int code = c.getResponseCode();
            if (code >= 300 && code < 400 && c.getHeaderField("Location") != null) {
                url = new URL(new URL(url), c.getHeaderField("Location")).toString();
                c.disconnect();
                if (!url.startsWith("https://")) throw new Exception("insecure redirect");
                continue;
            }
            if (code != 200) { c.disconnect(); throw new Exception("HTTP " + code); }
            try (InputStream in = c.getInputStream()) {
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) {
                    bos.write(buf, 0, n);
                    if (bos.size() > maxBytes) throw new Exception("too large");
                }
                Fetched f = new Fetched();
                f.body = bos.toByteArray();
                f.url = url;
                f.type = c.getContentType() == null ? "" : c.getContentType();
                return f;
            } finally { c.disconnect(); }
        }
        throw new Exception("too many redirects");
    }

    /**
     * HD icon of a site from its own metadata: apple-touch-icon, <link rel="icon" sizes>, web app manifest icons.
     * Picks the raster icon closest to ~192px (not "maskable"), returns it as a 128px PNG data URL: { icon, source }.
     */
    @PluginMethod
    public void siteIcon(PluginCall call) {
        String site = call.getString("url", "");
        if (!site.startsWith("https://")) { call.reject("https only"); return; }
        iconPool.execute(() -> {
            try {
                Fetched page = httpGet(site, 1_500_000);
                String html = new String(page.body, StandardCharsets.UTF_8);
                URL base = new URL(page.url);
                List<Object[]> cands = new ArrayList<>(); // {url, size, maskable, source}
                Matcher m = LINK.matcher(html);
                while (m.find()) {
                    String tag = m.group(), rel = attr(tag, "rel"), href = attr(tag, "href");
                    if (rel == null || href == null) continue;
                    rel = rel.toLowerCase();
                    String abs = new URL(base, href.replace("&amp;", "&")).toString();
                    if (rel.contains("apple-touch-icon")) cands.add(new Object[]{abs, Math.max(180, sizeOf(attr(tag, "sizes"))), false, "apple"});
                    else if (rel.matches("(.*\\s)?icon(\\s.*)?")) cands.add(new Object[]{abs, sizeOf(attr(tag, "sizes")), false, "icon"});
                    else if (rel.equals("manifest")) {
                        try {
                            Fetched mf = httpGet(abs, 300_000);
                            JSONArray icons = new JSONObject(new String(mf.body, StandardCharsets.UTF_8)).optJSONArray("icons");
                            for (int i = 0; icons != null && i < icons.length(); i++) {
                                JSONObject ic = icons.getJSONObject(i);
                                String purpose = ic.optString("purpose", "");
                                if (purpose.contains("monochrome")) continue;
                                cands.add(new Object[]{new URL(new URL(mf.url), ic.getString("src")).toString(), sizeOf(ic.optString("sizes")), purpose.contains("maskable"), "manifest"});
                            }
                        } catch (Exception ignored) { }
                    }
                }
                cands.add(new Object[]{new URL(base, "/apple-touch-icon.png").toString(), 180, false, "guess"});
                cands.sort((a, b) -> Integer.compare(score(a), score(b)));
                for (Object[] c : cands) {
                    String u = (String) c[0];
                    if (!u.startsWith("https://") || u.toLowerCase().contains(".svg")) continue;
                    try {
                        Fetched img = httpGet(u, 600_000);
                        Bitmap b = BitmapFactory.decodeByteArray(img.body, 0, img.body.length);
                        if (b == null || Math.min(b.getWidth(), b.getHeight()) < 64) continue;
                        int side = 128;
                        Bitmap out = Bitmap.createBitmap(side, side, Bitmap.Config.ARGB_8888);
                        float k = Math.min(side / (float) b.getWidth(), side / (float) b.getHeight());
                        int w = Math.round(b.getWidth() * k), h = Math.round(b.getHeight() * k);
                        new Canvas(out).drawBitmap(Bitmap.createScaledBitmap(b, w, h, true), (side - w) / 2f, (side - h) / 2f, null);
                        JSObject r = new JSObject();
                        r.put("icon", toDataUrl(out, Bitmap.CompressFormat.PNG, 100));
                        r.put("source", c[3]);
                        call.resolve(r);
                        return;
                    } catch (Exception ignored) { }
                }
                call.reject("no icon");
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? "error" : e.getMessage());
            }
        });
    }

    private static int score(Object[] c) { // lower is better: ~192px from above, not maskable, then bigger, then small
        int size = (Integer) c[1];
        return (Boolean.TRUE.equals(c[2]) ? 1000 : 0) + (size >= 160 ? size - 160 : 2000 - size);
    }

    // ------------------------------------------------------------------ site permissions (camera, mic, location)
    private final Map<Integer, Object[]> pendingPerms = new java.util.HashMap<>(); // id -> {PermissionRequest | Geo callback, origin, kinds}
    private int nextPermId = 1;
    private final Map<String, String> rememberedPerms = new java.util.HashMap<>(); // "origin|kind" -> allow / deny

    private void askUser(Tab tab, String origin, List<String> kinds, PermissionRequest req, GeolocationPermissions.Callback geo) {
        // remembered for this site and already allowed by Android: answer at once
        boolean all = true, anyDeny = false;
        for (String k : kinds) { String v = rememberedPerms.get(origin + "|" + k); if (!"allow".equals(v)) all = false; if ("deny".equals(v)) anyDeny = true; }
        if (anyDeny) { if (req != null) req.deny(); else geo.invoke(origin, false, false); return; }
        if (all && androidAllows(kinds)) { grant(req, geo, origin); return; }
        int id = nextPermId++;
        pendingPerms.put(id, new Object[]{ req != null ? req : geo, origin, kinds });
        JSObject ev = new JSObject();
        ev.put("id", id);
        ev.put("tabId", tab.id);
        ev.put("origin", origin);
        ev.put("kinds", new JSArray(kinds));
        notifyListeners("permissionRequest", ev);
    }

    private boolean androidAllows(List<String> kinds) {
        for (String k : kinds) if (getPermissionState(k) != PermissionState.GRANTED) return false;
        return true;
    }

    private void grant(PermissionRequest req, GeolocationPermissions.Callback geo, String origin) {
        if (req != null) req.grant(req.getResources()); else geo.invoke(origin, true, false);
    }

    private void notifyPermGone(int id) {
        JSObject ev = new JSObject();
        ev.put("id", id);
        notifyListeners("permissionCancelled", ev);
    }

    /** The user's answer: { id, allow }. When allowed, Android's own permission is asked if needed. */
    @PluginMethod
    public void answerPermission(PluginCall call) {
        int id = call.getInt("id", -1);
        boolean allow = Boolean.TRUE.equals(call.getBoolean("allow", false));
        Object[] p = pendingPerms.get(id);
        if (p == null) { call.resolve(); return; }
        @SuppressWarnings("unchecked") List<String> kinds = (List<String>) p[2];
        if (!allow) { finishPerm(id, false); call.resolve(); return; }
        if (androidAllows(kinds)) { finishPerm(id, true); call.resolve(); return; }
        requestPermissionForAliases(kinds.toArray(new String[0]), call, "afterAndroidPermission");
    }

    @PermissionCallback
    private void afterAndroidPermission(PluginCall call) {
        int id = call.getInt("id", -1);
        Object[] p = pendingPerms.get(id);
        if (p == null) { call.resolve(); return; }
        @SuppressWarnings("unchecked") List<String> kinds = (List<String>) p[2];
        boolean ok = androidAllows(kinds);
        finishPerm(id, ok);
        JSObject r = new JSObject();
        r.put("granted", ok);
        call.resolve(r);
    }

    private void finishPerm(int id, boolean allow) {
        Object[] p = pendingPerms.remove(id);
        if (p == null) return;
        getActivity().runOnUiThread(() -> {
            if (p[0] instanceof PermissionRequest) { PermissionRequest r = (PermissionRequest) p[0]; if (allow) r.grant(r.getResources()); else r.deny(); }
            else ((GeolocationPermissions.Callback) p[0]).invoke((String) p[1], allow, false);
        });
    }

    /** Remembered choices, from the app: { perms: { "origin|kind": "allow" | "deny" } } */
    @PluginMethod
    public void setSitePermissions(PluginCall call) {
        JSObject perms = call.getObject("perms", new JSObject());
        rememberedPerms.clear();
        java.util.Iterator<String> it = perms.keys();
        while (it.hasNext()) { String k = it.next(); rememberedPerms.put(k, perms.getString(k)); }
        call.resolve();
    }

    // ------------------------------------------------------------------ downloads
    private void download(Tab tab, String url, String ua, String disposition, String mime) {
        String name = URLUtil.guessFileName(url, disposition, mime);
        try {
            if (url.startsWith("http://") || url.startsWith("https://")) {
                DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
                String cookies = CookieManager.getInstance().getCookie(url);
                if (cookies != null) r.addRequestHeader("Cookie", cookies);
                r.addRequestHeader("User-Agent", ua);
                r.setMimeType(mime);
                r.setTitle(name);
                r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
                ((DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE)).enqueue(r);
                emitDownload(name, "started");
            } else if (url.startsWith("data:")) {
                String meta = url.substring(5, url.indexOf(','));
                String body = url.substring(url.indexOf(',') + 1);
                byte[] bytes = meta.endsWith(";base64") ? Base64.decode(body, Base64.DEFAULT) : Uri.decode(body).getBytes(StandardCharsets.UTF_8);
                askDownload(tab, bytes, name, meta.split(";")[0].isEmpty() ? mime : meta.split(";")[0]);
            } else if (url.startsWith("blob:") && tab.web != null) {
                String js = "(async()=>{try{const b=await (await fetch(" + JSObject.quote(url) + ")).blob();const r=new FileReader();"
                        + "r.onload=()=>chakraDownload.postMessage(JSON.stringify({data:r.result,name:" + JSObject.quote(name) + ",mime:b.type||" + JSObject.quote(mime) + "}));r.readAsDataURL(b)}catch(e){}})()";
                tab.web.evaluateJavascript(js, null);
            }
        } catch (Exception e) {
            emitDownload(name, "failed");
        }
    }

    // files generated by the page (data: / blob:) are saved only after the user confirms
    private final Map<Integer, Object[]> pendingDownloads = new java.util.HashMap<>();
    private int nextDownloadId = 1;

    private void askDownload(Tab tab, byte[] bytes, String name, String mime) {
        int id = nextDownloadId++;
        pendingDownloads.put(id, new Object[]{ bytes, name, mime });
        JSObject ev = new JSObject();
        ev.put("id", id);
        ev.put("tabId", tab.id);
        ev.put("origin", originOf(tab.url));
        ev.put("name", name);
        ev.put("size", bytes.length);
        notifyListeners("downloadRequest", ev);
    }

    /** { id, save }: the user's answer to a download generated by a page. */
    @PluginMethod
    public void answerDownload(PluginCall call) {
        Object[] d = pendingDownloads.remove(call.getInt("id", -1));
        if (d != null && Boolean.TRUE.equals(call.getBoolean("save", false))) saveBytes((byte[]) d[0], (String) d[1], (String) d[2]);
        call.resolve();
    }

    private void saveBytes(byte[] bytes, String name, String mime) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues v = new ContentValues();
                v.put(MediaStore.Downloads.DISPLAY_NAME, name);
                v.put(MediaStore.Downloads.MIME_TYPE, mime);
                v.put(MediaStore.Downloads.IS_PENDING, 1);
                Uri uri = getContext().getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                try (java.io.OutputStream os = getContext().getContentResolver().openOutputStream(uri)) { os.write(bytes); }
                v.clear();
                v.put(MediaStore.Downloads.IS_PENDING, 0);
                getContext().getContentResolver().update(uri, v, null, null);
            } else {
                java.io.File f = new java.io.File(getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), name);
                try (java.io.FileOutputStream os = new java.io.FileOutputStream(f)) { os.write(bytes); }
            }
            emitDownload(name, "saved");
        } catch (Exception e) {
            emitDownload(name, "failed");
        }
    }

    private void emitDownload(String name, String status) {
        JSObject ev = new JSObject();
        ev.put("name", name);
        ev.put("status", status);
        notifyListeners("download", ev);
    }

    /** Deliver a message from the wallet to a page, only if that tab still shows the same page. */
    @PluginMethod
    public void sendToPage(PluginCall call) {
        int target = call.getInt("pageId", -1);
        String json = call.getString("json", "null");
        getActivity().runOnUiThread(() -> {
            Tab t = tabFor(call);
            if (t == null || t.web == null || target != t.pageId) { call.resolve(); return; }
            String safe = json.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029");
            t.web.evaluateJavascript("window.__ewReceive && window.__ewReceive(" + safe + ")", null);
            call.resolve();
        });
    }

    /**
     * Injects one of the app's own page scripts (only those listed) into a tab, if it still shows the same page:
     * TronWeb for the Tron sites, too large to be in every page (src/mobile/tronwebPage.js).
     */
    @PluginMethod
    public void injectScript(PluginCall call) {
        int target = call.getInt("pageId", -1);
        String name = call.getString("name", "");
        if (!"tronweb".equals(name)) { call.reject("unknown script"); return; }
        String js = pageScript(name);
        if (js.isEmpty()) { call.reject("missing script"); return; }
        getActivity().runOnUiThread(() -> {
            Tab t = tabFor(call);
            if (t == null || t.web == null || target != t.pageId) { call.resolve(); return; }
            t.web.evaluateJavascript(js, null);
            call.resolve();
        });
    }

    private final java.util.Map<String, String> pageScripts = new java.util.HashMap<>();

    private String pageScript(String name) {
        synchronized (pageScripts) {
            String s = pageScripts.get(name);
            if (s != null) return s;
            try (InputStream is = getContext().getAssets().open("public/" + name + ".js")) {
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                byte[] buf = new byte[16384];
                int n;
                while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
                s = bos.toString(StandardCharsets.UTF_8.name());
            } catch (Exception e) { s = ""; }
            pageScripts.put(name, s);
            return s;
        }
    }

    /** Block screenshots / screen recording while sensitive data is on screen. */
    @PluginMethod
    public void setSecure(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
            call.resolve();
        });
    }
}

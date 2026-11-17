package dev.chakrawallet;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.os.Build;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.math.RoundingMode;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.TimeUnit;

/**
 * Periodic background check (WorkManager, every 15 min, only with network; Android batches and defers it to
 * save battery). Reads what the app wrote in its storage ("watch" config and "bridges"), then:
 *  - balances of every account on every main network (native + well-known tokens, one batched JSON-RPC request
 *    per network): an increase or a decrease since the last check -> "Received" / "Sent" notification;
 *  - TON (Android app): GRAM and the watched jettons of each account's TON wallet, from TON Center (at most one
 *    request a second without a key); tiny GRAM credits (the ads of spam transfers) aren't notified;
 *  - bridges still in transit: asks Relay / LI.FI / Across / deBridge -> "Bridge arrived / refunded / failed".
 * Nothing is notified while the app is in the foreground (the app shows its own toasts there).
 */
public class WatchWorker extends Worker {
    static final String WORK = "chakra-watch";
    static final String CHANNEL = "wallet-activity";
    static final String STATE = "chakra_watch"; // snapshot of balances, notified bridges, foreground flag
    private static final String STORE = "CapacitorStorage"; // Capacitor Preferences

    public WatchWorker(@NonNull Context c, @NonNull WorkerParameters p) { super(c, p); }

    static void schedule(Context c, boolean on) {
        WorkManager wm = WorkManager.getInstance(c);
        if (!on) { wm.cancelUniqueWork(WORK); return; }
        PeriodicWorkRequest req = new PeriodicWorkRequest.Builder(WatchWorker.class, 15, TimeUnit.MINUTES)
                .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build();
        wm.enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.UPDATE, req);
    }

    static void setForeground(Context c, boolean fg) {
        c.getSharedPreferences(STATE, Context.MODE_PRIVATE).edit().putBoolean("fg", fg).apply();
    }

    static boolean isForeground(Context c) { return c.getSharedPreferences(STATE, Context.MODE_PRIVATE).getBoolean("fg", false); }

    @NonNull
    @Override
    public Result doWork() {
        Context c = getApplicationContext();
        try {
            SharedPreferences store = c.getSharedPreferences(STORE, Context.MODE_PRIVATE);
            String cfgRaw = store.getString("ew_local:watch", null);
            if (cfgRaw == null) return Result.success();
            JSONObject cfg = new JSONObject(cfgRaw);
            if (!cfg.optBoolean("enabled", true)) return Result.success();
            Context lc = localized(c, cfg.optString("lang", "en"));
            locale = "it".equals(cfg.optString("lang")) ? Locale.ITALIAN : Locale.ENGLISH;
            checkBalances(c, lc, cfg);
            try { checkTon(c, lc, cfg.optJSONObject("ton")); } catch (Exception ignored) { }
            checkBridges(c, lc, store.getString("ew_local:bridges", "[]"));
        } catch (Exception ignored) { }
        return Result.success();
    }

    // ------------------------------------------------------------------ balances
    private void checkBalances(Context c, Context lc, JSONObject cfg) throws Exception {
        SharedPreferences st = c.getSharedPreferences(STATE, Context.MODE_PRIVATE);
        SharedPreferences.Editor ed = st.edit();
        JSONArray accounts = cfg.getJSONArray("accounts"), chains = cfg.getJSONArray("chains");
        for (int ci = 0; ci < chains.length(); ci++) {
            JSONObject ch = chains.getJSONObject(ci);
            JSONArray tokens = ch.optJSONArray("tokens");
            // one batched request: native balance + balanceOf(each token) for each account
            JSONArray batch = new JSONArray();
            int id = 0;
            for (int ai = 0; ai < accounts.length(); ai++) {
                String a = accounts.getJSONObject(ai).getString("address").toLowerCase(Locale.ROOT);
                batch.put(new JSONObject().put("jsonrpc", "2.0").put("id", id++).put("method", "eth_getBalance").put("params", new JSONArray().put(a).put("latest")));
                for (int ti = 0; tokens != null && ti < tokens.length(); ti++) {
                    String data = "0x70a08231" + "000000000000000000000000" + a.substring(2);
                    batch.put(new JSONObject().put("jsonrpc", "2.0").put("id", id++).put("method", "eth_call")
                            .put("params", new JSONArray().put(new JSONObject().put("to", tokens.getJSONObject(ti).getString("address")).put("data", data)).put("latest")));
                }
            }
            JSONArray res = null;
            JSONArray rpcs = ch.getJSONArray("rpc");
            for (int r = 0; r < rpcs.length() && res == null; r++) {
                try { res = new JSONArray(post(rpcs.getString(r), batch.toString())); } catch (Exception ignored) { }
            }
            if (res == null) continue;
            String[] values = new String[id];
            for (int i = 0; i < res.length(); i++) {
                JSONObject o = res.getJSONObject(i);
                if (o.has("result") && !o.isNull("result")) values[o.getInt("id")] = o.getString("result");
            }
            id = 0;
            for (int ai = 0; ai < accounts.length(); ai++) {
                JSONObject acc = accounts.getJSONObject(ai);
                String a = acc.getString("address").toLowerCase(Locale.ROOT);
                compare(c, lc, ed, st, ch, acc, a, "native", ch.getString("symbol"), ch.getInt("decimals"), values[id++], true);
                for (int ti = 0; tokens != null && ti < tokens.length(); ti++) {
                    JSONObject tk = tokens.getJSONObject(ti);
                    compare(c, lc, ed, st, ch, acc, a, tk.getString("address").toLowerCase(Locale.ROOT), tk.getString("symbol"), tk.getInt("decimals"), values[id++], false);
                }
            }
        }
        ed.apply();
    }

    private void compare(Context c, Context lc, SharedPreferences.Editor ed, SharedPreferences st, JSONObject ch, JSONObject acc,
                         String addr, String token, String symbol, int decimals, String hex, boolean isNative) throws Exception {
        if (hex == null || !hex.startsWith("0x")) return;
        BigInteger now = hex.length() > 2 ? new BigInteger(hex.substring(2), 16) : BigInteger.ZERO;
        compareAmount(c, lc, ed, st, ch, acc, addr, token, symbol, decimals, now, isNative, BigInteger.ZERO);
    }

    /** minIncrease: credits below it aren't news (TON: the dust of spam transfers). */
    private void compareAmount(Context c, Context lc, SharedPreferences.Editor ed, SharedPreferences st, JSONObject ch, JSONObject acc,
                               String addr, String token, String symbol, int decimals, BigInteger now, boolean isNative, BigInteger minIncrease) throws Exception {
        String key = ch.getInt("id") + ":" + addr + ":" + token;
        String prev = st.getString(key, null);
        ed.putString(key, now.toString());
        if (prev == null) return; // first look: just remember
        BigInteger diff = now.subtract(new BigInteger(prev));
        if (diff.signum() == 0) return;
        // network fees alone are not news: ignore small native decreases (< 2% of the previous balance)
        if (isNative && diff.signum() < 0 && diff.negate().multiply(BigInteger.valueOf(50)).compareTo(new BigInteger(prev)) < 0) return;
        if (diff.signum() > 0 && diff.compareTo(minIncrease) < 0) return;
        String amount = fmt(diff.abs(), decimals);
        String title = lc.getString(diff.signum() > 0 ? R.string.notif_received : R.string.notif_sent, amount, symbol);
        String body = lc.getString(R.string.notif_where, ch.getString("name"), acc.optString("name", addr.substring(0, 8)));
        notify(c, (key + now).hashCode(), title, body, diff.signum() > 0);
    }

    // ------------------------------------------------------------------ TON
    private static final BigInteger TON_DUST = BigInteger.valueOf(50_000_000L); // 0.05 GRAM: below it, a credit is an ad

    /** ton: { name, symbol, decimals, api, key, accounts: [{ id, address (raw), name }], jettons: [{ master (raw), symbol, decimals }] } */
    private void checkTon(Context c, Context lc, JSONObject ton) throws Exception {
        if (ton == null) return;
        JSONArray accounts = ton.optJSONArray("accounts");
        if (accounts == null || accounts.length() == 0) return;
        String api = ton.getString("api"), key = ton.optString("key", "");
        String auth = key.isEmpty() ? "" : "&api_key=" + enc(key);
        long gap = key.isEmpty() ? 1100 : 150; // TON Center: 1 request a second without a key
        JSONArray jettons = ton.optJSONArray("jettons");
        // only the watched jettons: an account full of airdropped ones can't push them out of the answer
        StringBuilder only = new StringBuilder();
        for (int ji = 0; jettons != null && ji < jettons.length(); ji++) only.append("&jetton_address=").append(enc(jettons.getJSONObject(ji).getString("master")));
        JSONObject ch = new JSONObject().put("id", -239).put("name", ton.optString("name", "TON"));
        SharedPreferences st = c.getSharedPreferences(STATE, Context.MODE_PRIVATE);
        SharedPreferences.Editor ed = st.edit();
        for (int ai = 0; ai < accounts.length(); ai++) {
            JSONObject acc = accounts.getJSONObject(ai);
            String raw = acc.getString("address");
            try {
                JSONObject w = new JSONObject(get(api + "/api/v3/walletInformation?use_v2=false&address=" + enc(raw) + auth));
                String bal = w.optString("balance", "");
                if (bal.matches("\\d+")) compareAmount(c, lc, ed, st, ch, acc, raw, "native", ton.optString("symbol", "GRAM"), ton.optInt("decimals", 9), new BigInteger(bal), true, TON_DUST);
            } catch (Exception ignored) { }
            Thread.sleep(gap);
            if (jettons == null || jettons.length() == 0) continue;
            try {
                JSONArray held = new JSONObject(get(api + "/api/v3/jetton/wallets?limit=100&owner_address=" + enc(raw) + only + auth)).optJSONArray("jetton_wallets");
                java.util.Map<String, BigInteger> byMaster = new java.util.HashMap<>();
                for (int i = 0; held != null && i < held.length(); i++) {
                    JSONObject jw = held.getJSONObject(i);
                    String b = jw.optString("balance", "");
                    if (b.matches("\\d+")) byMaster.put(jw.optString("jetton").toUpperCase(Locale.ROOT), new BigInteger(b));
                }
                for (int ji = 0; ji < jettons.length(); ji++) {
                    JSONObject j = jettons.getJSONObject(ji);
                    String master = j.getString("master").toUpperCase(Locale.ROOT);
                    BigInteger now = byMaster.containsKey(master) ? byMaster.get(master) : BigInteger.ZERO;
                    compareAmount(c, lc, ed, st, ch, acc, raw, master, j.getString("symbol"), j.getInt("decimals"), now, false, BigInteger.ZERO);
                }
            } catch (Exception ignored) { }
            Thread.sleep(gap);
        }
        ed.apply();
    }

    private static String enc(String s) throws Exception { return java.net.URLEncoder.encode(s, "UTF-8"); }

    private static Locale locale = Locale.ENGLISH;

    /** Amount in the app language: "7,45" / "7.45", up to 4 decimals (4 significant digits below 1). */
    private static String fmt(BigInteger raw, int decimals) {
        BigDecimal v = new BigDecimal(raw).movePointLeft(decimals);
        java.text.NumberFormat nf = java.text.NumberFormat.getNumberInstance(locale);
        nf.setRoundingMode(RoundingMode.HALF_UP);
        if (v.compareTo(BigDecimal.ONE) >= 0) nf.setMaximumFractionDigits(v.compareTo(BigDecimal.valueOf(1000)) >= 0 ? 2 : 4);
        else nf.setMaximumFractionDigits(Math.max(4, 3 - (int) Math.floor(Math.log10(Math.max(v.doubleValue(), 1e-18)))));
        return nf.format(v);
    }

    // ------------------------------------------------------------------ bridges
    private void checkBridges(Context c, Context lc, String raw) throws Exception {
        JSONArray list = new JSONArray(raw);
        SharedPreferences st = c.getSharedPreferences(STATE, Context.MODE_PRIVATE);
        for (int i = 0; i < list.length(); i++) {
            JSONObject b = list.getJSONObject(i);
            if (!"pending".equals(b.optString("status")) || System.currentTimeMillis() - b.optLong("created") > 3L * 86400000L) continue;
            String id = b.optString("id");
            if (st.getBoolean("bridge:" + id, false)) continue;
            String status = bridgeStatus(b);
            if (status == null || "pending".equals(status)) continue;
            st.edit().putBoolean("bridge:" + id, true).apply();
            JSONObject tok = b.optJSONObject("toToken");
            String symbol = tok != null ? tok.optString("symbol") : "";
            int dec = tok != null ? tok.optInt("decimals", 18) : 18;
            String amount = fmt(new BigInteger(b.optString("amountOut", "0")), dec);
            int title = "done".equals(status) ? R.string.notif_bridge_done : "refunded".equals(status) ? R.string.notif_bridge_refunded : R.string.notif_bridge_failed;
            notify(c, ("bridge" + id).hashCode(), lc.getString(title), lc.getString(R.string.notif_bridge_body, amount, symbol, chainName(b.optInt("toChainId"))), "done".equals(status));
        }
    }

    private String bridgeStatus(JSONObject b) {
        try {
            String p = b.optString("provider"), tx = b.optString("txHash");
            JSONObject ref = b.optJSONObject("ref");
            if ("Relay".equals(p) && ref != null) {
                String s = new JSONObject(get("https://api.relay.link/intents/status/v2?requestId=" + ref.optString("requestId"))).optString("status");
                return "success".equals(s) ? "done" : "refund".equals(s) ? "refunded" : "failure".equals(s) ? "failed" : "pending";
            }
            if ("LI.FI".equals(p)) {
                JSONObject r = new JSONObject(get("https://li.quest/v1/status?txHash=" + tx + "&fromChain=" + b.optInt("fromChainId") + "&toChain=" + b.optInt("toChainId")));
                String s = r.optString("status");
                return "DONE".equals(s) ? ("REFUNDED".equals(r.optString("substatus")) ? "refunded" : "done") : "FAILED".equals(s) ? "failed" : "pending";
            }
            if ("Across".equals(p)) {
                String s = new JSONObject(get("https://app.across.to/api/deposit/status?originChainId=" + b.optInt("fromChainId") + "&depositTxHash=" + tx)).optString("status");
                return "filled".equals(s) ? "done" : ("refunded".equals(s) || "expired".equals(s)) ? "refunded" : "pending";
            }
            if ("deBridge".equals(p) && ref != null) {
                String s = new JSONObject(get("https://dln.debridge.finance/v1.0/dln/order/" + ref.optString("orderId") + "/status")).optString("status");
                return s.contains("Fulfilled") || s.contains("Unlock") ? "done" : s.contains("Cancel") ? "refunded" : "pending";
            }
        } catch (Exception ignored) { }
        return null;
    }

    private static String chainName(int id) {
        switch (id) {
            case 1: return "Ethereum"; case 8453: return "Base"; case 42161: return "Arbitrum"; case 10: return "Optimism";
            case 137: return "Polygon"; case 56: return "BNB Chain"; case 43114: return "Avalanche"; case 100: return "Gnosis";
            default: return "#" + id;
        }
    }

    // ------------------------------------------------------------------ notifications
    static void ensureChannel(Context c, Context lc) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL, lc.getString(R.string.notif_channel), NotificationManager.IMPORTANCE_DEFAULT);
        ch.setDescription(lc.getString(R.string.notif_channel_desc));
        ch.setLightColor(0xFF1B4DDB);
        c.getSystemService(NotificationManager.class).createNotificationChannel(ch);
    }

    static void notify(Context c, int id, String title, String body, boolean positive) {
        if (isForeground(c)) return; // the app is open: it shows its own messages
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(c, android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
        ensureChannel(c, c);
        Intent open = new Intent(c, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(c, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder n = new NotificationCompat.Builder(c, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_chakra)
                .setColor(positive ? 0xFF138A52 : 0xFF1B4DDB)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setContentIntent(pi)
                .setCategory(NotificationCompat.CATEGORY_STATUS)
                .setGroup("chakra-activity");
        try { NotificationManagerCompat.from(c).notify(id, n.build()); } catch (SecurityException ignored) { }
    }

    private static Context localized(Context c, String lang) {
        Configuration conf = new Configuration(c.getResources().getConfiguration());
        conf.setLocale(Locale.forLanguageTag("it".equals(lang) ? "it" : "en"));
        return c.createConfigurationContext(conf);
    }

    // ------------------------------------------------------------------ http
    private static String get(String url) throws Exception { return http(url, null); }
    private static String post(String url, String json) throws Exception { return http(url, json); }

    private static String http(String url, String body) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(10000);
        c.setReadTimeout(15000);
        c.setRequestProperty("Accept", "application/json");
        if (body != null) {
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            try (OutputStream os = c.getOutputStream()) { os.write(body.getBytes(StandardCharsets.UTF_8)); }
        }
        try (InputStream in = c.getInputStream()) {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) { bos.write(buf, 0, n); if (bos.size() > 2_000_000) break; }
            return bos.toString("UTF-8");
        } finally { c.disconnect(); }
    }
}

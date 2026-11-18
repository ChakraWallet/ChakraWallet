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
 *  - Solana: SOL and the watched tokens of each account's Solana address, from a Solana node (the first of the list
 *    that answers); tiny SOL credits (the dust of address poisoning) aren't notified;
 *  - Tron: TRX and the watched TRC-20 tokens of each account's Tron address, from TronGrid (one request per account;
 *    a few a second without a key); tiny TRX credits (the dust of address poisoning) aren't notified;
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
            try { checkSolana(c, lc, cfg.optJSONObject("solana")); } catch (Exception ignored) { }
            try { checkTron(c, lc, cfg.optJSONObject("tron")); } catch (Exception ignored) { }
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

    // ------------------------------------------------------------------ Solana
    private static final BigInteger SOL_DUST = BigInteger.valueOf(1_000_000L); // 0.001 SOL: below it, a credit is poisoning dust
    private static final String[] SPL_PROGRAMS = { "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" };

    /** The `result` of a JSON-RPC call from the first node that gives one (nodes refuse some methods), or null. */
    private static Object solRpc(JSONArray rpcs, String method, JSONArray params) {
        String body;
        try { body = new JSONObject().put("jsonrpc", "2.0").put("id", 1).put("method", method).put("params", params).toString(); } catch (Exception e) { return null; }
        for (int i = 0; rpcs != null && i < rpcs.length(); i++) {
            try {
                JSONObject r = new JSONObject(post(rpcs.getString(i), body));
                if (r.has("result") && !r.isNull("result")) return r.get("result");
            } catch (Exception ignored) { }
        }
        return null;
    }

    /** solana: { name, symbol, decimals, rpc: [urls], accounts: [{ id, address, name }], tokens: [{ mint, symbol, decimals }] } */
    private void checkSolana(Context c, Context lc, JSONObject sol) throws Exception {
        if (sol == null) return;
        JSONArray accounts = sol.optJSONArray("accounts");
        if (accounts == null || accounts.length() == 0) return;
        JSONArray rpcs = sol.optJSONArray("rpc");
        JSONArray tokens = sol.optJSONArray("tokens");
        JSONObject ch = new JSONObject().put("id", -501).put("name", sol.optString("name", "Solana"));
        SharedPreferences st = c.getSharedPreferences(STATE, Context.MODE_PRIVATE);
        SharedPreferences.Editor ed = st.edit();
        JSONObject confirmed = new JSONObject().put("commitment", "confirmed");
        for (int ai = 0; ai < accounts.length(); ai++) {
            JSONObject acc = accounts.getJSONObject(ai);
            String a = acc.getString("address"); // base58: case matters
            Object bal = solRpc(rpcs, "getBalance", new JSONArray().put(a).put(confirmed));
            if (bal instanceof JSONObject && ((JSONObject) bal).has("value")) {
                compareAmount(c, lc, ed, st, ch, acc, a, "native", sol.optString("symbol", "SOL"), sol.optInt("decimals", 9),
                        new BigInteger(((JSONObject) bal).get("value").toString()), true, SOL_DUST);
            }
            if (tokens == null || tokens.length() == 0) continue;
            // the token accounts of both token programs; a query that fails leaves the tokens alone (no false "sent")
            java.util.Map<String, BigInteger> byMint = new java.util.HashMap<>();
            boolean ok = true;
            for (String program : SPL_PROGRAMS) {
                Object r = solRpc(rpcs, "getTokenAccountsByOwner", new JSONArray().put(a).put(new JSONObject().put("programId", program))
                        .put(new JSONObject().put("encoding", "jsonParsed").put("commitment", "confirmed")));
                JSONArray list = r instanceof JSONObject ? ((JSONObject) r).optJSONArray("value") : null;
                if (list == null) { ok = false; break; }
                for (int i = 0; i < list.length(); i++) {
                    JSONObject info = list.getJSONObject(i).optJSONObject("account");
                    info = info == null ? null : info.optJSONObject("data");
                    info = info == null ? null : info.optJSONObject("parsed");
                    info = info == null ? null : info.optJSONObject("info");
                    if (info == null) continue;
                    String mint = info.optString("mint", "");
                    JSONObject amt = info.optJSONObject("tokenAmount");
                    String v = amt == null ? "" : amt.optString("amount", "");
                    if (!v.matches("\\d+")) continue;
                    BigInteger prev = byMint.containsKey(mint) ? byMint.get(mint) : BigInteger.ZERO;
                    byMint.put(mint, prev.add(new BigInteger(v)));
                }
            }
            if (!ok) continue;
            for (int ti = 0; ti < tokens.length(); ti++) {
                JSONObject tk = tokens.getJSONObject(ti);
                String mint = tk.getString("mint");
                BigInteger now = byMint.containsKey(mint) ? byMint.get(mint) : BigInteger.ZERO;
                compareAmount(c, lc, ed, st, ch, acc, a, mint, tk.getString("symbol"), tk.getInt("decimals"), now, false, BigInteger.ZERO);
            }
        }
        ed.apply();
    }

    // ------------------------------------------------------------------ Tron
    private static final BigInteger TRX_DUST = BigInteger.valueOf(100_000L); // 0.1 TRX: below it, a credit is poisoning dust

    /** tron: { name, symbol, decimals, api, key, accounts: [{ id, address (T…), name }], tokens: [{ address, symbol, decimals }] } */
    private void checkTron(Context c, Context lc, JSONObject tr) throws Exception {
        if (tr == null) return;
        JSONArray accounts = tr.optJSONArray("accounts");
        if (accounts == null || accounts.length() == 0) return;
        String api = tr.optString("api", "https://api.trongrid.io"), key = tr.optString("key", "");
        long gap = key.isEmpty() ? 1200 : 200; // TronGrid: few requests a second without a key
        JSONArray tokens = tr.optJSONArray("tokens");
        JSONObject ch = new JSONObject().put("id", -195).put("name", tr.optString("name", "Tron"));
        SharedPreferences st = c.getSharedPreferences(STATE, Context.MODE_PRIVATE);
        SharedPreferences.Editor ed = st.edit();
        for (int ai = 0; ai < accounts.length(); ai++) {
            JSONObject acc = accounts.getJSONObject(ai);
            String a = acc.getString("address"); // base58: case matters
            try {
                JSONObject j = new JSONObject(http(api + "/v1/accounts/" + enc(a), null, key));
                JSONArray data = j.optJSONArray("data");
                if (data == null || !j.optBoolean("success", true)) continue; // no answer: leave the balances alone
                BigInteger trx = BigInteger.ZERO;
                java.util.Map<String, BigInteger> held = new java.util.HashMap<>();
                if (data.length() > 0) {
                    JSONObject d = data.getJSONObject(0);
                    String b = d.optString("balance", "0");
                    if (b.matches("\\d+")) trx = new BigInteger(b);
                    JSONArray trc20 = d.optJSONArray("trc20");
                    for (int i = 0; trc20 != null && i < trc20.length(); i++) {
                        JSONObject o = trc20.getJSONObject(i);
                        for (java.util.Iterator<String> it = o.keys(); it.hasNext(); ) {
                            String t = it.next(), v = o.optString(t, "");
                            if (v.matches("\\d+")) held.put(t, new BigInteger(v));
                        }
                    }
                }
                compareAmount(c, lc, ed, st, ch, acc, a, "native", tr.optString("symbol", "TRX"), tr.optInt("decimals", 6), trx, true, TRX_DUST);
                for (int ti = 0; tokens != null && ti < tokens.length(); ti++) {
                    JSONObject tk = tokens.getJSONObject(ti);
                    String t = tk.getString("address");
                    compareAmount(c, lc, ed, st, ch, acc, a, t, tk.getString("symbol"), tk.getInt("decimals"), held.containsKey(t) ? held.get(t) : BigInteger.ZERO, false, BigInteger.ZERO);
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
                // networks LI.FI knows by an id of its own (Solana, Tron): the route's reference carries them
                long from = ref != null && ref.has("lifiFrom") ? ref.optLong("lifiFrom") : b.optLong("fromChainId");
                long to = ref != null && ref.has("lifiTo") ? ref.optLong("lifiTo") : b.optLong("toChainId");
                JSONObject r = new JSONObject(get("https://li.quest/v1/status?txHash=" + tx + "&fromChain=" + from + "&toChain=" + to));
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
    private static String get(String url) throws Exception { return http(url, null, null); }
    private static String post(String url, String json) throws Exception { return http(url, json, null); }

    /** tronGridKey: TronGrid's optional key (its own header). */
    private static String http(String url, String body, String tronGridKey) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(10000);
        c.setReadTimeout(15000);
        c.setRequestProperty("Accept", "application/json");
        if (tronGridKey != null && !tronGridKey.isEmpty()) c.setRequestProperty("TRON-PRO-API-KEY", tronGridKey);
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

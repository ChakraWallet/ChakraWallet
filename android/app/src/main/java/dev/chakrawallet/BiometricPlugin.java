package dev.chakrawallet;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import androidx.annotation.NonNull;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Fingerprint unlock. The wallet password is encrypted with an AES-GCM key kept in the Android Keystore that:
 *  - can be used only right after a strong biometric authentication (CryptoObject bound to the prompt);
 *  - is invalidated by Android when a fingerprint is added or changed (we then wipe it and fall back to the password).
 * The password itself never leaves this flow unencrypted except as the result of unlock().
 */
@CapacitorPlugin(name = "Biometric")
public class BiometricPlugin extends Plugin {
    private static final String KEY_ALIAS = "chakra_biometric";
    private static final String PREFS = "chakra_biometric";
    private static final int AUTHENTICATORS = BiometricManager.Authenticators.BIOMETRIC_STRONG;

    private String str(int id, Object... args) { return getContext().getString(id, args); }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private boolean available() {
        return BiometricManager.from(getContext()).canAuthenticate(AUTHENTICATORS) == BiometricManager.BIOMETRIC_SUCCESS;
    }

    private boolean enabled() {
        return prefs().contains("ct") && prefs().contains("iv");
    }

    private void wipe() {
        prefs().edit().clear().apply();
        try {
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            ks.deleteEntry(KEY_ALIAS);
        } catch (Exception ignored) { }
    }

    private SecretKey createKey() throws Exception {
        KeyGenParameterSpec.Builder b = new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) b.setInvalidatedByBiometricEnrollment(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) b.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG);
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        kg.init(b.build());
        return kg.generateKey();
    }

    private SecretKey loadKey() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        return (SecretKey) ks.getKey(KEY_ALIAS, null);
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject r = new JSObject();
        r.put("available", available());
        r.put("enabled", enabled());
        call.resolve(r);
    }

    /** Encrypts and stores the wallet password (verified by the caller) after a fingerprint. */
    @PluginMethod
    public void enable(PluginCall call) {
        String password = call.getString("password");
        if (password == null || password.isEmpty()) { call.reject(str(R.string.bio_password_missing)); return; }
        if (!available()) { call.reject(str(R.string.bio_no_fingerprint), "unavailable"); return; }
        Cipher cipher;
        try {
            wipe();
            cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, createKey());
        } catch (Exception e) {
            wipe();
            call.reject(str(R.string.bio_key_failed, e.getMessage()), "failed");
            return;
        }
        prompt(call, cipher, call.getString("title", str(R.string.bio_enable_title)), (c) -> {
            byte[] ct = c.doFinal(password.getBytes(StandardCharsets.UTF_8));
            prefs().edit()
                    .putString("ct", Base64.encodeToString(ct, Base64.NO_WRAP))
                    .putString("iv", Base64.encodeToString(c.getIV(), Base64.NO_WRAP))
                    .apply();
            call.resolve();
        }, true);
    }

    /** Shows the fingerprint prompt and returns { password }. */
    @PluginMethod
    public void unlock(PluginCall call) {
        if (!enabled()) { call.reject(str(R.string.bio_not_enabled), "not_enabled"); return; }
        Cipher cipher;
        try {
            byte[] iv = Base64.decode(prefs().getString("iv", ""), Base64.NO_WRAP);
            SecretKey key = loadKey();
            if (key == null) throw new KeyPermanentlyInvalidatedException();
            cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, iv));
        } catch (KeyPermanentlyInvalidatedException e) {
            wipe();
            call.reject(str(R.string.bio_invalidated), "invalidated");
            return;
        } catch (Exception e) {
            wipe();
            call.reject(str(R.string.bio_unavailable, e.getMessage()), "invalidated");
            return;
        }
        byte[] ct = Base64.decode(prefs().getString("ct", ""), Base64.NO_WRAP);
        prompt(call, cipher, call.getString("title", str(R.string.bio_unlock_title)), (c) -> {
            JSObject r = new JSObject();
            r.put("password", new String(c.doFinal(ct), StandardCharsets.UTF_8));
            call.resolve(r);
        }, false);
    }

    @PluginMethod
    public void disable(PluginCall call) {
        wipe();
        call.resolve();
    }

    private interface OnCipher { void run(Cipher c) throws Exception; }

    private void prompt(PluginCall call, Cipher cipher, String title, OnCipher onOk, boolean wipeOnError) {
        FragmentActivity activity = getActivity();
        activity.runOnUiThread(() -> {
            BiometricPrompt bp = new BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
                    try {
                        BiometricPrompt.CryptoObject co = result.getCryptoObject();
                        if (co == null || co.getCipher() == null) throw new IllegalStateException("missing cipher");
                        onOk.run(co.getCipher());
                    } catch (Exception e) {
                        if (wipeOnError) wipe();
                        call.reject(str(R.string.bio_error, e.getMessage()), "failed");
                    }
                }

                @Override
                public void onAuthenticationError(int code, @NonNull CharSequence msg) {
                    if (wipeOnError) wipe();
                    boolean cancelled = code == BiometricPrompt.ERROR_USER_CANCELED || code == BiometricPrompt.ERROR_NEGATIVE_BUTTON || code == BiometricPrompt.ERROR_CANCELED;
                    call.reject(msg.toString(), cancelled ? "cancelled" : "failed");
                }
                // onAuthenticationFailed (finger not recognised) is retried by the system prompt itself
            });
            BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
                    .setTitle(title)
                    .setSubtitle("Chakra")
                    .setNegativeButtonText(call.getString("negative", str(R.string.bio_negative)))
                    .setAllowedAuthenticators(AUTHENTICATORS)
                    .setConfirmationRequired(false)
                    .build();
            bp.authenticate(info, new BiometricPrompt.CryptoObject(cipher));
        });
    }
}

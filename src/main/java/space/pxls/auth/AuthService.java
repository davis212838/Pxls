package space.pxls.auth;

import com.mashape.unirest.http.exceptions.UnirestException;

import space.pxls.App;

import java.util.Map;
import java.util.LinkedHashMap;
import javax.crypto.Mac;
import javax.crypto.SecretKey;
import javax.crypto.spec.SecretKeySpec;
import java.net.URLEncoder;
import java.net.URLDecoder;
import org.apache.commons.codec.binary.Base64;
import space.pxls.util.Util;

import java.io.UnsupportedEncodingException;
import java.security.NoSuchAlgorithmException;
import java.security.InvalidKeyException;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

public abstract class AuthService {
    private String id;
    // Gson serialization needs fields, not getters.
    @SuppressWarnings({"unused", "FieldCanBeLocal"})
    private String name;
    private transient Set<String> validStates = ConcurrentHashMap.newKeySet();

    AuthService(String id, String name) {
        this.id = id;
        this.name = name;
    }

    public String generateState() {
        String s = Util.generateRandomToken();
        validStates.add(s);
        return s;
    }

    static Map<String, String> parseQuery(String s) {
        Map<String, String> query_pairs = new LinkedHashMap<>();
        try {
            String[] pairs = s.split("&");
            for (String pair : pairs) {
                int idx = pair.indexOf("=");
                query_pairs.put(URLDecoder.decode(pair.substring(0, idx), "UTF-8"), URLDecoder.decode(pair.substring(idx + 1), "UTF-8"));
            }
        } catch (UnsupportedEncodingException ignore) {
        }
        return query_pairs;
    }

    private String getOauthSignature(String url, String params, String secret, String method) {
        try {
            String base = method + "&" + url + "&" + params;
            
            // yea, don't ask me why, it is needed to append a "&" to the end of
            // secret key.
            String privKey = App.getConfig().getString("oauth."+id+".secret") + "&" + secret;

            SecretKey key = new SecretKeySpec(privKey.getBytes("UTF-8"), "HmacSHA1");

            Mac mac = Mac.getInstance("HmacSHA1");
            mac.init(key);

            // encode it, base64 it, change it to string and return.
            return new String(new Base64().encode(mac.doFinal(base.getBytes(
                "UTF-8"))), "UTF-8").trim();
        } catch (UnsupportedEncodingException | NoSuchAlgorithmException | InvalidKeyException e) {
            return "";
        }
    }

    String getOauthRequest(String url, String _params, String callback, String method, String key) {
        try {
            String params = "oauth_callback=" + URLEncoder.encode(callback, "UTF-8") +
                "&oauth_consumer_key=" + URLEncoder.encode(App.getConfig().getString("oauth."+id+".key"), "UTF-8") +
                "&oauth_nonce=" + String.valueOf(Math.random() * 100000000) +
                "&oauth_signature_method=HMAC-SHA1" +
                "&oauth_timestamp=" + String.valueOf(System.currentTimeMillis() / 1000);
            if (!_params.isEmpty()) {
                params += "&" + _params;
            }
            params += "&oauth_version=1.0";
            String signature = getOauthSignature(URLEncoder.encode(url, "UTF-8"), URLEncoder.encode(params, "UTF-8"), key, method);
            params += "&oauth_signature=" + URLEncoder.encode(signature, "UTF-8");
            return params;
        } catch (UnsupportedEncodingException e) {
            return "";
        }
    }

    String getOauthRequestToken(String url) {
        return getOauthRequest(url, "", getCallbackUrl(), "GET", "");
    }

    String getOauthAccessToken(String url, String token, String verifier, String secret) {
        try {
            String params = "oauth_token=" + URLEncoder.encode(token, "UTF-8") +
                "&oauth_verifier=" + URLEncoder.encode(verifier, "UTF-8");
            return getOauthRequest(url, params, "oob", "POST", secret);
        } catch (UnsupportedEncodingException e) {
            return "";
        }
    }

    public boolean verifyState(String state) {
        return validStates.remove(state);
    }

    public abstract String getRedirectUrl(String state);

    String getCallbackUrl() {
        return App.getConfig().getString("oauth.callbackBase") + "/" + id;
    }

    public abstract String getToken(String code) throws UnirestException;

    public abstract String getIdentifier(String token) throws UnirestException, InvalidAccountException;

    public String getId() {
        return id;
    }

    public static class InvalidAccountException extends Exception {
        InvalidAccountException(String s) {
            super(s);
        }
    }

    public boolean use() {
        return !App.getConfig().getString("oauth."+id+".key").isEmpty();
    }

    public boolean isConfigured() {
        String key = App.getConfig().getString("oauth." + id + ".key");
        return key != null && !key.equals("");
    }
}

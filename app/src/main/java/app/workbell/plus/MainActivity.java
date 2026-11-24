package app.workbell.plus;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

/** Shows the Work Bell page (assets/index.html) and connects it to Android through {@link Bridge}. */
public class MainActivity extends Activity {
    static final int PICK_CONTACT = 41;
    static final int ASK_PERMISSIONS = 42;

    WebView web;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(0xFF0B1F5C);
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        web.setWebChromeClient(new WebChromeClient());
        Bridge bridge = new Bridge(this);
        web.addJavascriptInterface(bridge, "OccasionNative");
        web.addJavascriptInterface(bridge, "ContactNative");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleLink(request.getUrl().toString());
            }

            @SuppressWarnings("deprecation")
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleLink(url);
            }
        });
        setContentView(web);
        web.loadUrl("file:///android_asset/index.html");
    }

    /** Only the app page loads inside; WhatsApp links open WhatsApp. */
    boolean handleLink(String url) {
        if (url == null) return true;
        if (url.startsWith("file:///android_asset/")) return false;
        if (url.startsWith("https://wa.me/") || url.startsWith("https://api.whatsapp.com/")) {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            } catch (Exception ignored) { }
        }
        return true;
    }

    @Override
    protected void onResume() {
        super.onResume();
        Store.restore(this);
        js("if(window.refreshNative)refreshNative()");
    }

    void js(final String code) {
        runOnUiThread(() -> {
            if (web != null) web.evaluateJavascript(code, null);
        });
    }

    void pickContact() {
        try {
            Intent i = new Intent(Intent.ACTION_PICK);
            i.setType("vnd.android.cursor.dir/phone_v2");
            startActivityForResult(i, PICK_CONTACT);
        } catch (Exception e) {
            js("if(window.contactPickError)contactPickError()");
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != PICK_CONTACT) return;
        if (resultCode != RESULT_OK || data == null || data.getData() == null) return; // cancelled
        Cursor cursor = null;
        try {
            cursor = getContentResolver().query(data.getData(), new String[]{"data1", "display_name"}, null, null, null);
            if (cursor != null && cursor.moveToFirst()) {
                String number = cursor.getString(cursor.getColumnIndexOrThrow("data1"));
                int nameColumn = cursor.getColumnIndex("display_name");
                String name = nameColumn >= 0 ? cursor.getString(nameColumn) : "";
                js("if(window.contactPicked)contactPicked(" + JSONObject.quote(number == null ? "" : number)
                        + "," + JSONObject.quote(name == null ? "" : name) + ")");
            } else {
                js("if(window.contactPickError)contactPickError()");
            }
        } catch (Exception e) {
            js("if(window.contactPickError)contactPickError()");
        } finally {
            if (cursor != null) cursor.close();
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        js("if(window.refreshNative)refreshNative();if(window.renderHealth)renderHealth()");
    }
}

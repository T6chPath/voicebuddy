package app.zenvqo.chat;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

/**
 * zenvqo chat for Android: a WebView showing the standalone app (assets/index.html, built from the React frontend).
 *
 * Loaded from file:///android_asset (always readable by WebView, even with file access off). A file origin counts as
 * local, so requests to a model server on your home network (llama-server on the laptop) aren't blocked as
 * "public site → private network". Chats are stored on the phone in IndexedDB; Settings → Connection points the
 * page at your model server (it must allow CORS — llama-server does).
 */
public class MainActivity extends Activity {
    private static final String START_URL = "file:///android_asset/index.html";
    private static final int FILE_REQUEST = 1001;

    private WebView web;
    private NativeNet net;
    private ValueCallback<Uri[]> pendingFiles;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        FrameLayout root = new FrameLayout(this);
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);
        applyInsets(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);                       // localStorage (settings) + IndexedDB (chats)
        s.setAllowFileAccess(false);                        // android_asset stays readable; the rest of storage doesn't
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setAllowContentAccess(false);
        s.setSupportMultipleWindows(false);                 // target=_blank links reach shouldOverrideUrlLoading
        s.setMediaPlaybackRequiresUserGesture(true);

        net = new NativeNet(web);
        web.addJavascriptInterface(net, "ZenvqoNative");     // AI requests without CORS limits; only the bundled page runs here

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if ("file".equals(u.getScheme()) && START_URL.equals(u.buildUpon().fragment(null).build().toString())) {
                    return false;                                   // in-app navigation (#/c/… routes)
                }
                openExternally(u);                                  // links in answers open in the browser
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingFiles != null) pendingFiles.onReceiveValue(null);
                pendingFiles = callback;
                Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                pick.setType("*/*");                                 // the page validates file types itself
                pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try {
                    startActivityForResult(Intent.createChooser(pick, null), FILE_REQUEST);
                } catch (ActivityNotFoundException e) {
                    pendingFiles = null;
                    return false;
                }
                return true;
            }
        });

        web.setDownloadListener((url, userAgent, contentDisposition, mimetype, contentLength) -> openExternally(Uri.parse(url)));

        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(START_URL);
    }

    /** Edge-to-edge on Android 11+: we draw behind the system bars ourselves and pad the WebView by the bar and keyboard
     * insets — one code path for every version (and no double resize when the keyboard opens). Older Android uses
     * fitsSystemWindows + adjustResize. */
    private void applyInsets(View root) {
        if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime() | WindowInsets.Type.displayCutout());
                v.setPadding(i.left, i.top, i.right, i.bottom);
                return WindowInsets.CONSUMED;
            }
            return insets;
        });
        if (Build.VERSION.SDK_INT < 30) root.setFitsSystemWindows(true);
    }

    private void openExternally(Uri uri) {
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
        if (!scheme.equals("http") && !scheme.equals("https") && !scheme.equals("mailto")) return;   // no intent://, javascript:, file:
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, R.string.no_app_for_link, Toast.LENGTH_SHORT).show();
        }
    }

    private void goBackOrFinish() {
        if (web.canGoBack()) web.goBack();
        else finish();
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {           // still delivered for targetSdk 35 (predictive back is opt-in until SDK 36)
        goBackOrFinish();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_REQUEST || pendingFiles == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null && clip.getItemCount() > 0) {
                result = new Uri[clip.getItemCount()];
                for (int i = 0; i < clip.getItemCount(); i++) result[i] = clip.getItemAt(i).getUri();
            } else if (data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
        }
        pendingFiles.onReceiveValue(result);                        // null = cancelled; the page handles it
        pendingFiles = null;
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    protected void onPause() {
        web.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onDestroy() {
        if (pendingFiles != null) pendingFiles.onReceiveValue(null);
        if (net != null) net.shutdown();
        web.destroy();
        super.onDestroy();
    }
}

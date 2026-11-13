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
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
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
    private static final int REQ_CAMERA = 1002;

    private WebView web;
    private NativeNet net;
    private NativeTTS speech;
    private NativeASR ears;
    private NativePDF pdf;
    private NativeImageGen images;
    private NativeShare share;
    private ValueCallback<Uri[]> pendingFiles;
    private PermissionRequest pendingCamera;
    private boolean pageGone;                               // the page's process stopped: this WebView can't be used again

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        FrameLayout root = new FrameLayout(this);
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);
        applyInsets(root);

        if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);   // test builds only: lets the automated phone test drive the page
        }
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
        speech = new NativeTTS(this, web);
        web.addJavascriptInterface(speech, "ZenvqoTTS");      // read replies aloud with the phone's TTS engine
        ears = new NativeASR(this, web);
        web.addJavascriptInterface(ears, "ZenvqoASR");        // voice input with the phone's speech recognizer
        pdf = new NativePDF(this, web);
        web.addJavascriptInterface(pdf, "ZenvqoPDF");         // replies → PDF files in Downloads
        web.addJavascriptInterface(new NativeAssets(this), "ZenvqoAssets");   // data files the PDF reader needs
        web.addJavascriptInterface(new NativeApk(this, web), "ZenvqoApk");       // "Make app": web pages → installable APKs
        web.addJavascriptInterface(new NativePlay(this, web), "ZenvqoPlay");     // "Google Play package": web pages → .aab + store listing folder
        share = new NativeShare(this, web);
        web.addJavascriptInterface(share, "ZenvqoShare");     // "Share → zenvqo" from WhatsApp, Gallery, Files…
        images = new NativeImageGen(this, web);
        web.addJavascriptInterface(images, "ZenvqoImageGen");  // pictures made on the phone itself (stable-diffusion.cpp)

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

            /** The page's own process stopped: Android needed its memory (a picture made on the phone uses a lot) or it
             *  crashed. Open the page again instead of letting Android close the whole app; an unfinished reply then
             *  says so, with Retry. */
            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                if (view != web) return true;
                pageGone = true;
                if (images != null) images.shutdown();                // the picture it was waiting for can't reach it now
                ViewGroup parent = (ViewGroup) view.getParent();
                if (parent != null) parent.removeView(view);
                view.destroy();
                recreate();
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            /** The in-app camera ("Take a photo"): only the camera is ever granted, and only to the app's own page. */
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                boolean video = false;
                for (String r : request.getResources()) if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) video = true;
                if (!video || !"file".equals(request.getOrigin().getScheme())) { request.deny(); return; }
                if (Build.VERSION.SDK_INT < 23 || checkSelfPermission(android.Manifest.permission.CAMERA) == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                    request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
                    return;
                }
                if (pendingCamera != null) pendingCamera.deny();
                pendingCamera = request;
                requestPermissions(new String[]{android.Manifest.permission.CAMERA}, REQ_CAMERA);
            }

            @Override
            public void onPermissionRequestCanceled(PermissionRequest request) {
                if (request == pendingCamera) pendingCamera = null;
            }

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

        if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) web.loadUrl(START_URL);
        share.take(getIntent());                            // opened from another app's Share menu
    }

    @Override
    protected void onNewIntent(Intent intent) {             // shared to zenvqo while it was already open
        super.onNewIntent(intent);
        setIntent(intent);
        share.take(intent);
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
        if (!pageGone) web.saveState(outState);
    }

    @Override
    protected void onPause() {
        if (!pageGone) web.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (!pageGone) web.onResume();
    }

    @Override
    protected void onDestroy() {
        if (pendingFiles != null) pendingFiles.onReceiveValue(null);
        if (net != null) net.shutdown();
        if (speech != null) speech.shutdown();
        if (ears != null) ears.shutdown();
        if (images != null) images.shutdown();
        if (!pageGone) web.destroy();
        super.onDestroy();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_CAMERA && pendingCamera != null) {
            boolean ok = grantResults.length > 0 && grantResults[0] == android.content.pm.PackageManager.PERMISSION_GRANTED;
            if (ok) pendingCamera.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
            else pendingCamera.deny();                                   // the page shows how to allow it, and offers the gallery
            pendingCamera = null;
            return;
        }
        if (requestCode == NativeASR.REQ_MIC && ears != null) {
            ears.onPermission(grantResults.length > 0 && grantResults[0] == android.content.pm.PackageManager.PERMISSION_GRANTED);
        }
    }
}

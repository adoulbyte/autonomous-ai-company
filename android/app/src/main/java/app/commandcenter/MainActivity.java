package app.commandcenter;

import android.app.Activity;
import android.app.AlertDialog;
import android.os.Handler;
import android.os.Looper;
import android.webkit.ConsoleMessage;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

/**
 * Thin, private wrapper around the command-center web app.
 * The platform address is entered once on the phone and stored locally: nothing personal is built into the APK.
 */
public class MainActivity extends Activity {
  private static final String PREFS = "settings";
  private static final String KEY_URL = "url";
  private static final int FILE_REQUEST = 42;
  private WebView web;
  private ValueCallback<Uri[]> fileCallback;
  private String lastError = "";
  private String currentUrl = "";
  private boolean checked = false;

  @Override protected void onCreate(Bundle state) {
    super.onCreate(state);
    String url = prefs().getString(KEY_URL, "");
    if (url.isEmpty()) showSetup(); else showApp(url);
  }

  private SharedPreferences prefs() { return getSharedPreferences(PREFS, MODE_PRIVATE); }

  /** First launch: ask for the platform address (e.g. https://….workers.dev). */
  private void showSetup() {
    LinearLayout box = new LinearLayout(this);
    box.setOrientation(LinearLayout.VERTICAL);
    box.setGravity(Gravity.CENTER_VERTICAL);
    box.setPadding(56, 56, 56, 56);
    box.setBackgroundColor(Color.parseColor("#F6F5F2"));
    TextView title = new TextView(this);
    title.setText("Centre de commande");
    title.setTextSize(24);
    title.setTextColor(Color.parseColor("#111827"));
    TextView help = new TextView(this);
    help.setText("Saisis l'adresse de ta plateforme (celle que tu ouvres dans le navigateur). Elle est enregistrée uniquement sur ce téléphone.");
    help.setTextSize(15);
    help.setPadding(0, 24, 0, 24);
    EditText input = new EditText(this);
    input.setHint("https://…");
    input.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
    input.setSingleLine(true);
    input.setText(prefs().getString(KEY_URL, currentUrl));
    Button ok = new Button(this);
    ok.setText("Ouvrir la plateforme");
    ok.setOnClickListener(v -> {
      String u = input.getText().toString().trim().replaceAll("\\s+", "");
      if (!u.startsWith("http")) u = "https://" + u;
      if (!u.startsWith("https://") || u.length() < 12) { Toast.makeText(this, "Adresse invalide (elle doit commencer par https://)", Toast.LENGTH_LONG).show(); return; }
      prefs().edit().putString(KEY_URL, u).apply();
      showApp(u);
    });
    box.addView(title); box.addView(help); box.addView(input); box.addView(ok);
    setContentView(box);
  }

  private void showApp(String url) {
    currentUrl = url; checked = false;
    WebView.setWebContentsDebuggingEnabled(true);
    web = new WebView(this);
    web.setLayoutParams(new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);            // keeps you signed in
    s.setAllowFileAccess(false);
    s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    s.setDatabaseEnabled(true);
    s.setLoadWithOverviewMode(true);
    s.setUseWideViewPort(true);
    web.setBackgroundColor(Color.parseColor("#F6F5F2"));
    final String host = Uri.parse(url).getHost();
    web.setWebViewClient(new WebViewClient() {
      @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
        Uri u = req.getUrl();
        if (host != null && host.equals(u.getHost())) return false;                 // stay in the app
        try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }   // mailto:, other sites
        return true;
      }
      @Override public void onReceivedError(WebView view, int code, String description, String failingUrl) {
        lastError = "Erreur réseau : " + description;
      }
      @Override public void onPageFinished(WebView view, String loaded) {
        // If nothing is displayed a few seconds after loading, explain why and offer a way out (instead of a blank screen).
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
          if (checked || web == null) return;
          web.evaluateJavascript("(function(){var r=document.getElementById('root');return r?String(r.innerText.length+r.children.length):'-1';})()", v -> {
            String n = v == null ? "" : v.replace("\"", "");
            if (n.equals("0") || n.equals("-1") || n.equals("null")) showProblem();
            else checked = true;
          });
        }, 7000);
      }
    });
    web.setWebChromeClient(new WebChromeClient() {   // lets the Settings page upload a logo from the phone
      @Override public boolean onConsoleMessage(ConsoleMessage m) {
        if (m.messageLevel() == ConsoleMessage.MessageLevel.ERROR) lastError = m.message() + " (" + m.lineNumber() + ")";
        return super.onConsoleMessage(m);
      }
      @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        fileCallback = callback;
        try { startActivityForResult(params.createIntent(), FILE_REQUEST); } catch (Exception e) { fileCallback = null; return false; }
        return true;
      }
    });
    web.setOnLongClickListener(v -> false);
    setContentView(web);
    web.loadUrl(url);
  }

  private void showProblem() {
    if (isFinishing()) return;
    checked = true;
    new AlertDialog.Builder(this)
      .setTitle("La page ne s'affiche pas")
      .setMessage("Adresse : " + currentUrl + (lastError.isEmpty() ? "" : "\n\nDétail : " + lastError) + "\n\nVérifie l'adresse (la même que dans Chrome) ou ouvre la plateforme dans Chrome.")
      .setPositiveButton("Réessayer", (d, w) -> { checked = false; lastError = ""; web.reload(); })
      .setNeutralButton("Changer l'adresse", (d, w) -> { prefs().edit().remove(KEY_URL).apply(); web = null; showSetup(); })
      .setNegativeButton("Ouvrir dans Chrome", (d, w) -> { try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(currentUrl))); } catch (Exception ignored) { } })
      .show();
  }

  @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    if (requestCode == FILE_REQUEST && fileCallback != null) {
      fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
      fileCallback = null;
      return;
    }
    super.onActivityResult(requestCode, resultCode, data);
  }

  @Override public void onBackPressed() {
    if (web != null && web.canGoBack()) web.goBack();
    else super.onBackPressed();
  }
}

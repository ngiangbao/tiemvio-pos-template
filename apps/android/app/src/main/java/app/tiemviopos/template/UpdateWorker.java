package app.tiemviopos.template;

import android.app.*;
import android.content.*;
import android.os.Build;
import androidx.annotation.NonNull;
import androidx.work.*;
import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.security.spec.X509EncodedKeySpec;
import android.util.Base64;

public class UpdateWorker extends Worker {
    static final String BASE = "https://github.com/YOUR_GITHUB_OWNER/RELEASES_REPO/releases/latest/download/";
    public UpdateWorker(@NonNull Context context, @NonNull WorkerParameters params) { super(context, params); }
    static File dir(Context c) { return new File(c.getCacheDir(), "updates"); }
    static byte[] get(String url, int max) throws Exception {
        URL target = new URL(url);
        if (!target.getProtocol().equals("https") || !target.getHost().equals("github.com") || !target.getPath().startsWith("/YOUR_GITHUB_OWNER/RELEASES_REPO/releases/")) throw new IOException("Invalid source");
        HttpURLConnection connection = (HttpURLConnection) target.openConnection();
        connection.setConnectTimeout(15000); connection.setReadTimeout(30000);
        try (InputStream in = connection.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] b = new byte[16384]; int n, total = 0;
            while ((n = in.read(b)) != -1) { total += n; if (total > max) throw new IOException("Too large"); out.write(b,0,n); }
            return out.toByteArray();
        } finally { connection.disconnect(); }
    }
    static JSONObject verify(Context c, byte[] data, byte[] sig) throws Exception {
        String pem;
        try(InputStream in = c.getAssets().open("update-public.pem")) { pem = new String(read(in), StandardCharsets.UTF_8); }
        byte[] der = Base64.decode(pem.replace("-----BEGIN PUBLIC KEY-----", "").replace("-----END PUBLIC KEY-----", "").replaceAll("\\s", ""), Base64.DEFAULT);
        Signature verifier = Signature.getInstance("SHA256withRSA");
        verifier.initVerify(KeyFactory.getInstance("RSA").generatePublic(new X509EncodedKeySpec(der)));
        verifier.update(data);
        if(!verifier.verify(Base64.decode(sig, Base64.DEFAULT))) throw new SecurityException("Signature mismatch");
        JSONObject root = new JSONObject(new String(data, StandardCharsets.UTF_8));
        if(root.getInt("schema") != 1) throw new SecurityException("Unknown schema");
        return root.getJSONObject("android");
    }
    static byte[] read(InputStream in) throws IOException { ByteArrayOutputStream out = new ByteArrayOutputStream(); byte[] b=new byte[8192]; int n; while((n=in.read(b))!=-1)out.write(b,0,n);return out.toByteArray(); }
    static byte[] readFile(File file) throws IOException { try(InputStream in=new FileInputStream(file)){return read(in);} }
    static void writeFile(File file,byte[] bytes) throws IOException { try(OutputStream out=new FileOutputStream(file)){out.write(bytes);} }
    static boolean hasPending(Context c) {
        try { JSONObject a=verify(c, readFile(new File(dir(c),"native-update.json")),readFile(new File(dir(c),"native-update.sig")));
            return a.getInt("versionCode")>BuildConfig.VERSION_CODE && new File(dir(c),"update.apk").isFile();
        } catch(Exception e) { return false; }
    }
    static File verifiedApk(Context c) throws Exception {
        JSONObject a=verify(c,readFile(new File(dir(c),"native-update.json")),readFile(new File(dir(c),"native-update.sig")));
        if(a.getInt("versionCode")<=BuildConfig.VERSION_CODE)throw new SecurityException("Old version");
        File apk=new File(dir(c),"update.apk");
        MessageDigest md=MessageDigest.getInstance("SHA-256");
        try(InputStream in=new FileInputStream(apk)){byte[] b=new byte[16384];int n;while((n=in.read(b))!=-1)md.update(b,0,n);}
        StringBuilder hex=new StringBuilder();for(byte b:md.digest())hex.append(String.format("%02x",b));
        if(!hex.toString().equalsIgnoreCase(a.getString("sha256")))throw new SecurityException("Hash mismatch");
        return apk;
    }
    @NonNull @Override public Result doWork() {
        Context c=getApplicationContext();
        try {
            byte[] data=get(BASE+"native-update.json",65536), sig=get(BASE+"native-update.sig",2048);
            JSONObject a=verify(c,data,sig);
            if(a.getInt("versionCode")<=BuildConfig.VERSION_CODE)return Result.success();
            if(!dir(c).isDirectory()&&!dir(c).mkdirs())throw new IOException("No cache");
            byte[] apk=get(a.getString("url"),100*1024*1024);
            StringBuilder hex=new StringBuilder();for(byte b:MessageDigest.getInstance("SHA-256").digest(apk))hex.append(String.format("%02x",b));
            if(!hex.toString().equalsIgnoreCase(a.getString("sha256")))throw new SecurityException("Hash mismatch");
            writeFile(new File(dir(c),"update.apk"),apk);
            writeFile(new File(dir(c),"native-update.json"),data);
            writeFile(new File(dir(c),"native-update.sig"),sig);
            NotificationManager nm=(NotificationManager)c.getSystemService(Context.NOTIFICATION_SERVICE);
            if(Build.VERSION.SDK_INT>=26)nm.createNotificationChannel(new NotificationChannel("updates","Cập nhật Tiemvio POS",NotificationManager.IMPORTANCE_DEFAULT));
            Intent open=new Intent(c,UpdateActivity.class);
            PendingIntent pi=PendingIntent.getActivity(c,0,open,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
            Notification.Builder n=Build.VERSION.SDK_INT>=26?new Notification.Builder(c,"updates"):new Notification.Builder(c);
            if(Build.VERSION.SDK_INT>=33 && c.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)!=android.content.pm.PackageManager.PERMISSION_GRANTED)return Result.success();
            nm.notify(1,n.setSmallIcon(android.R.drawable.stat_sys_download_done).setContentTitle("Tiemvio POS có bản cập nhật")
                .setContentText("Đã tải xong. Chạm để hoàn tất cài đặt.").setContentIntent(pi).setAutoCancel(true).build());
            return Result.success();
        } catch(Exception e) { return getRunAttemptCount()<3?Result.retry():Result.failure(); }
    }
}

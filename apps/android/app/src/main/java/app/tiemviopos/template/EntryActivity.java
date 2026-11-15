package app.tiemviopos.template;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import androidx.work.*;
import java.util.concurrent.TimeUnit;

public class EntryActivity extends Activity {
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        WorkManager wm = WorkManager.getInstance(this);
        Constraints net = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        wm.enqueueUniquePeriodicWork("tiemvio-updates", ExistingPeriodicWorkPolicy.KEEP,
            new PeriodicWorkRequest.Builder(UpdateWorker.class, 6, TimeUnit.HOURS).setConstraints(net).build());
        wm.enqueueUniqueWork("tiemvio-check-now", ExistingWorkPolicy.KEEP,
            new OneTimeWorkRequest.Builder(UpdateWorker.class).setConstraints(net).build());
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        } else open();
    }
    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] grants) { super.onRequestPermissionsResult(code, permissions, grants); open(); }
    private void open() {
        if (UpdateWorker.hasPending(this)) startActivity(new Intent(this, UpdateActivity.class));
        else startActivity(new Intent(this, com.google.androidbrowserhelper.trusted.LauncherActivity.class));
        finish();
    }
}

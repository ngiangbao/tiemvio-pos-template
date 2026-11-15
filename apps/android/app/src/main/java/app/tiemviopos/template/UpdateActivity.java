package app.tiemviopos.template;

import android.app.*;
import android.content.*;
import android.os.*;
import android.net.Uri;
import android.provider.Settings;
import android.widget.*;
import androidx.core.content.FileProvider;

public class UpdateActivity extends Activity {
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        LinearLayout layout=new LinearLayout(this);layout.setOrientation(LinearLayout.VERTICAL);layout.setPadding(40,80,40,40);
        TextView text=new TextView(this);text.setText("Tiemvio POS đã tải bản mới. Hoàn tất cài đặt khi bạn sẵn sàng; dữ liệu bán hàng vẫn được giữ.");text.setTextSize(19);layout.addView(text);
        Button install=new Button(this);install.setText("Cài bản cập nhật");layout.addView(install);install.setOnClickListener(v->install());
        Button later=new Button(this);later.setText("Tiếp tục bán hàng");layout.addView(later);later.setOnClickListener(v->{startActivity(new Intent(this,com.google.androidbrowserhelper.trusted.LauncherActivity.class));finish();});
        setContentView(layout);
        if(!UpdateWorker.hasPending(this)){startActivity(new Intent(this,com.google.androidbrowserhelper.trusted.LauncherActivity.class));finish();}
    }
    private void install() {
        try {
            if(Build.VERSION.SDK_INT>=26&&!getPackageManager().canRequestPackageInstalls()) {
                startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,Uri.parse("package:"+getPackageName())));return;
            }
            Uri uri=FileProvider.getUriForFile(this,getPackageName()+".files",UpdateWorker.verifiedApk(this));
            startActivity(new Intent(Intent.ACTION_VIEW).setDataAndType(uri,"application/vnd.android.package-archive").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION));
        } catch(Exception e) { Toast.makeText(this,"Chưa cài được bản mới. Hãy mở lại app để thử lại.",Toast.LENGTH_LONG).show(); }
    }
}

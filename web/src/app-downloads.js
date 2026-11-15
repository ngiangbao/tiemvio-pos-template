export const APP_DOWNLOAD_BASE='https://github.com/ngiangbao/tiemvio-pos-releases/releases/latest/download/';
export function appDownloads(){return `<div class="card app-downloads" style="margin-top:12px">
  <h3>Tải ứng dụng</h3>
  <p class="muted" style="margin:6px 0 12px">Cài Tiemvio POS trên máy tính hoặc điện thoại, dùng chung tài khoản và dữ liệu cửa hàng.</p>
  <div style="display:flex;flex-wrap:wrap;gap:10px">
    <a href="${APP_DOWNLOAD_BASE}Tiemvio-POS-Windows.exe" class="primary" style="display:inline-block;padding:12px 16px;border-radius:14px;text-decoration:none" target="_blank" rel="noopener noreferrer">Tải Windows (.exe)</a>
    <a href="${APP_DOWNLOAD_BASE}Tiemvio-POS-Android.apk" class="primary" style="display:inline-block;padding:12px 16px;border-radius:14px;text-decoration:none" target="_blank" rel="noopener noreferrer">Tải Android (.apk)</a>
    <a href="https://DOWNLOADS_HOST.invalid/install-ios.html" class="primary" style="display:inline-block;padding:12px 16px;border-radius:14px;text-decoration:none" target="_blank" rel="noopener noreferrer">Cài cho iOS</a>
  </div>
  <p class="muted" style="font-size:12.5px;margin:10px 0 0">Windows 10/11 x64 có Edge · Android 7 trở lên có Chrome · iOS cài bằng Safari hoặc profile Web Clip. Giao diện tự cập nhật khi rảnh; Windows tự cài bộ cài mới. Android/iOS có thể yêu cầu thao tác xác nhận của hệ điều hành.</p>
</div>`;}

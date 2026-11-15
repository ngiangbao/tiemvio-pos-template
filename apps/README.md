# Tiemvio POS — Android và Windows

Mã nguồn nằm trong repo riêng tư. Bộ cài phát hành công khai tại
https://github.com/YOUR_GITHUB_OWNER/RELEASES_REPO/releases/latest.

- Android: `Tiemvio-POS-Android.apk`, Android 7 trở lên, Chrome hoặc trình duyệt hỗ trợ Trusted Web Activity. Dùng trình duyệt thật để đăng nhập Google, lưu offline và cập nhật giao diện web.
- Windows: `Tiemvio-POS-Windows.exe`, Windows 10/11 x64, Microsoft Edge. Bộ cài theo người dùng, không cần quyền quản trị. Shortcut mở Edge ở chế độ app, giữ đăng nhập Google và dữ liệu offline. Tác vụ nền kiểm tra bộ cài mỗi giờ và khi đăng nhập Windows.
- Giao diện/logic bán hàng cập nhật qua Firebase Hosting. App chờ lúc không có thao tác, biểu mẫu, đơn sửa, giỏ hoặc AI đang chạy trước khi tải lại.
- Windows tự tải, kiểm tra chữ ký RSA của feed và SHA-256 bộ cài rồi cài âm thầm. Không đóng cửa sổ bán hàng đang mở. Thông báo cập nhật xuất hiện ở khay hệ thống nếu Windows cho phép.
- Android tự kiểm tra/tải APK khi mở và theo lịch nền (Android có thể trì hoãn do tiết kiệm pin). Thông báo hoặc lần mở tiếp theo dẫn tới trình cài của hệ điều hành. Cần cho phép cài ứng dụng từ nguồn này và xác nhận khi Android yêu cầu. Không hứa cài APK âm thầm trên máy cá nhân. Cập nhật web không cần bước này.

## Phát hành

Tăng `package.json` version, chạy `npm run release:prepare`, commit lên main.
Tạo tag `vX.Y.Z` hoặc chạy workflow **Release Android + Windows** với version khớp package.
Workflow kiểm tra/build cả hai nền tảng, triển khai web, sau đó mới công bố release và feed đã ký.
Tag không khớp version hoặc bản đã phát hành sẽ bị từ chối. Không thay bộ cài của bản cũ.

Secrets: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`,
`UPDATE_SIGNING_PRIVATE_KEY`, `RELEASES_DEPLOY_KEY` (SSH deploy key chỉ ghi repo bộ cài).
Không đổi khóa ký sau khi người dùng cài app. Sao lưu khóa riêng ngoài GitHub; mất khóa Android đồng nghĩa không cập nhật được APK đã cài.
Variables: `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_SERVICE_ACCOUNT` cho OIDC Firebase Hosting (không cần khóa service account).

Repo công khai chỉ chứa APK, EXE, checksum, feed chữ ký và hướng dẫn; không chứa khóa hay mã nguồn.
EXE chưa ký Authenticode có thể bị SmartScreen cảnh báo khi cài lần đầu; chữ ký feed riêng bảo vệ các bản cập nhật, không thay thế chứng chỉ Windows.

Kiểm thử: CI build APK release + lint, Windows self-contained + NSIS và test xác minh feed/chống sửa nội dung/chống hạ phiên bản. Cần kiểm thử cài và nâng cấp trên thiết bị thật trước khi phát hành rộng rãi.

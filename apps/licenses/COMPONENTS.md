# Giấy phép của thành phần bên thứ ba

Phần mềm Tiemvio POS dùng các thành phần dưới đây. Mỗi thành phần giữ giấy phép riêng; giấy phép độc quyền trong `LICENSE` chỉ áp dụng cho mã do tác giả viết. Phiên bản lấy từ `package-lock.json` tại thời điểm cập nhật (07-11-2026); xem toàn văn giấy phép trong thư mục của từng gói.

## Chạy trong ứng dụng trên điện thoại

| Thành phần | Dùng để | Giấy phép |
|---|---|---|
| Firebase JavaScript SDK 13 (Google) | Đăng nhập Google, cơ sở dữ liệu Firestore | Apache-2.0 |
| jsQR 1.4 (Cosmo Wenman) | Đọc mã QR ngân hàng từ ảnh | Apache-2.0 |
| Workbox (Google) | Dùng offline, cập nhật ứng dụng | MIT |
| Phông Plus Jakarta Sans (Tokotype) | Chữ giao diện (tải từ Google Fonts) | SIL Open Font License 1.1 |

## Chỉ dùng khi phát triển và triển khai

| Thành phần | Dùng để | Giấy phép |
|---|---|---|
| Vite 8, vite-plugin-pwa 2 | Đóng gói ứng dụng | MIT |
| Firebase CLI (firebase-tools) | Triển khai, trình giả lập | MIT |
| @firebase/rules-unit-testing | Kiểm thử luật bảo mật | Apache-2.0 |
| qrcode 1.5 | Tạo mã QR để kiểm thử | MIT |
| Wrangler (Cloudflare) | Triển khai dịch vụ thông báo | MIT hoặc Apache-2.0 |

## Dịch vụ thông báo (Cloudflare Workers)

| Thành phần | Dùng để | Giấy phép |
|---|---|---|
| @block65/webcrypto-web-push 2 | Mã hóa và gửi thông báo Web Push | MIT |

## Dịch vụ bên ngoài (điều khoản riêng, không phải thư viện)

Google Firebase và Google Fonts, Cloudflare Workers, VietQR (img.vietqr.io, tạo ảnh mã chuyển khoản), và nhà cung cấp AI do chủ quán chọn (Anthropic, OpenRouter hoặc khác). Dùng các dịch vụ này là chịu điều khoản và chính sách của từng bên.

## Ghi chú

- Bản Android còn dùng Android Browser Helper 2.7.4, AndroidX Browser/WorkManager/Core và các phụ thuộc của chúng (Apache-2.0 và giấy phép tương ứng). Mã do Tiemvio POS viết không thay giấy phép của các thư viện này.
- Bản Windows đóng gói .NET runtime theo MIT và các thông báo thành phần kèm SDK. Edge là trình duyệt cài riêng, không được phân phối trong bộ cài.
- Khi phát hành EXE/APK, giữ toàn văn giấy phép và thông báo thành phần được đóng gói trong thư mục `licenses` của bản phát hành; đây là phần tách biệt với giấy phép độc quyền của Tiemvio POS.

- Thông báo bản quyền của từng thư viện nằm trong gói của nó dưới `node_modules/`; khi phân phối bản đóng gói, giữ nguyên các thông báo này theo yêu cầu của giấy phép MIT và Apache-2.0.
- Ảnh món, logo và nội dung thực đơn do cửa hàng cung cấp, thuộc về chủ của chúng, không nằm trong danh sách này.

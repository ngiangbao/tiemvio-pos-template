# Tiemvio POS

Phiên bản **1.20.5**, đồng bộ và kiểm tra ngày **19-11-2026**. Xem [lịch sử cập nhật](CHANGELOG.md).

Mẫu POS cho F&B/bán lẻ, bắt đầu với **thực đơn, khách hàng, kho, đơn hàng và báo cáo trống**. Dùng repo này để tạo repo riêng cho từng cửa hàng; không dùng chung dự án Firebase giữa các khách hàng không liên quan.

Giữ các chức năng: bán hàng/giỏ giữ, sửa/gộp/tách đơn, lịch sử sửa, doanh thu/đối soát, kho/công thức, nhân viên/chấm công/lịch làm, khuyến mãi, AI và chat dùng chung 7 ngày, PWA/iOS, mã nguồn bộ cài Android APK/Windows EXE và luồng cập nhật đã ký. Bản mẫu chưa nối tới dịch vụ thật và chưa có bộ cài dùng được trước khi cấu hình.

## Tạo cửa hàng mới

1. Bấm **Use this template → Create a new repository** trên GitHub, đặt repo cửa hàng là **Private**. Dùng một bản sao riêng và một Firebase project mới cho mỗi cửa hàng.
2. Cài Node.js 24.12+, Java 21+ (nếu chạy emulator), Firebase CLI và GitHub CLI theo nhu cầu. Chạy `npm ci` và `npm ci --prefix push-worker`.
3. Tạo Firebase project mới, web app, Firestore database mới/empty; bật Google Authentication. Chọn vùng dữ liệu sau khi đánh giá pháp lý/nhu cầu vận hành. Không nhập dữ liệu hoặc cấu hình từ một cửa hàng khác.
4. Sao chép `shop.config.example.json` thành `shop.config.json`; điền tên, slug, email chủ quán, email hỗ trợ liên hệ, Firebase public config, HTTPS origin, `downloadsSite`, repo bộ cài và Android package **riêng**. Không nhập service-account private key vào cấu hình web.
5. Chạy `npm run configure:shop`. Script chỉ chạy một lần cho một clone, đồng bộ hostname/namespace/owner bootstrap; Windows có registry/mutex/install directory riêng theo slug. Thay logo trong `web/public/icons/` bằng logo được phép sử dụng.
6. Thiết lập Firebase Auth authorized domain và `authDomain` đúng origin; cấu hình Hosting cùng origin để đăng nhập Google trên iOS hoạt động. Tạo website tải riêng bằng `firebase hosting:sites:create <downloadsSite> --project <projectId>`. Site tải chỉ phục vụ file tĩnh, không đăng ký service worker/SPA fallback để link profile không bị mở thành trang bán hàng. Chạy `npm run check:configured`, `npm run build`, rồi `npm run deploy` với tài khoản được quyền của **dự án mới**.
7. Chủ quán cấu hình đăng nhập lần đầu; app tạo hồ sơ chủ quán được quy tắc cho phép, thực đơn vẫn trống. Tạo phân loại món, món, kho, ngân hàng, nhân viên và khuyến mãi theo nhu cầu. Không có email hỗ trợ thực nào được cấp quyền sửa mặc định.

`shop.config.json` bị gitignore. Commit `shop.configured.json` và cấu hình public được sinh vào repo cửa hàng riêng tư để CI có thể build/deploy; các định danh Firebase web không phải admin secrets. Khi sao chép tiếp cho cửa hàng khác, bắt đầu từ repo template sạch, không sao chép repo đã cấu hình.

## iOS, Android và Windows

- **iOS:** build tạo `/install-ios.html` với hai cách: Safari → Thêm vào màn hình chính, hoặc profile Web Clip chỉ thêm icon. Người dùng xác nhận cài; profile không có MDM/VPN/chứng chỉ gốc. Tên miền, ID và UUID được tạo theo cửa hàng. Không IPA/sideload.
- **Android:** TWA dùng trình duyệt thật để đăng nhập Google, package ID riêng. Cần Chrome/trình duyệt hỗ trợ. APK mới có thể tải nền và báo cập nhật; hệ điều hành có thể yêu cầu xác nhận cài.
- **Windows:** EXE per-user, mở Edge ở chế độ app; updater nền kiểm tra feed RSA/hash và cài bản mới. Không đóng cửa sổ bán hàng khi cập nhật launcher. Các cửa hàng dùng slug khác để không ghi đè bộ cài của nhau.
- **Cập nhật web:** chỉ áp dụng lúc rảnh, không có giỏ, chỉnh sửa, biểu mẫu, thao tác chưa rõ kết quả hoặc AI đang chạy. Mạng/hệ điều hành có thể trì hoãn cập nhật.

### Khóa và phát hành native riêng

1. Sau cấu hình, cài JDK và chạy `npm run native:init`. Khóa mới ở `secrets/` (không commit); public key và `assetlinks.json` phải đi cùng đúng bộ cài. Sao lưu khóa ngoài GitHub; không tạo lại sau khi khách đã cài.
2. Đặt GitHub Secrets: `ANDROID_KEYSTORE_BASE64` từ `secrets/keystore-base64.txt`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS=pos-release`, `UPDATE_SIGNING_PRIVATE_KEY`. Không dùng khóa từ khách hàng khác.
3. Tạo repo bộ cài công khai riêng theo `releasesRepo`; thêm `distribution/publish.yml` thành `.github/workflows/publish.yml`, public key thành `update-public.pem`, và README. Cấp một SSH deploy key chỉ ghi repo đó; lưu private deploy key vào secret `RELEASES_DEPLOY_KEY` của repo nguồn.
4. Cấu hình Google Workload Identity Federation giới hạn đúng repo/branch/tag của clone và service account có quyền Hosting cần thiết. Đặt variables `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_SERVICE_ACCOUNT`; không sao chép provider/service account từ dự án khác.
5. Chạy `npm run release:prepare`, commit các file public/generated cần thiết. Tăng version và tạo tag `vX.Y.Z`/GitHub Release hoặc chạy **Release Android + Windows**. Workflow yêu cầu cấu hình, ký APK, kiểm thử updater Windows, build và triển khai web rồi chuyển bộ cài sang repo công khai. Tránh thay nội dung release đã công bố.

Repo template không chứa khóa ký/public-key nhận dạng app đang chạy, token, worker/KV thật, fingerprint Android thật, bản sao cơ sở dữ liệu hoặc lịch sử Git từ hệ thống khác. Khóa public sẽ chỉ được tạo sau khi bạn khởi tạo riêng cho clone.

## Kiểm tra

```sh
npm run check:template
npm test
npm run test:web
npm run build
```

Test dùng dữ liệu giả trong emulator; không kết nối cửa hàng thật. `check:template` kiểm tra trạng thái sạch trước cấu hình. CI chỉ test/build; triển khai thật là bước được cấu hình riêng. Chạy thử cài/nâng cấp trên thiết bị thực trước phân phối rộng.

## Pháp lý và bảo mật

Điều khoản mẫu 25 mục tại `docs/TERMS-VI.md` và `/legal.txt`; phải điền bên cung cấp, hợp đồng/SLA/DPA và quy trình dữ liệu theo triển khai thực tế. POS chưa phát hành hóa đơn điện tử kết nối thuế. Mã nguồn công khai không đồng nghĩa giấy phép MIT: xem `LICENSE`; chủ sở hữu/đơn vị được ủy quyền được tùy biến theo thỏa thuận.

Security Rules kế thừa là điểm xuất phát cho một cửa hàng, cần rà soát và xác minh trước phát hành rộng. Không có dữ liệu công khai không xác thực; tài khoản chủ quán bootstrap bị ràng buộc email cấu hình, các email hỗ trợ thật không được mặc định cấp quyền sửa. Không coi việc pass test là chứng nhận bảo mật hoặc tuân thủ toàn diện.

Tên Tiemvio được tra cứu sơ bộ web/kho ứng dụng/GitHub ngày 16-11-2026, chưa thấy sản phẩm POS trùng trong kết quả thu được. Đây không phải tra cứu nhãn hiệu đầy đủ, không bảo đảm đăng ký được.

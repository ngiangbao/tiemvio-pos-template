# Lịch sử cập nhật Tiemvio POS

## 1.20.5 — 19-11-2026

- Chủ quán chấm thoát hộ hoặc sửa giờ tan ca bằng ngày/giờ thực tế theo múi giờ cửa hàng và lý do bắt buộc.
- Lưu người điều chỉnh, thời điểm, giờ cũ, giờ mới và lý do; nhân viên xem được lịch sử của mình. Chặn ghi đè lịch sử và xử lý xung đột khi hai người cùng sửa.
- Cảnh báo ca chưa kết thúc sang ngày sau, quá giờ phân ca hơn 15 phút hoặc kéo dài từ 12 giờ; không tự đóng ca.
- Ca mở cũ vẫn hiển thị khi đã có hơn 120 lượt chấm công mới.

## 1.20.4 — 16-11-2026

- Tùy chỉnh chương trình khách hàng thân thiết: tỷ lệ tích điểm, giá trị quy đổi, giới hạn giảm bằng điểm và tối đa 10 bậc thành viên theo tổng chi tiêu.
- Bảo toàn khoản giảm bằng điểm của đơn cũ khi sửa, gộp, tách hoặc hoàn tiền sau khi thay đổi chính sách.
- Biểu đồ doanh thu theo giờ căn thẳng cột giờ, thanh biểu đồ, doanh thu, số đơn và số ly; số liệu không xuống dòng.
- Bổ sung nhận diện chế độ toàn màn hình của Web Clip, giữ khoảng an toàn cho vùng cử chỉ và thu gọn khoảng đệm thanh điều hướng.
- Trang tải profile iOS chạy trên site tĩnh riêng, tránh bị service worker chuyển về trang bán hàng.

Bản mẫu tiếp tục khởi tạo với dữ liệu kinh doanh trống, cấu hình Firebase và tên miền mẫu. Mỗi cửa hàng cần dự án Firebase, thông tin chủ quán, bộ nhận diện, khóa ký cập nhật và repo bộ cài riêng trước khi triển khai. Bản mẫu không tự kết nối tới một cửa hàng có sẵn.

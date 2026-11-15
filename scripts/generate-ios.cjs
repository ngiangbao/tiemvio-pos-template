const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.join(__dirname,'..'),dest=path.join(root,'web/public');
const name='Tiemvio POS',url='https://APP_HOST.invalid/',slug='Tiemvio-POS';
const downloadOrigin='https://DOWNLOADS_HOST.invalid';
const idPrefix='app.pos.webclip.'+crypto.createHash('sha256').update(url).digest('hex').slice(0,16);
const esc=s=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const uuid=label=>{const h=crypto.createHash('sha256').update(url+label).digest('hex');return h.slice(0,8)+'-'+h.slice(8,12)+'-8'+h.slice(13,16)+'-a'+h.slice(17,20)+'-'+h.slice(20,32);};
const icon=fs.readFileSync(path.join(dest,'icons/apple-touch-icon.png')).toString('base64');
const profile=`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>PayloadType</key><string>Configuration</string><key>PayloadVersion</key><integer>1</integer>
<key>PayloadIdentifier</key><string>${idPrefix}.profile</string>
<key>PayloadUUID</key><string>${uuid('profile')}</string>
<key>PayloadDisplayName</key><string>${esc(name)} · Web Clip</string>
<key>PayloadDescription</key><string>Chỉ thêm biểu tượng ${esc(name)} mở ${esc(url)}. Không đăng ký quản lý thiết bị, không cài chứng chỉ hoặc cấu hình VPN.</string>
<key>PayloadRemovalDisallowed</key><false/>
<key>PayloadContent</key><array><dict>
<key>PayloadType</key><string>com.apple.webClip.managed</string><key>PayloadVersion</key><integer>1</integer>
<key>PayloadIdentifier</key><string>${idPrefix}.clip</string><key>PayloadUUID</key><string>${uuid('clip')}</string>
<key>PayloadDisplayName</key><string>${esc(name)}</string><key>Label</key><string>${esc(name)}</string>
<key>URL</key><string>${esc(url)}</string><key>FullScreen</key><true/>
<key>IsRemovable</key><true/><key>Precomposed</key><true/><key>IgnoreManifestScope</key><false/>
<key>Icon</key><data>${icon}</data>
</dict></array></dict></plist>\n`;
fs.writeFileSync(path.join(dest,slug+'-iOS.mobileconfig'),profile);
fs.writeFileSync(path.join(dest,'install-ios.html'),`<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cài ${esc(name)} trên iPhone/iPad</title><meta name="theme-color" content="#57291f"><style>*{box-sizing:border-box}body{font-family:system-ui,-apple-system,sans-serif;background:#faf6f0;color:#2a1a15;margin:0;padding:28px 18px;line-height:1.65}main{max-width:720px;margin:auto}.logo{width:88px;height:88px;border-radius:22px}h1{line-height:1.2;font-size:29px}section{background:white;border:1px solid #eadfd5;border-radius:20px;padding:22px;margin:18px 0}h2{font-size:21px;margin-top:0}.button{display:inline-block;background:#57291f;color:white;padding:12px 18px;border-radius:12px;text-decoration:none;font-weight:650;margin:6px 4px 6px 0}.hint{font-size:14px;color:#695a50}li{margin:8px 0}a{color:#57291f}footer{font-size:13px;margin-top:24px}</style></head><body><main>
<img class="logo" src="/icons/apple-touch-icon.png" alt="${esc(name)}"><h1>Cài ${esc(name)} trên iPhone/iPad</h1><p>Không cần file IPA, sideload hoặc tài khoản Apple Developer. Hai cách dưới đây mở cùng dữ liệu cửa hàng sau khi đăng nhập.</p>
<section><h2>1. Thêm bằng Safari · Khuyên dùng</h2><ol><li>Mở <a href="${esc(url)}">${esc(url)}</a> bằng <strong>Safari</strong>. Nếu đang ở Zalo/Facebook, chọn mở liên kết trong Safari.</li><li>Chọn <strong>Chia sẻ</strong>, rồi <strong>Thêm vào màn hình chính</strong>. Tùy phiên bản iOS, Chia sẻ có thể nằm trong menu trang.</li><li>Bật <strong>Mở dưới dạng ứng dụng web</strong> nếu iOS hiện lựa chọn này, rồi bấm <strong>Thêm</strong>.</li><li>Mở icon ${esc(name)} trên màn hình chính và đăng nhập tài khoản được chủ quán cấp quyền.</li></ol><a class="button" href="${esc(url)}">Mở ${esc(name)}</a><p class="hint">Website không thể tự bấm nút Thêm của iOS. Nếu app đã có trên màn hình chính, tiếp tục dùng icon hiện tại để giữ phiên đăng nhập và dữ liệu đang chờ.</p></section>
<section><h2>2. Cài profile Web Clip</h2><p>Profile này chỉ tạo icon ${esc(name)} và mở app toàn màn hình. Không có MDM, VPN, chứng chỉ gốc hoặc tài khoản quản lý thiết bị.</p><a class="button" href="/${slug}-iOS.mobileconfig">Tải profile ${esc(name)}</a><ol><li>Tải bằng Safari và cho phép tải hồ sơ khi iPhone hỏi.</li><li>Mở <strong>Cài đặt → Hồ sơ đã tải về → Cài đặt</strong>. Nếu chưa thấy, kiểm tra <strong>Cài đặt chung → VPN &amp; Quản lý thiết bị</strong>.</li><li>Đọc nội dung hồ sơ, xác nhận và nhập mật mã thiết bị nếu iOS yêu cầu. Cài trong vòng 8 phút sau tải; nếu hồ sơ đã hết hạn, tải lại.</li><li>Trở về màn hình chính, mở icon ${esc(name)} và đăng nhập.</li></ol><p class="hint">Profile chưa có chữ ký xác thực tổ chức; iOS có thể hiển thị “Chưa xác minh”. Kiểm tra đúng URL ${esc(url)} và payload Web Clip trước khi cài. Bạn có thể chọn cách Safari ở trên nếu không muốn cài profile.</p><p class="hint">Để gỡ: xóa icon nếu iOS cho phép, hoặc vào VPN &amp; Quản lý thiết bị và gỡ hồ sơ ${esc(name)}. Không xóa dữ liệu trình duyệt khi còn đơn chưa đồng bộ.</p></section>
<section><h2>Cập nhật và thông báo</h2><p>Giao diện mới được tải qua web; app chờ trạng thái rảnh để áp dụng. Cần có mạng để nhận cập nhật và đồng bộ. Web Clip không biến website thành app native/App Store, và không bảo đảm tự xuất hiện trong Thư viện ứng dụng trên mọi phiên bản iOS.</p><p>Thông báo phụ thuộc phiên bản iOS, cách cài và quyền bạn đã cho phép; nếu cần Web Push, ưu tiên cài web app bằng Safari. Không cần cài lại IPA mỗi lần app web đổi.</p></section>
<footer><a href="https://support.apple.com/en-az/guide/iphone/iphea86e5236/26/ios/26" target="_blank" rel="noopener">Hướng dẫn web app của Apple</a> · <a href="https://support.apple.com/en-ie/102400" target="_blank" rel="noopener">Hướng dẫn cài profile</a> · <a href="/legal.txt">Điều khoản</a></footer>
</main></body></html>`);
console.log('Generated iOS Web Clip profile and installation guide');
// Separate static origin: it never registers a worker or serves a POS SPA fallback.
const downloads=path.join(root,'downloads');fs.mkdirSync(path.join(downloads,'icons'),{recursive:true});
let guide=fs.readFileSync(path.join(dest,'install-ios.html'),'utf8');
guide=guide.replace('href="/'+slug+'-iOS.mobileconfig"','href="'+downloadOrigin+'/'+slug+'-iOS.mobileconfig"');
fs.writeFileSync(path.join(dest,'install-ios.html'),guide);
fs.copyFileSync(path.join(dest,'install-ios.html'),path.join(downloads,'install-ios.html'));
fs.copyFileSync(path.join(dest,slug+'-iOS.mobileconfig'),path.join(downloads,slug+'-iOS.mobileconfig'));
fs.copyFileSync(path.join(dest,'icons/apple-touch-icon.png'),path.join(downloads,'icons/apple-touch-icon.png'));
fs.copyFileSync(path.join(dest,'legal.txt'),path.join(downloads,'legal.txt'));
fs.writeFileSync(path.join(downloads,'index.html'),'<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/install-ios.html"><title>Cài '+esc(name)+'</title><a href="/install-ios.html">Hướng dẫn cài cho iOS</a>');

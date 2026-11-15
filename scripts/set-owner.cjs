// Usage: npm run set-owner -- you@gmail.com
// Writes the shop owner's Google address into firestore.rules (only this account may create the first owner record).
const fs = require('node:fs');
const path = require('node:path');
const email = String(process.argv[2] || '').trim().toLowerCase();
if (!/^[^\s@']+@[^\s@']+\.[^\s@']+$/.test(email)) {
  console.error('Dùng: npm run set-owner -- email-chu-quan@gmail.com');
  process.exit(1);
}
const file = path.join(__dirname, '..', 'firestore.rules');
const rules = fs.readFileSync(file, 'utf8');
const next = rules.replace(/function ownerEmail\(\) \{ return '[^']*'; \}/, `function ownerEmail() { return '${email}'; }`);
if (next === rules && !rules.includes(`'${email}'`)) { console.error('Không tìm thấy dòng ownerEmail() trong firestore.rules'); process.exit(1); }
fs.writeFileSync(file, next);
console.log('Đã đặt chủ quán:', email, '\nChạy "npm run deploy" để áp dụng luật bảo mật.');

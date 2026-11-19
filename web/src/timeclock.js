const parts = (value, timeZone) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
  timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
}).formatToParts(new Date(value)).map(p => [p.type, p.value]));
export function clockLocal(value, timeZone = 'Asia/Ho_Chi_Minh') {
  const p = parts(value, timeZone); return {day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`};
}
// Interpret the owner's input in the shop timezone, independent of the phone's timezone.
export function clockIso(day, time, timeZone = 'Asia/Ho_Chi_Minh') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw Error('Ngày hoặc giờ tan ca không hợp lệ.');
  const target = Date.parse(`${day}T${time}:00.000Z`); if (!Number.isFinite(target)) throw Error('Ngày tan ca không hợp lệ.');
  let guess = target;
  for (let i = 0; i < 4; i++) {
    const p = parts(guess, timeZone), shown = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00.000Z`);
    const diff = target - shown; if (!diff) break; guess += diff;
  }
  const actual = clockLocal(guess, timeZone);
  if (actual.day !== day || actual.time !== time) throw Error('Giờ này không tồn tại trong múi giờ cửa hàng.');
  return new Date(guess).toISOString();
}
export function clockWarning(entry, schedule = [], now = Date.now(), timeZone = 'Asia/Ho_Chi_Minh') {
  if (entry.outAt || !Number.isFinite(Date.parse(entry.inAt))) return '';
  const start = clockLocal(entry.inAt, timeZone), today = clockLocal(now, timeZone).day;
  if (start.day < today) return 'Chưa tan ca từ ngày trước';
  const minutes = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const plans = schedule.filter(s => s.email === entry.email && s.day === start.day && minutes(start.time) >= minutes(s.start) - 60 && minutes(start.time) <= minutes(s.end));
  if (plans.length && plans.every(s => now > Date.parse(clockIso(s.day, s.end, timeZone)) + 15 * 60000)) return 'Đã quá giờ phân ca hơn 15 phút, chưa chấm thoát';
  if (now - Date.parse(entry.inAt) >= 12 * 3600000) return 'Đã chấm công từ 12 giờ trở lên, cần kiểm tra';
  return '';
}

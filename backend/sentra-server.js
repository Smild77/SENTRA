require('dotenv').config()

const http = require('http')
const oracledb = require('oracledb')
const { WebSocketServer } = require('ws')
const os = require('os')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const hikvision = require('./lib/hikvision')
const evidencePack = require('./lib/evidence-pack')

/* ★ Local date helper — ใช้ local timezone แทน UTC (ป้องกันวันที่ผิดช่วง 00:00-07:00 น.)
   ใช้ใน label ของ getDateRange + getDateRangeFromParams */
function localDateStr(d) {
  d = d || new Date();
  var y = d.getFullYear();
  var m = String(d.getMonth() + 1).padStart(2, '0');
  var day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

// ★ Local date+time helper (เหมือน localDateStr แต่รวมเวลาด้วย) — ใช้เขียน timestamp ลง QR log CSV
function localDateTimeStr(d) {
  d = d || new Date();
  var hh = String(d.getHours()).padStart(2, '0');
  var mi = String(d.getMinutes()).padStart(2, '0');
  var ss = String(d.getSeconds()).padStart(2, '0');
  var ms = String(d.getMilliseconds()).padStart(3, '0');
  return localDateStr(d) + ' ' + hh + ':' + mi + ':' + ss + '.' + ms;
}

// ★ Escape ค่าสำหรับเขียนลง CSV field (RFC 4180): quote ถ้ามี comma/quote/newline,
//   และ double ตัว " ที่อยู่ข้างในเพื่อไม่ให้ column เพี้ยนตอนเปิดด้วย Excel/CSV parser อื่น
function csvEscape(v) {
  v = String(v == null ? '' : v)
  if (v.indexOf(',') >= 0 || v.indexOf('"') >= 0 || v.indexOf('\n') >= 0) {
    return '"' + v.replace(/"/g, '""') + '"'
  }
  return v
}

// ★ ดึง LAN IP ทั้งหมดของเครื่อง (เพื่อแสดงให้ผู้ใช้รู้ว่าต้องแชร์ URL ไหน)
function getLanIPs() {
  var ifaces = os.networkInterfaces();
  var ips = [];
  for (var name in ifaces) {
    for (var i = 0; i < ifaces[name].length; i++) {
      var addr = ifaces[name][i];
      if (addr.family === 'IPv4' && !addr.internal) ips.push(addr.address);
    }
  }
  return ips;
}

// ─── QR Code Log File (auto-write every new panel) ───────────
const QR_LOG_DIR = path.join(__dirname, 'qr-logs')
const QR_LOG_RETENTION_DAYS = parseInt(process.env.QR_LOG_RETENTION_DAYS || '30')
// ★ รอบการลบไฟล์เก่า — วันละครั้ง (ไม่ใช่แค่ตอน start)
const QR_PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000
let qrPurgeTimer = null

// สร้างโฟลเดอร์ qr-logs ถ้ายังไม่มี
try { if (!fs.existsSync(QR_LOG_DIR)) fs.mkdirSync(QR_LOG_DIR, { recursive: true }) } catch (e) { console.warn('[QRLog] mkdir failed:', e.message) }

// เขียน QR entry ใหม่ลงไฟล์ CSV (append mode)
// Format: timestamp,machine_id,lot_id,panel_id,is_error
function appendQrLog(machineId, lotId, panelId, isError, eventTime) {
  try {
    var d = eventTime ? new Date(eventTime) : new Date()
    var dateStr = localDateStr(d) // YYYY-MM-DD (local)
    var fileName = 'qr-' + dateStr + '.csv'
    var filePath = path.join(QR_LOG_DIR, fileName)
    // ถ้าไฟล์ใหม่ → เขียน header
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, 'timestamp,machine_id,lot_id,panel_id,is_read\n', 'utf8')
    }
    var ts = localDateTimeStr(d)
    var line = [ts, csvEscape(machineId), csvEscape(lotId), csvEscape(panelId), isError ? 'FALSE' : 'TRUE'].join(',') + '\n'
    fs.appendFile(filePath, line, 'utf8', function(err) {
      if (err) console.warn('[QRLog] append failed:', err.message)
    })
  } catch (e) {
    console.warn('[QRLog] error:', e.message)
  }
}

// ลบไฟล์ log เก่ากว่า N วัน (รันตอน start)
function purgeOldQrLogs() {
  try {
    var files = fs.readdirSync(QR_LOG_DIR)
    var now = Date.now()
    var cutoff = now - QR_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000
    files.forEach(function(f) {
      if (!/^qr-\d{4}-\d{2}-\d{2}\.csv$/.test(f)) return
      var stat = fs.statSync(path.join(QR_LOG_DIR, f))
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(path.join(QR_LOG_DIR, f))
        console.log('[QRLog] purged old file:', f)
      }
    })
  } catch (e) { /* silent */ }
}

// ─── Config ───────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3001')
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '3000')
/* ★ ค่าที่เอาไปต่อใส่ SQL ต้องเป็นจำนวนเต็มบวกเสมอ — ถ้า .env พิมพ์ผิดจะได้ NaN
   แล้วกลายเป็น "SYSDATE - NaN/1440" ซึ่ง Oracle ฟ้อง ORA-00904 ตอน runtime
   ไม่ใช่ตอน start ทำให้ตามยาก */
function posInt(v, fallback) {
  const n = parseInt(v, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}
const POLL_MINUTES = posInt(process.env.POLL_MINUTES, 2)
/* ★ [FIX] ช่วงย้อนหลังของยอด panel/LOT — แยกออกจาก POLL_MINUTES เพราะสองส่วนนี้
   ต้องการคนละช่วง: latest_status อยากได้แค่ "สถานะล่าสุด" ของเครื่องที่เพิ่งเดิน
   ส่วนยอด OK/Error เป็นตัวเลขสะสมทั้งกะ เดิมฮาร์ดโค้ดไว้ 24 ชม.ทั้งคู่
   ลดค่านี้ได้ถ้า query ยังช้า (เช่น 720 = 12 ชม.) แลกกับยอดสะสมที่สั้นลง */
const PANEL_STATS_MINUTES = posInt(process.env.PANEL_STATS_MINUTES, 1440)
// ★ ระยะเวลาที่ถือว่าเครื่อง "ไม่มีข้อมูล" (NO_DATA) — ถ้าเครื่องไม่ active ในช่วงนี้ → สีเทาจาง
// STALE_MINUTES ควร >= POLL_MINUTES (เพราะ DB query ใช้ POLL_MINUTES เป็น lookback)
const STALE_MINUTES = posInt(process.env.STALE_MINUTES, POLL_MINUTES)
// ★ เวลาสูงสุดที่ยอมให้ query ของ poll ใช้ — เกินนี้ Oracle จะยกเลิก call และ watchdog จะปลดล็อก
const POLL_TIMEOUT_MS = posInt(process.env.POLL_TIMEOUT_MS, 15000)
// ★ query ที่ใช้เกินค่านี้จะถูก log ไว้ — เตือนก่อนที่มันจะโตจนชน POLL_TIMEOUT_MS
const SLOW_QUERY_WARN_MS = posInt(process.env.SLOW_QUERY_WARN_MS, Math.round(POLL_TIMEOUT_MS / 3))
/* ★ เพดานเวลาของ query ฝั่ง API — คนละตัวกับ POLL_TIMEOUT_MS
   poll ต้องจบเร็วเพราะยิงทุก 3 วิ ส่วน API ผู้ใช้กดเองครั้งเดียวและอาจขอช่วง 7/30 วัน
   จึงให้เวลามากกว่าได้ แต่ต้อง "มีเพดาน" ไม่งั้น query ยาวจะจอง connection ค้างจนเต็ม pool
   แล้ว poll กับ API เส้นอื่นพลอยตายตาม (นี่คืออาการ time out ที่เห็นตอนเลือก 7 วัน) */
const API_TIMEOUT_MS = posInt(process.env.API_TIMEOUT_MS, 90000)
/* ★ [FIX] ค่าเดียวใช้ไม่พอ — 90 วิพอสำหรับ 7 วัน แต่ 30 วันข้อมูลเยอะกว่าหลายเท่า
   จึงชน callTimeout แล้วเด้ง "time out" ทุกครั้ง ตอนนี้แยกเพดานตาม "ความยาวช่วงที่ขอ"
   และปรับได้ทาง .env ทีละตัวโดยไม่ต้องแก้โค้ด */
const API_TIMEOUT_WEEK_MS  = posInt(process.env.API_TIMEOUT_WEEK_MS, 180000)   // ช่วง 3–7 วัน
const API_TIMEOUT_MONTH_MS = posInt(process.env.API_TIMEOUT_MONTH_MS, 300000)  // ยาวกว่า 7 วัน (เช่น 30 วัน)
// ★ เส้นแบ่งว่าช่วงกี่วันนับเป็น "สั้น" / "สัปดาห์" / "ยาว"
const API_TIMEOUT_SHORT_MAX_DAYS = posInt(process.env.API_TIMEOUT_SHORT_MAX_DAYS, 2)
const API_TIMEOUT_WEEK_MAX_DAYS  = posInt(process.env.API_TIMEOUT_WEEK_MAX_DAYS, 7)
/* ★ override ราย API — ใส่เมื่อเส้นไหนหนักกว่าเพื่อนจริง ๆ
   0 หรือไม่ตั้ง = คิดตามความยาวช่วงตามปกติ (ชื่อ key ตรงกับ path จะได้ไล่ log ง่าย) */
const API_TIMEOUT_BY_ENDPOINT = {
  'qr-summary':      posInt(process.env.API_TIMEOUT_QR_SUMMARY_MS, 0),
  'qr-history':      posInt(process.env.API_TIMEOUT_QR_HISTORY_MS, 0),
  'qr-daily':        posInt(process.env.API_TIMEOUT_QR_DAILY_MS, 0),
  'status-history':  posInt(process.env.API_TIMEOUT_STATUS_HISTORY_MS, 0),
  'machine-history': posInt(process.env.API_TIMEOUT_MACHINE_HISTORY_MS, 0),
  'lot-report':      posInt(process.env.API_TIMEOUT_LOT_REPORT_MS, 0),
  'machines':        posInt(process.env.API_TIMEOUT_MACHINES_MS, 0),
}
/* ★ เวลารอ connection ว่างจาก pool — ต้องยาวกว่าเดิม เพราะ query ช่วง 30 วัน
   จอง connection ได้นานเป็นนาที ถ้าคิวสั้นไปเส้นอื่นจะเด้ง NJS-040 (queue timeout)
   ทั้งที่ DB ยังไม่ได้ช้าเลย */
const QUEUE_TIMEOUT_MS = posInt(process.env.ORACLE_QUEUE_TIMEOUT_MS, Math.max(POLL_TIMEOUT_MS, 30000))

// ★ จำนวนวันของช่วงที่ขอ (ปัดขึ้น อย่างน้อย 1)
function rangeDays(start, end) {
  if (!(start instanceof Date) || !(end instanceof Date)) return 1
  const ms = end.getTime() - start.getTime()
  if (!Number.isFinite(ms) || ms <= 0) return 1
  return Math.max(1, Math.ceil(ms / 86400000))
}
// ★ เพดานเวลาของ API เส้นนั้น: override ราย endpoint มาก่อน ถ้าไม่มีก็ดูความยาวช่วง
function apiTimeoutForDays(endpoint, days) {
  const override = API_TIMEOUT_BY_ENDPOINT[endpoint] || 0
  if (override > 0) return override
  const d = Number.isFinite(days) && days > 0 ? days : 1
  if (d <= API_TIMEOUT_SHORT_MAX_DAYS) return API_TIMEOUT_MS
  if (d <= API_TIMEOUT_WEEK_MAX_DAYS) return API_TIMEOUT_WEEK_MS
  return API_TIMEOUT_MONTH_MS
}
// r = { start, end } หรือ null สำหรับ query ที่ไม่มีช่วงเวลา
function apiTimeoutFor(endpoint, r) {
  return apiTimeoutForDays(endpoint, r ? rangeDays(r.start, r.end) : 1)
}
// ★ เพดานที่ยาวที่สุดที่เป็นไปได้ — frontend ใช้ตัดสินว่าจะรอสูงสุดเท่าไร
function maxApiTimeoutMs() {
  var vals = [API_TIMEOUT_MS, API_TIMEOUT_WEEK_MS, API_TIMEOUT_MONTH_MS]
  Object.keys(API_TIMEOUT_BY_ENDPOINT).forEach(function(k) {
    if (API_TIMEOUT_BY_ENDPOINT[k] > 0) vals.push(API_TIMEOUT_BY_ENDPOINT[k])
  })
  return Math.max.apply(null, vals)
}

// ★ เทส: จำกัดเครื่อง (null = ทุกเครื่อง)
const ALLOWED_MACHINES = process.env.ALLOWED_MACHINES
  ? process.env.ALLOWED_MACHINES.split(',').map(s => s.trim().toUpperCase())
  : null

// ─── กล้อง NVR (Hikvision ISAPI) ───────────────────────
const NVR_CONFIG = {
  host: process.env.NVR_HOST || '',
  port: parseInt(process.env.NVR_PORT || '80'),
  user: process.env.NVR_USER || '',
  password: process.env.NVR_PASSWORD || '',
}
// ─── Vendor Evidence Pack ──────────────────────────────
const QR_TARGET_PCT = parseFloat(process.env.QR_TARGET_PCT || '99')
const REPORT_CONTACT = process.env.REPORT_CONTACT || ''
const REPORT_PLANT = process.env.REPORT_PLANT || ''
const DAY_SHIFT_START_HOUR = parseInt(process.env.DAY_SHIFT_START_HOUR || '8')
// ★ ฟอนต์สำหรับ PDF — ต้องครอบคลุม CJK/ไทย เพราะ ALARM_TEXT ส่วนใหญ่เป็นภาษาจีน
//   default = Arial Unicode MS (มากับ Windows) — เปลี่ยนได้ถ้าเครื่อง deploy ไม่มีฟอนต์นี้
const PDF_FONT_PATH = process.env.PDF_FONT_PATH || ''

const CAMERA_MAP_PATH = path.join(__dirname, 'config', 'camera-map.json')
// ★ โหลดใหม่ทุกครั้งที่เรียก (ไฟล์เล็ก แก้ mapping ได้โดยไม่ต้อง restart server)
function loadCameraMap() {
  try {
    var data = JSON.parse(fs.readFileSync(CAMERA_MAP_PATH, 'utf8'))
    return data.machines || {}
  } catch (e) {
    console.warn('[Camera] อ่าน camera-map.json ไม่ได้:', e.message)
    return {}
  }
}

/* ─── Layout: ผังเครื่องจักร + โซน ──────────────────────
   ★ เดิมฝังเป็น MACHINES_DB / ZONE_PRESETS อยู่ใน index.html (ไฟล์ 257 KB)
     แก้ตำแหน่งทีต้อง copy-paste โค้ดกลับมาแปะเองทุกครั้ง
     ย้ายมาเป็น JSON แล้วให้ server เขียนให้ผ่าน POST — แก้บนหน้าเว็บได้จบในตัว
   อ่านใหม่ทุกครั้งที่เรียก (ไฟล์เล็ก แก้แล้วไม่ต้อง restart) เหมือน camera-map.json */
const MACHINES_PATH = path.join(__dirname, 'config', 'machines.json')
const ZONES_PATH = path.join(__dirname, 'config', 'zones.json')

function loadJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (e) {
    console.warn('[Layout] อ่าน ' + path.basename(filePath) + ' ไม่ได้:', e.message)
    return fallback
  }
}

// ★ เขียนแบบ atomic (เขียน .tmp แล้ว rename) + สำรองไฟล์เดิมไว้ 1 ชุด — กันไฟล์ผังพังแล้วข้อมูลหายหมด
function saveJsonFile(filePath, data) {
  const tmp = filePath + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
  try { if (fs.existsSync(filePath)) fs.copyFileSync(filePath, filePath + '.bak') } catch {}
  fs.renameSync(tmp, filePath)
}

const MAX_BODY_BYTES = 2 * 1024 * 1024

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body ใหญ่เกิน ' + MAX_BODY_BYTES + ' bytes'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (e) {
        reject(new Error('JSON ไม่ถูกต้อง: ' + e.message))
      }
    })
    req.on('error', reject)
  })
}

// ★ ตรวจ factory/floor ก่อนเอาไปเป็น key — กันเขียนขยะลงไฟล์ผัง
function validFactory(v) { return typeof v === 'string' && /^[A-Z0-9_-]{1,20}$/.test(v) }
function validFloor(v) { return /^[0-9]{1,2}$/.test(String(v)) }
function num100(v) { return typeof v === 'number' && isFinite(v) && v >= 0 && v <= 100 }

function validateMachines(list) {
  if (!Array.isArray(list)) throw new Error('machines ต้องเป็น array')
  return list.map((m, i) => {
    if (!m || typeof m.id !== 'string' || !m.id.trim()) throw new Error(`machines[${i}] ไม่มี id`)
    if (!num100(m.x) || !num100(m.y)) throw new Error(`machines[${i}] (${m.id}) x/y ต้องเป็นตัวเลข 0-100`)
    return {
      id: m.id.trim(),
      name: String(m.name == null ? m.id : m.name),
      type: String(m.type == null ? '' : m.type),
      zone: String(m.zone == null ? '' : m.zone),
      x: m.x,
      y: m.y,
    }
  })
}

function validateZones(list) {
  if (!Array.isArray(list)) throw new Error('zones ต้องเป็น array')
  return list.map((z, i) => {
    if (!z || typeof z.name !== 'string' || !z.name.trim()) throw new Error(`zones[${i}] ไม่มี name`)
    if (!Array.isArray(z.points) || z.points.length < 3) throw new Error(`zones[${i}] (${z.name}) ต้องมีอย่างน้อย 3 จุด`)
    const points = z.points.map((p, j) => {
      if (!p || !num100(p.x) || !num100(p.y)) throw new Error(`zones[${i}].points[${j}] x/y ต้องเป็นตัวเลข 0-100`)
      return { x: p.x, y: p.y }
    })
    const out = { name: z.name.trim(), points }
    // ★ เก็บ nameKey ไว้ ไม่งั้นโซนที่มีคำแปล i18n จะกลายเป็นข้อความตายตัวหลังเซฟทับ
    if (typeof z.nameKey === 'string' && z.nameKey) out.nameKey = z.nameKey
    if (typeof z.fill === 'string') out.fill = z.fill
    if (typeof z.border === 'string') out.border = z.border
    if (typeof z.labelRotate === 'number') out.labelRotate = z.labelRotate
    return out
  })
}

// อัปเดตเฉพาะ factory/floor ที่ส่งมา — ชั้นอื่นในไฟล์เดิมไม่ถูกแตะ
function saveLayoutSection(filePath, factory, floor, items) {
  const all = loadJsonFile(filePath, {})
  if (!all[factory]) all[factory] = {}
  all[factory][String(floor)] = items
  saveJsonFile(filePath, all)
  return all
}

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT
oracledb.fetchAsString = [oracledb.CLOB]

// ─── Oracle Pool ──────────────────────────────────────
let pool = null

async function getPool() {
  if (pool) return pool

  const connectString = process.env.ORACLE_CONNECTION_STRING
    || `${process.env.ORACLE_HOST}:${process.env.ORACLE_PORT || 1521}/${process.env.ORACLE_SERVICE || process.env.ORACLE_SID}`

  pool = await oracledb.createPool({
    user: process.env.ORACLE_USER,
    password: process.env.ORACLE_PASSWORD,
    connectString,
    poolMin: 1,
    /* ★ [FIX] 3 น้อยไปเมื่อ API ช่วงยาวจอง connection ได้นานถึง API_TIMEOUT_MS
       poll กินไป 1 เส้นเสมอ เหลือ 2 ให้ทั้ง UI หลักและหน้า report — ผู้ใช้เปิดสองหน้าพร้อมกัน
       ก็เต็มแล้ว เส้นถัดไปต้องรอคิวจนชน queueTimeout = อาการ "time out" ที่เห็น */
    poolMax: posInt(process.env.ORACLE_POOL_MAX, 6),
    poolIncrement: 1,
    poolTimeout: 60,
    stmtCacheSize: 10,
    /* ★ [FIX] เพดานเวลารอ connection ว่างจาก pool — default คือ 60 วิ
       ถ้า pool เต็ม poll จะค้างรอเงียบ ๆ นานกว่า POLL_TIMEOUT_MS เสียอีก
       ทำให้ watchdog เข้าใจผิดว่า query ช้า ทั้งที่ยังไม่ได้เริ่ม query ด้วยซ้ำ */
    queueTimeout: QUEUE_TIMEOUT_MS,
  })
  console.log(`[DB] Oracle Pool created: ${connectString}`)
  return pool
}

// ─── Date range helper (สำหรับ QR history) ─────────────────
// range: 'today' | 'yesterday' | 'week' | 'month'
// returns: { start: Date, end: Date, label: string }
function getDateRange(range) {
  var now = new Date()
  var start = new Date(now)
  var end = new Date(now)
  var label = ''
  if (range === 'today') {
    start.setHours(0, 0, 0, 0)
    end.setHours(23, 59, 59, 999)
    label = localDateStr(start)
  } else if (range === 'yesterday') {
    start.setDate(start.getDate() - 1)
    start.setHours(0, 0, 0, 0)
    end.setDate(end.getDate() - 1)
    end.setHours(23, 59, 59, 999)
    label = localDateStr(start)
  } else if (range === 'week') {
    // 7 วันล่าสุด รวมวันนี้
    start.setDate(start.getDate() - 6)
    start.setHours(0, 0, 0, 0)
    end.setHours(23, 59, 59, 999)
    label = localDateStr(start) + ' to ' + localDateStr(end)
  } else if (range === 'month') {
    // 30 วันล่าสุด รวมวันนี้
    start.setDate(start.getDate() - 29)
    start.setHours(0, 0, 0, 0)
    end.setHours(23, 59, 59, 999)
    label = localDateStr(start) + ' to ' + localDateStr(end)
  } else {
    // default = today
    start.setHours(0, 0, 0, 0)
    end.setHours(23, 59, 59, 999)
    label = localDateStr(start)
  }
  return { start: start, end: end, label: label }
}

function getDateRangeFromParams(startStr, endStr) {
  var now = new Date()
  var start, end, label
  if (!startStr && !endStr) {
    // default = today
    start = new Date(now); start.setHours(0, 0, 0, 0)
    end = new Date(now); end.setHours(23, 59, 59, 999)
    label = localDateStr(start)
  } else {
    // parse YYYY-MM-DD
    start = startStr ? new Date(startStr + 'T00:00:00') : new Date(now)
    if (!startStr) start.setHours(0, 0, 0, 0)
    end = endStr ? new Date(endStr + 'T23:59:59.999') : new Date(now)
    if (!endStr) end.setHours(23, 59, 59, 999)
    label = localDateStr(start) + ' to ' + localDateStr(end)
  }
  return { start: start, end: end, label: label }
}

// ─── Panel counting rules ─────────────────────────────────
/*
  ★ [FIX] "จำนวนแผ่น" ต้องนับเป็น "แผ่น" ไม่ใช่ "แถว event"
  ปัญหาเดิม: SUM(CASE...) นับทุกแถว → ตัวเลขไม่กลม (ควรเป็น 40 / 80 ตามคาสเซ็ตต์)

  สาเหตุที่เจอจากข้อมูลจริง (backend/qr-logs/*.csv รวม 8,606 แถว):
    1. suffix "/0"  — แผ่นเดียวถูกบันทึก 2 ID เช่น 126071301900001001 กับ 126071301900001001/0
                      พบที่ SMK-SPR-01-L 69 แผ่น → นับเกินเท่าตัว
    2. suffix ",BD" / ",BB" — ฟอร์แมตปกติของ WIR-Vdevelop-01-UL (ไม่ได้ซ้ำ แต่ต้อง normalize ให้เทียบกันได้)
    3. แผ่น dummy / jig — 'Dummy0F', 'M0960027E2000C-0607', 'M0960002G2000E-0607',
                      'M0960013A2000G-0607', '0000M0960111B20093' (ID ตัวเดียววิ่งข้ามหลายเครื่อง)
    4. สแกนเพี้ยน — '\x1cQ4784', '0'

  วิธีแยก: normalize ก่อน แล้วตัดเฉพาะ ID ที่ "รู้แน่ว่าไม่ใช่แผ่นงาน" ออก

  ★ เคยลองใช้ whitelist ('^[0-9]{14}[0-9A-Z][0-9]{3,5}$') แล้วพบว่า **ตัดเกิน** ตอนรันกับ DB จริง
    (CPP-VCP-01-L หายไป 312/505 = 62%, WIR-SE-01-L/-UL หาย 357/351, WIR-Pretreatment-01-L/-UL หาย 240/240)
    เลข L/UL เท่ากันเป๊ะ = เป็นทั้ง "ฟอร์แมต" ที่เครื่องกลุ่มนั้นใช้ ไม่ใช่ขยะ
    → เปลี่ยนมาใช้ blacklist แทน: ฟอร์แมตแปลกใหม่ที่ยังไม่รู้จักจะถูก "นับ" ไว้ก่อน ปลอดภัยกว่านับขาด
*/

/* ★ กฎทั้งสามข้อล่างรับ "ชื่อคอลัมน์" เข้ามา ไม่ฝัง PANEL_ID ไว้ตายตัว
   เพราะ panelBaseSql() แปลง CLOB เป็น VARCHAR2 (PANEL_TXT/PANEL_LEN) ให้ครั้งเดียวแล้ว
   กฎจึงทำงานบนค่าที่แปลงแล้วได้เลย — และยังมีนิยามอยู่ที่เดียวเหมือนเดิม */

// ตัดทุกอย่างหลัง ',' หรือ '/' ออก → ได้ ID แกนกลางของแผ่น (VARCHAR2 เพื่อให้ DISTINCT ได้)
const sqlNormPanel = (txt) => `UPPER(REGEXP_SUBSTR(${txt}, '^[^,/]+'))`

// ไม่ใช่แผ่นงาน — ตัดเฉพาะ 4 กรณีที่ยืนยันแล้ว (ทดสอบกับ qr-logs: ตัดออก 7 ID, เหลือแผ่นดี 5,463 ID ครบ)
const sqlIsJunkPanel = (norm) => `(
                         ${norm} LIKE 'DUMMY%'
                      OR REGEXP_LIKE(${norm}, 'M[0-9]{7}[A-Z][0-9]{4}')
                      OR REGEXP_LIKE(${norm}, '[^0-9A-Z]')
                      OR LENGTH(${norm}) < 10
                    )`

/* แถวที่อ่าน QR ไม่ได้ (null / ว่าง / Error / NULL) — ใช้เกณฑ์เดิม แต่ทำ UPPER ทุกที่ให้ครอบคลุม 'ERROR_' ตัวใหญ่
   หมายเหตุ: DBMS_LOB.SUBSTR ของ LOB ยาว 0 คืน NULL อยู่แล้ว ${txt} IS NULL จึงครอบคลุมทั้ง
   PANEL_ID IS NULL และ GETLENGTH = 0 ของเดิม (คง ${len} = 0 ไว้ด้วยเพื่อให้เจตนาชัด) */
const sqlIsUnread = (txt, len) => `(${txt} IS NULL
                        OR ${len} = 0
                        OR UPPER(SUBSTR(${txt}, 1, 5))  = 'ERROR'
                        OR UPPER(SUBSTR(${txt}, 1, 20)) LIKE '%NULL%')`

// นับ "แผ่น" ไม่ใช่ "แถว": OK = แผ่นงานจริงแบบไม่ซ้ำ, ERROR = จำนวนครั้งที่อ่านไม่ได้ (ซ้ำไม่ได้อยู่แล้ว)
const SQL_COUNT_OK  = `COUNT(DISTINCT CASE WHEN IS_REAL = 1 THEN NORM_PANEL END)`
const SQL_COUNT_ERR = `SUM(IS_UNREAD)`

/*
  ★ [FIX] CEID 10117 ไม่ใช่ event อ่านแผ่น
  ตรวจจาก DB จริง: 1,648 แถว/วัน บน 15 เครื่อง, DATAITEM01 = '1'..'6' (เลขพอร์ต),
  และ COUNT(DISTINCT PANEL_ID) = 0 ทุกกลุ่ม → PANEL_ID ว่างหมด
  ของเดิมนับแถวพวกนี้เป็น "อ่าน QR ไม่ได้" → กด %QR ต่ำเกินจริง
  (เช่น GLD-IR-01-UL ได้ OK=0/ERR=24 = 0% ขณะที่ GLD-IR-01-L LOT เดียวกันได้ 40/0 = 100%)
*/
const SQL_IS_PANEL_EVENT = `(CEID IS NULL OR TO_CHAR(CEID) <> '10117')`

/*
  ★ [PERF] panelBaseSql() — บล็อกมาตรฐานที่คืน NORM_PANEL / IS_UNREAD / IS_REAL
  ให้ query ทุกเส้นใช้ร่วมกัน (แทน SQL_PANEL_FLAGS แบบชั้นเดียวของเดิม)

  ทำไมต้องเปลี่ยน — จาก tools/diagnose-poll-perf.js กับข้อมูลจริง:
      scan 140,854 แถว (24 ชม.) = 62ms      ← อ่านตารางแทบไม่มีต้นทุน
      aggregate                 = 14.7s     ← 99.6% ของเวลาอยู่ที่งานราย "แถว"
      คิดเป็น ~0.10 ms/แถว และโตเป็นเส้นตรง → 7 วัน ≈ 1M แถว ≈ 100 วินาที
  งานรายแถวนั้นคือการแตะ CLOB. ของเดิม SQL_PANEL_FLAGS ประเมินซ้ำทุกแถว:
      NORM_PANEL 5 ครั้ง (select list 1 + inline ในเช็ค junk อีก 4)
      IS_UNREAD  2 ครั้ง (ครั้งละ 3 DBMS_LOB call)
  รวม ~11 DBMS_LOB call + 5 REGEXP_SUBSTR ต่อแถว ทั้งที่ค่าที่ได้เหมือนกันหมด

  ของใหม่แบ่งเป็น 3 ชั้น ให้แต่ละค่าคำนวณ "ครั้งเดียว" แล้วส่งต่อเป็น VARCHAR2:
      ชั้นใน   DBMS_LOB.SUBSTR / GETLENGTH  ครั้งเดียว → PANEL_TXT, PANEL_LEN
      ชั้นกลาง REGEXP_SUBSTR                ครั้งเดียว → NORM_PANEL, IS_UNREAD
      ชั้นนอก  เช็ค junk บน NORM_PANEL ที่มีอยู่แล้ว    → IS_REAL
  ตรรกะเท่าเดิมเป๊ะ:
      - DBMS_LOB.SUBSTR(PANEL_ID, 5|20, 1) เป็น prefix ของ (PANEL_ID, 100, 1) อยู่แล้ว
        จึงใช้ SUBSTR(PANEL_TXT, 1, 5|20) แทนได้ตรง ๆ
      - LOB ยาว 0 ทำให้ DBMS_LOB.SUBSTR คืน NULL → PANEL_TXT IS NULL ครอบคลุมทั้ง
        PANEL_ID IS NULL และ GETLENGTH = 0 (คง PANEL_LEN = 0 ไว้ด้วยเพื่อความชัดเจน)
  NO_MERGE กัน optimizer พับชั้นกลับเข้าหากันแล้วทำให้กลับไปคำนวณซ้ำเหมือนเดิม

  ★ ยืนยันตัวเลขก่อนเชื่อ: รัน `node tools/ab-panel-sql.js 1440` บนเครื่องที่ต่อ DB ได้
    มันเทียบ SQL เก่า/ใหม่บนหน้าต่างเดียวกัน แล้วบอกทั้ง "เร็วขึ้นกี่เท่า" และ
    "ตัวเลขตรงกันทุกเครื่องไหม" — ถ้าตัวเลขไม่ตรง ห้ามใช้

  cols  : array ของ [expr, alias] คอลัมน์ที่ต้องดึงจากตารางหลักและส่งผ่านออกมา
  where : เงื่อนไข WHERE ที่ใช้กับตารางหลัก (bind ใช้ชื่อ/หมายเลขได้ตามปกติ)
  withPanelText : ส่ง PANEL_TXT (100 ตัวแรกของ PANEL_ID เป็น VARCHAR2) ออกมาด้วย
                  สำหรับเส้นที่ต้องโชว์ ID ดิบ — ใช้แทนการลาก CLOB ผ่านทั้ง 3 ชั้น
*/
function panelBaseSql(cols, where, withPanelText) {
  const inner = cols.map(function(c) { return c[0] + ' AS ' + c[1] }).join(',\n                   ')
  const pass  = cols.map(function(c) { return c[1] }).join(', ')
  const txt   = withPanelText ? 'PANEL_TXT, ' : ''
  return `
        SELECT ${pass}, ${txt}NORM_PANEL, IS_UNREAD,
               CASE WHEN IS_UNREAD = 1 THEN 0
                    WHEN ${sqlIsJunkPanel('NORM_PANEL')} THEN 0
                    ELSE 1 END AS IS_REAL
        FROM (
          SELECT /*+ NO_MERGE */ ${pass}, ${txt}
                 ${sqlNormPanel('PANEL_TXT')} AS NORM_PANEL,
                 CASE WHEN ${sqlIsUnread('PANEL_TXT', 'PANEL_LEN')}
                      THEN 1 ELSE 0 END AS IS_UNREAD
          FROM (
            SELECT /*+ NO_MERGE */
                   ${inner},
                   DBMS_LOB.SUBSTR(PANEL_ID, 100, 1) AS PANEL_TXT,
                   DBMS_LOB.GETLENGTH(PANEL_ID)      AS PANEL_LEN
            FROM PAEAPTRACE.EAP_EQP_EVENT_PNL_PNL
            WHERE ${where}
          )
        )`
}

/*
  ★ [FIX] Total Sheet นับ "ต่อ LOT" ไม่ใช่ 24 ชม.
  วัดจาก DB จริง (LOT ที่จบแล้ว 45 LOT): ต่อ LOT กลมเป๊ะ 40/60/80 = 19/45 LOT (42%)
  ส่วนแบบ 24 ชม. กลม 6/102 เครื่อง (5.9%) ซึ่งเท่ากับความบังเอิญ — คร่อมหลาย LOT เลยไม่มีทางกลม
  ถ้าเครื่องไหนยังไม่มี LOT (BL เป็น null) ค่อย fallback ไปใช้ยอด 24 ชม. ของเดิม
*/
const SQL_SHEET_OK  = `COALESCE(BL.LOT_OK_PANELS, P.OK_PANELS)`
const SQL_SHEET_ERR = `COALESCE(BL.LOT_ERROR_COUNT, P.ERROR_COUNT)`
const SQL_PCT_QR = `
        CASE WHEN NVL(${SQL_SHEET_OK}, 0) + NVL(${SQL_SHEET_ERR}, 0) = 0 THEN 0
             ELSE ROUND(NVL(${SQL_SHEET_OK}, 0) * 100.0
                        / (NVL(${SQL_SHEET_OK}, 0) + NVL(${SQL_SHEET_ERR}, 0)), 2)
        END`

async function fetchLotReport(days = 7) {
  let p = await getPool()
  let conn
  try {
    conn = await p.getConnection()
  } catch (e) {
    // ★ Pool พัง → สร้างใหม่
    console.warn('[DB] Pool broken, recreating...', e.message)
    pool = null
    p = await getPool()
    conn = await p.getConnection()
  }
  /* ★ [FIX] เพดานเวลาฝั่ง API — กัน query ช่วงยาวจอง connection ค้างจนเต็ม pool */
  conn.callTimeout = apiTimeoutForDays('lot-report', days)
  try {
    const sql = `
      WITH panel_read AS (
          SELECT
              MAIN_EQP_ID,
              SUB_EQP_NAME,
              SUB_EQP_ID,
              LOT_ID,
              DATE_TIME,
              /* ★ [FIX] เดิม PARTITION BY LOT_ID, PANEL_ID เฉยๆ → แผ่นเดียวกันที่ผ่านทั้ง -L และ -UL
                 ถูกตัดทิ้งไปฝั่งหนึ่ง ทำให้เครื่องปลายทางนับได้น้อยกว่าจริง จึงต้องแยกตามเครื่องด้วย
                 และ dedup ด้วย ID ที่ normalize แล้ว (ตัด ",BD" / "/0" ออก) */
              ROW_NUMBER() OVER (
                  PARTITION BY SUB_EQP_ID, LOT_ID, NORM_PANEL
                  ORDER BY DATE_TIME
              ) AS rn
          FROM (
${panelBaseSql([
            ['MAIN_EQP_ID', 'MAIN_EQP_ID'],
            ['SUB_EQP_NAME', 'SUB_EQP_NAME'],
            ['SUB_EQP_ID', 'SUB_EQP_ID'],
            ['LOT_ID', 'LOT_ID'],
            ['DATE_TIME', 'DATE_TIME']
          ], `(SUB_EQP_ID LIKE '%-L'  OR  SUB_EQP_ID LIKE '%-UL')
              /* ★ [FIX] ตัด event ที่ไม่ใช่การอ่านแผ่น */
              AND ${SQL_IS_PANEL_EVENT}
              AND DATE_TIME >= SYSDATE - :1`)}
          )
          /* ★ IS_REAL = 1 คือ "อ่าน QR ได้ และไม่ใช่ dummy/jig/สแกนเพี้ยน"
             ตรงกับเงื่อนไขเดิม NOT IS_UNREAD AND NOT IS_JUNK ทุกประการ
             ต่างกันแค่ค่านี้ถูกคำนวณไว้ครั้งเดียวในชั้นล่าง ไม่ใช่ 7 ครั้งต่อแถว */
          WHERE IS_REAL = 1
      ),
      lot_summary AS (
          SELECT
              MAIN_EQP_ID,
              SUB_EQP_NAME,
              SUB_EQP_ID,
              LOT_ID,
              COUNT(*)       AS total_panel_qty,
              MIN(DATE_TIME) AS lot_start_time,
              MAX(DATE_TIME) AS lot_end_time
          FROM panel_read
          WHERE rn = 1
          GROUP BY MAIN_EQP_ID, SUB_EQP_NAME, SUB_EQP_ID, LOT_ID
      ),
      lot_bounds AS (
          SELECT MIN(lot_start_time) AS global_start, MAX(lot_end_time) AS global_end
          FROM lot_summary
      ),
      eqp_list AS (
          SELECT DISTINCT MAIN_EQP_ID, SUB_EQP_ID FROM lot_summary
      ),
      alm_pre AS (
          SELECT 
              a.MAIN_EQP_ID, a.SUB_EQP_ID, a.DATE_TIME,
              a.ALARM_TEXT, a.ALARM_CATEGORY, a.EQP_STATUS
          FROM PAEAPTRACE.EAP_EQP_ALM a
          CROSS JOIN lot_bounds b
          JOIN eqp_list e
              ON  e.MAIN_EQP_ID = a.MAIN_EQP_ID
              AND e.SUB_EQP_ID  = a.SUB_EQP_ID
          WHERE a.EQP_STATUS = 'DOWN'
            AND a.DATE_TIME >= b.global_start
            AND a.DATE_TIME <= b.global_end
      )
      SELECT
          ls.MAIN_EQP_ID, ls.SUB_EQP_NAME, ls.SUB_EQP_ID, ls.LOT_ID,
          ls.total_panel_qty, ls.lot_start_time, ls.lot_end_time,
          alm.ALARM_TEXT, alm.ALARM_CATEGORY,
          alm.EQP_STATUS AS alarm_status, alm.DATE_TIME AS alarm_time
      FROM lot_summary ls
      LEFT JOIN alm_pre alm
             ON  alm.MAIN_EQP_ID = ls.MAIN_EQP_ID
             AND alm.SUB_EQP_ID  = ls.SUB_EQP_ID
             AND alm.DATE_TIME BETWEEN ls.lot_start_time AND ls.lot_end_time
      ORDER BY ls.MAIN_EQP_ID, ls.LOT_ID, alm.DATE_TIME
    `
    const result = await conn.execute(sql, [days], {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
    })
    return result.rows
  } finally {
    await conn.close()
  }
}

// ─── SQL Query: ดึงรายชื่อเครื่องจักรทั้งหมดจาก DB ───
async function fetchAllMachines() {
  const p = await getPool()
  const conn = await p.getConnection()
  /* ★ [FIX] เพดานเวลาฝั่ง API — กัน query ช่วงยาวจอง connection ค้างจนเต็ม pool */
  conn.callTimeout = apiTimeoutFor('machines', null)
  try {
    const sql = `
      SELECT DISTINCT
        COALESCE(SUB_EQP_ID, MAIN_EQP_ID) AS MACHINE_ID,
        SUB_EQP_NAME AS MACHINE_NAME,
        SUB_EQP_NAME
      FROM PAEAPTRACE.EAP_EQP_EVENT_PNL_PNL
      WHERE DATE_TIME >= SYSDATE - 1/24
      ORDER BY MACHINE_ID
    `
    const result = await conn.execute(sql, [], { outFormat: oracledb.OUT_FORMAT_OBJECT })
    return result.rows
  } finally {
    await conn.close()
  }
}

let loggedFirstPollTiming = false

// ─── SQL Query ───
 async function fetchLatestMachineStates() {
  const p = await getPool()
  const conn = await p.getConnection()
  /* ★ [FIX] ให้ Oracle ยกเลิก query เองถ้าเกินเวลา — ไม่งั้น connection ค้างอยู่ใน pool (poolMax=3)
     ค้างครบ 3 เส้นเมื่อไหร่ API ทุกเส้นตายหมด */
  conn.callTimeout = POLL_TIMEOUT_MS
  try {
    const sql = `
      WITH latest_status AS (
        SELECT
          COALESCE(SUB_EQP_ID, MAIN_EQP_ID) AS MACHINE_ID,
          SUB_EQP_NAME,
          DATE_TIME      AS EVENT_TIME,
          PRODUCTMODE    AS MACHINE_MODE,
          EQPSTATUS      AS MACHINE_STATUS,
          LOT_ID AS LOT_ID,
          PANEL_ID       AS LAST_PANEL_ID,
          DATE_TIME      AS PANEL_TIME,
          ROW_NUMBER() OVER (PARTITION BY COALESCE(SUB_EQP_ID, MAIN_EQP_ID) ORDER BY DATE_TIME DESC) AS rn
        FROM PAEAPTRACE.EAP_EQP_EVENT_PNL_PNL
        /* ★ [FIX] เดิมฮาร์ดโค้ด 1440/1440 (= 24 ชม.) ทั้งที่ .env ตั้ง POLL_MINUTES ไว้
           และ banner ตอน start ก็ประกาศว่า "Lookback: 15 min" — ค่านั้นไม่เคยถูกใช้เลย
           ผลคือทุก ๆ 3 วินาที Oracle ต้อง ROW_NUMBER() เรียงข้อมูลทั้ง 24 ชม.
           เพื่อเอาแค่แถวล่าสุดของแต่ละเครื่อง (WHERE rn = 1) จนชน call timeout
           ส่วนนี้ต้องการแค่ "เครื่องที่เพิ่งเดินใน POLL_MINUTES ล่าสุด" พอ
           เครื่องที่เงียบเกินช่วงนี้จะไม่ถูกคืนมา แล้วโค้ดข้างล่างจะ mark เป็น
           NO_DATA ให้เอง — ตรงกับที่ .env อธิบาย STALE_MINUTES ไว้ */
        WHERE DATE_TIME >= SYSDATE - ${POLL_MINUTES}/1440
      ),
      -- ★ [FIX] normalize PANEL_ID + คัด dummy/jig ครั้งเดียว แล้วใช้ต่อทั้ง panel_stats และ lot_panel_stats
      panel_base AS (
        -- ★ ยอดสะสม ยังต้องมองย้อนหลังยาว แต่ปรับได้จาก .env แล้ว (ดู PANEL_STATS_MINUTES)
${panelBaseSql([
        ['COALESCE(SUB_EQP_ID, MAIN_EQP_ID)', 'MACHINE_ID'],
        ['LOT_ID', 'LOT_ID'],
        ['DATE_TIME', 'DATE_TIME']
      ], `DATE_TIME >= SYSDATE - ${PANEL_STATS_MINUTES}/1440
              AND ${SQL_IS_PANEL_EVENT}`)}
      ),
      panel_stats AS (
        -- ★ ยอด 24 ชม. — ตอนนี้ใช้เป็น fallback เฉพาะเครื่องที่ยังไม่มี LOT เท่านั้น
        SELECT
          MACHINE_ID,
          ${SQL_COUNT_OK}  AS OK_PANELS,
          ${SQL_COUNT_ERR} AS ERROR_COUNT,
          MIN(DATE_TIME) AS FIRST_EVENT_TIME,
          MAX(DATE_TIME) AS LAST_EVENT_TIME
        FROM panel_base
        GROUP BY MACHINE_ID
      ),
      lot_panel_stats AS (
        -- ★ สำหรับ fallback: %QR + Total ของแต่ละ LOT
        SELECT
          MACHINE_ID,
          NVL(LOT_ID, '(no lot)') AS LOT_ID,
          ${SQL_COUNT_OK}  AS LOT_OK_PANELS,
          ${SQL_COUNT_ERR} AS LOT_ERROR_COUNT,
          MIN(DATE_TIME) AS LOT_START_TIME,
          MAX(DATE_TIME) AS LOT_END_TIME,
          -- ★ ล่าสุดของ LOT นี้ (ใช้เพื่อเรียงลำดั้ง fallback)
          MAX(DATE_TIME) AS LOT_LAST_EVENT
        FROM panel_base
        WHERE LOT_ID IS NOT NULL
        GROUP BY MACHINE_ID, NVL(LOT_ID, '(no lot)')
      ),
      best_lot AS (
        -- ★ เลือก LOT ที่ดีที่สุดสำหรับแสดงผล %QR
        -- กฏ: ถ้า LOT ปัจจุบันมี panel → ใช้ LOT ปัจจุบัน
        --      ถ้า LOT ปัจจุบันยังไม่มี panel → ใช้ LOT ล่าสุดที่มี panel
        SELECT MACHINE_ID, LOT_ID, LOT_OK_PANELS, LOT_ERROR_COUNT, LOT_START_TIME, LOT_END_TIME,
               CASE WHEN LOT_ID = MAX(LOT_ID) OVER (PARTITION BY MACHINE_ID) THEN 0 ELSE 1 END AS IS_FALLBACK_LOT
        FROM (
          SELECT MACHINE_ID, LOT_ID, LOT_OK_PANELS, LOT_ERROR_COUNT, LOT_START_TIME, LOT_END_TIME, LOT_LAST_EVENT,
                 ROW_NUMBER() OVER (
                   PARTITION BY MACHINE_ID
                   ORDER BY
                     CASE WHEN LOT_OK_PANELS + LOT_ERROR_COUNT > 0 THEN 0 ELSE 1 END,
                     LOT_LAST_EVENT DESC
                 ) AS rn
          FROM lot_panel_stats
        ) WHERE rn = 1
      )
      SELECT
        E.MACHINE_ID,
        E.SUB_EQP_NAME AS MACHINE_NAME,
        E.EVENT_TIME,
        E.MACHINE_MODE,
        E.MACHINE_STATUS,
        -- ★ แสดง LOT_ID ของ best_lot (อาจเป็น LOT ปัจจุบันหรือ LOT ก่อนหน้า)
        COALESCE(BL.LOT_ID, E.LOT_ID) AS LOT_ID,
        COALESCE(BL.IS_FALLBACK_LOT, 0) AS IS_FALLBACK_LOT,
        M.SPEC_NAME     AS JOB_NAME,
        -- ★ [FIX] Total Sheet + %QR ของ "LOT ที่กำลังรัน" (เดิมรวมทุก LOT ใน 24 ชม. เลยไม่มีทางเป็นเลขกลม)
        ${SQL_SHEET_OK}  AS TOTAL_SHEET,
        ${SQL_SHEET_ERR} AS ERROR_SHEET,
        -- ★ LOT_START/END_TIME จาก best_lot (ถ้ามี) หรือ fallback จาก panel_stats
        COALESCE(BL.LOT_START_TIME, P.FIRST_EVENT_TIME, E.EVENT_TIME) AS LOT_START_TIME,
        COALESCE(BL.LOT_END_TIME, P.LAST_EVENT_TIME, E.EVENT_TIME)   AS LOT_END_TIME,
${SQL_PCT_QR}    AS PCT_QR,
        E.LAST_PANEL_ID,
        E.PANEL_TIME,
        A.ALARM_TEXT     AS ALARM_TEXT,
        A.ALARM_CATEGORY AS ALARM_CATEGORY,
        A.ALARM_TIME     AS ALARM_TIME,
        T.PN             AS PRODUCT_ID
      FROM latest_status E
      LEFT JOIN panel_stats P
        ON P.MACHINE_ID = E.MACHINE_ID
      LEFT JOIN best_lot BL
        ON BL.MACHINE_ID = E.MACHINE_ID
      LEFT JOIN (
        SELECT COALESCE(SUB_EQP_ID, MAIN_EQP_ID) AS MACHINE_ID, ALARM_TEXT, ALARM_CATEGORY,
               DATE_TIME AS ALARM_TIME,
               ROW_NUMBER() OVER (PARTITION BY COALESCE(SUB_EQP_ID, MAIN_EQP_ID) ORDER BY DATE_TIME DESC) AS rn
        FROM PAEAPTRACE.EAP_EQP_ALM
        WHERE DATE_TIME >= SYSDATE - 30/1440
      ) A ON A.MACHINE_ID = E.MACHINE_ID
         AND A.rn = 1
      LEFT JOIN (
        SELECT COALESCE(SUB_EQP_ID, MAIN_EQP_ID) AS MACHINE_ID, PN,
               ROW_NUMBER() OVER (PARTITION BY COALESCE(SUB_EQP_ID, MAIN_EQP_ID) ORDER BY DATE_TIME DESC) AS rn
        FROM PAEAPTRACE.EAP_EQP_TRACE
        WHERE DATE_TIME >= SYSDATE - 30/1440
          AND PN IS NOT NULL
      ) T ON T.MACHINE_ID = E.MACHINE_ID
         AND T.rn = 1
      LEFT JOIN DWD_PA01_PRD.LOTINFO_MAIN M
        ON M.LOT_NAME = E.LOT_ID
      WHERE E.rn = 1
      ORDER BY E.EVENT_TIME DESC
    `
    /* ★ [FIX] จับเวลา query ไว้ — ตอน NJS-123 เด้ง log บอกแค่ว่า "เกิน 15 วิ"
       ไม่บอกว่าปกติใช้กี่วิ เลยไม่รู้ว่าใกล้ชนเพดานแค่ไหน หรือแก้แล้วดีขึ้นจริงไหม */
    const t0 = Date.now()
    const result = await conn.execute(sql, [], {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
    })
    const ms = Date.now() - t0
    if (ms >= SLOW_QUERY_WARN_MS) {
      console.warn(`[Poll] SLOW query: ${ms}ms (${result.rows.length} rows) - limit is ${POLL_TIMEOUT_MS}ms`)
      console.warn(`[Poll]   If close to the limit, lower PANEL_STATS_MINUTES in .env (now ${PANEL_STATS_MINUTES} min)`)
    } else if (!loggedFirstPollTiming) {
      // log รอบแรกที่สำเร็จเสมอ เพื่อให้มีค่าอ้างอิงไว้เทียบตอนมีปัญหา
      loggedFirstPollTiming = true
      console.log(`[Poll] first query took ${ms}ms (${result.rows.length} rows)`)
    }
    return result.rows.map(normalizeRow)
  } finally {
    await conn.close()
  }
}

function normalizeRow(row) {
  return {
    machine_id: String(row.MACHINE_ID || ''),
    machine_name: String(row.MACHINE_NAME || row.MACHINE_ID || ''),
    event_time: row.EVENT_TIME || null,
    machine_mode: String(row.MACHINE_MODE || 'UNKNOWN'),
    status: String(row.MACHINE_STATUS || 'UNKNOWN').toUpperCase(),
    lot_id: row.LOT_ID || null,
    is_fallback_lot: parseInt(row.IS_FALLBACK_LOT) || 0,
    job_name: row.JOB_NAME || null,
    total_sheet: parseInt(row.TOTAL_SHEET) || 0,
    error_sheet: parseInt(row.ERROR_SHEET) || 0,
    pct_qr: parseFloat(row.PCT_QR) || 0,
    alarm_text: row.ALARM_TEXT || null,
    alarm_category: row.ALARM_CATEGORY || null,
    alarm_time: row.ALARM_TIME || null,
    product_id: row.PRODUCT_ID || null,
    // [QR History] map fields so broadcast sends real values (not undefined)
    last_panel_id: row.LAST_PANEL_ID || null,
    panel_time:    row.PANEL_TIME    || null,
    // [LOT times] เวลาเริ่ม-จบ LOT ปัจจุบัน
    lot_start_time: row.LOT_START_TIME || null,
    lot_end_time:   row.LOT_END_TIME   || null,
    /* ★ [Day totals] ยอดรวมทั้งวัน (ทุก LOT) — มีเฉพาะ /api/machine-history
       โหมด live จะเป็น null → frontend ใช้ยอดต่อ LOT เหมือนเดิม */
    day_total_sheet: row.DAY_TOTAL_SHEET != null ? (parseInt(row.DAY_TOTAL_SHEET) || 0) : null,
    day_error_sheet: row.DAY_ERROR_SHEET != null ? (parseInt(row.DAY_ERROR_SHEET) || 0) : null,
    day_pct_qr:      row.DAY_PCT_QR      != null ? (parseFloat(row.DAY_PCT_QR)  || 0) : null,
    day_lot_count:   row.DAY_LOT_COUNT   != null ? (parseInt(row.DAY_LOT_COUNT) || 0) : null,
  }
}

// ─── SQL: QR history ของเครื่องเดียว ────────
function fillLotIds(rows) {
  // rows มาเรียง DESC (ล่าสุดก่อน) เราจะทำงานกับเวลาจริง (ASC)
  var sorted = rows.slice().sort(function(a, b) {
    return (a.DATE_TIME || 0) - (b.DATE_TIME || 0)
  })
  function hasLot(r) {
    var lot = r.LOT_ID
    return lot && lot !== '(no lot)' && String(lot).trim() !== ''
  }
  // Pass 1: Forward-fill (อดีต → ปัจจุบัน)
  var lastLot = null
  for (var i = 0; i < sorted.length; i++) {
    if (hasLot(sorted[i])) {
      lastLot = sorted[i].LOT_ID
    } else if (lastLot) {
      // ไม่มี LOT → เช็คแผ่นถัดไปก่อนว่าเป็น LOT ใหม่ไหม
      var nextLot = null
      if (i + 1 < sorted.length && hasLot(sorted[i + 1])) {
        nextLot = sorted[i + 1].LOT_ID
      }
      if (nextLot && nextLot !== lastLot) {
        // แผ่นถัดไปเป็น LOT ใหม่ → ใช้ LOT ใหม่ (back-fill)
        sorted[i].LOT_ID = nextLot
        lastLot = nextLot
      } else {
        // ใช้ LOT เดิม (forward-fill)
        sorted[i].LOT_ID = lastLot
      }
    }
  }
  // Pass 2: Back-fill (ปัจจุบัน → อดีต) สำหรับแผ่นแรกสุดที่ยังไม่มี LOT
  for (var j = sorted.length - 1; j >= 0; j--) {
    if (!hasLot(sorted[j])) {
      if (j + 1 < sorted.length && hasLot(sorted[j + 1])) {
        sorted[j].LOT_ID = sorted[j + 1].LOT_ID
      }
    }
  }
  return sorted.reverse()
}

async function fetchQrHistory(machineId, range, limit, offset, startStr, endStr) {
  // ★ หาช่วงเวลาก่อนขอ connection — เพดานเวลาขึ้นกับว่าขอย้อนหลังกี่วัน
  const r = startStr || endStr ? getDateRangeFromParams(startStr, endStr) : getDateRange(range)
  const p = await getPool()
  const conn = await p.getConnection()
  /* ★ [FIX] เพดานเวลาฝั่ง API — กัน query ช่วงยาวจอง connection ค้างจนเต็ม pool */
  conn.callTimeout = apiTimeoutFor('qr-history', r)
  try {
    var binds = { start_date: r.start, end_date: r.end, machine1: machineId, machine2: machineId }
    var limitClause = ''
    if (limit && limit > 0) {
      limitClause = ' AND ROWNUM <= :row_limit'
      binds.row_limit = parseInt(limit) + parseInt(offset || 0)
    }
    const sql = `
      SELECT * FROM (
        SELECT MACHINE_ID, LOT_ID,
               /* ★ PANEL_TXT = 100 ตัวแรกของ PANEL_ID ที่ชั้นในแปลงเป็น VARCHAR2 ไว้แล้ว
                  panel id จริงสั้นกว่านี้มาก และตรงนี้เอาไปโชว์เฉย ๆ จึงไม่ต้องลาก CLOB ต่อ */
               PANEL_TXT AS PANEL_ID, DATE_TIME,
               1 - IS_UNREAD AS IS_READ,
               NORM_PANEL, IS_UNREAD, IS_REAL
        FROM (
${panelBaseSql([
        ['COALESCE(SUB_EQP_ID, MAIN_EQP_ID)', 'MACHINE_ID'],
        ["NVL(LOT_ID, '(no lot)')", 'LOT_ID'],
        ['DATE_TIME', 'DATE_TIME']
      ], `DATE_TIME >= :start_date
              AND DATE_TIME <= :end_date
              /* ★ [FIX] ย้าย filter เครื่องเข้ามาใน subquery
                 เดิมกรองอยู่ข้างนอก → inner query สแกน panel ของ "ทุกเครื่อง" ทั้งช่วงเวลา
                 แล้วค่อย sort ทำให้วันย้อนหลัง (ข้อมูลเต็ม 24 ชม.) ช้าจนหมดเวลา */
              AND (SUB_EQP_ID = :machine1 OR (SUB_EQP_ID IS NULL AND MAIN_EQP_ID = :machine2))
              AND ${SQL_IS_PANEL_EVENT}`, true)}
        )
        ORDER BY DATE_TIME DESC
      )
      WHERE 1 = 1
        ${limitClause}
    `
    const result = await conn.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT })
    var rows = result.rows || []
    // apply offset (manual since we use ROWNUM)
    if (offset && offset > 0) rows = rows.slice(offset)
    // ★ Fill LOT_ID (forward-fill + back-fill)
    rows = fillLotIds(rows)
    // group by LOT_ID
    var lotsMap = new Map()
    var totalOk = 0, totalErr = 0
    // ★ [FIX] นับ "แผ่น" ไม่ใช่ "แถว" — กันแผ่นเดิมที่ถูกบันทึกซ้ำ (เช่น ...001001 กับ ...001001/0)
    var seenPanels = new Set()
    rows.forEach(function(r) {
      var isUnread = r.IS_READ !== 1
      var isReal = r.IS_REAL === 1
      // แผ่น dummy / jig / สแกนเพี้ยน → ไม่นับ (แต่ยังแสดงในลิสต์ พร้อม flag)
      var isDummy = !isUnread && !isReal
      // แผ่นงานจริงที่เคยเจอแล้วในช่วงเวลานี้ → ข้ามทั้งแถว
      if (isReal) {
        if (seenPanels.has(r.NORM_PANEL)) return
        seenPanels.add(r.NORM_PANEL)
      }
      var lotId = r.LOT_ID || '(no lot)'
      if (!lotsMap.has(lotId)) {
        lotsMap.set(lotId, { lot_id: lotId, panels: [], ok_count: 0, err_count: 0 })
      }
      var lot = lotsMap.get(lotId)
      // ★ compute lot_start_time (oldest) and lot_end_time (newest)
      if (!lot.lot_start_time || r.DATE_TIME < lot.lot_start_time) lot.lot_start_time = r.DATE_TIME
      if (!lot.lot_end_time || r.DATE_TIME > lot.lot_end_time) lot.lot_end_time = r.DATE_TIME
      lot.panels.push({
        panel_id: r.PANEL_ID,
        time: r.DATE_TIME,
        is_error: isUnread,
        is_dummy: isDummy
      })
      if (isDummy) return
      if (isUnread) { lot.err_count++; totalErr++ } else { lot.ok_count++; totalOk++ }
    })
    var lots = Array.from(lotsMap.values()).sort(function(a, b) {
      // sort by latest panel time desc
      var at = a.panels[0] ? a.panels[0].time : 0
      var bt = b.panels[0] ? b.panels[0].time : 0
      return bt - at
    })
    return {
      machine_id: machineId,
      range: range,
      label: r.label,
      lots: lots,
      summary: {
        total_panels: totalOk + totalErr,
        ok: totalOk,
        err: totalErr,
        pct_qr: (totalOk + totalErr) > 0 ? Math.round(totalOk * 1000 / (totalOk + totalErr)) / 10 : 0
      }
    }
  } finally {
    await conn.close()
  }
}

// ─── SQL: % QR หลายวันของเครื่องเดียว (ตารางใน popup) ───────
async function fetchQrDaily(machineId, range, startStr, endStr) {
  // ★ หาช่วงเวลาก่อนขอ connection — เพดานเวลาขึ้นกับว่าขอย้อนหลังกี่วัน
  const r = startStr || endStr ? getDateRangeFromParams(startStr, endStr) : getDateRange(range)
  const p = await getPool()
  const conn = await p.getConnection()
  /* ★ [FIX] เพดานเวลาฝั่ง API — กัน query ช่วงยาวจอง connection ค้างจนเต็ม pool */
  conn.callTimeout = apiTimeoutFor('qr-daily', r)
  try {
    const sql = `
      SELECT
        QR_DAY,
        MID,
        ${SQL_COUNT_OK} + ${SQL_COUNT_ERR} AS TOTAL_CNT,
        ${SQL_COUNT_ERR} AS ERR_CNT,
        ${SQL_COUNT_OK}  AS OK_CNT
      FROM (
${panelBaseSql([
        ['TRUNC(DATE_TIME)', 'QR_DAY'],
        ['COALESCE(SUB_EQP_ID, MAIN_EQP_ID)', 'MID']
      ], `DATE_TIME >= :start_date
              AND DATE_TIME <= :end_date
              /* ★ [PERF] filter เครื่องต้องอยู่ "ในสุด"
                 ของเดิมกรอง MID ไว้นอก GROUP BY → ต้อง normalize CLOB ของ
                 ทุกเครื่องทั้งช่วง แล้วค่อยทิ้งทุกเครื่องยกเว้นเครื่องเดียว
                 ช่วง 7/30 วันจึงช้าจนหมดเวลา ทั้งที่ต้องการข้อมูลเครื่องเดียว */
              AND (SUB_EQP_ID = :machine1 OR (SUB_EQP_ID IS NULL AND MAIN_EQP_ID = :machine2))
              AND ${SQL_IS_PANEL_EVENT}`)}
      )
      GROUP BY QR_DAY, MID
      ORDER BY QR_DAY DESC
    `
    const result = await conn.execute(sql, {
      start_date: r.start, end_date: r.end,
      machine1: machineId, machine2: machineId
    }, { outFormat: oracledb.OUT_FORMAT_OBJECT })
    var days = (result.rows || []).map(function(r) {
      var total = r.TOTAL_CNT || 0
      var ok = r.OK_CNT || 0
      var err = r.ERR_CNT || 0
      return {
        date: r.QR_DAY instanceof Date ? localDateStr(r.QR_DAY) : String(r.QR_DAY),
        total: total,
        ok: ok,
        err: err,
        pct_qr: total > 0 ? Math.round(ok * 1000 / total) / 10 : 0
      }
    })
    var grandTotal = days.reduce(function(s, d) { return s + d.total }, 0)
    var grandOk = days.reduce(function(s, d) { return s + d.ok }, 0)
    var grandErr = days.reduce(function(s, d) { return s + d.err }, 0)
    return {
      machine_id: machineId,
      range: range,
      label: r.label,
      days: days,
      grand_total: grandTotal,
      grand_ok: grandOk,
      grand_err: grandErr,
      grand_pct_qr: grandTotal > 0 ? Math.round(grandOk * 1000 / grandTotal) / 10 : 0
    }
  } finally {
    await conn.close()
  }
}

// ─── SQL: ประวัติสถานะเครื่องเดียวทั้งวัน ───────
const STATUS_HIST_CACHE_TTL_MS = 30 * 1000
const STATUS_HIST_CACHE_MAX = 100
const statusHistoryCache = new Map()

function statusHistCacheKey(machineId, range, startStr, endStr, alarmCategory) {
  /* ★ [FIX] ต้องรวม alarmCategory ด้วย ไม่งั้น cache ของ category หนึ่งจะไปทับอีก category */
  return machineId + '|' + (range || 'today') + '|' + (startStr || '') + '|' + (endStr || '') + '|' + (alarmCategory || 'all')
}

function getStatusHistCache(key) {
  const entry = statusHistoryCache.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) { statusHistoryCache.delete(key); return null }
  return entry.data
}

function setStatusHistCache(key, data) {
  if (statusHistoryCache.size >= STATUS_HIST_CACHE_MAX) {
    const firstKey = statusHistoryCache.keys().next().value
    if (firstKey) statusHistoryCache.delete(firstKey)
  }
  statusHistoryCache.set(key, { data: data, expiresAt: Date.now() + STATUS_HIST_CACHE_TTL_MS })
}

async function fetchStatusHistory(machineId, range, startStr, endStr, limit, offset, alarmCategory) {
  const r = startStr || endStr ? getDateRangeFromParams(startStr, endStr) : getDateRange(range)
  const almCat = alarmCategory || 'all'
  const cacheKey = statusHistCacheKey(machineId, range, startStr, endStr, almCat)
  const cached = getStatusHistCache(cacheKey)
  if (cached) {
    console.log('[StatusHist] ✓ CACHE HIT for ' + machineId)
    const lim = limit != null ? parseInt(limit, 10) : 50
    const off = offset != null ? parseInt(offset, 10) : 0
    return {
      ...cached,
      events: cached.events.slice(off, off + lim),
      total: cached.events.length,
      offset: off,
      limit: lim,
      cached: true
    }
  }
  const t0 = Date.now()
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
  const isLiveRange = r.end >= todayStart
  const snap = isLiveRange ? snapshot[machineId] : null
  var latestEvent = null
  if (snap) {
    latestEvent = {
      type: 'event',
      machine_id: snap.machine_id,
      machine_name: snap.machine_name,
      event_time: snap.event_time instanceof Date ? snap.event_time.toISOString() : (snap.event_time || new Date().toISOString()),
      status: snap.status,
      machine_mode: snap.machine_mode,
      lot_id: snap.lot_id || '(no lot)',
      total_sheet: snap.total_sheet,
      error_sheet: snap.error_sheet,
      pct_qr: snap.pct_qr,
      alarm_text: null,
      alarm_category: null,
      product_id: snap.product_id
    }
  }
  console.log('[StatusHist] ✓ Snapshot lookup for ' + machineId + ': ' + (latestEvent ? 'HIT' : 'MISS') + ' (live=' + isLiveRange + ', ' + (Date.now() - t0) + 'ms)')
  var events = latestEvent ? [latestEvent] : []
  const p = await getPool()
  const conn = await p.getConnection()
  /* ★ [FIX] เพดานเวลาฝั่ง API — กัน query ช่วงยาวจอง connection ค้างจนเต็ม pool */
  conn.callTimeout = apiTimeoutFor('status-history', r)
  try {
    if (!isLiveRange) {
      const evLimit = limit != null ? parseInt(limit, 10) : 50
      const evSql = `
        SELECT * FROM (
          SELECT
            DATE_TIME    AS EVENT_TIME,
            EQPSTATUS    AS MACHINE_STATUS,
            PRODUCTMODE  AS MACHINE_MODE,
            LOT_ID       AS LOT_ID
          FROM PAEAPTRACE.EAP_EQP_EVENT_PNL_PNL
          WHERE DATE_TIME >= :start_date
            AND DATE_TIME <= :end_date
            AND (SUB_EQP_ID = :machine_id1 OR (SUB_EQP_ID IS NULL AND MAIN_EQP_ID = :machine_id2))
          ORDER BY DATE_TIME DESC
        )
        WHERE ROWNUM <= :ev_limit
      `
      try {
        const evResult = await conn.execute(evSql, {
          start_date: r.start,
          end_date: r.end,
          machine_id1: machineId,
          machine_id2: machineId,
          ev_limit: evLimit
        }, { outFormat: oracledb.OUT_FORMAT_OBJECT })
        const evRows = (evResult.rows || []).map(function(row) {
          return {
            type: 'event',
            machine_id: machineId,
            machine_name: null,
            event_time: row.EVENT_TIME instanceof Date ? row.EVENT_TIME.toISOString() : String(row.EVENT_TIME),
            status: row.MACHINE_STATUS,
            machine_mode: row.MACHINE_MODE,
            lot_id: row.LOT_ID || '(no lot)',
            total_sheet: null,
            error_sheet: null,
            pct_qr: null,
            alarm_text: null,
            alarm_category: null,
            product_id: null
          }
        })
        events = events.concat(evRows)
        console.log('[StatusHist] historical events for ' + machineId + ' [' + r.label + ']: ' + evRows.length)
      } catch (evErr) {
        console.warn('[StatusHist] historical event query failed:', evErr.message)
      }
    }

    const almSql = `
      SELECT * FROM (
        SELECT
          'alarm' AS TYPE,
          NULL AS MACHINE_STATUS,
          NULL AS MACHINE_MODE,
          NULL AS LOT_ID,
          NULL AS TOTAL_SHEET,
          NULL AS ERROR_SHEET,
          NULL AS PCT_QR,
          NULL AS PRODUCT_ID,
          ALARM_TEXT,
          ALARM_CATEGORY,
          DATE_TIME AS EVENT_TIME
        FROM PAEAPTRACE.EAP_EQP_ALM
        WHERE DATE_TIME >= :start_date
          AND DATE_TIME <= :end_date
          AND (
            COALESCE(SUB_EQP_ID, MAIN_EQP_ID) = :machine_id1
            OR MAIN_EQP_ID = :machine_id2
            OR SUB_EQP_ID = :machine_id3
          )
          /* ★ Filter by alarm category if specified (K/P/G) */
          AND (:alm_category1 = 'all' OR ALARM_CATEGORY = :alm_category2)
        ORDER BY DATE_TIME DESC
      )
      WHERE ROWNUM <= :alm_limit
    `
    var alarms = []
    try {
      const almLimit = limit != null ? parseInt(limit, 10) : 50
      const almBinds = {
        start_date: r.start,
        end_date: r.end,
        machine_id1: machineId,
        machine_id2: machineId,
        machine_id3: machineId,
        alm_category1: almCat,
        alm_category2: almCat,
        alm_limit: almLimit
      }
      const almResult = await conn.execute(almSql, almBinds, { outFormat: oracledb.OUT_FORMAT_OBJECT })
      alarms = (almResult.rows || []).map(function(r) {
        return {
          type: 'alarm',
          event_time: r.EVENT_TIME instanceof Date ? r.EVENT_TIME.toISOString() : String(r.EVENT_TIME),
          status: 'ALARM',
          alarm_text: r.ALARM_TEXT,
          alarm_category: r.ALARM_CATEGORY,
          lot_id: null,
          machine_mode: null,
          total_sheet: null,
          error_sheet: null,
          pct_qr: null,
          product_id: null
        }
      })
    } catch(almErr) {
      console.warn('[StatusHist] alarm query failed:', almErr.message)
    }

    /* ★ รวม events + alarms เป็น list เดียว เรียงตามเวลา DESC */
    var allItems = events.concat(alarms)
    allItems.sort(function(a, b) {
      var at = new Date(a.event_time).getTime()
      var bt = new Date(b.event_time).getTime()
      return bt - at
    })

    var alarmsTotal = alarms.length
    console.log('[StatusHist] ' + machineId + ' [' + r.label + ']: ' + events.length + ' events, ' + alarmsTotal + ' alarms, total=' + (Date.now() - t0) + 'ms')

    const fullResult = {
      machine_id: machineId,
      range: range,
      label: r.label,
      total: allItems.length,
      events_count: events.length,
      alarms_total: alarmsTotal,
      events: allItems
    }
    // ★ [PERF] store in cache
    setStatusHistCache(cacheKey, fullResult)
    // Apply pagination
    const off = offset != null ? parseInt(offset, 10) : 0
    const paged = allItems.slice(off, off + (limit != null ? parseInt(limit, 10) : 50))
    return { ...fullResult, events: paged, offset: off, cached: false }
  } finally {
    await conn.close()
  }
}


/* ★ [PERF] cache ผลสรุป %QR
   ช่วงยาว (7/30 วัน) ต่อให้ query เร็วขึ้นแล้วก็ยังกินเวลาหลายวินาที และหน้า report
   มี auto-refresh + ผู้ใช้กดสลับช่วงไปมา ทุกครั้งเดิมยิง query ใหม่หมด
   - ช่วงที่ "จบไปแล้ว" (end < ตอนนี้) ข้อมูลนิ่งแล้ว เก็บได้ยาว
   - ช่วงที่มีวันนี้อยู่ด้วย ข้อมูลยังวิ่ง เก็บสั้น ๆ พอกัน refresh ซ้ำ */
const QR_SUMMARY_CACHE_MAX = 50
const QR_SUMMARY_TTL_LIVE_MS   = 60 * 1000       // ช่วงที่ยังมีวันนี้อยู่
const QR_SUMMARY_TTL_CLOSED_MS = 30 * 60 * 1000  // ช่วงที่จบไปแล้ว
const qrSummaryCache = new Map()

function getQrSummaryCache(key) {
  const entry = qrSummaryCache.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    qrSummaryCache.delete(key)
    return null
  }
  return entry.data
}

function setQrSummaryCache(key, data, ttlMs) {
  if (qrSummaryCache.size >= QR_SUMMARY_CACHE_MAX) {
    const firstKey = qrSummaryCache.keys().next().value
    if (firstKey) qrSummaryCache.delete(firstKey)
  }
  qrSummaryCache.set(key, { data: data, expiresAt: Date.now() + ttlMs })
}

async function fetchQrSummary(range, startStr, endStr) {
  // ★ ต้องรู้ช่วงเวลาก่อน ถึงจะเช็ค cache ได้ — key คือช่วงจริง ไม่ใช่ชื่อ range
  //   'week' ของวันนี้กับของเมื่อวานคนละช่วงกัน ส่วน custom ที่บังเอิญตรงกับ week ใช้ผลร่วมกันได้เลย
  const r = startStr || endStr ? getDateRangeFromParams(startStr, endStr) : getDateRange(range)
  const cacheKey = r.start.getTime() + '|' + r.end.getTime()
  const cached = getQrSummaryCache(cacheKey)
  if (cached) {
    console.log('[QrSummary] cache hit: ' + r.label)
    return { ...cached, cached: true }
  }

  const p = await getPool()
  const conn = await p.getConnection()
  /* ★ [FIX] ให้ Oracle ยกเลิกเองถ้าเกินเวลา — ไม่งั้น query ช่วงยาวจะจอง connection
     ค้างไว้จนครบ poolMax แล้ว API เส้นอื่น (รวมทั้ง poll) พลอยหมดเวลาตามไปด้วย */
  conn.callTimeout = apiTimeoutFor('qr-summary', r)
  try {
    const t0 = Date.now()
    const sql = `
      SELECT
        MACHINE_ID,
        MAX(MACHINE_NAME) AS MACHINE_NAME,
        ${SQL_COUNT_OK} + ${SQL_COUNT_ERR} AS TOTAL_CNT,
        ${SQL_COUNT_ERR} AS ERR_CNT,
        ${SQL_COUNT_OK}  AS OK_CNT
      FROM (
${panelBaseSql([
        ['COALESCE(SUB_EQP_ID, MAIN_EQP_ID)', 'MACHINE_ID'],
        ['SUB_EQP_NAME', 'MACHINE_NAME']
      ], `DATE_TIME >= :1
              AND DATE_TIME <= :2
              AND ${SQL_IS_PANEL_EVENT}`)}
      )
      GROUP BY MACHINE_ID
      ORDER BY TOTAL_CNT DESC
    `
    const result = await conn.execute(sql, [r.start, r.end], { outFormat: oracledb.OUT_FORMAT_OBJECT })
    var byMachine = (result.rows || []).map(function(r) {
      var total = r.TOTAL_CNT || 0
      var ok = r.OK_CNT || 0
      var err = r.ERR_CNT || 0
      return {
        machine_id: r.MACHINE_ID,
        machine_name: r.MACHINE_NAME || r.MACHINE_ID,
        total: total,
        ok: ok,
        err: err,
        pct_qr: total > 0 ? Math.round(ok * 1000 / total) / 10 : 0
      }
    })
    var grandTotal = byMachine.reduce(function(s, m) { return s + m.total }, 0)
    var grandOk = byMachine.reduce(function(s, m) { return s + m.ok }, 0)
    var grandErr = byMachine.reduce(function(s, m) { return s + m.err }, 0)
    console.log('[QrSummary] ' + r.label + ': ' + byMachine.length + ' machines, ' + (Date.now() - t0) + 'ms')
    const out = {
      range: range,
      label: r.label,
      overall: {
        total: grandTotal,
        ok: grandOk,
        err: grandErr,
        pct_qr: grandTotal > 0 ? Math.round(grandOk * 1000 / grandTotal) / 10 : 0,
        machine_count: byMachine.length
      },
      by_machine: byMachine
    }
    setQrSummaryCache(cacheKey, out, r.end.getTime() < Date.now() ? QR_SUMMARY_TTL_CLOSED_MS : QR_SUMMARY_TTL_LIVE_MS)
    return { ...out, cached: false }
  } finally {
    await conn.close()
  }
}

// ─── ดึงสถานะเครื่องย้อนหลังตามวันที่ ───
const MACHINE_HIST_CACHE_TTL_MS = 5 * 60 * 1000
const MACHINE_HIST_CACHE_MAX = 200
const machineHistoryCache = new Map()

function machineHistCacheKey(machineId, dateStr) {
  return machineId + '|' + (dateStr || '')
}

function getMachineHistCache(key) {
  const entry = machineHistoryCache.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    machineHistoryCache.delete(key)
    return null
  }
  return entry.data
}

function setMachineHistCache(key, data) {
  if (machineHistoryCache.size >= MACHINE_HIST_CACHE_MAX) {
    const firstKey = machineHistoryCache.keys().next().value
    if (firstKey) machineHistoryCache.delete(firstKey)
  }
  machineHistoryCache.set(key, { data: data, expiresAt: Date.now() + MACHINE_HIST_CACHE_TTL_MS })
}

async function fetchMachineHistory(machineId, dateStr) {
  // check cache ก่อน
  const cacheKey = machineHistCacheKey(machineId, dateStr)
  const cached = getMachineHistCache(cacheKey)
  if (cached) {
    console.log('[MachineHistory] cache hit:', cacheKey)
    return cached
  }

  const p = await getPool()
  const conn = await p.getConnection()
  /* ★ [FIX] เพดานเวลาฝั่ง API — กัน query ช่วงยาวจอง connection ค้างจนเต็ม pool */
  conn.callTimeout = apiTimeoutForDays('machine-history', 1)
  try {
    const r = getDateRangeFromParams(dateStr, dateStr)
    const sql = `
      WITH latest_status AS (
        SELECT
          COALESCE(SUB_EQP_ID, MAIN_EQP_ID) AS MACHINE_ID,
          SUB_EQP_NAME,
          DATE_TIME      AS EVENT_TIME,
          PRODUCTMODE    AS MACHINE_MODE,
          EQPSTATUS      AS MACHINE_STATUS,
          LOT_ID         AS LOT_ID,
          PANEL_ID       AS LAST_PANEL_ID,
          DATE_TIME      AS PANEL_TIME,
          ROW_NUMBER() OVER (PARTITION BY COALESCE(SUB_EQP_ID, MAIN_EQP_ID) ORDER BY DATE_TIME DESC) AS rn
        FROM PAEAPTRACE.EAP_EQP_EVENT_PNL_PNL
        WHERE DATE_TIME >= :ls_start
          AND DATE_TIME <= :ls_end
          AND (SUB_EQP_ID = :ls_machine1 OR (SUB_EQP_ID IS NULL AND MAIN_EQP_ID = :ls_machine2))
      ),
      -- ★ [FIX] normalize + คัด dummy/jig ครั้งเดียว (กฎเดียวกับ fetchLatestMachineStates)
      panel_base AS (
${panelBaseSql([
        ['COALESCE(SUB_EQP_ID, MAIN_EQP_ID)', 'MACHINE_ID'],
        ['LOT_ID', 'LOT_ID'],
        ['DATE_TIME', 'DATE_TIME']
      ], `DATE_TIME >= :ps_start
              AND DATE_TIME <= :ps_end
              AND (SUB_EQP_ID = :ps_machine1 OR (SUB_EQP_ID IS NULL AND MAIN_EQP_ID = :ps_machine2))
              AND ${SQL_IS_PANEL_EVENT}`)}
      ),
      panel_stats AS (
        SELECT
          MACHINE_ID,
          ${SQL_COUNT_OK}  AS OK_PANELS,
          ${SQL_COUNT_ERR} AS ERROR_COUNT,
          MIN(DATE_TIME) AS FIRST_EVENT_TIME,
          MAX(DATE_TIME) AS LAST_EVENT_TIME
        FROM panel_base
        GROUP BY MACHINE_ID
      ),
      lot_panel_stats AS (
        SELECT
          MACHINE_ID,
          NVL(LOT_ID, '(no lot)') AS LOT_ID,
          ${SQL_COUNT_OK}  AS LOT_OK_PANELS,
          ${SQL_COUNT_ERR} AS LOT_ERROR_COUNT,
          MIN(DATE_TIME) AS LOT_START_TIME,
          MAX(DATE_TIME) AS LOT_END_TIME,
          MAX(DATE_TIME) AS LOT_LAST_EVENT
        FROM panel_base
        WHERE LOT_ID IS NOT NULL
        GROUP BY MACHINE_ID, NVL(LOT_ID, '(no lot)')
      ),
      best_lot AS (
        SELECT MACHINE_ID, LOT_ID, LOT_OK_PANELS, LOT_ERROR_COUNT, LOT_START_TIME, LOT_END_TIME,
               CASE WHEN LOT_ID = MAX(LOT_ID) OVER (PARTITION BY MACHINE_ID) THEN 0 ELSE 1 END AS IS_FALLBACK_LOT
        FROM (
          SELECT MACHINE_ID, LOT_ID, LOT_OK_PANELS, LOT_ERROR_COUNT, LOT_START_TIME, LOT_END_TIME, LOT_LAST_EVENT,
                 ROW_NUMBER() OVER (
                   PARTITION BY MACHINE_ID
                   ORDER BY
                     CASE WHEN LOT_OK_PANELS + LOT_ERROR_COUNT > 0 THEN 0 ELSE 1 END,
                     LOT_LAST_EVENT DESC
                 ) AS rn
          FROM lot_panel_stats
        ) WHERE rn = 1
      ),
      -- ★ [FIX] โหมดดูย้อนหลัง: ต้องรู้จำนวน LOT ทั้งวันด้วย
      lot_count AS (
        SELECT MACHINE_ID, COUNT(*) AS LOT_COUNT
        FROM lot_panel_stats
        GROUP BY MACHINE_ID
      )
      SELECT
        E.MACHINE_ID,
        E.SUB_EQP_NAME AS MACHINE_NAME,
        E.EVENT_TIME,
        E.MACHINE_MODE,
        E.MACHINE_STATUS,
        COALESCE(BL.LOT_ID, E.LOT_ID) AS LOT_ID,
        COALESCE(BL.IS_FALLBACK_LOT, 0) AS IS_FALLBACK_LOT,
        M.SPEC_NAME     AS JOB_NAME,
        -- ★ [FIX] ต่อ LOT (กฎเดียวกับ fetchLatestMachineStates)
        ${SQL_SHEET_OK}  AS TOTAL_SHEET,
        ${SQL_SHEET_ERR} AS ERROR_SHEET,
        COALESCE(BL.LOT_START_TIME, P.FIRST_EVENT_TIME, E.EVENT_TIME) AS LOT_START_TIME,
        COALESCE(BL.LOT_END_TIME, P.LAST_EVENT_TIME, E.EVENT_TIME)   AS LOT_END_TIME,
${SQL_PCT_QR}    AS PCT_QR,
        /* ★ [FIX] ยอดรวม "ทั้งวัน" (ทุก LOT) — หน้าจอดูย้อนหลังใช้ตัวนี้ ไม่ใช่ยอดของ LOT เดียว */
        NVL(P.OK_PANELS, 0)   AS DAY_TOTAL_SHEET,
        NVL(P.ERROR_COUNT, 0) AS DAY_ERROR_SHEET,
        CASE WHEN NVL(P.OK_PANELS, 0) + NVL(P.ERROR_COUNT, 0) = 0 THEN 0
             ELSE ROUND(NVL(P.OK_PANELS, 0) * 100.0
                        / (NVL(P.OK_PANELS, 0) + NVL(P.ERROR_COUNT, 0)), 2)
        END AS DAY_PCT_QR,
        NVL(LC.LOT_COUNT, 0)  AS DAY_LOT_COUNT,
        E.LAST_PANEL_ID,
        E.PANEL_TIME,
        A.ALARM_TEXT     AS ALARM_TEXT,
        A.ALARM_CATEGORY AS ALARM_CATEGORY,
        A.ALARM_TIME     AS ALARM_TIME,
        T.PN             AS PRODUCT_ID
      FROM latest_status E
      LEFT JOIN panel_stats P
        ON P.MACHINE_ID = E.MACHINE_ID
      LEFT JOIN best_lot BL
        ON BL.MACHINE_ID = E.MACHINE_ID
      LEFT JOIN lot_count LC
        ON LC.MACHINE_ID = E.MACHINE_ID
      LEFT JOIN (
        SELECT COALESCE(SUB_EQP_ID, MAIN_EQP_ID) AS MACHINE_ID, ALARM_TEXT, ALARM_CATEGORY,
               DATE_TIME AS ALARM_TIME,
               ROW_NUMBER() OVER (PARTITION BY COALESCE(SUB_EQP_ID, MAIN_EQP_ID) ORDER BY DATE_TIME DESC) AS rn
        FROM PAEAPTRACE.EAP_EQP_ALM
        WHERE DATE_TIME >= :alm_start
          AND DATE_TIME <= :alm_end
          AND (SUB_EQP_ID = :alm_machine1 OR (SUB_EQP_ID IS NULL AND MAIN_EQP_ID = :alm_machine2))
      ) A ON A.MACHINE_ID = E.MACHINE_ID
         AND A.rn = 1
      LEFT JOIN (
        SELECT COALESCE(SUB_EQP_ID, MAIN_EQP_ID) AS MACHINE_ID, PN,
               ROW_NUMBER() OVER (PARTITION BY COALESCE(SUB_EQP_ID, MAIN_EQP_ID) ORDER BY DATE_TIME DESC) AS rn
        FROM PAEAPTRACE.EAP_EQP_TRACE
        WHERE DATE_TIME >= :trc_start
          AND DATE_TIME <= :trc_end
          AND (SUB_EQP_ID = :trc_machine1 OR (SUB_EQP_ID IS NULL AND MAIN_EQP_ID = :trc_machine2))
          AND PN IS NOT NULL
      ) T ON T.MACHINE_ID = E.MACHINE_ID
         AND T.rn = 1
      LEFT JOIN DWD_PA01_PRD.LOTINFO_MAIN M
        ON M.LOT_NAME = COALESCE(BL.LOT_ID, E.LOT_ID)
      WHERE E.rn = 1
    `
    const binds = {
      ls_start: r.start,  ls_end: r.end,  ls_machine1: machineId,  ls_machine2: machineId,   // latest_status
      ps_start: r.start,  ps_end: r.end,  ps_machine1: machineId,  ps_machine2: machineId,   // panel_base (ใช้ร่วม panel_stats + lot_panel_stats)
      alm_start: r.start, alm_end: r.end, alm_machine1: machineId, alm_machine2: machineId,  // alarm join
      trc_start: r.start, trc_end: r.end, trc_machine1: machineId, trc_machine2: machineId,  // product/trace join
    }
    const t0 = Date.now()
    const result = await conn.execute(sql, binds, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
    })
    const elapsed = Date.now() - t0
    const rows = (result.rows || []).map(normalizeRow)
    console.log('[MachineHistory] query ' + machineId + ' @ ' + dateStr + ' took ' + elapsed + 'ms, rows=' + rows.length)

    const data = rows.length === 0
      ? { machine_id: machineId, date: dateStr, found: false, state: null, label: r.label }
      : { machine_id: machineId, date: dateStr, found: true, state: rows[0], label: r.label }

    // เก็บ cache (รวมผล not found — ไม่เปลี่ยนอยู่แล้ว)
    setMachineHistCache(cacheKey, data)
    return data
  } finally {
    await conn.close()
  }
}

// ─── Snapshot & Change Detection ──────────────────────
let snapshot = {}
let isPolling = false
let pollTimer = null
/* ★ [FIX] generation counter — ใช้ให้ watchdog ปลดล็อกได้อย่างปลอดภัย
   และทิ้งผลลัพธ์ของรอบที่ timeout ไปแล้ว ไม่ให้ข้อมูลเก่ามาทับข้อมูลใหม่ */
let pollGeneration = 0

function hasChanged(prev, curr) {
  if (!prev) return true
  return (
    prev.status !== curr.status ||
    prev.alarm_text !== curr.alarm_text ||
    prev.machine_mode !== curr.machine_mode ||
    prev.lot_id !== curr.lot_id ||
    prev.last_panel_id !== curr.last_panel_id
  )
}

async function poll() {
  if (isPolling) return
  isPolling = true
  const myGen = ++pollGeneration

  /* ★ [FIX] Watchdog "เตือนอย่างเดียว" — ห้ามปลดล็อก isPolling ตรงนี้เด็ดขาด
     ของเดิมมันปลดล็อกทิ้งทั้งที่ query เก่ายังวิ่งอยู่ใน Oracle อีก POLL_INTERVAL_MS
     ถัดมารอบใหม่ก็ไปหยิบ connection เส้นใหม่จาก pool (poolMax=3) ผลคือมี query
     24 ชม. ตัวหนักวิ่งพร้อมกันได้ถึง 3 เส้น แย่ง DB กันเอง ทุกเส้นเลยเกิน timeout
     → ช้าเกินเพดานแค่ "ครั้งเดียว" ระบบจะล็อกตัวเองตายถาวร ฟื้นเองไม่ได้เลย
     ตอนนี้กันการค้างด้วย conn.callTimeout + pool queueTimeout แทน ซึ่งการันตีว่า
     poll จะ settle เสมอ แล้ว scheduleNextPoll ค่อยตั้งรอบถัดไปหลังรอบนี้จบจริง */
  const watchdog = setTimeout(() => {
    if (pollGeneration === myGen && isPolling) {
      console.warn(`[Poll] ยังไม่จบใน ${POLL_TIMEOUT_MS}ms — รอบถัดไปจะเริ่มหลังรอบนี้จบ (ไม่ยิงซ้อน)`)
    }
  }, POLL_TIMEOUT_MS)

  try {
    const rows = await fetchLatestMachineStates()

    // ★ รอบนี้ timeout ไปแล้วและมีรอบใหม่เข้ามาแทน → ทิ้งผลเก่า อย่าเอาไปทับ snapshot ใหม่
    if (pollGeneration !== myGen) {
      console.warn('[Poll] รอบที่ timeout ไปแล้วเพิ่งตอบกลับ — ทิ้งผลลัพธ์')
      return
    }

    // Group by machine_id — เอา event ล่าสุด
    const latest = new Map()
    for (const r of rows) {
      // ★ Filter เฉพาะเครื่องที่กำหนด
      if (ALLOWED_MACHINES && !ALLOWED_MACHINES.includes((r.machine_id || '').toUpperCase())) continue
      if (/-M[12]$/.test(r.machine_id)) continue
      if (!latest.has(r.machine_id)) latest.set(r.machine_id, r)
    }

    const changed = []
    for (const [id, curr] of latest) {
      const prev = snapshot[id]
      if (hasChanged(prev, curr)) {
        // ★ [FIX] เก็บ panel เดิมไว้ด้วย — ใช้ตัดสินว่า "แผ่นเปลี่ยนจริงไหม" ตอนเขียน qr-log
        changed.push({ ...curr, prev_status: prev?.status || null, prev_panel_id: prev ? prev.last_panel_id : undefined })
      }
      snapshot[id] = { ...curr }
    }

    for (const [id, prev] of Object.entries(snapshot)) {
      if (latest.has(id)) continue            // ยัง active → ข้าม
      if (prev.status === 'NO_DATA') continue // อยู่ใน NO_DATA อยู่แล้ว → ข้าม
      const noData = {
        machine_id: id,
        machine_name: prev.machine_name || id,
        event_time: null,
        machine_mode: 'NO_DATA',
        status: 'NO_DATA',
        prev_status: prev.status,
        lot_id: null,
        is_fallback_lot: 0,
        job_name: null,
        total_sheet: 0,
        error_sheet: 0,
        pct_qr: 0,
        alarm_text: null,
        alarm_category: null,
        alarm_time: null,
        error_detail: null,
        product_id: null,
        last_panel_id: null,
        panel_time: null,
        lot_start_time: null,
        lot_end_time: null,
      }
      changed.push(noData)
      snapshot[id] = noData
    }

    if (changed.length > 0) {
      console.log(`[Poll] ${changed.length} machine(s) changed`)
      for (const m of changed) {
        broadcast({
          type: 'MACHINE_STATUS_CHANGE',
          severity: m.alarm_text ? 'critical' : m.status === 'DOWN' ? 'critical' : m.status === 'IDLE' ? 'info' : m.status === 'NO_DATA' ? 'no_data' : 'ok',
          timestamp: new Date().toISOString(),
          machine_id: m.machine_id,
          machine_name: m.machine_name,
          event_time: m.event_time,
          machine_mode: m.machine_mode,
          status: m.status,
          prev_status: m.prev_status,
          lot_id: m.lot_id,
        is_fallback_lot: m.is_fallback_lot,
          job_name: m.job_name,
          total_sheet: m.total_sheet,
          error_sheet: m.error_sheet,
          pct_qr: m.pct_qr,
          last_panel_id: m.last_panel_id,
          panel_time: m.panel_time,
          lot_start_time: m.lot_start_time,
          lot_end_time: m.lot_end_time,
          alarm_text: m.alarm_text,
          alarm_category: m.alarm_category,
          alarm_time: m.alarm_time,
          error_detail: m.error_detail,
          product_id: m.product_id,
        })
        // ★ Auto-log QR ลงไฟล์ CSV (บันทึกทุก panel รวม null/error/empty)
        /* ★ [FIX] เดิมเขียนทุกครั้งที่ hasChanged() เป็นจริง ซึ่งรวมกรณี status/alarm/mode เปลี่ยน
           → แผ่นเดิมถูกเขียนซ้ำหลายแถวด้วย timestamp เดียวกัน (พบขยะ 713 แถว จาก 8,606)
           ตอนนี้เขียนเฉพาะตอน panel เปลี่ยนจริงเท่านั้น */
        var panelIdForLog = m.last_panel_id || '';
        if (m.prev_panel_id === undefined || m.prev_panel_id !== m.last_panel_id) {
          var isErrorForLog = !panelIdForLog || String(panelIdForLog).indexOf('Error') === 0 || String(panelIdForLog).trim() === '' || /NULL/i.test(String(panelIdForLog));
          appendQrLog(m.machine_id, m.lot_id, panelIdForLog, isErrorForLog, m.panel_time || m.event_time)
        }
      }
    }

    // ★ [FIX] client ที่ต่อเข้ามาตอน snapshot ยังว่าง (ก่อน poll แรกเสร็จ) ถูกตั้ง _awaitingSnapshot ไว้
    for (const ws of clients) {
      if (ws._awaitingSnapshot) {
        ws._awaitingSnapshot = false
        try {
          ws.send(JSON.stringify({ type: 'SNAPSHOT', data: snapshot }))
        } catch { clients.delete(ws) }
      }
    }
  } catch (err) {
    console.error('[Poll] Error:', err.message)
  } finally {
    clearTimeout(watchdog)
    // ★ ปลดล็อกเฉพาะเจ้าของ lock ปัจจุบัน — รอบที่ timeout ไปแล้วห้ามไปปลดล็อกของรอบใหม่
    if (pollGeneration === myGen) isPolling = false
  }
}

let pollingStarted = false
function startPolling() {
  if (pollingStarted) return
  pollingStarted = true
  if (ALLOWED_MACHINES) {
    console.log(`[Poll] ★ FILTER: ${ALLOWED_MACHINES.length} machine(s): ${ALLOWED_MACHINES.join(', ')}`)
  }
  console.log(`[Poll] Started — every ${POLL_INTERVAL_MS}ms, last ${POLL_MINUTES} min`)
  runPollCycle() // first poll immediately
}

/* ★ [FIX] ตั้งรอบถัดไป "หลังรอบนี้จบแล้ว" แทน setInterval
   setInterval ยิงตามนาฬิกาไม่สนว่ารอบก่อนจบหรือยัง พอ query ใช้เวลานานกว่า
   POLL_INTERVAL_MS รอบใหม่จะทับรอบเก่าไปเรื่อย ๆ จน DB รับไม่ไหว
   แบบนี้ถ้า query ใช้ 5 วิ ก็จะได้ข้อมูลใหม่ทุก 5 วิ (ช้าลงนิดหน่อย)
   แทนที่จะยิงซ้อนกันทุก 3 วิจนไม่ได้ข้อมูลเลยสักรอบ */
function scheduleNextPoll(elapsedMs) {
  if (!pollingStarted) return // shutdown แล้ว
  pollTimer = setTimeout(runPollCycle, Math.max(0, POLL_INTERVAL_MS - elapsedMs))
}

async function runPollCycle() {
  const t0 = Date.now()
  try {
    await poll()
  } finally {
    scheduleNextPoll(Date.now() - t0)
  }
}

// ─── WebSocket (no Redis) ─────────────────────────────
const clients = new Set()

function broadcast(data) {
  const msg = JSON.stringify(data)
  for (const ws of clients) {
    try {
      if (ws.readyState === ws.OPEN) ws.send(msg)
    } catch { clients.delete(ws) }
  }
}

// ─── HTTP + WS Server ─────────────────────────────────
const frontendDir = path.join(__dirname, '..', 'frontend')

/* ★ [PERF] gzip JSON responses — ลดขนาด ~70% */
function sendJson(res, data) {
  var json = JSON.stringify(data)
  var acceptEnc = (res.req && res.req.headers && res.req.headers['accept-encoding']) || ''
  if (acceptEnc.indexOf('gzip') >= 0 && json.length > 1024) {
    var buf = zlib.gzipSync(json)
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': buf.length })
    res.end(buf)
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(json)
  }
}

const MIME = {
  '.html':'text/html; charset=utf-8', '.jpg':'image/jpeg', '.jpeg':'image/jpeg',
  '.png':'image/png', '.webp':'image/webp', '.svg':'image/svg+xml', '.ico':'image/x-icon',
  '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.json':'application/json; charset=utf-8', '.woff2':'font/woff2',
}
// ★ ไฟล์รูปแทบไม่เปลี่ยน → cache ยาว 1 วัน / ไฟล์โค้ดกับ html ให้ revalidate ทุกครั้ง (ETag ทำให้ได้ 304 ตัวเปล่า)
const LONG_CACHE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.svg', '.ico', '.woff2'])

/* ★ [PERF] serve ไฟล์แบบ stream + ETag
   ของเดิมใช้ fs.readFileSync() → รูปแผนที่ 10 MB บล็อก event loop ทั้ง process ทุกครั้งที่มีคนโหลด
   (ระหว่างนั้น WS broadcast กับ API อื่นหยุดหมด ยิ่งเปิดหลายจอยิ่งกระตุก)
   และไม่มี cache header เลย → browser โหลดรูปใหม่แทบทุกครั้ง */
async function serveStatic(req, res, filePath, mime) {
  let stat
  try {
    stat = await fs.promises.stat(filePath)
    if (!stat.isFile()) return false
  } catch {
    return false
  }

  const ext = path.extname(filePath).toLowerCase()
  const etag = '"' + stat.size.toString(16) + '-' + Math.floor(stat.mtimeMs).toString(16) + '"'
  // ★ ไฟล์ใน vendor/ ปักเวอร์ชันไว้แล้ว (เช่น html2canvas 1.4.1) → cache ยาวได้เหมือนรูป
  const isVendor = filePath.startsWith(path.join(frontendDir, 'vendor') + path.sep)
  const cacheControl = (LONG_CACHE_EXT.has(ext) || isVendor) ? 'public, max-age=86400' : 'no-cache'

  // ไฟล์ไม่เปลี่ยนตั้งแต่ครั้งก่อน → ตอบ 304 ตัวเปล่า ไม่ต้องส่ง body
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { 'ETag': etag, 'Cache-Control': cacheControl })
    res.end()
    return true
  }

  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': stat.size,
    'Cache-Control': cacheControl,
    'ETag': etag,
    'Last-Modified': stat.mtime.toUTCString(),
  })

  const stream = fs.createReadStream(filePath)
  stream.on('error', (err) => {
    console.error('[Static] stream error:', filePath, err.message)
    res.destroy()
  })
  res.on('close', () => stream.destroy())
  stream.pipe(res)
  return true
}

const app = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  let urlPath = req.url.split('?')[0]
  // ★ decode ก่อน (รองรับชื่อไฟล์ที่มีช่องว่าง/อักษรไทย) — traversal ยังกันด้วย startsWith ข้างล่างเหมือนเดิม
  try { urlPath = decodeURIComponent(urlPath) } catch {}

  if (urlPath === '/' || urlPath === '/index.html') {
    if (await serveStatic(req, res, path.join(frontendDir, 'index.html'), MIME['.html'])) return
  }
  // Static assets (.jpg, .png, .js, .css, ...)
  const ext = path.extname(urlPath).toLowerCase()
  if (MIME[ext]) {
    const filePath = path.join(frontendDir, urlPath)
    if (filePath === frontendDir || filePath.startsWith(frontendDir + path.sep)) {
      if (await serveStatic(req, res, filePath, MIME[ext])) return
    }
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime(), machines: Object.keys(snapshot).length }))
  } else if (req.url === '/api/snapshot') {
    sendJson(res, snapshot)
  } else if (req.url === '/api/machines') {
    try {
      const rows = await fetchAllMachines()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ count: rows.length, rows }))
    } catch (err) {
      console.error('[API] /api/machines error:', err.message)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
  } else if (req.url.startsWith('/api/lot-report')) {
    try {
      const u = new URL(req.url, 'http://localhost')
      const days = Math.min(Math.max(parseInt(u.searchParams.get('days') || '7', 10), 1), 30)
      const rows = await fetchLotReport(days)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ days, count: rows.length, rows }))
    } catch (err) {
      console.error('[API] /api/lot-report error:', err.message)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
  } else if (req.url.startsWith('/api/qr-history')) {
    // ★ QR history ของเครื่องเดียว (group by LOT)
    try {
      const u = new URL(req.url, 'http://localhost')
      const machineId = u.searchParams.get('machine_id') || ''
      const range = u.searchParams.get('range') || 'today'
      const startStr = u.searchParams.get('start_date')
      const endStr = u.searchParams.get('end_date')
      const limit = parseInt(u.searchParams.get('limit') || '100', 10) // 0 = all
      const offset = parseInt(u.searchParams.get('offset') || '0', 10)
      if (!machineId) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'machine_id required' }))
        return
      }
      const data = await fetchQrHistory(machineId, range, limit, offset, startStr, endStr)
      sendJson(res, data)
    } catch (err) {
      console.error('[API] /api/qr-history error:', err.message)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
  } else if (req.url.startsWith('/api/qr-daily')) {
    // ★ % QR หลายวันของเครื่องเดียว
    try {
      const u = new URL(req.url, 'http://localhost')
      const machineId = u.searchParams.get('machine_id') || ''
      const range = u.searchParams.get('range') || 'today'
      const startStr = u.searchParams.get('start_date')
      const endStr = u.searchParams.get('end_date')
      if (!machineId) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'machine_id required' }))
        return
      }
      const data = await fetchQrDaily(machineId, range, startStr, endStr)
      sendJson(res, data)
    } catch (err) {
      console.error('[API] /api/qr-daily error:', err.message)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
  } else if (req.url.startsWith('/api/status-history')) {
    // ★ ประวัติสถานะเครื่องเดียว (EQPSTATUS) ทั้งวัน
    try {
      const u = new URL(req.url, 'http://localhost')
      const machineId = u.searchParams.get('machine_id') || ''
      const range = u.searchParams.get('range') || 'today'
      const startStr = u.searchParams.get('start_date')
      const endStr = u.searchParams.get('end_date')
      if (!machineId) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'machine_id required' }))
        return
      }
      const limit = u.searchParams.get('limit')    // ★ [PERF] default 50
      const offset = u.searchParams.get('offset')  // ★ [PERF] pagination
      const alarmCategory = u.searchParams.get('alarm_category') || 'all'  // ★ [FIX] เดิมไม่ได้อ่าน
      const data = await fetchStatusHistory(machineId, range, startStr, endStr, limit, offset, alarmCategory)
      sendJson(res, data)
    } catch (err) {
      console.error('[API] /api/status-history error:', err.message)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
  } else if (req.url.startsWith('/api/machine-history')) {
    // ★ ดึงสถานะล่าสุดของเครื่องเดียวในวันที่กำหนด (สำหรับ "ดูข้อมูลย้อนหลัง" ในหน้าเครื่อง)
    try {
      const u = new URL(req.url, 'http://localhost')
      const machineId = u.searchParams.get('machine_id') || ''
      const dateStr = u.searchParams.get('date') || localDateStr()
      if (!machineId) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'machine_id required' }))
        return
      }
      const data = await fetchMachineHistory(machineId, dateStr)
      sendJson(res, data)
    } catch (err) {
      /* ★ [FIX] log ให้ครบ จะได้เห็นเลข ORA- จริงเวลาดีบัก */
      console.error('[API] /api/machine-history error:', err.errorNum ? ('ORA-' + err.errorNum + ' ') : '', err.message)
      console.error(err.stack)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message, ora: err.errorNum || null }))
    }
  } else if (req.url.startsWith('/api/qr-summary')) {
    // ★ สรุป % QR รวมทุกเครื่อง (สำหรับ sidebar)
    try {
      const u = new URL(req.url, 'http://localhost')
      const range = u.searchParams.get('range') || 'today'
      const startStr = u.searchParams.get('start_date')
      const endStr = u.searchParams.get('end_date')
      const data = await fetchQrSummary(range, startStr, endStr)
      sendJson(res, data)
    } catch (err) {
      console.error('[API] /api/qr-summary error:', err.message)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
  } else if (req.url.startsWith('/api/qr-export')) {
    // ★ Export QR history เป็น CSV (download)
    try {
      const u = new URL(req.url, 'http://localhost')
      const machineId = u.searchParams.get('machine_id') || ''
      const range = u.searchParams.get('range') || 'today'
      const startStr = u.searchParams.get('start_date')
      const endStr = u.searchParams.get('end_date')
      if (!machineId) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'machine_id required' }))
        return
      }
      const data = await fetchQrHistory(machineId, range, 0, 0, startStr, endStr) // limit=0 = all
      // Build CSV
      var csv = 'timestamp,machine_id,lot_id,panel_id,is_read\n'
      data.lots.forEach(function(lot) {
        lot.panels.forEach(function(p) {
          // ★ [FIX] เดิมใช้ toISOString() (UTC) → timestamp ใน export เพี้ยนไป 7 ชม. จากเวลาไทยที่แสดงในหน้าเว็บ
          var ts = p.time instanceof Date ? localDateTimeStr(p.time) : String(p.time)
          csv += [ts, csvEscape(data.machine_id), csvEscape(lot.lot_id), csvEscape(p.panel_id), p.is_error ? 'FALSE' : 'TRUE'].join(',') + '\n'
        })
      })
      var dateLabel = data.label.replace(/ to /g, '_')
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition', 'attachment; filename="qr_' + machineId + '_' + dateLabel + '.csv"')
      res.writeHead(200)
      res.end(csv)
    } catch (err) {
      console.error('[API] /api/qr-export error:', err.message)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
  } else if (req.url.startsWith('/api/qr-logs/')) {
    // ★ Serve QR log file ตรงจาก qr-logs/ folder
    try {
      const u = new URL(req.url, 'http://localhost')
      const fileName = path.basename(u.pathname)
      if (!/^qr-\d{4}-\d{2}-\d{2}\.csv$/.test(fileName)) {
        res.writeHead(400); res.end('Invalid file name'); return
      }
      const filePath = path.join(QR_LOG_DIR, fileName)
      if (!fs.existsSync(filePath)) {
        res.writeHead(404); res.end('File not found'); return
      }
      const data = fs.readFileSync(filePath)
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition', 'attachment; filename="' + fileName + '"')
      res.writeHead(200)
      res.end(data)
    } catch (err) {
      console.error('[API] /api/qr-logs error:', err.message)
      res.writeHead(500); res.end('Server error')
    }
  } else if (req.url.startsWith('/api/machines/evidence-pack')) {
    // ★ Vendor Evidence Pack — สร้าง PDF ให้ vendor เครื่องจักร
    //   ยังไม่เคยทดสอบกับ Oracle จริง + ต้องรัน CREATE TABLE FAULT_ZONE_MAP ก่อน (oracle_setup.sql ข้อ 6)
    try {
      const u = new URL(req.url, 'http://localhost')
      const machineId = u.searchParams.get('machine_id') || ''
      const alarmText = u.searchParams.get('alarm_text') || null
      const range = u.searchParams.get('range') || 'week'
      const startStr = u.searchParams.get('start_date')
      const endStr = u.searchParams.get('end_date')
      if (!machineId) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'machine_id required' }))
        return
      }
      const r = startStr || endStr ? getDateRangeFromParams(startStr, endStr) : getDateRange(range)
      const pool = await getPool()
      const data = await evidencePack.fetchEvidencePackData(pool, {
        machineId: machineId,
        alarmText: alarmText,
        start: r.start,
        end: r.end,
        label: r.label,
        targetPct: QR_TARGET_PCT,
        dayShiftStartHour: DAY_SHIFT_START_HOUR,
      })
      evidencePack.generatePdf(data, res, { plant: REPORT_PLANT, contact: REPORT_CONTACT, fontPath: PDF_FONT_PATH || undefined })
    } catch (err) {
      console.error('[API] /api/machines/evidence-pack error:', err.message)
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
      }
    }
  } else if (req.url.startsWith('/api/layout/machines') || req.url.startsWith('/api/layout/zones')) {
    // ★ บันทึกผังจากโหมด Admin (Machine Drag / Zone Editor) ลงไฟล์ JSON ตรง ๆ
    const isMachines = req.url.startsWith('/api/layout/machines')
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'ต้องใช้ POST' }))
      return
    }
    try {
      const body = await readJsonBody(req)
      const factory = body.factory
      const floor = body.floor
      if (!validFactory(factory)) throw new Error('factory ไม่ถูกต้อง')
      if (!validFloor(floor)) throw new Error('floor ไม่ถูกต้อง')

      const items = isMachines ? validateMachines(body.machines) : validateZones(body.zones)
      saveLayoutSection(isMachines ? MACHINES_PATH : ZONES_PATH, factory, floor, items)

      console.log(`[Layout] บันทึก ${isMachines ? 'machines' : 'zones'} ${factory}/${floor}F — ${items.length} รายการ`)
      sendJson(res, { ok: true, factory, floor: String(floor), count: items.length })
    } catch (err) {
      console.error('[API] /api/layout save error:', err.message)
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
  } else if (req.url.startsWith('/api/layout')) {
    // ★ ผังทั้งหมด — frontend โหลดตอน boot
    try {
      sendJson(res, {
        machines: loadJsonFile(MACHINES_PATH, {}),
        zones: loadJsonFile(ZONES_PATH, {}),
        /* ★ เป้าหมาย %QR — frontend ใช้เป็นเกณฑ์สีเดียวกันทั้งหน้าจอ
           (ของเดิม frontend hardcode ไว้คนละค่าในแต่ละที่: 100 บ้าง 95 บ้าง) */
        qr_target_pct: QR_TARGET_PCT,
        /* ★ เพดานเวลาฝั่ง server แยกตามความยาวช่วง — frontend เอาไปตั้งเวลารอของตัวเอง
           ให้ยาวกว่านิดหน่อย จะได้เห็น error จริงจาก server แทนที่จะถูกฝั่ง browser ตัดไปก่อน */
        api_timeouts: {
          short_ms: API_TIMEOUT_MS,
          week_ms: API_TIMEOUT_WEEK_MS,
          month_ms: API_TIMEOUT_MONTH_MS,
          max_ms: maxApiTimeoutMs(),
          short_max_days: API_TIMEOUT_SHORT_MAX_DAYS,
          week_max_days: API_TIMEOUT_WEEK_MAX_DAYS,
        },
      })
    } catch (err) {
      console.error('[API] /api/layout error:', err.message)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
  } else if (req.url.startsWith('/api/camera-map')) {
    // ★ รายชื่อเครื่องที่มีกล้อง map ไว้ — frontend ใช้ตัดสินใจว่าจะโชว์ปุ่มดูกล้องไหม
    try {
      const cams = loadCameraMap()
      sendJson(res, {
        configured: !!NVR_CONFIG.host,
        machines: Object.keys(cams),
      })
    } catch (err) {
      console.error('[API] /api/camera-map error:', err.message)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
  } else if (req.url.startsWith('/api/camera-live')) {
    // ★ Live view กล้อง (MJPEG ผ่าน ISAPI httpPreview) — proxy ผ่าน server กัน credential หลุดไป client
    try {
      const u = new URL(req.url, 'http://localhost')
      const machineId = u.searchParams.get('machine_id') || ''
      if (!NVR_CONFIG.host) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'NVR ยังไม่ได้ตั้งค่า (NVR_HOST ว่างใน .env)' }))
        return
      }
      const cam = loadCameraMap()[machineId]
      if (!cam) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'ไม่มี mapping กล้องสำหรับเครื่องนี้ใน camera-map.json' }))
        return
      }
      await hikvision.proxyLivePreview(NVR_CONFIG, cam.channel, res)
    } catch (err) {
      console.error('[API] /api/camera-live error:', err.message)
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
      }
    }
  } else if (req.url.startsWith('/api/camera-playback')) {
    // ★ ดูวิดีโอย้อนหลัง ณ เวลาที่ระบุ (เช่น เวลาที่เกิด alarm) — ค้นหาคลิปที่ครอบคลุมเวลานั้นแล้วส่งไฟล์
    try {
      const u = new URL(req.url, 'http://localhost')
      const machineId = u.searchParams.get('machine_id') || ''
      const timeStr = u.searchParams.get('time') || ''
      if (!NVR_CONFIG.host) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'NVR ยังไม่ได้ตั้งค่า (NVR_HOST ว่างใน .env)' }))
        return
      }
      const cam = loadCameraMap()[machineId]
      if (!cam) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'ไม่มี mapping กล้องสำหรับเครื่องนี้ใน camera-map.json' }))
        return
      }
      const target = timeStr ? new Date(timeStr) : new Date()
      if (isNaN(target.getTime())) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'time ไม่ถูกต้อง ต้องเป็น ISO date string' }))
        return
      }
      // ★ ค้นหาในช่วง ±5 นาทีรอบเวลาที่ต้องการ
      const searchStart = new Date(target.getTime() - 5 * 60 * 1000)
      const searchEnd = new Date(target.getTime() + 5 * 60 * 1000)
      const matches = await hikvision.searchRecordings(NVR_CONFIG, cam.channel, searchStart, searchEnd)
      const best = hikvision.pickBestMatch(matches, target)
      if (!best) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'ไม่พบวิดีโอบันทึกในช่วงเวลานี้ (อาจถูกลบแล้วหรือ NVR ไม่ได้บันทึก)' }))
        return
      }
      await hikvision.proxyPlaybackDownload(NVR_CONFIG, best.playbackUri, res)
    } catch (err) {
      console.error('[API] /api/camera-playback error:', err.message)
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
      }
    }
  } else {
    res.writeHead(404)
    res.end('Not Found')
  }
})

const wss = new WebSocketServer({ server: app, path: '/ws' })

wss.on('connection', (ws) => {
  clients.add(ws)
  /* ★ [FIX] Heartbeat — ของเดิมลบ client ตอน 'close'/'error' เท่านั้น
     ถ้าโน้ตบุ๊กพับจอหรือ WiFi หลุด TCP จะค้างครึ่งใบ ไม่มี event 'close' ยิงมาเลย
     → connection ตายค้างใน Set ตลอด และ broadcast() ยิงใส่ทุก 3 วิ สะสมขึ้นเรื่อย ๆ
     browser ตอบ pong ให้เองในระดับ protocol ไม่ต้องแก้ฝั่ง client */
  ws.isAlive = true
  ws.on('pong', () => { ws.isAlive = true })

  console.log(`[WS] Client connected — total: ${clients.size}`)

  // ส่ง snapshot ทันที
  ws.send(JSON.stringify({ type: 'SNAPSHOT', data: snapshot }))

  // ★ ถ้า snapshot ว่าง → รอ poll แรกเสร็จแล้วส่งใหม่ (แก้ race condition)
  if (Object.keys(snapshot).length === 0) {
    console.log('[WS] Snapshot empty — will re-send after first poll')
    ws._awaitingSnapshot = true
  }

  ws.on('close', () => {
    clients.delete(ws)
    console.log(`[WS] Client left — total: ${clients.size}`)
  })
  ws.on('error', () => clients.delete(ws))
})

// ★ ส่ง ping ทุก 30 วิ — client ที่ไม่ตอบ pong ภายในรอบถัดไปถือว่าตายแล้ว ตัดทิ้ง
const WS_HEARTBEAT_MS = parseInt(process.env.WS_HEARTBEAT_MS || '30000')
const wsHeartbeatTimer = setInterval(() => {
  for (const ws of clients) {
    if (ws.isAlive === false) {
      console.log('[WS] Client ไม่ตอบ ping — ตัดทิ้ง')
      clients.delete(ws)
      try { ws.terminate() } catch {}
      continue
    }
    ws.isAlive = false
    try { ws.ping() } catch {
      clients.delete(ws)
      try { ws.terminate() } catch {}
    }
  }
}, WS_HEARTBEAT_MS)
wsHeartbeatTimer.unref()

// ─── Start ────────────────────────────────────────────
async function main() {
  console.log('=== SENTRA(Standalone) ===')
  /* ★ พิมพ์ช่วงเวลาที่ query ใช้จริง ไม่ใช่แค่ที่ตั้งไว้ — บั๊กรอบก่อนคือ banner
     ประกาศ "Lookback: 15 min" แต่ SQL ฮาร์ดโค้ด 24 ชม. ไว้ ไม่มีทางรู้จากหน้าจอเลย */
  console.log(`[Info] Poll: every ${POLL_INTERVAL_MS}ms | Lookback: ${POLL_MINUTES} min | ` +
              `PanelStats: ${PANEL_STATS_MINUTES} min | poll timeout: ${POLL_TIMEOUT_MS}ms`)
  /* ★ เพดานเวลา API แยกตามความยาวช่วง — พิมพ์ออกมาให้เห็น จะได้รู้ว่าค่าใน .env ติดจริงไหม */
  console.log(`[Info] API timeout: <=${API_TIMEOUT_SHORT_MAX_DAYS}d ${API_TIMEOUT_MS}ms | ` +
              `<=${API_TIMEOUT_WEEK_MAX_DAYS}d ${API_TIMEOUT_WEEK_MS}ms | longer ${API_TIMEOUT_MONTH_MS}ms | ` +
              `pool queue: ${QUEUE_TIMEOUT_MS}ms` +
              Object.keys(API_TIMEOUT_BY_ENDPOINT)
                .filter(function(k) { return API_TIMEOUT_BY_ENDPOINT[k] > 0 })
                .map(function(k) { return ` | ${k}: ${API_TIMEOUT_BY_ENDPOINT[k]}ms (override)` })
                .join(''))
  /* ★ [FIX] ลบ QR log เก่ากว่า 30 วัน — ของเดิมรันแค่ครั้งเดียวตอน start
     server ที่เปิดทิ้งไว้เป็นเดือน ๆ จะไม่เคยลบไฟล์เก่าเลย แม้ตั้ง retention ไว้แล้ว
     (ไฟล์วันที่งานเยอะ ~580 KB/วัน → ปีนึงราว 200 MB) */
  purgeOldQrLogs()
  console.log(`[QRLog] Auto-cleanup done (retention: ${QR_LOG_RETENTION_DAYS} days)`)
  qrPurgeTimer = setInterval(purgeOldQrLogs, QR_PURGE_INTERVAL_MS)
  qrPurgeTimer.unref()

  // ★ Start server ก่อนเลย (ไม่ exit ถ้า Oracle ไม่ติด)
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] Running on http://0.0.0.0:${PORT} (accepts all interfaces)`)
    console.log(`[Server] Frontend  : http://localhost:${PORT}/`)
    console.log(`[Server] WebSocket  : ws://localhost:${PORT}/ws`)
    console.log(`[Server] Health    : http://localhost:${PORT}/health`)
    // ★ แสดง LAN IP ทั้งหมดที่คนอื่นสามารถใช้เข้าได้
    var ips = getLanIPs();
    if (ips.length > 0) {
      console.log('\n========================================');
      console.log('  ★ LINK:');
      ips.forEach(function(ip) {
        console.log('    http://' + ip + ':' + PORT + '/');
      });
      console.log('========================================\n');
    } else {
      console.log('\n→ เปิด http://localhost:' + PORT + '/ ใน browser\n');
    }
  })

  // Test Oracle connection (retry ทุก 30 วินาที — ไม่ exit)
  async function tryConnectOracle(attempt) {
    try {
      const p = await getPool()
      const conn = await p.getConnection()
      const test = await conn.execute('SELECT 1 FROM DUAL')
      await conn.close()
      console.log('[DB] Oracle connection OK ✓ (attempt ' + attempt + ')')
      startPolling()
      return true
    } catch (err) {
      console.warn('[DB] Oracle connection failed (attempt ' + attempt + '): ' + err.message)
      console.warn('[DB] จะ retry ใน 30 วินาที... (สลับ wifi เข้าเครือข่ายบริษัทก่อน)')
      return false
    }
  }

  let attempt = 0
  async function retryLoop() {
    const ok = await tryConnectOracle(++attempt)
    if (!ok) {
      const retryTimer = setInterval(async () => {
        const ok2 = await tryConnectOracle(++attempt)
        if (ok2) {
          console.log('[DB] ✓ Oracle reconnected! เริ่ม polling...')
          clearInterval(retryTimer)
        }
      }, 30000)
    }
  }
  retryLoop()
}

async function shutdown() {
  console.log('\n[Server] Shutting down...')
  // ★ pollTimer เป็น setTimeout แล้ว (ไม่ใช่ setInterval) — เคลียร์แล้วปิดสวิตช์
  //   ไม่ให้ scheduleNextPoll ตั้งรอบใหม่ระหว่างกำลังปิด pool
  pollingStarted = false
  if (pollTimer) clearTimeout(pollTimer)
  if (qrPurgeTimer) clearInterval(qrPurgeTimer)
  clearInterval(wsHeartbeatTimer)
  for (const ws of clients) ws.close()
  if (pool) { await pool.close(10); pool = null }
  process.exit(0)
}

/* ★ [FIX] Node ตั้งค่า default ให้ unhandled promise rejection ฆ่า process ทิ้ง
   promise เดียวที่พลาดไป (เช่น query ที่ DB ตัดกลางคัน, socket เขียนไม่ได้)
   จะทำให้จอมอนิเตอร์ทั้งไลน์ดับ และ start-server.bat ไม่ได้เปิดใหม่ให้เอง
   (หน้าต่างขึ้น "Server stopped." แล้วค้างรอคนมากดเอง)
   ทิศทางเดียวกับที่ Oracle ต่อไม่ติดแล้วไม่ exit: log ไว้แล้วรันต่อ เพราะทุก path
   ที่สำคัญมี retry ของตัวเองอยู่แล้ว (poll ทุก 3 วิ / reconnect ทุก 30 วิ) */
process.on('unhandledRejection', (reason) => {
  console.error('[UnhandledRejection]', reason && reason.stack ? reason.stack : reason)
})

/* uncaughtException ต่างจากข้างบนตรงที่ state หลังจากนี้เชื่อไม่ได้ 100%
   แต่บนเครื่องที่ไม่มีตัวคุม restart การรันต่อแบบพิการยังดีกว่าจอดับสนิท
   ★ ถ้าเห็น log นี้บ่อย ๆ ให้ตามแก้ที่ต้นเหตุ อย่าปล่อยผ่าน */
process.on('uncaughtException', (err) => {
  console.error('[UncaughtException]', err && err.stack ? err.stack : err)
  console.error('[UncaughtException] server ยังรันต่อ — ถ้าข้อมูลเริ่มเพี้ยน ให้ปิดแล้วเปิดใหม่')
})

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

main().catch(err => { console.error('[Fatal]', err); process.exit(1) })
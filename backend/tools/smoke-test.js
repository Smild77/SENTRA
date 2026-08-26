/* ═══════════════════════════════════════════════════════
   Smoke test — ตรวจว่า server ยังทำงานถูกต้องหลังแก้โค้ด
   รันด้วย:  npm test   (จาก backend/)

   ★ ไม่ต้องต่อ Oracle — ทดสอบเฉพาะส่วนที่ไม่พึ่ง DB
     (server ถูกออกแบบให้ start ได้แม้ Oracle ไม่ติด)
   ★ ทดสอบการเขียนไฟล์ผังด้วย โดยสำรองไฟล์จริงไว้ก่อนแล้วคืนค่าให้ตอนจบเสมอ
   ═══════════════════════════════════════════════════════ */

const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const PORT = process.env.SMOKE_PORT || '39117'
const BASE = 'http://127.0.0.1:' + PORT
const MACHINES_PATH = path.join(ROOT, 'config', 'machines.json')
const ZONES_PATH = path.join(ROOT, 'config', 'zones.json')

let passed = 0
let failed = 0

function ok(name) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + name) }
function bad(name, detail) {
  failed++
  console.log('  \x1b[31m✗\x1b[0m ' + name)
  if (detail) console.log('      → ' + detail)
}

function check(name, cond, detail) {
  if (cond) ok(name); else bad(name, detail)
}

async function get(pathname, headers) {
  const res = await fetch(BASE + pathname, { headers: headers || {} })
  return res
}

function countLeaves(obj) {
  let n = 0
  for (const f in obj) for (const fl in obj[f]) n += obj[f][fl].length
  return n
}

async function run() {
  console.log('\n=== 1. ไฟล์ JS parse ผ่านทั้งหมด ===')
  const jsFiles = ['sentra-server.js', 'lib/evidence-pack.js', 'lib/hikvision.js']
  for (const f of jsFiles) {
    try {
      new (require('vm').Script)(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f })
      ok(f)
    } catch (e) {
      bad(f, e.message)
    }
  }

  console.log('\n=== 2. ไฟล์ config เป็น JSON ที่ถูกต้อง ===')
  let machines = null
  let zones = null
  try { machines = JSON.parse(fs.readFileSync(MACHINES_PATH, 'utf8')); ok('machines.json') }
  catch (e) { bad('machines.json', e.message) }
  try { zones = JSON.parse(fs.readFileSync(ZONES_PATH, 'utf8')); ok('zones.json') }
  catch (e) { bad('zones.json', e.message) }
  try { JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'camera-map.json'), 'utf8')); ok('camera-map.json') }
  catch (e) { bad('camera-map.json', e.message) }

  if (machines) {
    let bad_ = []
    for (const f in machines) for (const fl in machines[f]) machines[f][fl].forEach((m) => {
      if (!m.id) bad_.push(f + '/' + fl + ' มีเครื่องที่ไม่มี id')
      else if (!(m.x >= 0 && m.x <= 100 && m.y >= 0 && m.y <= 100)) bad_.push(m.id + ' พิกัดนอกช่วง 0-100')
    })
    check('พิกัดเครื่องจักรอยู่ในช่วง 0-100 ทั้งหมด (' + countLeaves(machines) + ' เครื่อง)',
      bad_.length === 0, bad_.slice(0, 5).join(', '))

    const ids = []
    for (const f in machines) for (const fl in machines[f]) machines[f][fl].forEach((m) => ids.push(m.id))
    const dup = ids.filter((id, i) => ids.indexOf(id) !== i)
    check('ไม่มี machine id ซ้ำ', dup.length === 0, 'ซ้ำ: ' + dup.join(', '))
  }

  if (zones) {
    let bad_ = []
    for (const f in zones) for (const fl in zones[f]) zones[f][fl].forEach((z) => {
      if (!Array.isArray(z.points) || z.points.length < 3) bad_.push((z.name || '?') + ' มีจุดน้อยกว่า 3')
    })
    check('ทุกโซนมีอย่างน้อย 3 จุด (' + countLeaves(zones) + ' โซน)', bad_.length === 0, bad_.join(', '))
  }

  console.log('\n=== 2b. คำแปล i18n ครบทั้ง 3 ภาษา ===')
  const I18N_DIR = path.join(ROOT, '..', 'frontend', 'i18n')
  const sandbox = { window: {} }
  const langs = { th: 'I18N_TH', en: 'I18N_EN', ch: 'I18N_CH' }
  const dicts = {}
  for (const [lang, varName] of Object.entries(langs)) {
    try {
      require('vm').runInNewContext(fs.readFileSync(path.join(I18N_DIR, lang + '.js'), 'utf8'), sandbox)
      dicts[lang] = sandbox.window[varName]
      check('i18n/' + lang + '.js โหลดได้ (' + Object.keys(dicts[lang]).length + ' คีย์)', !!dicts[lang])
    } catch (e) {
      bad('i18n/' + lang + '.js', e.message)
    }
  }
  if (Object.keys(dicts).length === 3) {
    const all = new Set()
    for (const l in dicts) Object.keys(dicts[l]).forEach((k) => all.add(k))
    for (const l in dicts) {
      const missing = [...all].filter((k) => !(k in dicts[l]))
      check('ภาษา ' + l + ' มีคีย์ครบ',
        missing.length === 0,
        'ขาด ' + missing.length + ' คีย์: ' + missing.slice(0, 10).join(', '))
    }
  }

  console.log('\n=== 3. ไฟล์แผนที่ที่ frontend อ้างถึงมีอยู่จริง ===')
  const indexHtml = fs.readFileSync(path.join(ROOT, '..', 'frontend', 'index.html'), 'utf8')
  const activeMaps = (indexHtml.match(/mapImg:\[[^\]]*\][^}]*active:true/g) || [])
    .flatMap((s) => s.match(/maps\/[A-Za-z0-9_]+\.(?:jpg|png|webp)/g) || [])
  check('พบรายชื่อไฟล์แผนที่ของโรงงานที่เปิดใช้งาน', activeMaps.length > 0)
  for (const rel of activeMaps) {
    const p = path.join(ROOT, '..', 'frontend', rel)
    check(rel, fs.existsSync(p), 'ไม่พบไฟล์')
  }

  console.log('\n=== 3b. ทำงานออฟไลน์ได้ (ไม่พึ่ง CDN) ===')
  // ★ หน้างานไม่มีเน็ต — ถ้ามี src/href ชี้ออกไปข้างนอก ฟีเจอร์นั้นจะพังเงียบ ๆ
  const external = indexHtml.match(/(?:src|href)=["']https?:\/\/[^"']+/g) || []
  check('index.html ไม่มี src/href ชี้ออกอินเทอร์เน็ต', external.length === 0, external.join(', '))
  check('มี frontend/vendor/html2canvas.min.js (ปุ่มถ่ายภาพ P)',
    fs.existsSync(path.join(ROOT, '..', 'frontend', 'vendor', 'html2canvas.min.js')))

  console.log('\n=== 3c. รองรับมือถือ / จอสัมผัส ===')
  check('มี <meta viewport>', /<meta\s+name=["']viewport["']/.test(indexHtml))
  check('#map ตั้ง touch-action:none (ไม่ให้ browser แย่ง gesture ไปซูมทั้งหน้า)',
    /#map\{[^}]*touch-action:\s*none/.test(indexHtml))
  for (const ev of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
    check('ผูก ' + ev + ' ไว้แล้ว', indexHtml.indexOf("'" + ev + "'") >= 0)
  }
  check('touch handler ไม่ใช่ passive (ต้อง preventDefault ได้ ไม่งั้น pinch ไปซูมทั้งหน้า)',
    /'touchmove'[\s\S]{0,2000}?\{passive:false\}/.test(indexHtml))
  const mediaCount = (indexHtml.match(/@media/g) || []).length
  check('มี @media อย่างน้อย 4 ชุด (768 / 480 / แนวนอน / hover:none) — พบ ' + mediaCount,
    mediaCount >= 4)
  for (const q of ['max-width:768px', 'max-width:480px', 'orientation:landscape', 'hover:none']) {
    check('breakpoint ' + q, indexHtml.replace(/\s/g, '').indexOf('@media(' + q.replace(/\s/g, '')) >= 0 ||
      indexHtml.replace(/\s/g, '').indexOf(q.replace(/\s/g, '')) >= 0)
  }
  // ★ เครื่องมือ Admin ต้องใช้ pointer events ไม่งั้นลาก/วาดบนจอสัมผัสไม่ได้
  check('Machine Drag ใช้ pointerdown/up (ไม่ใช่ mouse-only)',
    indexHtml.indexOf("'pointerdown'") >= 0 && indexHtml.indexOf("'pointerup'") >= 0)
  check('Zone Editor ใช้ pointermove', indexHtml.indexOf("'pointermove'") >= 0)
  check('#mini-map ถูกซ่อนตอนจอแคบ รวมกรณีมีคลาส .show ด้วย',
    /#mini-map,#mini-map\.show\{display:none\}/.test(indexHtml.replace(/\s*\n\s*/g, '')))

  console.log('\n=== 3d. หน้าสรุปรายเครื่อง (report.html) ===')
  const reportPath = path.join(ROOT, '..', 'frontend', 'report.html')
  check('มีไฟล์ frontend/report.html', fs.existsSync(reportPath))
  if (fs.existsSync(reportPath)) {
    const reportHtml = fs.readFileSync(reportPath, 'utf8')
    const rExternal = reportHtml.match(/(?:src|href)=["']https?:\/\/[^"']+/g) || []
    check('report.html ไม่มี src/href ชี้ออกอินเทอร์เน็ต', rExternal.length === 0, rExternal.join(', '))
    check('report.html มี <meta viewport>', /<meta\s+name=["']viewport["']/.test(reportHtml))
    check('report.html ใช้ /api/qr-summary (ไม่ต้องมี endpoint ใหม่)',
      reportHtml.indexOf('/api/qr-summary') >= 0)
    check('index.html มีลิงก์ไป report.html', indexHtml.indexOf('href="report.html"') >= 0)
    check('index.html รับ deep link ?machine= จากหน้าสรุป',
      indexHtml.indexOf('applyMachineDeepLink') >= 0)
    // ★ คีย์ที่หน้า report เรียกใช้ต้องมีครบทั้ง 3 ภาษา ไม่งั้นจะโชว์ชื่อคีย์ดิบ ๆ บนหน้าจอ
    if (Object.keys(dicts).length === 3) {
      const used = new Set()
      const re = /data-i18n(?:-ph|-title)?=["']([A-Za-z0-9_]+)["']/g
      let m
      while ((m = re.exec(reportHtml)) !== null) used.add(m[1])
      ;(reportHtml.match(/\bt\(\s*'([A-Za-z0-9_]+)'\s*\)/g) || []).forEach((s) => {
        used.add(s.replace(/^t\(\s*'/, '').replace(/'\s*\)$/, ''))
      })
      for (const l in dicts) {
        const missing = [...used].filter((k) => !(k in dicts[l]))
        check('report.html: ภาษา ' + l + ' มีคีย์ครบ (' + used.size + ' คีย์)',
          missing.length === 0, 'ขาด: ' + missing.slice(0, 10).join(', '))
      }
    }
  }

  // ─── ส่วนที่ต้อง start server ─────────────────────────
  console.log('\n=== 4. Start server (ไม่ต้องมี Oracle) ===')
  const backupMachines = fs.readFileSync(MACHINES_PATH)
  const backupZones = fs.readFileSync(ZONES_PATH)

  const srv = spawn(process.execPath, ['sentra-server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT, ORACLE_CONNECTION_STRING: 'smoke-test-no-db:1521/none' },
    stdio: 'ignore',
  })

  try {
    // รอ server ตอบ /health (สูงสุด 15 วิ)
    let up = false
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 250))
      try {
        const r = await get('/health')
        if (r.ok) { up = true; break }
      } catch {}
    }
    check('server ตอบ /health', up)
    if (!up) throw new Error('server ไม่ขึ้น — ข้ามการทดสอบ HTTP ที่เหลือ')

    console.log('\n=== 5. API ===')
    const layoutRes = await get('/api/layout')
    const layout = await layoutRes.json()
    check('GET /api/layout คืนเครื่องจักรครบ',
      countLeaves(layout.machines) === countLeaves(machines),
      'ได้ ' + countLeaves(layout.machines) + ' ควรได้ ' + countLeaves(machines))
    check('GET /api/layout คืนโซนครบ',
      countLeaves(layout.zones) === countLeaves(zones),
      'ได้ ' + countLeaves(layout.zones) + ' ควรได้ ' + countLeaves(zones))

    const snap = await get('/api/snapshot')
    check('GET /api/snapshot ตอบ 200', snap.status === 200)

    console.log('\n=== 6. Static + cache header ===')
    const html = await get('/')
    check('GET / ตอบ 200', html.status === 200)
    check('GET / มี ETag', !!html.headers.get('etag'))
    check('GET / เป็น no-cache (แก้ index.html แล้วเห็นผลทันที)',
      html.headers.get('cache-control') === 'no-cache', html.headers.get('cache-control'))

    const report = await get('/report.html')
    check('GET /report.html ตอบ 200', report.status === 200, 'ได้ ' + report.status)
    check('GET /report.html เป็น HTML',
      (report.headers.get('content-type') || '').indexOf('text/html') >= 0,
      report.headers.get('content-type'))

    const img = await get('/maps/' + (activeMaps[0] || '').replace('maps/', ''))
    if (img.status === 200) {
      const etag = img.headers.get('etag')
      check('รูปแผนที่มี Cache-Control ยาว',
        (img.headers.get('cache-control') || '').indexOf('max-age=') >= 0,
        img.headers.get('cache-control'))
      const again = await get('/maps/' + (activeMaps[0] || '').replace('maps/', ''), { 'If-None-Match': etag })
      check('ส่ง If-None-Match ซ้ำได้ 304 (ไม่โหลดรูปใหม่)', again.status === 304, 'ได้ ' + again.status)
    } else {
      bad('โหลดรูปแผนที่', 'HTTP ' + img.status)
    }

    const vendor = await get('/vendor/html2canvas.min.js')
    check('serve /vendor/html2canvas.min.js ได้', vendor.status === 200, 'ได้ ' + vendor.status)
    check('vendor เป็น JS และ cache ยาว',
      (vendor.headers.get('content-type') || '').indexOf('javascript') >= 0 &&
      (vendor.headers.get('cache-control') || '').indexOf('max-age=') >= 0,
      vendor.headers.get('content-type') + ' / ' + vendor.headers.get('cache-control'))

    console.log('\n=== 7. กัน path traversal ===')
    for (const p of ['/../backend/.env', '/..%2f..%2fbackend%2f.env', '/maps/../../backend/.env']) {
      const r = await get(p)
      check('บล็อก ' + p, r.status === 404, 'ได้ ' + r.status)
    }

    console.log('\n=== 8. บันทึกผัง (POST /api/layout/*) ===')
    const post = (p, body) => fetch(BASE + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    const badCases = [
      ['factory ไม่ถูกต้อง', { factory: '../evil', floor: 1, machines: [] }],
      ['floor ไม่ถูกต้อง', { factory: 'ZZTEST', floor: 'abc', machines: [] }],
      ['พิกัดนอกช่วง', { factory: 'ZZTEST', floor: 1, machines: [{ id: 'X', x: 999, y: 0 }] }],
      ['ไม่มี id', { factory: 'ZZTEST', floor: 1, machines: [{ x: 1, y: 2 }] }],
    ]
    for (const [name, body] of badCases) {
      const r = await post('/api/layout/machines', body)
      check('ปฏิเสธ: ' + name, r.status === 400, 'ได้ ' + r.status)
    }

    const getMethod = await get('/api/layout/machines')
    check('GET /api/layout/machines ตอบ 405', getMethod.status === 405, 'ได้ ' + getMethod.status)

    // round-trip: เขียนแล้วอ่านกลับต้องได้ค่าเดิม + ชั้นอื่นต้องไม่ถูกแตะ
    const before = JSON.parse(fs.readFileSync(MACHINES_PATH, 'utf8'))
    const firstFactory = Object.keys(before)[0]
    const otherCount = countLeaves(before) - (before[firstFactory]['1'] || []).length

    const testRow = { id: 'ZZ-SMOKE-1', name: 'smoke', type: 'L', zone: 'Z', x: 12.3, y: 45.6 }
    const saveRes = await post('/api/layout/machines', { factory: 'ZZTEST', floor: 9, machines: [testRow] })
    const saveJson = await saveRes.json()
    check('POST บันทึกสำเร็จ', saveRes.status === 200 && saveJson.ok === true, JSON.stringify(saveJson))

    const after = JSON.parse(fs.readFileSync(MACHINES_PATH, 'utf8'))
    check('เขียนค่าที่ส่งไปลงไฟล์ถูกต้อง',
      JSON.stringify((after.ZZTEST || {})['9']) === JSON.stringify([testRow]),
      JSON.stringify((after.ZZTEST || {})['9']))
    check('ชั้น/โรงงานอื่นไม่ถูกแตะ',
      countLeaves(after) - 1 === countLeaves(before),
      'ก่อน ' + countLeaves(before) + ' หลัง ' + countLeaves(after))
    check('สร้างไฟล์สำรอง .bak ไว้ให้', fs.existsSync(MACHINES_PATH + '.bak'))
  } catch (e) {
    bad('ระหว่างทดสอบ HTTP', e.message)
  } finally {
    srv.kill()
    // ★ คืนไฟล์ผังกลับเป็นของเดิมเสมอ ไม่ว่าจะ pass หรือ fail
    fs.writeFileSync(MACHINES_PATH, backupMachines)
    fs.writeFileSync(ZONES_PATH, backupZones)
    for (const p of [MACHINES_PATH + '.bak', ZONES_PATH + '.bak', MACHINES_PATH + '.tmp', ZONES_PATH + '.tmp']) {
      try { fs.unlinkSync(p) } catch {}
    }
  }

  console.log('\n' + '─'.repeat(50))
  console.log(failed === 0
    ? `\x1b[32mผ่านทั้งหมด ${passed} ข้อ ✓\x1b[0m`
    : `\x1b[31mผ่าน ${passed} / ไม่ผ่าน ${failed}\x1b[0m`)
  process.exit(failed === 0 ? 0 : 1)
}

run().catch((e) => { console.error('\n[Smoke] ล้มเหลว:', e); process.exit(1) })

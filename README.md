# SENTRA — EAP Factory Dashboard

Real-time Machine Status Monitor สำหรับโรงงาน PA01 และ PA06
ดึงข้อมูลจาก Oracle DB ส่งผ่าน WebSocket มาแสดงบน Dashboard

## สถาปัตยกรรม

```
Oracle DB (PAEAPTRACE / DWD_PA01_PRD)
    ↓ poll ทุก 3 วินาที
Node.js Server (sentra-server.js)
    ↓ WebSocket push (เฉพาะที่เปลี่ยน)
Frontend Dashboard (index.html)
```

## ฟีเจอร์หลัก

### Realtime Dashboard
- สถานะเครื่องจักรแบบสี: RUN (เขียว) / IDLE (เหลือง) / DOWN (แดง) / NO_DATA (เทาจาง)
- อัพเดตอัตโนมัติผ่าน WebSocket ส่งเฉพาะเครื่องที่มีการเปลี่ยนแปลง
- แสดง LOT ID, Total Sheet, % QR, Error Sheet, เวลาอัปเดตล่าสุด
- แผนผังชั้นโรงงาน (1F / 2F) พร้อมตำแหน่งเครื่องจักรบนแผนที่

### หน้าเครื่อง (Machine Info Panel)
เปิดได้จากการคลิกที่เครื่องบนแผนที่ จะเปิด Info Panel ทางขวา:
- ข้อมูลเครื่องจักร (Mode, Status, Alarm, LOT ID, เวลาเริ่ม/จบ LOT, Total Sheet, % QR, Product ID)
- QR Code History — แสดงรายการแผ่นงานที่อ่าน QR ได้ จัดกลุ่มตาม LOT
- % QR ย้อนหลัง — ตารางสรุปรายวัน
- Status History — ประวัติสถานะ + Alarm พร้อม filter ตามหมวด (K / P / G)

### ดูข้อมูลย้อนหลัง (History Mode)
ในหน้าเครื่องมี date picker ที่หัวข้อ "ข้อมูลเครื่องจักร"
- เลือกวันที่ต้องการดู → ระบบโหลดสถานะเครื่องในวันนั้นจาก Oracle DB
- มี badge สีเหลืองบอกวันที่กำลังดูอยู่
- กดปุ่ม "วันนี้" เพื่อกลับเป็นข้อมูลสด
- ตอนเปลี่ยนวัน ระบบ sync QR Date Range และ Status History Date Range ไปที่วันเดียวกันให้อัตโนมัติ
- มี cache ทั้งฝั่ง server (5 นาที) และฝั่ง client (5 นาที) คลิกซ้ำไม่ต้อง query ใหม่
- ตอนโหลดจะแสดง skeleton fields แทน spinner เพื่อให้รู้สึกว่าตอบสนองเร็ว

### หน้าสรุปรายเครื่อง — กราฟแท่ง (`report.html`)
เปิดจากปุ่ม **📊 สรุปรายเครื่อง** บน header (**เปิดเป็นแท็บใหม่** แผนที่เดิมยังอยู่)
หรือเข้าตรงที่ `http://localhost:3001/report.html`
เอาไว้เทียบเครื่องต่อเครื่องในหน้าเดียว (หน้าแผนที่ดูทีละเครื่อง)

- ปุ่มลัดในหน้านี้: `1` / `2` / `3` สลับตัววัด · `/` ค้นหา · `R` รีเฟรช · `Esc` ล้างช่องค้นหา
- กราฟแท่งแนวนอน 3 ตัววัด สลับด้วยปุ่มบนแถบเครื่องมือ
  - **จำนวนแผ่น** — แท่งซ้อน อ่าน QR ได้ (เขียว) / Error (แดง) เห็นทั้งปริมาณและคุณภาพในแท่งเดียว
  - **% QR** — ไล่สีตามเป้า (`QR_TARGET_PCT`) พร้อมเส้นประเป้าหมาย
  - **แผ่น Error** — เรียงหาเครื่องที่อ่านไม่ออกเยอะสุด
- ช่วงเวลา: วันนี้ / เมื่อวาน / 7 วัน / 30 วัน / กำหนดเอง · กรองตามโรงงาน+ชั้น · ค้นหา · เรียง · Top N
- KPI ด้านบน: แผ่นทั้งหมด / อ่านได้ / อ่านไม่ได้ / % QR รวม / เครื่องที่มีข้อมูล / เครื่องที่ต่ำกว่าเป้า
  (นับตามตัวกรอง ไม่ลดลงตาม Top N ที่เป็นแค่การแสดงผล)
- คลิกที่แท่ง → เปิดหน้าเครื่องนั้นบนแผนที่ (`index.html?machine=<id>`) โดยใช้แท็บแผนที่เดิมซ้ำ
  หน้าสรุปไม่ถูกปิดทิ้ง และคลิกเครื่องถัดไปก็ไม่งอกแท็บใหม่เรื่อย ๆ (ปุ่ม "แผนที่" กับโลโก้ก็ไปแท็บเดียวกัน)
- ปุ่ม **⬇ CSV** (มี BOM เปิดใน Excel ภาษาไทย/จีนไม่เพี้ยน) และ **📷 PNG**
- รีเฟรชอัตโนมัติทุก 60 วินาที เฉพาะช่วงเวลาที่รวมวันนี้ (ดูย้อนหลังไม่ต้องรีเฟรช)
- เครื่องที่อยู่ในผังแต่ไม่มี event ในช่วงนั้นจะขึ้นเป็นยอด 0 (ไม่ได้หายไปเฉย ๆ) ปิดได้ด้วย checkbox
- ★ ตอนดู **% QR** ถ้าทุกเครื่องอยู่แถว ๆ 97-100% แกนจะตัดฐานขึ้นมาให้เห็นความต่าง
  และเขียนกำกับใต้หัวข้อว่า "แกนเริ่มที่ N%" — อย่าอ่านความยาวแท่งเป็นสัดส่วนจาก 0 ในโหมดนั้น
- ใช้ `GET /api/qr-summary` ที่มีอยู่แล้ว ไม่มี endpoint ใหม่ และวาดกราฟด้วย CSS/HTML ล้วน ไม่มีไลบรารีกราฟ

### Sidebar
- สรุปสถานะรวม (จำนวน RUN / IDLE / DOWN)
- % QR รวมของทุกเครื่อง (กดรีเฟรชได้)
- สรุปรายวัน (3 วัน) — Lots / Panels / Alarms

### รองรับมือถือ / แท็บเล็ต
- **ลากนิ้วเดียว** = เลื่อนแผนที่ · **สองนิ้ว (pinch)** = ซูมเข้า/ออก · **แตะสองครั้ง** = ซูมเข้า (แตะซ้ำตอนซูมสุด = กลับ 100%)
  จุดที่นิ้วจับอยู่จะอยู่กับที่ระหว่างซูม และใช้ค่า scale/pan ชุดเดียวกับเมาส์ ไม่ได้แยกโค้ดคนละทาง
- Layout ปรับตามขนาดจอ 3 ระดับ: แท็บเล็ต (≤768px) → sidebar เป็น overlay, info-panel เป็น bottom sheet, ปุ่มขยายเป็น 44px
  · มือถือจอแคบ (≤480px) → ซ่อน mini-map, ย่อ header, ตารางเลื่อนแนวนอนในกล่องตัวเอง
  · มือถือแนวนอน (สูง ≤500px) → ลดความสูง header, ซ่อน legend
- Zone Editor / Machine Drag ใช้ Pointer Events → วาดโซนและลากเครื่องด้วยนิ้วบนแท็บเล็ตได้

### เครื่องมือบนแผนที่
- Zoom In / Out / Reset (+ / − / 0)
- ถ่ายภาพหน้าจอเป็น PNG (P)
- แสดง/ซ่อน Zone
- Admin Mode (กด `A` + รหัสผ่าน `admin`):
  - Zone Editor — วาด / แก้ไข / ลบโซน (กด `E` เพื่อเปิดหน้าต่างบันทึก)
  - Machine Drag — ลากย้ายตำแหน่งเครื่องจักรบนแผนที่ (กด `M` เพื่อเปิดหน้าต่างบันทึก)
  - **บันทึกลง Server** — เขียนลง `backend/config/machines.json` / `zones.json` โดยตรง
    ทุกคนที่เปิดหน้านี้จะเห็นผังใหม่ทันทีหลังรีเฟรช ไม่ต้อง copy-paste โค้ดกลับมาแปะใน `index.html` อีก
    (ยังกด "คัดลอก JSON" เก็บไว้เองได้ถ้าต้องการ)

### อื่น ๆ
- ค้นหาเครื่องจักร (กด `/` แล้วพิมพ์)
- Alert Panel — แจ้งเตือนเครื่องที่มีปัญหา
- รองรับ 3 ภาษา: ไทย / English / 中文
- ทำงานในเครือข่ายภายในได้ 100% (ไม่ต้องต่อเน็ต — ใช้ฟอนต์ระบบ และไลบรารีภายนอกเก็บไว้ใน `frontend/vendor/` ไม่ได้ดึงจาก CDN)

## วิธีรัน

### 1. ติดตั้ง dependencies
```bash
cd sentra/backend
npm install
```

### 2. ตั้งค่า Oracle credentials
คัดลอกไฟล์ตัวอย่างแล้วใส่ค่าจริง:
```bash
copy .env.example .env
```

`backend/.env.example` มีคำอธิบายทุกตัวแปรอยู่แล้ว ตัวที่จำเป็นจริง ๆ มีแค่ 3 ตัว:
```env
ORACLE_CONNECTION_STRING=pafabdb01.eavarytech.com:1521/parpbn08
ORACLE_USER=INTELLIGENT_READ_PA01_PRD
ORACLE_PASSWORD=your_password_here
```

ตัวเลือกอื่นที่ใช้บ่อย:

| ตัวแปร | ค่าเริ่มต้น | ความหมาย |
|--------|------------|----------|
| `PORT` | 3001 | พอร์ตของ server |
| `POLL_INTERVAL_MS` | 3000 | poll Oracle ทุกกี่มิลลิวินาที |
| `POLL_MINUTES` | 2 | แต่ละรอบ poll มองย้อนหลังกี่นาที |
| `STALE_MINUTES` | = POLL_MINUTES | ไม่มีข้อมูลเกินกี่นาที = NO_DATA |
| `POLL_TIMEOUT_MS` | 15000 | query ของ poll ใช้เวลาได้สูงสุดเท่าไร เกินนี้ยกเลิกแล้วให้รอบถัดไปทำต่อ |
| `WS_HEARTBEAT_MS` | 30000 | ส่ง ping หา WebSocket client ทุกกี่มิลลิวินาที (ไม่ตอบ = ตัดทิ้ง) |
| `QR_LOG_RETENTION_DAYS` | 30 | เก็บไฟล์ QR log กี่วัน (ลบอัตโนมัติตอน start และวันละครั้งหลังจากนั้น) |
| `ALLOWED_MACHINES` | (ว่าง = ทุกเครื่อง) | จำกัดเฉพาะบางเครื่อง คั่นด้วย comma |
| `NVR_HOST` / `NVR_USER` / `NVR_PASSWORD` | (ว่าง) | กล้อง NVR — เว้นว่าง = ปิดฟีเจอร์ดูกล้อง |

ต้องเชื่อม VPN/เครือข่ายภายในก่อน ไม่งั้นเข้า Oracle ไม่ได้
(ถ้า Oracle ยังไม่ติด server จะยัง start ได้ปกติแล้ว retry ให้ทุก 30 วินาที)

### 3. รันเซิร์ฟเวอร์

วิธีง่าย (Windows): ดับเบิ้ลคลิก `backend\start-server.bat`

หรือพิมพ์ใน terminal:
```bash
npm start
# หรือ: node sentra-server.js
```

โหมดพัฒนา (auto-reload):
```bash
npm run dev
```

ตรวจว่าโค้ดยังทำงานถูกต้องหลังแก้ (ไม่ต้องต่อ Oracle):
```bash
npm test
```

รันสำเร็จแล้ว server จะแสดง LAN IP ทั้งหมดที่คนในวงเครือข่ายเดียวกันเข้าได้ ส่ง URL นั้นให้เพื่อนร่วมงานได้เลย

### 4. เปิด Dashboard
เปิด browser ไปที่:
```
http://localhost:3001/
```

สำคัญ: ต้องเปิดผ่าน `http://localhost:3001/` เท่านั้น ห้ามดับเบิ้ลคลิกไฟล์ `index.html` ตรง ๆ เพราะจะเป็น `file://` แล้ว fetch/WebSocket ไม่ได้

เลือก PA01 หรือ PA06 → เลือกชั้น (1F / 2F) → สถานะเครื่องจักรจะแสดงบนแผนที่

## กล้อง (Hikvision NVR / iVMS-4200)

★ ยังไม่ได้ทดสอบกับ NVR จริง (เขียนโดยไม่มี network access ไปหา NVR) — ต้องทดสอบกับเครื่องจริงก่อนใช้งาน

### ตั้งค่า
1. เติม `.env`: `NVR_HOST`, `NVR_PORT` (default 80), `NVR_USER`, `NVR_PASSWORD` (แนะนำสร้าง user read-only แยกใน iVMS-4200 ไม่ใช้ admin)
2. เติม `backend/config/camera-map.json` — map `machine_id` (ต้องตรงกับใน `MACHINES_DB` ของ `index.html`) ไปยังเลข channel ใน NVR เช่น:
   ```json
   { "machines": { "AOI-PEP-01-L": { "channel": 3 } } }
   ```
3. ทดสอบต่อ NVR ก่อน (ไม่ต้องรัน server เต็ม):
   ```bash
   node tools/test-camera-conn.js                       # เช็ค auth
   node tools/test-camera-conn.js --channel=3 --search   # เช็ค auth + ค้นหาคลิปย้อนหลัง 10 นาที
   ```

### วิธีใช้บนหน้าเว็บ
- เปิดหน้าเครื่อง → ส่วน **Status History** ทุกแถวที่เป็น ⚠ ALARM จะมีปุ่ม **📹** ท้ายแถว → กดแล้วเปิดวิดีโอ ณ เวลาที่เกิด alarm นั้น
- ในหน้าต่างกล้องมีปุ่มสลับ **🔴 ดูสด** / **⏪ ดูซ้ำช่วงเวลานี้** กด `Esc` เพื่อปิด
- ปุ่ม 📹 จะโผล่**เฉพาะเครื่องที่ map ไว้ใน `camera-map.json`** เท่านั้น (เครื่องอื่นไม่เห็นปุ่ม ไม่รก UI)

### วิธีทำงาน
- **Live view**: ใช้ ISAPI `httpPreview` (MJPEG over HTTP) — เล่นได้ตรงในเบราว์เซอร์ ไม่ต้องแปลง RTSP/HLS. Server proxy ให้เพื่อไม่ให้ credential ของ NVR หลุดไปฝั่ง client
- **Playback**: ใช้ ISAPI `ContentMgmt/search` หาคลิปที่ครอบคลุมเวลาที่ต้องการ แล้ว `ContentMgmt/download` ส่งไฟล์ผ่าน HTTP
- ⚠️ **จุดที่ต้องเช็คกับเครื่องจริง**: ไฟล์ที่ได้จาก `ContentMgmt/download` อาจเป็น PS (MPEG-2 Program Stream) ไม่ใช่ MP4 ขึ้นกับ firmware — ถ้าเบราว์เซอร์เล่นไม่ได้ ต้อง remux ด้วย ffmpeg (เป็น dependency ใหม่ ต้องคุยกันก่อนเพิ่ม)
- นาฬิกา NVR ต้องตรงกับเวลาเครื่อง server (ต่างกันเกิน ~5 วิ → กดดูตอน alarm จะได้ภาพผิดจังหวะ)

## Vendor Evidence Pack

★ ยังไม่ได้ทดสอบกับ Oracle จริง (เขียนโดยไม่มี network access ไปหา DB) — ต้องทดสอบก่อนใช้งาน

### ก่อนใช้งาน
1. รัน `CREATE TABLE FAULT_ZONE_MAP` ใน `backend/sql/oracle_setup.sql` ข้อ 6 (ยังไม่ได้รันบน DB จริง)
2. กรอกข้อมูลตาราง `FAULT_ZONE_MAP` เอง (ดู `backend/data/fault-zone-map-seed.csv` ที่สร้างจาก `node tools/seed-fault-zone-map.js` และตัวอย่างร่างใน `backend/data/fault-zone-map-draft-example.csv`)
3. เติม `.env`: `QR_TARGET_PCT` (default 99), `REPORT_PLANT`, `REPORT_CONTACT`, `DAY_SHIFT_START_HOUR` (default 8 = กะกลางวัน 08:00-20:00)

### ใช้งาน
เปิดหน้าเครื่อง → ในส่วน QR History กดปุ่ม **⬇PDF** (ใช้ช่วงวันที่เดียวกับที่เลือกไว้ใน QR History) → ระบบจะดึง fault ที่เกิดบ่อยสุดในช่วงนั้นมาสร้างรายงาน หรือระบุ fault เจาะจงเองผ่าน query param `alarm_text`

### Machine Zone Diagram (ส่วน schematic ใน PDF)
สร้าง**อัตโนมัติจากข้อมูลใน `FAULT_ZONE_MAP`** ไม่ต้องวาดรูปเอง — เป็นผังกล่องโซนเรียงซ้าย→ขวาตามทิศทางที่แผ่นวิ่ง พร้อมลูกศรเชื่อม โซนที่เกิด fault จะไฮไลต์สีแดง + มีเส้นชี้ลงมาที่ชื่อ fault

- เรียงกล่องตามคอลัมน์ `ZONE_ORDER` (เลขน้อยอยู่ซ้าย แนะนำเว้นช่วง 10/20/30/40 จะได้แทรกทีหลังง่าย) ถ้าปล่อยเป็น 0 หมดจะเรียงตาม `ZONE_ID` แทน แต่ไม่สื่อทิศทางการไหลจริง
- เพิ่มเครื่องรุ่นใหม่ = เพิ่มแถวใน `FAULT_ZONE_MAP` อย่างเดียว **ไม่ต้องแก้โค้ด**
- ⚠️ **ไม่ใช่รูปเครื่องจริง** — เป็น diagram เชิงกระบวนการ ถ้าต้องการ side-elevation ที่เหมือนเครื่องจริง ต้องส่งรูปถ่าย/แบบ CAD มาให้วาดเพิ่ม

### ข้อจำกัดที่รู้อยู่แล้ว
- `machine_type` derive จาก `machine_id` อัตโนมัติ (ตัดเลขไลน์ + role ท้ายออก เช่น `DRL-DEP-03-M1` → `DRL-DEP`) — เครื่องรุ่นเดียวกันหลายไลน์ใช้ mapping เดียวกันได้
- ถ้าไม่มีแถวใน `FAULT_ZONE_MAP` ตรงกับ fault นั้น → รายงานยังออกได้ปกติ แค่ไม่มี zone highlight/causes (degrade ตามที่ออกแบบไว้)
- "Representative occurrence" เลือกจาก occurrence ที่มี alarm รอบข้าง (±60 วิ) เยอะที่สุดในช่วงเวลาที่เลือก
- ฟอนต์ PDF ต้องครอบคลุมภาษาจีน/ไทย (default = Arial Unicode MS ที่มากับ Windows) ถ้าเครื่องที่ deploy ไม่มี ต้องตั้ง `PDF_FONT_PATH` ใน `.env` ไม่งั้นตัวอักษรจีนจะเพี้ยน

## API Endpoints

| Endpoint | คำอธิบาย |
|----------|----------|
| `GET /health` | สถานะเซิร์ฟเวอร์ + uptime + จำนวนเครื่องใน snapshot |
| `GET /api/snapshot` | Snapshot สถานะเครื่องจักรทั้งหมด (JSON) |
| `GET /api/machines` | รายชื่อเครื่องจักรทั้งหมดจาก DB |
| `GET /api/lot-report?days=7` | สรุป Lot ย้อนหลัง N วัน (1–30) |
| `GET /api/qr-history?machine_id=X&range=today` | ประวัติ QR ของเครื่อง (group by LOT) — รองรับ `limit`, `offset`, `start_date`, `end_date` |
| `GET /api/qr-daily?machine_id=X&range=week` | % QR รายวันของเครื่อง (หลายวัน) |
| `GET /api/status-history?machine_id=X&range=today` | ประวัติ EQPSTATUS ทั้งวัน — รองรับ `limit`, `offset`, `alarm_category` |
| `GET /api/machine-history?machine_id=X&date=YYYY-MM-DD` | สถานะล่าสุดของเครื่องในวันที่เลือก (ใช้สำหรับ History Mode ในหน้าเครื่อง) |
| `GET /api/qr-summary?range=today` | สรุป % QR รวมทุกเครื่อง (สำหรับ sidebar) |
| `GET /api/qr-export?machine_id=X&range=today` | Export ประวัติ QR เป็น CSV (download) |
| `GET /api/qr-logs/qr-YYYY-MM-DD.csv` | ดาวน์โหลดไฟล์ QR log รายวัน |
| `GET /api/layout` | ผังเครื่องจักร + โซนทั้งหมด (frontend โหลดตอน boot) — อ่านจาก `backend/config/machines.json` + `zones.json` |
| `POST /api/layout/machines` | บันทึกตำแหน่งเครื่องจักรของ 1 ชั้น — body: `{factory, floor, machines:[{id,name,type,zone,x,y}]}` |
| `POST /api/layout/zones` | บันทึกโซนของ 1 ชั้น — body: `{factory, floor, zones:[{name,nameKey?,fill,border,points:[{x,y}]}]}` |
| `GET /api/camera-map` | รายชื่อเครื่องที่ map กล้องไว้ (frontend ใช้ตัดสินใจโชว์ปุ่ม 📹) |
| `GET /api/camera-live?machine_id=X` | Live view กล้อง (MJPEG, proxy ผ่าน server) — ต้องมี mapping ใน `camera-map.json` |
| `GET /api/camera-playback?machine_id=X&time=ISO` | วิดีโอย้อนหลัง ณ เวลาที่ระบุ (ค้นหาคลิป ±5 นาทีรอบเวลานั้น) |
| `GET /api/machines/evidence-pack?machine_id=X&alarm_text=Y&range=week` | สร้าง PDF Vendor Evidence Pack — ไม่ระบุ `alarm_text` = auto เลือก fault ที่เกิดบ่อยสุดในช่วงเวลา รองรับ `start_date`/`end_date` แทน `range` ได้เหมือน endpoint อื่น |
| `ws://localhost:3001/ws` | WebSocket สำหรับ real-time updates (push SNAPSHOT + CHANGES) |

ค่า `range` ที่รองรับ: `today` (default) / `yesterday` / `week` (7 วัน) / `month` (30 วัน) หรือกำหนด `start_date` + `end_date` (YYYY-MM-DD) เอง

`POST /api/layout/*` เขียนทับเฉพาะ factory/floor ที่ส่งมา ชั้นอื่นในไฟล์ไม่ถูกแตะ และสำรองไฟล์เดิมไว้เป็น `.bak` ให้อัตโนมัติ
ถ้าค่าไม่ผ่านการตรวจ (พิกัดนอกช่วง 0-100, ไม่มี id, โซนมีน้อยกว่า 3 จุด) จะตอบ 400 พร้อมบอกว่าแถวไหนผิด — ไฟล์เดิมไม่ถูกแก้

## การปรับแต่ง Polling

| ค่า (`.env`) | คำแนะนำ | ผลกระทบ |
|--------------|---------|---------|
| `POLL_INTERVAL_MS=3000` | ค่าเริ่มต้น สมดุล | อัพเดตทุก 3 วิ โหลด Oracle ปานกลาง |
| `POLL_INTERVAL_MS=5000` | ประหยัดทรัพยากร | ดีเลย์ 5 วิ โหลด Oracle ลดลง ~40% |
| `POLL_INTERVAL_MS=10000` | ประหยัดมาก | ดีเลย์ 10 วิ |
| `POLL_MINUTES=2` | ดึงแค่ 2 นาทีล่าสุด | เหมาะกับสถานะปัจจุบัน |
| `POLL_MINUTES=30` | ดึงล่าสุด 30 นาที | query ช้าลง ไม่จำเป็น |
| `STALE_MINUTES=2` | ค่าเริ่มต้น = `POLL_MINUTES` | ถ้าเครื่องไม่ active ในช่วงนี้ → สีเทาจาง (NO_DATA) |
| `ALLOWED_MACHINES=MC001,MC002` | จำกัดเฉพาะเครื่อง (สำหรับเทส) | `null` = ทุกเครื่อง |

## ปุ่มลัด

| ปุ่ม | การทำงาน |
|-----|---------|
| `+` / `=` | Zoom In |
| `-` / `_` | Zoom Out |
| `0` / `Home` | Reset Zoom |
| `F` | เปิด/ปิด Sidebar |
| `P` | ถ่ายภาพหน้าจอ (PNG) |
| `A` | เข้า Admin Mode (ต้องใส่รหัสผ่าน) |
| `E` | (Admin + Zone Editor) เปิดหน้าต่างบันทึกโซนลง server |
| `M` | (Admin + Machine Drag) เปิดหน้าต่างบันทึกตำแหน่งเครื่องจักรลง server |
| `/` | โฟกัสช่องค้นหา |
| `?` | แสดงคำแนะนำปุ่มลัด |
| `Esc` | ปิด popup / alert / ออกจากช่องค้นหา |

## เทคโนโลยี

- Backend: Node.js + `oracledb` 6 (thin mode, ไม่ต้องติดตั้ง Oracle Client) + `ws` (WebSocket)
- Frontend: HTML/CSS/JavaScript ล้วน (ไม่มี framework, ไม่มี build step)
- Database: Oracle (read-only จาก `PAEAPTRACE.EAP_EQP_EVENT_PNL_PNL`, `EAP_EQP_ALM`, `EAP_EQP_TRACE`, `DWD_PA01_PRD.LOTINFO_MAIN`)
- Realtime: WebSocket push + change detection (ส่งเฉพาะที่เปลี่ยน, ลด bandwidth)
- Resilience: Oracle disconnect → retry ทุก 30 วินาทีอัตโนมัติ (server ไม่ exit),
  poll watchdog ตัด query ที่ค้าง, WebSocket heartbeat ตัด client ที่ตายแล้วทิ้ง
- Static files: serve แบบ stream + ETag/304 + `Cache-Control` (รูปแผนที่ cache 1 วัน)
- QR Log: เขียนไฟล์ CSV รายวันที่ `backend/qr-logs/` อัตโนมัติ (เก็บ 30 วัน)

## โครงสร้างโปรเจกต์

```
sentra/
├── backend/
│   ├── sentra-server.js           ← main entry point (HTTP + WS + Oracle poll)
│   ├── .env                    ← Oracle credentials + config (git-ignored)
│   ├── .env.example            ← ตัวอย่าง .env พร้อมคำอธิบายทุกตัวแปร (คัดลอกไปเป็น .env)
│   ├── start-server.bat        ← ตัวเริ่มเซิร์ฟเวอร์บน Windows
│   ├── package.json
│   │
│   ├── lib/                    ← โมดูลที่ sentra-server.js require เข้าไปใช้
│   │   ├── hikvision.js        ← ISAPI client (digest auth + live/playback) สำหรับกล้อง NVR
│   │   └── evidence-pack.js    ← Vendor Evidence Pack: query + PDF generation (pdfkit)
│   │
│   ├── config/                 ← ไฟล์ตั้งค่าที่แก้ได้โดยไม่ต้อง restart (อ่านใหม่ทุกครั้งที่เรียก)
│   │   ├── camera-map.json     ← mapping machine_id → channel กล้องใน NVR
│   │   ├── machines.json       ← ผังเครื่องจักร (id/name/type/zone/x/y) แยกตามโรงงาน+ชั้น
│   │   └── zones.json          ← รูปหลายเหลี่ยมของโซนบนแผนที่ แยกตามโรงงาน+ชั้น
│   │
│   ├── sql/                    ← SQL ที่รันมือ ไม่ได้ถูกเรียกจากโค้ด
│   │   ├── oracle_setup.sql    ← สร้างตาราง History + index + GRANT + purge job
│   │   └── index_recommendations.sql  ← SQL อ้างอิงสำหรับดึงสถานะเครื่อง + QR %
│   │
│   ├── tools/                  ← สคริปต์รันมือทั้งหมด (SELECT อย่างเดียว) — ดู tools/README.md
│   │   ├── verify-panel-count.js      ← ตรวจการนับแผ่น: เทียบวิธีเดิม vs ปัจจุบัน รายเครื่อง
│   │   ├── diagnose-panel-ids.js      ← ฟอร์แมต PANEL_ID / สาเหตุที่แผ่นซ้ำ
│   │   ├── diagnose-event-types.js    ← ค่าของ CEID / PANELTYPE
│   │   ├── diagnose-lot-id-gaps.js    ← ผลกระทบของแถวที่ LOT_ID ว่าง
│   │   ├── test-conn.js               ← ทดสอบ Oracle connection
│   │   ├── test-camera-conn.js        ← ทดสอบต่อ NVR
│   │   ├── check-evidence-setup.js    ← ตรวจว่า Evidence Pack พร้อมใช้หรือยัง
│   │   ├── list-alarm-codes.js        ← สำรวจรูปแบบ ALARM_TEXT ใน EAP_EQP_ALM
│   │   ├── seed-fault-zone-map.js     ← สร้าง data/fault-zone-map-seed.csv ให้กรอก zone/severity/causes เอง
│   │   ├── smoke-test.js              ← `npm test` — ตรวจ config/API/static/การบันทึกผัง (ไม่ต้องต่อ Oracle)
│   │   ├── run-tools.bat              ← เมนูเลือกรัน (double-click ได้)
│   │   └── output/             ← (auto, git-ignored) ผลลัพธ์ UTF-8 ของสคริปต์ข้างบน
│   │
│   ├── data/
│   │   ├── fault-zone-map-draft-example.csv  ← ตัวอย่างการกรอก FAULT_ZONE_MAP
│   │   └── fault-zone-map-seed.csv           ← (auto, git-ignored) สร้างจาก seed-fault-zone-map.js
│   │
│   └── qr-logs/                ← (auto, git-ignored) CSV รายวัน — สร้างอัตโนมัติตอนรัน
│
└── frontend/
    ├── index.html              ← Dashboard (HTML + CSS + JS ในไฟล์เดียว)
    │                              ★ ผังเครื่องจักร/โซนไม่ได้ฝังในนี้แล้ว — โหลดจาก GET /api/layout ตอน boot
    ├── report.html             ← หน้าสรุปรายเครื่อง (กราฟแท่ง) — แยกไฟล์ ไม่แตะ index.html
    │                              ใช้ /api/layout + /api/qr-summary, กราฟวาดด้วย CSS ล้วน
    ├── vendor/                 ← ไลบรารีภายนอกที่เก็บไว้ในโปรเจกต์เอง (ไม่พึ่ง CDN — หน้างานไม่มีเน็ต)
    │   └── html2canvas.min.js   ← ใช้โดยปุ่มถ่ายภาพหน้าจอ (P) — html2canvas 1.4.1, MIT
    ├── i18n/                   ← คำแปล โหลดผ่าน <script src="i18n/xx.js">
    │   ├── th.js               ← ภาษาไทย
    │   ├── en.js               ← ภาษาอังกฤษ
    │   └── ch.js               ← ภาษาจีน
    └── maps/                   ← แผนผังโรงงาน อ้างใน MACHINES_DB ว่า 'maps/PAxx_xF.jpg'
        ├── PA01_1F.jpg / PA01_2F.jpg   ← PA01 ชั้น 1 / 2
        └── PA06_1F.jpg / PA06_2F.jpg   ← PA06 ชั้น 1 / 2
```

> เซิร์ฟเวอร์ serve ไฟล์ static แบบรวม subfolder อยู่แล้ว (`path.join(frontendDir, urlPath)`
> พร้อม guard กัน path traversal) เพิ่มโฟลเดอร์ใหม่ใน `frontend/` ได้เลยโดยไม่ต้องแก้โค้ด

## การแก้ปัญหา

| อาการ | สาเหตุ | วิธีแก้ |
|------|------|------|
| หน้าเว็บเปิดไม่ได้ | ยังไม่รัน server | รัน `start-server.bat` หรือ `node sentra-server.js` |
| "Oracle connection FAILED" | ยังไม่สลับ wifi/VPN | สลับเข้าเครือข่ายบริษัท → server จะ retry ทุก 30 วิ อัตโนมัติ |
| โหลดไม่ได้ในเว็บ | เปิดเป็น `file://` | เปิดผ่าน `http://localhost:3001/` เท่านั้น |
| ข้อมูลไม่ขึ้น | Oracle ยังไม่ติด | ดู terminal — รอ retry หรือเช็ค wifi อีกครั้ง |
| Dashboard ไม่อัพเดต | WebSocket ตัด | เปิด console (F12) ดูสถานะ WS และ `#cdot` สีเขียวหรือไม่ |
| ปุ่ม PA02–PA05, PA07 กดไม่ได้ | ปกติ | ตอนนี้ใช้ได้แค่ PA01 และ PA06 (ดู `active:false` ใน `FACTORIES` ใน `index.html`) |
| ต้องการเข้า Admin Mode | ต้องใส่รหัส | กด `A` → รหัสผ่าน `admin` (เปลี่ยนได้ใน `index.html` ตรง `ADMIN_PASSWORD`) |
| ดูข้อมูลย้อนหลังช้า | cache miss ครั้งแรก | คลิกซ้ำจะเร็วขึ้น (cache 5 นาที) ถ้ายังช้าอาจเป็นเพราะ Oracle ไม่มี index ดูด้านล่าง |

### ถ้าดูข้อมูลย้อนหลังยังช้าหลัง cache miss ครั้งแรก

ดู backend console log จะมีข้อความ `[MachineHistory] query <machineId> @ <date> took XXXms` บอกเวลาจริง
- ถ้าเกิน 1 วินาที → อาจเป็นเพราะ Oracle ไม่มี index ที่เหมาะสม
- แนะนำให้ DBA รันคำสั่งสร้าง index ตามที่อยู่ใน `backend/sql/index_recommendations.sql`
- หรือลอง `EXPLAIN PLAN FOR <query>` ดูว่า Oracle ใช้ index หรือเปล่า

ตรวจสอบเชื่อม Oracle ได้จริง:
```bash
node tools/test-conn.js
# หรือเปิด browser ไป http://localhost:3001/api/lot-report?days=1
# ถ้าได้ JSON มี rows แปลว่า Oracle ติด
```

## Notes

- โฟลเดอร์ `backend/src/` เป็น modular version (poller / alertEngine / historyWriter / wsHub) ที่ยังไม่สมบูรณ์ ไม่ถูกใช้งานจริง — ทุกอย่างรวมอยู่ใน `sentra-server.js` ไฟล์เดียว
- หากต้องการใช้ Redis pub/sub สำหรับ multi-instance ในอนาคต ดูโครงสร้างเดิมใน `src/` เป็นจุดเริ่มต้น
- Server ผูกกับ `0.0.0.0` — คนในวงเครือข่ายเดียวกันสามารถเข้าผ่าน LAN IP ของเครื่องที่รัน server ได้
- QR log CSV แบ่งตามวันที่ `qr-logs/qr-YYYY-MM-DD.csv` — ลบไฟล์เก่ากว่า 30 วันอัตโนมัติตอน server start (โฟลเดอร์นี้อยู่ใน `.gitignore` ไม่ถูก commit ขึ้น git)
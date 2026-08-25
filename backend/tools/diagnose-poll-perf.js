/*
  Why did the poll query start hitting NJS-123 today?

  The poll SQL scans PAEAPTRACE.EAP_EQP_EVENT_PNL_PNL twice: once over
  POLL_MINUTES (light) and once over PANEL_STATS_MINUTES (heavy, 24h by
  default). This tool measures that heavy half on its own so we can tell
  WHICH of these is true:

    1. row volume grew  -> rows/hour today is much higher than usual
    2. the query never had headroom -> time scales smoothly with the window
       and 24h simply lands past 15s
    3. the plan went bad -> time explodes between two adjacent windows
       (e.g. 240min is 2s but 480min is 40s) with no matching row growth

  Read-only. Runs each step with its own generous timeout, so it reports a
  number instead of dying the way the server does.

  Usage:  node tools/diagnose-poll-perf.js

  Keep output pure ASCII - cmd.exe on this machine runs code page 950.
*/

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const oracledb = require('oracledb')

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT
oracledb.fetchAsString = [oracledb.CLOB]

// Per-step ceiling. Far above the server's POLL_TIMEOUT_MS on purpose: we want
// the real duration, not another timeout.
const STEP_TIMEOUT_MS = 120000
// Stop widening the window once a step gets this slow - no point waiting 2min
// on every remaining size once we have seen the cliff.
const GIVE_UP_MS = 60000

const WINDOWS = [15, 60, 240, 480, 720, 1440]

// ---- copied verbatim from sentra-server.js so we measure the real thing ----
const NORM_PANEL = `UPPER(REGEXP_SUBSTR(DBMS_LOB.SUBSTR(PANEL_ID, 100, 1), '^[^,/]+'))`
const IS_JUNK_PANEL = `(
       ${NORM_PANEL} LIKE 'DUMMY%'
       OR REGEXP_LIKE(${NORM_PANEL}, 'M[0-9]{7}[A-Z][0-9]{4}')
       OR REGEXP_LIKE(${NORM_PANEL}, '[^0-9A-Z]')
       OR LENGTH(${NORM_PANEL}) < 10
     )`
const IS_UNREAD = `(PANEL_ID IS NULL OR DBMS_LOB.GETLENGTH(PANEL_ID) = 0 OR UPPER(DBMS_LOB.SUBSTR(PANEL_ID, 5, 1)) = 'ERROR' OR UPPER(DBMS_LOB.SUBSTR(PANEL_ID, 20, 1)) LIKE '%NULL%')`
const PANEL_FLAGS = `
          ${NORM_PANEL} AS NORM_PANEL,
          CASE WHEN ${IS_UNREAD} THEN 1 ELSE 0 END AS IS_UNREAD,
          CASE WHEN ${IS_UNREAD} THEN 0
               WHEN ${IS_JUNK_PANEL} THEN 0
               ELSE 1 END AS IS_REAL`
const COUNT_OK = `COUNT(DISTINCT CASE WHEN IS_REAL = 1 THEN NORM_PANEL END)`
const COUNT_ERR = `SUM(IS_UNREAD)`
const IS_PANEL_EVENT = `(CEID IS NULL OR TO_CHAR(CEID) <> '10117')`
const TABLE = 'PAEAPTRACE.EAP_EQP_EVENT_PNL_PNL'
// ---------------------------------------------------------------------------

function pad(s, n) { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)) }
function padL(s, n) { s = String(s); return ' '.repeat(Math.max(0, n - s.length)) + s }
function fmtMs(ms) { return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms' }

async function timed(conn, sql) {
  conn.callTimeout = STEP_TIMEOUT_MS
  const t0 = Date.now()
  try {
    const r = await conn.execute(sql)
    return { ms: Date.now() - t0, rows: r.rows }
  } catch (e) {
    return { ms: Date.now() - t0, error: e.message }
  }
}

async function main() {
  const connectString = process.env.ORACLE_CONNECTION_STRING
  console.log('=== SENTRA poll-query performance diagnosis ===')
  console.log('DB     : ' + connectString)
  console.log('Table  : ' + TABLE)
  console.log('.env   : POLL_MINUTES=' + process.env.POLL_MINUTES +
              '  PANEL_STATS_MINUTES=' + process.env.PANEL_STATS_MINUTES +
              '  POLL_TIMEOUT_MS=' + process.env.POLL_TIMEOUT_MS)
  console.log('')

  const pool = await oracledb.createPool({
    user: process.env.ORACLE_USER,
    password: process.env.ORACLE_PASSWORD,
    connectString,
    poolMin: 1, poolMax: 1, poolIncrement: 0, poolTimeout: 10,
  })
  const conn = await pool.getConnection()

  try {
    // --- 1. is today's data volume abnormal? -------------------------------
    console.log('--- [1] rows per hour, last 48h (is today unusually busy?) ---')
    const hist = await timed(conn, `
      SELECT TO_CHAR(TRUNC(DATE_TIME, 'HH24'), 'MM-DD HH24') AS HR, COUNT(*) AS N
      FROM ${TABLE}
      WHERE DATE_TIME >= SYSDATE - 2
      GROUP BY TRUNC(DATE_TIME, 'HH24')
      ORDER BY 1`)
    if (hist.error) {
      console.log('  FAILED: ' + hist.error)
    } else {
      const rows = hist.rows
      const counts = rows.map(r => Number(r.N))
      const max = Math.max(1, ...counts)
      for (const r of rows) {
        const n = Number(r.N)
        const bar = '#'.repeat(Math.max(1, Math.round((n / max) * 40)))
        console.log('  ' + pad(r.HR, 9) + padL(n, 7) + '  ' + bar)
      }
      const half = Math.ceil(rows.length / 2)
      const older = counts.slice(0, half).reduce((a, b) => a + b, 0)
      const newer = counts.slice(half).reduce((a, b) => a + b, 0)
      console.log('')
      console.log('  previous 24h : ' + older + ' rows')
      console.log('  latest   24h : ' + newer + ' rows'
        + (older > 0 ? '   (' + (newer / older).toFixed(2) + 'x)' : ''))
    }
    console.log('')

    // --- 2. how does the heavy half scale with the window? ----------------
    console.log('--- [2] the heavy aggregate (panel_base + panel_stats), by window ---')
    console.log('  ' + pad('window', 10) + padL('rows', 9) + padL('scan', 10) + padL('aggregate', 12) + '  verdict')
    let lastMs = 0
    for (const w of WINDOWS) {
      const cnt = await timed(conn, `
        SELECT COUNT(*) AS N FROM ${TABLE}
        WHERE DATE_TIME >= SYSDATE - ${w}/1440 AND ${IS_PANEL_EVENT}`)
      if (cnt.error) { console.log('  ' + pad(w + ' min', 10) + '  scan FAILED: ' + cnt.error); break }
      const n = Number(cnt.rows[0].N)

      const agg = await timed(conn, `
        WITH panel_base AS (
          SELECT COALESCE(SUB_EQP_ID, MAIN_EQP_ID) AS MACHINE_ID, LOT_ID, DATE_TIME,
${PANEL_FLAGS}
          FROM ${TABLE}
          WHERE DATE_TIME >= SYSDATE - ${w}/1440 AND ${IS_PANEL_EVENT}
        )
        SELECT MACHINE_ID, ${COUNT_OK} AS OK_PANELS, ${COUNT_ERR} AS ERROR_COUNT
        FROM panel_base GROUP BY MACHINE_ID`)

      let verdict = ''
      if (agg.error) {
        verdict = 'FAILED: ' + agg.error
      } else {
        const perRow = n > 0 ? (agg.ms / n) : 0
        verdict = perRow.toFixed(2) + ' ms/row'
        // a jump far steeper than the row growth means the plan changed
        if (lastMs > 0 && agg.ms > lastMs * 4) verdict += '   <-- CLIFF (plan change?)'
        if (Number(process.env.POLL_TIMEOUT_MS || 15000) < agg.ms) verdict += '   <-- over POLL_TIMEOUT_MS'
        lastMs = agg.ms
      }
      console.log('  ' + pad(w + ' min', 10) + padL(n, 9) + padL(fmtMs(cnt.ms), 10) +
                  padL(agg.error ? 'ERR' : fmtMs(agg.ms), 12) + '  ' + verdict)

      if (!agg.error && agg.ms > GIVE_UP_MS) {
        console.log('  (stopping here - already past ' + fmtMs(GIVE_UP_MS) + ')')
        break
      }
      if (agg.error) break
    }
    console.log('')

    // --- 3. are the table stats stale? ------------------------------------
    console.log('--- [3] optimizer stats (stale stats = bad plan) ---')
    const stats = await timed(conn, `
      SELECT OWNER, TABLE_NAME, NUM_ROWS,
             TO_CHAR(LAST_ANALYZED, 'YYYY-MM-DD HH24:MI') AS LAST_ANALYZED, STALE_STATS
      FROM ALL_TAB_STATISTICS
      WHERE OWNER = 'PAEAPTRACE' AND TABLE_NAME = 'EAP_EQP_EVENT_PNL_PNL'
        AND OBJECT_TYPE = 'TABLE'`)
    if (stats.error) {
      console.log('  cannot read (no privilege on ALL_TAB_STATISTICS): ' + stats.error)
    } else if (!stats.rows.length) {
      console.log('  no stats row found - table may never have been analyzed')
    } else {
      for (const r of stats.rows) {
        console.log('  NUM_ROWS=' + r.NUM_ROWS + '  LAST_ANALYZED=' + r.LAST_ANALYZED +
                    '  STALE_STATS=' + r.STALE_STATS)
      }
      console.log('  (LAST_ANALYZED long ago, or STALE_STATS=YES, points at a bad plan)')
    }
    console.log('')

    // --- 4. is DATE_TIME actually indexed? --------------------------------
    console.log('--- [4] indexes on DATE_TIME (no index = full table scan) ---')
    const idx = await timed(conn, `
      SELECT I.INDEX_NAME, C.COLUMN_POSITION, C.COLUMN_NAME
      FROM ALL_IND_COLUMNS C JOIN ALL_INDEXES I
        ON I.OWNER = C.INDEX_OWNER AND I.INDEX_NAME = C.INDEX_NAME
      WHERE C.TABLE_OWNER = 'PAEAPTRACE' AND C.TABLE_NAME = 'EAP_EQP_EVENT_PNL_PNL'
      ORDER BY I.INDEX_NAME, C.COLUMN_POSITION`)
    if (idx.error) {
      console.log('  cannot read: ' + idx.error)
    } else if (!idx.rows.length) {
      console.log('  NO INDEXES AT ALL -> every poll full-scans the table')
    } else {
      for (const r of idx.rows) {
        console.log('  ' + pad(r.INDEX_NAME, 34) + ' col' + r.COLUMN_POSITION + ' = ' + r.COLUMN_NAME)
      }
      const onDate = idx.rows.some(r => r.COLUMN_NAME === 'DATE_TIME' && Number(r.COLUMN_POSITION) === 1)
      console.log('  DATE_TIME leads an index: ' + (onDate ? 'YES' : 'NO  <-- full scan every 3 seconds'))
    }
  } finally {
    try { await conn.close() } catch (e) {}
    try { await pool.close(5) } catch (e) {}
  }

  console.log('')
  console.log('=== done - send this whole output back ===')
}

main().catch(e => { console.error('FAILED: ' + e.message); process.exit(1) })

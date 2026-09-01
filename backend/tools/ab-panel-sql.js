/*
  A/B test: can the 24h aggregate be made fast WITHOUT shrinking the window?

  diagnose-poll-perf.js showed where the time goes:
      scan 140,854 rows = 62ms      <- reading the table is basically free
      aggregate          = 14.7s    <- 99.6% of the time is per-row work

  That per-row work is the CLOB handling. Per row the current SQL evaluates:
      NORM_PANEL  5x  (1 in the select list + 4 inlined in the junk check)
      IS_UNREAD   2x  (3 DBMS_LOB calls each = 6 calls)
  so ~11 DBMS_LOB calls and 3 regexes on every one of the 140k rows.

  Variant B computes each of those exactly once in an inner block, then reuses
  the plain VARCHAR2 result. Same inputs, same output - just not recomputed.

  Variant B is what sentra-server.js SHIPS today (panelBaseSql()). Variant A is
  kept here as the old shape so the two can still be compared side by side.

  This tool runs A and B on the same window and checks BOTH:
      - is B actually faster
      - does B return byte-identical numbers to A (this is the part that
        matters: a faster query that changes %QR is worthless)

  Run this on a machine that can reach the DB before trusting the new numbers.
  Worth running at 1440 (one day) and again at 10080 (seven days), because the
  7-day report is where the old shape ran out of time.

  Read-only. Usage:  node tools/ab-panel-sql.js [windowMinutes]
  Keep output pure ASCII - cmd.exe on this machine runs code page 950.
*/

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const oracledb = require('oracledb')

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT
oracledb.fetchAsString = [oracledb.CLOB]

const WINDOW = parseInt(process.argv[2] || process.env.PANEL_STATS_MINUTES || '1440')
const STEP_TIMEOUT_MS = 180000
const TABLE = 'PAEAPTRACE.EAP_EQP_EVENT_PNL_PNL'
const IS_PANEL_EVENT = `(CEID IS NULL OR TO_CHAR(CEID) <> '10117')`

// ---- A: exactly what sentra-server.js runs today --------------------------
const A_NORM = `UPPER(REGEXP_SUBSTR(DBMS_LOB.SUBSTR(PANEL_ID, 100, 1), '^[^,/]+'))`
const A_JUNK = `(
       ${A_NORM} LIKE 'DUMMY%'
       OR REGEXP_LIKE(${A_NORM}, 'M[0-9]{7}[A-Z][0-9]{4}')
       OR REGEXP_LIKE(${A_NORM}, '[^0-9A-Z]')
       OR LENGTH(${A_NORM}) < 10
     )`
const A_UNREAD = `(PANEL_ID IS NULL OR DBMS_LOB.GETLENGTH(PANEL_ID) = 0 OR UPPER(DBMS_LOB.SUBSTR(PANEL_ID, 5, 1)) = 'ERROR' OR UPPER(DBMS_LOB.SUBSTR(PANEL_ID, 20, 1)) LIKE '%NULL%')`

const SQL_A = `
  WITH panel_base AS (
    SELECT COALESCE(SUB_EQP_ID, MAIN_EQP_ID) AS MACHINE_ID, LOT_ID, DATE_TIME,
           ${A_NORM} AS NORM_PANEL,
           CASE WHEN ${A_UNREAD} THEN 1 ELSE 0 END AS IS_UNREAD,
           CASE WHEN ${A_UNREAD} THEN 0
                WHEN ${A_JUNK} THEN 0
                ELSE 1 END AS IS_REAL
    FROM ${TABLE}
    WHERE DATE_TIME >= SYSDATE - ${WINDOW}/1440 AND ${IS_PANEL_EVENT}
  )
  SELECT MACHINE_ID,
         COUNT(DISTINCT CASE WHEN IS_REAL = 1 THEN NORM_PANEL END) AS OK_PANELS,
         SUM(IS_UNREAD) AS ERROR_COUNT
  FROM panel_base GROUP BY MACHINE_ID ORDER BY MACHINE_ID`

// ---- B: same logic, each CLOB expression evaluated once -------------------
// NO_MERGE keeps Oracle from folding the blocks back together and undoing it.
const SQL_B = `
  WITH raw_rows AS (
    SELECT /*+ NO_MERGE */
           COALESCE(SUB_EQP_ID, MAIN_EQP_ID) AS MACHINE_ID, LOT_ID, DATE_TIME,
           DBMS_LOB.SUBSTR(PANEL_ID, 100, 1) AS PANEL_TXT,
           DBMS_LOB.GETLENGTH(PANEL_ID)      AS PANEL_LEN
    FROM ${TABLE}
    WHERE DATE_TIME >= SYSDATE - ${WINDOW}/1440 AND ${IS_PANEL_EVENT}
  ),
  norm_rows AS (
    SELECT /*+ NO_MERGE */
           MACHINE_ID, LOT_ID, DATE_TIME,
           UPPER(REGEXP_SUBSTR(PANEL_TXT, '^[^,/]+')) AS NORM_PANEL,
           CASE WHEN PANEL_TXT IS NULL
                  OR PANEL_LEN = 0
                  OR UPPER(SUBSTR(PANEL_TXT, 1, 5))  = 'ERROR'
                  OR UPPER(SUBSTR(PANEL_TXT, 1, 20)) LIKE '%NULL%'
                THEN 1 ELSE 0 END AS IS_UNREAD
    FROM raw_rows
  ),
  panel_base AS (
    SELECT MACHINE_ID, LOT_ID, DATE_TIME, NORM_PANEL, IS_UNREAD,
           CASE WHEN IS_UNREAD = 1 THEN 0
                WHEN NORM_PANEL LIKE 'DUMMY%'
                  OR REGEXP_LIKE(NORM_PANEL, 'M[0-9]{7}[A-Z][0-9]{4}')
                  OR REGEXP_LIKE(NORM_PANEL, '[^0-9A-Z]')
                  OR LENGTH(NORM_PANEL) < 10
                THEN 0 ELSE 1 END AS IS_REAL
    FROM norm_rows
  )
  SELECT MACHINE_ID,
         COUNT(DISTINCT CASE WHEN IS_REAL = 1 THEN NORM_PANEL END) AS OK_PANELS,
         SUM(IS_UNREAD) AS ERROR_COUNT
  FROM panel_base GROUP BY MACHINE_ID ORDER BY MACHINE_ID`

function fmtMs(ms) { return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms' }
function pad(s, n) { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)) }

async function timed(conn, sql, label) {
  conn.callTimeout = STEP_TIMEOUT_MS
  process.stdout.write('  running ' + label + ' ... ')
  const t0 = Date.now()
  try {
    const r = await conn.execute(sql)
    const ms = Date.now() - t0
    console.log(fmtMs(ms) + '  (' + r.rows.length + ' machines)')
    return { ms, rows: r.rows }
  } catch (e) {
    const ms = Date.now() - t0
    console.log('FAILED after ' + fmtMs(ms) + ': ' + e.message)
    return { ms, error: e.message }
  }
}

// numbers must match exactly - that is the whole point of the test
function compare(a, b) {
  const diffs = []
  const key = r => String(r.MACHINE_ID)
  const mapB = new Map(b.map(r => [key(r), r]))
  for (const ra of a) {
    const rb = mapB.get(key(ra))
    if (!rb) { diffs.push(key(ra) + ': missing in B'); continue }
    if (Number(ra.OK_PANELS) !== Number(rb.OK_PANELS) ||
        Number(ra.ERROR_COUNT || 0) !== Number(rb.ERROR_COUNT || 0)) {
      diffs.push(key(ra) + ': A ok=' + ra.OK_PANELS + ' err=' + ra.ERROR_COUNT +
                 '  |  B ok=' + rb.OK_PANELS + ' err=' + rb.ERROR_COUNT)
    }
    mapB.delete(key(ra))
  }
  for (const k of mapB.keys()) diffs.push(k + ': missing in A')
  return diffs
}

async function main() {
  console.log('=== A/B: current SQL vs single-evaluation SQL ===')
  console.log('window : ' + WINDOW + ' min')
  console.log('DB     : ' + process.env.ORACLE_CONNECTION_STRING)
  console.log('')

  const pool = await oracledb.createPool({
    user: process.env.ORACLE_USER,
    password: process.env.ORACLE_PASSWORD,
    connectString: process.env.ORACLE_CONNECTION_STRING,
    poolMin: 1, poolMax: 1, poolIncrement: 0, poolTimeout: 10,
  })
  const conn = await pool.getConnection()

  try {
    // warm the buffer cache first so run 1 is not unfairly penalised
    console.log('--- warm-up (result ignored) ---')
    await timed(conn, `SELECT COUNT(*) AS N FROM ${TABLE}
                       WHERE DATE_TIME >= SYSDATE - ${WINDOW}/1440`, 'scan   ')
    console.log('')

    console.log('--- timings ---')
    const a1 = await timed(conn, SQL_A, 'A run1 ')
    const b1 = await timed(conn, SQL_B, 'B run1 ')
    const a2 = await timed(conn, SQL_A, 'A run2 ')
    const b2 = await timed(conn, SQL_B, 'B run2 ')
    console.log('')

    if (a1.error || b1.error) {
      console.log('one side failed - cannot compare')
    } else {
      const aBest = Math.min(a1.ms, a2.error ? a1.ms : a2.ms)
      const bBest = Math.min(b1.ms, b2.error ? b1.ms : b2.ms)
      console.log('--- result ---')
      console.log('  ' + pad('A (current)', 16) + 'best ' + fmtMs(aBest))
      console.log('  ' + pad('B (optimised)', 16) + 'best ' + fmtMs(bBest))
      console.log('  ' + pad('speed-up', 16) + (aBest / bBest).toFixed(1) + 'x')
      console.log('  ' + pad('POLL_TIMEOUT_MS', 16) + (process.env.POLL_TIMEOUT_MS || 15000) + 'ms')
      console.log('')

      const diffs = compare(a1.rows, b1.rows)
      if (diffs.length === 0) {
        console.log('  CORRECTNESS: identical on all ' + a1.rows.length + ' machines  -> B is safe to ship')
      } else {
        console.log('  CORRECTNESS: ' + diffs.length + ' MISMATCH(ES) -> do NOT ship B')
        diffs.slice(0, 20).forEach(d => console.log('    ' + d))
        if (diffs.length > 20) console.log('    ... and ' + (diffs.length - 20) + ' more')
      }
    }
  } finally {
    try { await conn.close() } catch (e) {}
    try { await pool.close(5) } catch (e) {}
  }

  console.log('')
  console.log('=== done - send this whole output back ===')
}

main().catch(e => { console.error('FAILED: ' + e.message); process.exit(1) })

/**
 * apps-script-onedit.gs
 *
 * Google Sheets Apps Script that POSTs an HMAC-signed payload to the
 * Hookka ERP whenever an operator edits Completion Date / PIC 1 / PIC 2
 * on any of the dept tabs. Pair with the ERP-side handler at
 *   POST /api/sheets-sync/apps-script-webhook
 *
 * One-time setup (paste this whole file into the Sheets Apps Script editor):
 *   1. Open the spreadsheet (id 1hDGUYeKuWHpCXKrZptFI2eIKh9yNdhw7JeKbTjxT-x8).
 *   2. Extensions -> Apps Script. Replace the default Code.gs with this file.
 *   3. Project Settings -> Script Properties -> Add property
 *        SHEETS_SYNC_SECRET = <same hex string set on ERP via
 *                              wrangler secret put SHEETS_SYNC_SECRET>
 *      and (optional, only if you ever change deploy URL):
 *        ERP_WEBHOOK_URL = https://hookka-erp-testing.pages.dev/api/sheets-sync/apps-script-webhook
 *   4. Triggers (clock icon) -> Add Trigger:
 *        Function: onEditTrigger
 *        Event source: From spreadsheet
 *        Event type: On edit
 *        Failure notification: Notify me daily
 *      Save and grant the OAuth consent screen (read access to spreadsheet,
 *      external HTTP requests).
 *
 * Sheet shape this script assumes (must match row 1 of every dept tab):
 *   A=PO No   B=Customer Ref   C=Customer   D=Model   E=WIP
 *   F=Category   G=Qty   H=Due Date   I=Completion Date
 *   J=PIC 1   K=PIC 2   L=Status   M=jobCardId
 *
 * Trigger fires for every edit; this handler short-circuits when the
 * edited column isn't I / J / K, or when the row's jobCardId (col M) is
 * empty. Failures log to Apps Script -> Executions; they never block the
 * user's edit because Apps Script swallows runtime errors per-trigger.
 */

// ---- Configuration -------------------------------------------------------

var DEFAULT_WEBHOOK_URL =
  'https://hookka-erp-testing.pages.dev/api/sheets-sync/apps-script-webhook';

// 1-based column indexes for the three editable fields.
var COL_COMPLETION_DATE = 9;  // I
var COL_PIC1            = 10; // J
var COL_PIC2            = 11; // K
var COL_JOBCARD_ID      = 13; // M

// Whitelist of dept tabs the trigger fires for. Anything else (Overview,
// future helper sheets) is ignored.
var DEPT_TABS = {
  FAB_CUT:    true,
  FAB_SEW:    true,
  FOAM:       true,
  WOOD_CUT:   true,
  FRAMING:    true,
  WEBBING:    true,
  UPHOLSTERY: true,
  PACKING:    true,
};

// ---- Trigger entry point -------------------------------------------------

function onEditTrigger(e) {
  try {
    if (!e || !e.range) return;
    var sheet = e.range.getSheet();
    var sheetName = sheet.getName();
    if (!DEPT_TABS[sheetName]) return;

    var col = e.range.getColumn();
    if (col !== COL_COMPLETION_DATE && col !== COL_PIC1 && col !== COL_PIC2) {
      return;
    }
    var row = e.range.getRow();
    if (row < 2) return; // header row

    var jobCardId = sheet.getRange(row, COL_JOBCARD_ID).getValue();
    if (!jobCardId) return;
    jobCardId = String(jobCardId).trim();
    if (!jobCardId) return;

    var completionRaw = sheet.getRange(row, COL_COMPLETION_DATE).getValue();
    var pic1Raw       = sheet.getRange(row, COL_PIC1).getValue();
    var pic2Raw       = sheet.getRange(row, COL_PIC2).getValue();

    var completionDate = formatDateCell(completionRaw);
    var pic1Name = pic1Raw == null ? '' : String(pic1Raw).trim();
    var pic2Name = pic2Raw == null ? '' : String(pic2Raw).trim();

    var props = PropertiesService.getScriptProperties();
    var secret = props.getProperty('SHEETS_SYNC_SECRET');
    if (!secret) {
      Logger.log('[sheets-sync] SHEETS_SYNC_SECRET not set in Script Properties — aborting.');
      return;
    }
    var webhookUrl = props.getProperty('ERP_WEBHOOK_URL') || DEFAULT_WEBHOOK_URL;

    var timestamp = Date.now();
    var payload = jobCardId + '|' + timestamp + '|' + completionDate + '|' + pic1Name + '|' + pic2Name;
    var signature = hmacSha256Hex(secret, payload);

    var body = {
      jobCardId: jobCardId,
      completionDate: completionDate || null,
      pic1Name: pic1Name || null,
      pic2Name: pic2Name || null,
      timestamp: timestamp,
      signature: signature,
    };

    var resp = UrlFetchApp.fetch(webhookUrl, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(body),
      muteHttpExceptions: true,
    });
    var code = resp.getResponseCode();
    if (code < 200 || code >= 300) {
      Logger.log('[sheets-sync] webhook ' + code + ': ' + resp.getContentText());
    }
  } catch (err) {
    // Swallow — never block the user's edit.
    Logger.log('[sheets-sync] onEditTrigger error: ' + (err && err.stack ? err.stack : err));
  }
}

// ---- Helpers -------------------------------------------------------------

/**
 * Normalises whatever Sheets returns for the Completion Date cell into the
 * canonical YYYY-MM-DD form the ERP expects. Empty cell -> ''.
 */
function formatDateCell(raw) {
  if (raw == null || raw === '') return '';
  if (raw instanceof Date) {
    var y = raw.getFullYear();
    var m = String(raw.getMonth() + 1).padStart(2, '0');
    var d = String(raw.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }
  // String input — best-effort: if it parses as a Date, reformat;
  // otherwise pass through (the ERP-side normalisation will handle other forms).
  var s = String(raw).trim();
  if (!s) return '';
  var parsed = new Date(s);
  if (!isNaN(parsed.getTime()) && parsed.getFullYear() > 1970) {
    var y2 = parsed.getFullYear();
    var m2 = String(parsed.getMonth() + 1).padStart(2, '0');
    var d2 = String(parsed.getDate()).padStart(2, '0');
    return y2 + '-' + m2 + '-' + d2;
  }
  return s;
}

/**
 * HMAC-SHA256 -> hex. Uses Apps Script's Utilities.computeHmacSha256Signature.
 */
function hmacSha256Hex(secret, message) {
  var bytes = Utilities.computeHmacSha256Signature(message, secret);
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
    var h = b.toString(16);
    hex += h.length === 1 ? '0' + h : h;
  }
  return hex;
}

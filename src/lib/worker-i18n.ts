// ============================================================
// Worker Portal i18n
//
// Four supported languages for the shop-floor worker portal:
//   en — English
//   ms — Bahasa Melayu (Malay)
//   zh — 简体中文
//   my — မြန်မာ (Burmese)
//
// This is intentionally a tiny hand-rolled dictionary — no i18next,
// no ICU. The portal has ~60 strings total and needs zero formatting
// features, so the added dependency weight isn't worth it.
//
// To add a new string: pick an ID in dot.case, add one line to every
// dictionary, then call t("my.new.string") anywhere.
// ============================================================
import { useEffect, useState, useCallback, useSyncExternalStore } from 'react';

export type WorkerLang = 'en' | 'ms' | 'zh' | 'my';

const STORAGE_KEY = 'hookka.worker.lang';

// Subscribers so every <WorkerLayout /> re-renders when language changes.
const listeners = new Set<() => void>();
function emit() {
  for (const fn of listeners) fn();
}

function readStoredLang(): WorkerLang {
  try {
    const v = localStorage.getItem(STORAGE_KEY) as WorkerLang | null;
    if (v === 'en' || v === 'ms' || v === 'zh' || v === 'my') return v;
  } catch { /* ignore */ }
  return 'en';
}

export function setWorkerLang(lang: WorkerLang) {
  try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* ignore */ }
  emit();
}

export function useWorkerLang(): WorkerLang {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    readStoredLang,
    () => 'en',
  );
}

// Dictionary shape: each key → {en, ms, zh, my}. Kept flat for
// easy grep-ability; nested translation namespaces aren't worth the
// complexity at this scale.
type Dict = Record<string, Record<WorkerLang, string>>;

const dict: Dict = {
  // ---- Brand / nav ----
  'brand.title': {
    en: 'Worker Portal',
    ms: 'Portal Pekerja',
    zh: '员工入口',
    my: 'ဝန်ထမ်းပေါ်တယ်',
  },
  'nav.home': { en: 'Home', ms: 'Utama', zh: '主页', my: 'ပင်မ' },
  'nav.scan': { en: 'Scan', ms: 'Imbas', zh: '扫码', my: 'စကင်န်' },
  'nav.team': { en: 'Team', ms: 'Pasukan', zh: '团队', my: 'အသင်း' },
  'nav.pay': { en: 'Pay', ms: 'Gaji', zh: '薪水', my: 'လစာ' },
  'nav.me': { en: 'Me', ms: 'Saya', zh: '我', my: 'ကျွန်ုပ်' },

  // ---- Login ----
  'login.title': {
    en: 'Sign in',
    ms: 'Log masuk',
    zh: '登录',
    my: 'ဝင်ရန်',
  },
  'login.empNo': {
    en: 'Employee No',
    ms: 'No. Pekerja',
    zh: '工号',
    my: 'ဝန်ထမ်းနံပါတ်',
  },
  'login.pin': { en: 'PIN', ms: 'PIN', zh: 'PIN 密码', my: 'PIN' },
  'login.submit': {
    en: 'Sign in',
    ms: 'Log masuk',
    zh: '登录',
    my: 'ဝင်ရန်',
  },
  'login.setupTitle': {
    en: 'First-time setup',
    ms: 'Persediaan kali pertama',
    zh: '首次登录',
    my: 'ပထမဆုံးအကြိမ် ပြင်ဆင်ခြင်း',
  },
  'login.setupDesc': {
    en: 'Create a 6-digit PIN for this employee number. You\'ll use it every time.',
    ms: 'Buat PIN 6 digit untuk nombor pekerja ini. Anda akan gunakannya setiap kali.',
    zh: '为此工号创建一个 6 位 PIN 密码，以后每次登录都会用到。',
    my: 'ဤဝန်ထမ်းနံပါတ်အတွက် ၆လုံးပါ PIN တစ်ခု ဖန်တီးပါ။ အဆင်အမြဲ သုံးပါမည်။',
  },
  'login.newPin': { en: 'New PIN', ms: 'PIN Baru', zh: '新 PIN', my: 'PIN အသစ်' },
  'login.confirmPin': {
    en: 'Confirm PIN',
    ms: 'Sahkan PIN',
    zh: '确认 PIN',
    my: 'PIN အတည်ပြုပါ',
  },
  'login.forgotPin': {
    en: 'Forgot PIN?',
    ms: 'Lupa PIN?',
    zh: '忘记 PIN？',
    my: 'PIN မေ့နေပါသလား?',
  },
  'login.resetTitle': {
    en: 'Reset PIN',
    ms: 'Set Semula PIN',
    zh: '重置 PIN',
    my: 'PIN ပြန်သတ်မှတ်',
  },
  'login.phoneLast4': {
    en: 'Last 4 digits of your phone',
    ms: '4 digit terakhir nombor telefon',
    zh: '手机号后 4 位',
    my: 'ဖုန်းနံပါတ် နောက်ဆုံး ၄လုံး',
  },
  'login.resetSubmit': {
    en: 'Set new PIN',
    ms: 'Tetapkan PIN Baru',
    zh: '设置新 PIN',
    my: 'PIN အသစ်ထည့်ပါ',
  },
  'login.pinMismatch': {
    en: 'PINs do not match',
    ms: 'PIN tidak sepadan',
    zh: '两次输入的 PIN 不一致',
    my: 'PIN နှစ်ခုမတူညီပါ',
  },

  // ---- Home ----
  'home.hello': { en: 'Hello', ms: 'Hai', zh: '你好', my: 'မင်္ဂလာပါ' },
  'home.clockIn': {
    en: 'Clock in',
    ms: 'Daftar masuk',
    zh: '上班打卡',
    my: 'အလုပ်ဝင်',
  },
  'home.clockOut': {
    en: 'Clock out',
    ms: 'Daftar keluar',
    zh: '下班打卡',
    my: 'အလုပ်ထွက်',
  },
  'home.clockedInAt': {
    en: 'Clocked in at',
    ms: 'Daftar masuk pada',
    zh: '打卡时间',
    my: 'အလုပ်ဝင်ချိန်',
  },
  'home.clockedOutAt': {
    en: 'Clocked out at',
    ms: 'Daftar keluar pada',
    zh: '下班时间',
    my: 'အလုပ်ထွက်ချိန်',
  },
  'home.workedHours': {
    en: 'Hours worked today',
    ms: 'Jam bekerja hari ini',
    zh: '今日工时',
    my: 'ယနေ့ အလုပ်နာရီ',
  },
  'home.photoRequired': {
    en: 'Please take a photo to punch',
    ms: 'Sila ambil foto untuk daftar',
    zh: '请拍照后才能打卡',
    my: 'ဓာတ်ပုံ ဦးစွာရိုက်ပါ',
  },
  'home.punchFailed': {
    en: 'Punch NOT recorded — network problem. Please tap again.',
    ms: 'Daftar TIDAK direkodkan — masalah rangkaian. Sila tekan sekali lagi.',
    zh: '打卡没有成功——网络问题，请再打一次。',
    my: 'ပန်ချ် မမှတ်တမ်းတင်ရပါ — ကွန်ရက်ပြဿနာ။ ထပ်နှိပ်ပါ။',
  },
  'home.lateBy': {
    en: 'Late',
    ms: 'Lewat',
    zh: '迟到',
    my: 'နောက်ကျ',
  },
  'home.cameraBlockedHint': {
    en: "Camera didn't open? Allow Camera for your browser in the phone's Settings (Apps → browser → Permissions → Camera), then tap the button again.",
    ms: 'Kamera tidak terbuka? Benarkan Kamera untuk pelayar dalam Tetapan telefon (Apl → pelayar → Kebenaran → Kamera), kemudian tekan butang sekali lagi.',
    zh: '相机没有打开？请到手机 设置 → 应用 → 浏览器 → 权限 → 相机 选择允许，然后再点一次按钮。',
    my: 'ကင်မရာ မပွင့်ပါသလား? ဖုန်း Settings → Apps → browser → Permissions → Camera တွင် ခွင့်ပြုပြီး ခလုတ်ကို ထပ်နှိပ်ပါ။',
  },
  'home.openingCamera': {
    en: 'Opening camera…',
    ms: 'Membuka kamera…',
    zh: '正在打开相机…',
    my: 'ကင်မရာ ဖွင့်နေသည်…',
  },
  'home.piecesDone': {
    en: 'Pieces done today',
    ms: 'Siap hari ini',
    zh: '今日完成',
    my: 'ယနေ့ပြီးသမျှ',
  },
  'home.estimatedEarnings': {
    en: 'Estimated earnings today',
    ms: 'Anggaran pendapatan hari ini',
    zh: '今日估算收入',
    my: 'ယနေ့ ခန့်မှန်းဝင်ငွေ',
  },
  'home.pending': { en: 'Pending', ms: 'Belum', zh: '待做', my: 'စောင့်ဆိုင်းနေ' },
  'home.inProgress': {
    en: 'In Progress',
    ms: 'Sedang Dibuat',
    zh: '进行中',
    my: 'လုပ်နေဆဲ',
  },
  'home.scanBig': {
    en: 'SCAN JOB CARD',
    ms: 'IMBAS KAD KERJA',
    zh: '扫描工单',
    my: 'ဝန်ဆောင်မှုကတ် စကင်န်ရန်',
  },
  'home.reportIssue': {
    en: 'Report Problem',
    ms: 'Lapor Masalah',
    zh: '报告问题',
    my: 'ပြဿနာတင်ပြရန်',
  },
  'home.qualityCheck': {
    en: 'Quality Check',
    ms: 'Pemeriksaan Kualiti',
    zh: '质量检查',
    my: 'အရည်အသွေး စစ်ဆေးမှု',
  },
  'home.qualityCheckDue': {
    en: 'due today',
    ms: 'perlu hari ini',
    zh: '今天要做',
    my: 'ယနေ့ လုပ်ရန်',
  },

  // ---- Scan ----
  'scan.title': {
    en: 'Scan Job Card',
    ms: 'Imbas Kad Kerja',
    zh: '扫描工单',
    my: 'ဝန်ဆောင်မှုကတ် စကင်န်',
  },
  'scan.manual': {
    en: 'Manual entry',
    ms: 'Masuk manual',
    zh: '手动输入',
    my: 'လက်ဖြင့်ဖြည့်ရန်',
  },
  'scan.manualHint': {
    en: 'Scan not working? Type the number printed under the barcode.',
    ms: 'Tak boleh imbas? Taip nombor di bawah kod bar.',
    zh: '扫不到?直接输入条形码下面那串号码。',
    my: 'စကင်ဖတ်၍မရပါက ဘားကုဒ်အောက်ရှိ နံပါတ်ကို ရိုက်ထည့်ပါ။',
  },
  'scan.manualPlaceholder': {
    en: 'Number under the barcode · PO · Job card',
    ms: 'Nombor bawah kod bar · PO · Kad kerja',
    zh: '条形码下的号码 · PO · 工卡',
    my: 'ဘားကုဒ်အောက်နံပါတ် · PO · Job card',
  },
  'scan.takePhoto': {
    en: 'Take photo',
    ms: 'Ambil gambar',
    zh: '拍照',
    my: 'ဓာတ်ပုံရိုက်ရန်',
  },
  'scan.uploadPhoto': {
    en: 'Upload photo',
    ms: 'Muat naik',
    zh: '上传照片',
    my: 'ဓာတ်ပုံတင်ရန်',
  },
  'scan.liveScan': {
    en: 'Scan QR / Barcode',
    ms: 'Imbas QR / Barkod',
    zh: '扫描二维码 / 条形码',
    my: 'QR / ဘားကုဒ် စကင်န်',
  },
  'scan.aimHint': {
    en: 'Point at the QR — it reads automatically, or tap the QR to scan it.',
    ms: 'Halakan ke QR — ia diimbas automatik, atau ketik QR untuk imbas.',
    zh: '对准二维码会自动识别；识别不到就点一下二维码来扫描。',
    my: 'QR ပေါ်ချိန်ပါ — အလိုအလျောက်ဖတ်သည်၊ မဖတ်ပါက QR ကို တို့၍ ဖတ်ပါ။',
  },
  'scan.aimHintBarcode': {
    en: 'Aim at the barcode you want, then tap it to scan. On a stacked list, tap the exact row.',
    ms: 'Halakan ke barkod yang anda mahu, kemudian ketik untuk imbas. Untuk senarai bertindih, ketik baris yang tepat.',
    zh: '对准你要的条形码，点一下扫描；若多条叠在一起，点你要的那一行。',
    my: 'လိုချင်သော ဘားကုဒ်ကို ချိန်ပြီး တို့၍ ဖတ်ပါ။ စာရင်းထပ်နေပါက မှန်ကန်သောလိုင်းကို တို့ပါ။',
  },
  'scan.tapHintBarcode': {
    en: 'Tap to scan',
    ms: 'Ketik untuk imbas',
    zh: '点一下扫描',
    my: 'တို့၍ ဖတ်ပါ',
  },
  'scan.tapHintBarcodeReady': {
    en: 'Detected — tap to scan',
    ms: 'Dikesan — ketik untuk imbas',
    zh: '已检测到 — 点一下扫描',
    my: 'တွေ့ရှိ — တို့၍ ဖတ်ပါ',
  },
  'scan.modeQr': {
    en: 'QR mode',
    ms: 'Mod QR',
    zh: '二维码模式',
    my: 'QR မုဒ်',
  },
  'scan.modeBarcode': {
    en: 'Barcode mode',
    ms: 'Mod Barkod',
    zh: '条形码模式',
    my: 'ဘားကုဒ် မုဒ်',
  },
  'scan.switchToBarcode': {
    en: 'Barcode',
    ms: 'Barkod',
    zh: '切换条形码',
    my: 'ဘားကုဒ်',
  },
  'scan.switchToQr': {
    en: 'QR',
    ms: 'QR',
    zh: '切换二维码',
    my: 'QR',
  },
  'scan.cancel': {
    en: 'Cancel',
    ms: 'Batal',
    zh: '取消',
    my: 'ပယ်ဖျက်',
  },
  'scan.cameraFail': {
    en: 'Cannot access camera. Use Upload photos instead, or reload over HTTPS.',
    ms: 'Kamera tidak boleh diakses. Guna Muat naik gambar, atau muat semula guna HTTPS.',
    zh: '无法开启摄像头，请改用上传照片，或改用 HTTPS 访问。',
    my: 'ကင်မရာဖွင့်၍မရပါ။ ဓာတ်ပုံတင်ရန်ကို အသုံးပြုပါ၊ သို့ HTTPS ဖြင့် ပြန်ဖွင့်ပါ။',
  },
  'scan.cameraDenied': {
    en: 'Camera permission is blocked. Tap the lock icon next to the web address, allow Camera, then try again — or use Take photo / Upload photo below.',
    ms: 'Kebenaran kamera disekat. Tekan ikon mangga di sebelah alamat web, benarkan Kamera, kemudian cuba lagi — atau guna Ambil gambar / Muat naik di bawah.',
    zh: '摄像头权限被拒绝。请点网址旁的锁头图标，允许“相机”，再试一次；或改用下方的 拍照 / 上传照片。',
    my: 'ကင်မရာခွင့်ပြုချက် ပိတ်ထားသည်။ ဝက်ဘ်လိပ်စာဘေးရှိ သော့ပုံကိုနှိပ်ပြီး Camera ကို ခွင့်ပြုပါ၊ ထို့နောက် ထပ်စမ်းပါ — သို့ အောက်ရှိ ဓာတ်ပုံရိုက်ရန်/တင်ရန် ကိုသုံးပါ။',
  },
  'scan.deptScanOk': {
    en: 'Now working in',
    ms: 'Sekarang bekerja di',
    zh: '现在开始计入部门',
    my: 'ယခု အလုပ်လုပ်နေသည့်ဌာန',
  },
  'scan.deptScanHint': {
    en: 'Your hours count here from now. Scan again when you switch line or department; punching out ends it.',
    ms: 'Jam kerja anda dikira di sini mulai sekarang. Imbas semula bila bertukar barisan atau jabatan; daftar keluar menamatkannya.',
    zh: '从现在起你的工时算在这里。换线或换部门时再扫一次；打卡下班自动结束。',
    my: 'ယခုမှစ၍ သင့်အလုပ်ချိန်ကို ဤနေရာသို့ တွက်သည်။ လိုင်း သို့ ဌာနပြောင်းလျှင် ထပ်စကင်န်ပါ၊ အလုပ်ထွက်ကတ်နှိပ်လျှင် ပြီးဆုံးသည်။',
  },
  'scan.deptNeedPunchIn': {
    en: 'Please punch in first, then scan the department code.',
    ms: 'Sila daftar masuk dahulu, kemudian imbas kod jabatan.',
    zh: '请先打卡上班，再扫部门码。',
    my: 'ကျေးဇူးပြု၍ အရင် punch in လုပ်ပြီးမှ ဌာနကုဒ်ကို စကင်န်ပါ။',
  },
  'scan.batchProgress': {
    en: 'Photo {i} of {n}',
    ms: 'Gambar {i} dari {n}',
    zh: '第 {i} / {n} 张',
    my: 'ဓာတ်ပုံ {i} / {n}',
  },
  'scan.batchDone': {
    en: 'All {n} photos scanned',
    ms: 'Semua {n} gambar diimbas',
    zh: '全部 {n} 张已扫描',
    my: 'ဓာတ်ပုံ {n} ပြီးစီးပါပြီ',
  },
  'scan.decoding': {
    en: 'Reading QR…',
    ms: 'Mengimbas QR…',
    zh: '正在识别二维码…',
    my: 'QR ကုဒ် ဖတ်နေသည်…',
  },
  'scan.decodeFail': {
    en: 'No QR code found in the image. Try again or use manual entry.',
    ms: 'Tiada kod QR dijumpai dalam gambar. Cuba lagi atau guna input manual.',
    zh: '图片中未识别到二维码，请重试或手动输入。',
    my: 'ဓာတ်ပုံတွင် QR ကုဒ် မတွေ့ပါ။ ထပ်မံကြိုးစားပါ သို့မဟုတ် လက်ဖြင့်ဖြည့်ပါ။',
  },
  'scan.pickOneWip': {
    en: 'This PO has multiple pieces — pick one',
    ms: 'PO ini ada beberapa keping — pilih satu',
    zh: '该订单有多个部件，请选择',
    my: 'ဤ PO တွင် အပိုင်းများစွာရှိသည် — တစ်ခုရွေးပါ',
  },
  // Shown as a pill on the lookup card when the scanned sticker carries
  // p=N&t=M in the QR — e.g. "Piece 2 of 3". Gives the worker a clear
  // signal that qty=3 job cards need 3 separate scans.
  'scan.pieceOf': {
    en: 'Piece {i} of {n}',
    ms: 'Keping {i} dari {n}',
    zh: '第 {i} / {n} 件',
    my: 'အပိုင်း {i} / {n}',
  },
  // Shown when the current worker already occupies pic1 or pic2 on the
  // scanned job card — stops them from tapping Complete twice on the
  // same piece.
  'scan.alreadyDone': {
    en: 'You already scanned this — it is already done.',
    ms: 'Anda sudah imbas ini — ia sudah siap.',
    zh: '你已经扫过这件 —— 已经完成了。',
    my: 'သင် ဤအပိုင်းကို စကင်န်ပြီးဖြစ်သည်။',
  },
  // Shown when the job card is already fully signed off by two other
  // workers (both PIC slots filled) — the Complete button is disabled.
  'scan.bothSlotsFilled': {
    en: 'Limit reached — this piece is already complete (both PICs done).',
    ms: 'Had dicapai — keping ini sudah siap (kedua-dua PIC selesai).',
    zh: '已达上限 —— 这件已经完成(两个 PIC 都做了)。',
    my: 'ဤကတ်တွင် PIC နှစ်နေရာလုံး ပြည့်နေပြီ။',
  },
  // By-whom line on the ✓ / already-full card — names of the 1 or 2 people on
  // the PIC slots (Wei Siang 2026-06-15: a shared scan must say BY WHOM).
  'scan.completedBy': {
    en: 'By: {who}',
    ms: 'Oleh: {who}',
    zh: '完成人:{who}',
    my: 'ပြီးစီးသူ — {who}',
  },
  // Both places of the worker's section are taken by 2 OTHER people.
  'scan.sectionFull': {
    en: '{dept} already has 2 people.',
    ms: '{dept} sudah ada 2 orang.',
    zh: '{dept} 已经满了(2 人)。',
    my: '{dept} တွင် လူ ၂ ဦး ပြည့်နေပြီ။',
  },
  'scan.start': { en: 'Start', ms: 'Mula', zh: '开始', my: 'စတင်ရန်' },
  'scan.pause': { en: 'Pause', ms: 'Jeda', zh: '暂停', my: 'ခဏရပ်ရန်' },
  'scan.complete': { en: 'Complete', ms: 'Siap', zh: '完成', my: 'ပြီးပါပြီ' },

  // ---- Issue ----
  'issue.title': {
    en: 'Report a Problem',
    ms: 'Lapor Masalah',
    zh: '报告问题',
    my: 'ပြဿနာ တင်ပြ',
  },
  'issue.category': {
    en: 'What is the problem?',
    ms: 'Apakah masalahnya?',
    zh: '发生什么问题？',
    my: 'ဘာပြဿနာလဲ?',
  },
  'issue.cat.material': {
    en: 'Material shortage',
    ms: 'Kekurangan bahan',
    zh: '材料短缺',
    my: 'ပစ္စည်း မလုံလောက်',
  },
  'issue.cat.machine': {
    en: 'Machine problem',
    ms: 'Masalah mesin',
    zh: '机器故障',
    my: 'စက်ပြင်ရန်ရှိ',
  },
  'issue.cat.quality': {
    en: 'Quality defect',
    ms: 'Kecacatan kualiti',
    zh: '质量问题',
    my: 'အရည်အသွေး ချို့ယွင်း',
  },
  'issue.cat.injury': {
    en: 'Injury / Safety',
    ms: 'Kecederaan / Keselamatan',
    zh: '受伤/安全',
    my: 'ထိခိုက်ဒဏ်ရာ / ဘေးကင်း',
  },
  'issue.cat.other': { en: 'Other', ms: 'Lain-lain', zh: '其他', my: 'အခြား' },
  'issue.description': {
    en: 'Describe the problem',
    ms: 'Terangkan masalah',
    zh: '描述问题',
    my: 'ပြဿနာကို ဖော်ပြပါ',
  },
  'issue.submit': { en: 'Send', ms: 'Hantar', zh: '发送', my: 'ပို့ပါ' },

  // ---- QC (IPQC on the phone) ----
  'qc.title': {
    en: 'Quality Check',
    ms: 'Pemeriksaan Kualiti',
    zh: '质量检查',
    my: 'အရည်အသွေး စစ်ဆေးမှု',
  },
  'qc.todayFor': {
    en: "Today's checks for",
    ms: 'Pemeriksaan hari ini untuk',
    zh: '今天的检查：',
    my: 'ယနေ့ စစ်ဆေးမှု —',
  },
  'qc.none': {
    en: 'No quality check due for your department today.',
    ms: 'Tiada pemeriksaan kualiti untuk jabatan anda hari ini.',
    zh: '今天你的部门没有需要做的质量检查。',
    my: 'ယနေ့ သင့်ဌာနအတွက် စစ်ဆေးမှု မရှိပါ။',
  },
  'qc.subject': {
    en: 'Which job card did you check?',
    ms: 'Kad kerja yang mana anda periksa?',
    zh: '你检查的是哪一张工卡？',
    my: 'ဘယ် job card ကို စစ်ခဲ့သလဲ?',
  },
  'qc.subjectNone': {
    en: 'No live job card in your department to check.',
    ms: 'Tiada kad kerja aktif di jabatan anda.',
    zh: '你的部门现在没有可检查的工卡。',
    my: 'သင့်ဌာနတွင် စစ်ရန် job card မရှိပါ။',
  },
  'qc.pass': { en: 'PASS', ms: 'LULUS', zh: '合格', my: 'အောင်' },
  'qc.fail': { en: 'FAIL', ms: 'GAGAL', zh: '不合格', my: 'ကျ' },
  'qc.na': { en: 'N/A', ms: 'T/B', zh: '不适用', my: 'မသက်ဆိုင်' },
  'qc.failReason': {
    en: 'What went wrong? (required)',
    ms: 'Apa yang tidak kena? (wajib)',
    zh: '哪里不合格？（必填）',
    my: 'ဘာမှားသလဲ? (ဖြည့်ရန်လို)',
  },
  'qc.failReasonMissing': {
    en: 'Every FAIL needs one line saying what was wrong.',
    ms: 'Setiap GAGAL perlu satu baris sebab.',
    zh: '每个不合格都要写一行原因。',
    my: 'ကျတိုင်း အကြောင်းပြချက် တစ်ကြောင်း ရေးရပါမည်။',
  },
  'qc.answerAll': {
    en: 'Answer every required item.',
    ms: 'Jawab setiap item wajib.',
    zh: '每个必填项都要作答。',
    my: 'လိုအပ်သော အချက်တိုင်း ဖြေပါ။',
  },
  'qc.submit': { en: 'Submit check', ms: 'Hantar', zh: '提交检查', my: 'တင်သွင်းရန်' },
  'qc.sent': {
    en: 'Check submitted. Thank you.',
    ms: 'Pemeriksaan dihantar. Terima kasih.',
    zh: '检查已提交，谢谢。',
    my: 'တင်သွင်းပြီးပါပြီ။ ကျေးဇူးတင်ပါသည်။',
  },
  'qc.required': { en: 'required', ms: 'wajib', zh: '必填', my: 'လိုအပ်' },

  'issue.sent': {
    en: 'Problem reported',
    ms: 'Masalah dilaporkan',
    zh: '问题已报告',
    my: 'ပြဿနာ တင်ပြပြီးပါပြီ',
  },

  // ---- Pay ----
  'pay.title': {
    en: 'My Pay',
    ms: 'Gaji Saya',
    zh: '我的薪水',
    my: 'ကျွန်ုပ်၏လစာ',
  },
  'pay.thisMonth': {
    en: 'This month (estimated)',
    ms: 'Bulan ini (anggaran)',
    zh: '本月（估算）',
    my: 'ယခုလ (ခန့်မှန်း)',
  },
  'pay.basicEarned': { en: 'Basic', ms: 'Asas', zh: '底薪', my: 'အခြေခံလစာ' },
  'pay.ot': { en: 'Overtime', ms: 'Kerja Lebih Masa', zh: '加班', my: 'OT အချိန်' },
  'pay.pieceBonus': {
    en: 'Piece bonus',
    ms: 'Bonus Kepingan',
    zh: '计件奖金',
    my: 'တစ်ပိုင်းလျှင် ဘောနပ်စ်',
  },
  'pay.gross': { en: 'Gross', ms: 'Kasar', zh: '总额', my: 'စုစုပေါင်း' },
  'pay.history': {
    en: 'Past payslips',
    ms: 'Slip gaji lama',
    zh: '历史工资单',
    my: 'ပြီးခဲ့သော လစာစာရွက်များ',
  },
  'pay.viewPayslip': {
    en: 'View payslip',
    ms: 'Lihat slip',
    zh: '查看工资单',
    my: 'လစာစာရွက် ကြည့်ရှုရန်',
  },
  'pay.estimate': { en: 'estimate', ms: 'anggaran', zh: '估算', my: 'ခန့်မှန်း' },
  'pay.basicFullMonth': {
    en: 'Basic',
    ms: 'Asas',
    zh: '底薪',
    my: 'အခြေခံလစာ',
  },
  'pay.basicAbsent': {
    en: 'Basic · {n}d absent',
    ms: 'Asas · {n}h tidak hadir',
    zh: '底薪 · 缺勤 {n} 天',
    my: 'အခြေခံလစာ · {n}ရက် မလာ',
  },
  'pay.fullSalary': {
    en: 'Full salary',
    ms: 'Gaji penuh',
    zh: '全月薪水',
    my: 'လစာအပြည့်',
  },
  'pay.absentDeduction': {
    en: 'Absent · {n}d',
    ms: 'Tidak hadir · {n}h',
    zh: '缺勤 · {n} 天',
    my: 'မလာ · {n}ရက်',
  },
  // Payslip label — the bare noun, without the "· {n}d" the in-app row adds.
  'pay.absence': { en: 'Absence', ms: 'Tidak hadir', zh: '缺勤', my: 'မလာခြင်း' },
  'pay.efficiencyAllowance': {
    en: 'Efficiency allowance',
    ms: 'Elaun kecekapan',
    zh: '效率津贴',
    my: 'ထိရောက်မှုကြေး',
  },
  // Late clock-in (>10 min) + owner-flagged short/under-recorded hours docked
  // this month. Shown as a deduction line so the worker sees why Basic dropped.
  'pay.lateShortDeduction': {
    en: 'Late / short hours',
    ms: 'Lewat / kurang jam',
    zh: '迟到 / 工时不足',
    my: 'နောက်ကျ / နာရီမပြည့်',
  },
  'pay.attendanceOt': {
    en: 'Attendance & OT',
    ms: 'Kehadiran & OT',
    zh: '出勤 & OT',
    my: 'အလုပ်ဆင်းမှု & OT',
  },
  'pay.from': { en: 'From', ms: 'Dari', zh: '从', my: 'မှ' },
  'pay.to': { en: 'To', ms: 'Hingga', zh: '到', my: 'အထိ' },
  'pay.thisMonthChip': {
    en: 'This month',
    ms: 'Bulan ini',
    zh: '本月',
    my: 'ယခုလ',
  },
  'pay.lastMonth': {
    en: 'Last month',
    ms: 'Bulan lepas',
    zh: '上月',
    my: 'ပြီးခဲ့သောလ',
  },
  'pay.last30d': {
    en: 'Last 30d',
    ms: '30 hari terakhir',
    zh: '近 30 天',
    my: '၃၀ ရက်',
  },
  'pay.days': { en: 'Days', ms: 'Hari', zh: '天数', my: 'ရက်ပေါင်း' },
  'pay.hours': { en: 'Hours', ms: 'Jam', zh: '小时', my: 'နာရီ' },
  'pay.otHrs': { en: 'OT hrs', ms: 'Jam OT', zh: 'OT 小时', my: 'OT နာရီ' },
  'pay.dailyAttendance': {
    en: 'Daily Attendance',
    ms: 'Kehadiran Harian',
    zh: '每日出勤',
    my: 'နေ့စဉ် အလုပ်ဆင်းမှု',
  },
  'pay.colDate': { en: 'Date', ms: 'Tarikh', zh: '日期', my: 'ရက်စွဲ' },
  'pay.colWorkHrs': {
    en: 'Working hrs',
    ms: 'Jam kerja',
    zh: '工时',
    my: 'အလုပ်နာရီ',
  },
  'pay.colOvertimeHrs': {
    en: 'Overtime hrs',
    ms: 'Jam OT',
    zh: '加班',
    my: 'OT နာရီ',
  },

  // ---- Home (Employee Detail Dashboard) ----
  'home.dashboardTitle': {
    en: 'Employee Detail Dashboard',
    ms: 'Papan Pemuka Pekerja',
    zh: '员工明细仪表板',
    my: 'ဝန်ထမ်း အသေးစိတ် ဒက်ရှ်ဘုတ်',
  },
  'home.workingHours': {
    en: 'Working Hours',
    ms: 'Jam Kerja',
    zh: '工作时数',
    my: 'အလုပ်နာရီ',
  },
  'home.productionTime': {
    en: 'Production Time',
    ms: 'Masa Pengeluaran',
    zh: '生产时间',
    my: 'ထုတ်လုပ်ချိန်',
  },
  'home.efficiencyPct': {
    en: 'Efficiency %',
    ms: 'Kecekapan %',
    zh: '效率 %',
    my: 'ထိရောက်မှု %',
  },
  'home.todayChip': { en: 'Today', ms: 'Hari ini', zh: '今天', my: 'ယနေ့' },
  'home.last7d': { en: '7d', ms: '7h', zh: '7天', my: '၇ရက်' },
  'home.last30d': { en: '30d', ms: '30h', zh: '30天', my: '၃၀ရက်' },
  'home.colWorkingHrs': {
    en: 'Working hrs',
    ms: 'Jam kerja',
    zh: '工时',
    my: 'အလုပ်နာရီ',
  },
  'home.colProductionHrs': {
    en: 'Production hrs',
    ms: 'Jam pengeluaran',
    zh: '生产工时',
    my: 'ထုတ်လုပ်နာရီ',
  },
  'home.completedProducts': {
    en: 'Completed products',
    ms: 'Produk siap',
    zh: '已完成产品',
    my: 'ပြီးစီးထုတ်ကုန်',
  },
  'home.colMins': { en: 'Mins', ms: 'Min', zh: '分钟', my: 'မိနစ်' },
  'home.colDateDept': {
    en: 'Date · Dept',
    ms: 'Tarikh · Jab',
    zh: '日期 · 部门',
    my: 'ရက်စွဲ · ဌာန',
  },
  'home.shareWith': {
    en: 'Shared with',
    ms: 'Dikongsi dengan',
    zh: '分享给',
    my: 'ဝေမျှသူ',
  },
  // ---- Team page (Operator Leader's Department Performance view) ----
  'team.title': {
    en: 'Department Performance',
    ms: 'Prestasi Jabatan',
    zh: '部门表现',
    my: 'ဌာန၏ စွမ်းဆောင်ရည်',
  },
  'team.allDepts': {
    en: 'All my departments',
    ms: 'Semua jabatan saya',
    zh: '我所有部门',
    my: 'ကျွန်ုပ်၏ ဌာန အားလုံး',
  },
  'team.allCats': {
    en: 'All categories',
    ms: 'Semua kategori',
    zh: '全部类别',
    my: 'အမျိုးအစား အားလုံး',
  },
  'team.dept': {
    en: 'Department',
    ms: 'Jabatan',
    zh: '部门',
    my: 'ဌာန',
  },
  'team.category': {
    en: 'Category',
    ms: 'Kategori',
    zh: '类别',
    my: 'အမျိုးအစား',
  },
  'team.from': { en: 'From', ms: 'Dari', zh: '从', my: 'မှ' },
  'team.to': { en: 'To', ms: 'Hingga', zh: '到', my: 'အထိ' },
  'team.workers': { en: 'Workers', ms: 'Pekerja', zh: '员工数', my: 'ဝန်ထမ်း' },
  'team.totalWorkingHrs': {
    en: 'Working Hrs',
    ms: 'Jam Kerja',
    zh: '工作时长',
    my: 'အလုပ်ချိန်',
  },
  'team.totalProductionHrs': {
    en: 'Production Hrs',
    ms: 'Jam Pengeluaran',
    zh: '生产时长',
    my: 'ထုတ်လုပ်ချိန်',
  },
  'team.avgEfficiency': {
    en: 'Avg Efficiency',
    ms: 'Kecekapan Purata',
    zh: '平均效率',
    my: 'ပျမ်းမျှ စွမ်းဆောင်ရည်',
  },
  'team.dailyBreakdown': {
    en: 'Daily Breakdown',
    ms: 'Pecahan Harian',
    zh: '每日明细',
    my: 'နေ့စဉ် အသေးစိတ်',
  },
  'team.colDate': { en: 'Date', ms: 'Tarikh', zh: '日期', my: 'ရက်စွဲ' },
  'team.colWorkingHrs': {
    en: 'Working',
    ms: 'Kerja',
    zh: '工时',
    my: 'အလုပ်',
  },
  'team.colProductionHrs': {
    en: 'Production',
    ms: 'Pengeluaran',
    zh: '生产',
    my: 'ထုတ်လုပ်',
  },
  'team.colEfficiency': {
    en: 'Efficiency',
    ms: 'Kecekapan',
    zh: '效率',
    my: 'စွမ်းဆောင်ရည်',
  },
  'team.empty': {
    en: 'No data in this range',
    ms: 'Tiada data dalam tempoh ini',
    zh: '此区间无数据',
    my: 'ဤကာလအတွင်း ဒေတာ မရှိပါ',
  },
  'team.loading': {
    en: 'Loading…',
    ms: 'Memuatkan…',
    zh: '加载中…',
    my: 'ဖွင့်နေသည်…',
  },
  'team.notLeader': {
    en: 'Operator Leader access only',
    ms: 'Akses Ketua Operator sahaja',
    zh: '仅限操作组长查看',
    my: 'အော်ပရေတာ ခေါင်းဆောင်သာ ကြည့်နိုင်သည်',
  },
  'team.workerProductionShare': {
    en: 'Per-worker share',
    ms: 'Bahagian setiap pekerja',
    zh: '每位员工占比',
    my: 'ဝန်ထမ်းတစ်ဦးစီ၏ ဝေစု',
  },
  'team.jobs': {
    en: 'Job cards',
    ms: 'Kad kerja',
    zh: '工作单',
    my: 'အလုပ်ကတ်များ',
  },

  // ---- Me ----
  'me.title': { en: 'Me', ms: 'Saya', zh: '我的', my: 'ကျွန်ုပ်' },
  'me.language': { en: 'Language', ms: 'Bahasa', zh: '语言', my: 'ဘာသာစကား' },
  'me.changePin': {
    en: 'Change PIN',
    ms: 'Tukar PIN',
    zh: '修改 PIN',
    my: 'PIN ပြောင်းရန်',
  },
  'me.phone': { en: 'Phone', ms: 'Telefon', zh: '电话', my: 'ဖုန်းနံပါတ်' },
  'me.dept': {
    en: 'Department',
    ms: 'Jabatan',
    zh: '部门',
    my: 'ဌာန',
  },
  'me.empNo': {
    en: 'Employee No',
    ms: 'No. Pekerja',
    zh: '工号',
    my: 'ဝန်ထမ်းနံပါတ်',
  },
  'me.leaves': {
    en: 'My Leaves',
    ms: 'Cuti Saya',
    zh: '我的假期',
    my: 'ခွင့်ရက်များ',
  },
  'me.logout': {
    en: 'Log out',
    ms: 'Log keluar',
    zh: '退出登录',
    my: 'ထွက်ရန်',
  },

  // ---- Non-production hours ----
  'nonprod.title': {
    en: 'Non-production hours',
    ms: 'Jam bukan pengeluaran',
    zh: '非生产工时',
    my: 'ထုတ်လုပ်မှုမဟုတ်သော အချိန်',
  },
  'nonprod.intro': {
    en: 'Did some hours of non-production work today (e.g. helping R&D)? Apply here so it counts as non-production and your efficiency stays fair.',
    ms: 'Ada buat kerja bukan pengeluaran hari ini (cth. bantu R&D)? Mohon di sini supaya ia dikira sebagai bukan pengeluaran dan kecekapan anda kekal adil.',
    zh: '今天做了非生产工作（例如协助研发）？在这里申请，让它计为非生产工时，效率才公平。',
    my: 'ဒီနေ့ ထုတ်လုပ်မှုမဟုတ်သော အလုပ် (ဥပမာ R&D ကူညီ) လုပ်ခဲ့ပါသလား? ဤနေရာတွင် လျှောက်ထားပါ။',
  },
  'nonprod.apply': {
    en: 'Apply hours',
    ms: 'Mohon jam',
    zh: '申请工时',
    my: 'အချိန်လျှောက်ရန်',
  },
  'nonprod.department': {
    en: 'Department',
    ms: 'Jabatan',
    zh: '部门',
    my: 'ဌာန',
  },
  'nonprod.date': {
    en: 'Date',
    ms: 'Tarikh',
    zh: '日期',
    my: 'ရက်စွဲ',
  },
  'nonprod.hours': {
    en: 'Hours',
    ms: 'Jam',
    zh: '小时',
    my: 'နာရီ',
  },
  'nonprod.note': {
    en: 'Note (optional)',
    ms: 'Nota (pilihan)',
    zh: '备注（可选）',
    my: 'မှတ်ချက် (မဖြစ်မနေမဟုတ်)',
  },
  'nonprod.submit': {
    en: 'Submit request',
    ms: 'Hantar permohonan',
    zh: '提交申请',
    my: 'တောင်းဆိုချက်တင်ရန်',
  },
  'nonprod.myRequests': {
    en: 'My requests',
    ms: 'Permohonan saya',
    zh: '我的申请',
    my: 'ကျွန်ုပ်၏တောင်းဆိုချက်များ',
  },
  'nonprod.noRequests': {
    en: 'No requests yet.',
    ms: 'Belum ada permohonan.',
    zh: '暂无申请。',
    my: 'တောင်းဆိုချက်မရှိသေးပါ။',
  },
  'nonprod.olderKept': {
    en: 'Older requests are kept on file.',
    ms: 'Permohonan lama disimpan dalam rekod.',
    zh: '较早的申请已存档保留。',
    my: 'အဟောင်းတောင်းဆိုချက်များကို မှတ်တမ်းတွင်သိမ်းထားသည်။',
  },
  'nonprod.pickDept': {
    en: 'Pick a department',
    ms: 'Pilih jabatan',
    zh: '选择部门',
    my: 'ဌာနရွေးပါ',
  },
  'nonprod.status.PENDING': {
    en: 'Pending',
    ms: 'Menunggu',
    zh: '待批',
    my: 'စောင့်ဆိုင်းဆဲ',
  },
  'nonprod.status.APPROVED': {
    en: 'Approved',
    ms: 'Diluluskan',
    zh: '已批准',
    my: 'အတည်ပြုပြီး',
  },
  'nonprod.status.REJECTED': {
    en: 'Rejected',
    ms: 'Ditolak',
    zh: '已拒绝',
    my: 'ငြင်းပယ်ပြီး',
  },

  // ---- Time adjustment (extends non-production hours, owner 2026-06-26) ----
  'timeadj.title': {
    en: 'Time adjustment',
    ms: 'Pelarasan masa',
    zh: '工时调整',
    my: 'အချိန်ချိန်ညှိခြင်း',
  },
  'timeadj.type': {
    en: 'Type',
    ms: 'Jenis',
    zh: '类型',
    my: 'အမျိုးအစား',
  },
  'timeadj.typeNonprod': {
    en: 'Non-production',
    ms: 'Bukan pengeluaran',
    zh: '非生产',
    my: 'ထုတ်လုပ်မှုမဟုတ်',
  },
  'timeadj.typeAddProd': {
    en: 'Extra production time',
    ms: 'Masa pengeluaran tambahan',
    zh: '额外生产工时',
    my: 'ထပ်ဆောင်းထုတ်လုပ်ချိန်',
  },
  'timeadj.introAddProd': {
    en: 'A production job took longer than its standard time? Claim the extra production hours here. Once approved, it counts as production output so your efficiency stays fair.',
    ms: 'Kerja pengeluaran ambil masa lebih daripada masa standard? Mohon jam pengeluaran tambahan di sini. Setelah diluluskan, ia dikira sebagai pengeluaran supaya kecekapan anda kekal adil.',
    zh: '某项生产工作超出了标准工时？在此申报额外的生产工时。批准后将计为生产产出，让你的效率保持公平。',
    my: 'ထုတ်လုပ်မှုအလုပ်တစ်ခု စံအချိန်ထက်ကြာခဲ့ပါသလား? ဤနေရာတွင် ထပ်ဆောင်းထုတ်လုပ်ချိန်ကို တောင်းဆိုပါ။',
  },
  'timeadj.minutesLabel': {
    en: 'Minutes',
    ms: 'Minit',
    zh: '分钟',
    my: 'မိနစ်',
  },
  'timeadj.minSuffix': {
    en: 'min',
    ms: 'min',
    zh: '分钟',
    my: 'မိနစ်',
  },
  'timeadj.jobRef': {
    en: 'Job / WIP reference (optional)',
    ms: 'Rujukan kerja / WIP (pilihan)',
    zh: '工单 / WIP 参考（可选）',
    my: 'အလုပ် / WIP ကိုးကား (မဖြစ်မနေမဟုတ်)',
  },
  'timeadj.jobRefPlaceholder': {
    en: 'e.g. PO number or job card',
    ms: 'cth. nombor PO atau kad kerja',
    zh: '例如 PO 编号或工卡',
    my: 'ဥပမာ PO နံပါတ် သို့မဟုတ် အလုပ်ကတ်',
  },
  'timeadj.reason': {
    en: 'Reason',
    ms: 'Sebab',
    zh: '原因',
    my: 'အကြောင်းပြချက်',
  },
  'timeadj.extraApproved': {
    en: 'approved (extra time)',
    ms: 'diluluskan (masa tambahan)',
    zh: '已批准（额外工时）',
    my: 'အတည်ပြုပြီး (ထပ်ဆောင်းအချိန်)',
  },
  'timeadj.rejectedReason': {
    en: 'Office reason',
    ms: 'Sebab pejabat',
    zh: '办公室理由',
    my: 'ရုံးအကြောင်းပြချက်',
  },
  'timeadj.approvedAmount': {
    en: 'Approved',
    ms: 'Diluluskan',
    zh: '已批准',
    my: 'အတည်ပြုပြီး',
  },
  'timeadj.ofRequested': {
    en: 'of',
    ms: 'daripada',
    zh: '/',
    my: '/',
  },

  // ---- Leaves ----
  'leave.title': {
    en: 'Leave',
    ms: 'Cuti',
    zh: '请假',
    my: 'ခွင့်',
  },
  'leave.annualLeft': {
    en: 'Annual leave left',
    ms: 'Cuti tahunan tinggal',
    zh: '剩余年假',
    my: 'ကျန်နေသော နှစ်စဉ်ခွင့်',
  },
  'leave.medicalLeft': {
    en: 'Medical leave left',
    ms: 'Cuti sakit tinggal',
    zh: '剩余病假',
    my: 'ကျန်နေသော ဆေးခွင့်',
  },
  'leave.apply': {
    en: 'Apply for leave',
    ms: 'Mohon cuti',
    zh: '申请请假',
    my: 'ခွင့်လျှောက်ရန်',
  },
  'leave.type': { en: 'Type', ms: 'Jenis', zh: '类型', my: 'အမျိုးအစား' },
  'leave.from': { en: 'From', ms: 'Dari', zh: '从', my: 'မှ' },
  'leave.to': { en: 'To', ms: 'Hingga', zh: '至', my: 'အထိ' },
  'leave.reason': { en: 'Reason', ms: 'Sebab', zh: '原因', my: 'အကြောင်းရင်း' },
  'leave.history': {
    en: 'Leave history',
    ms: 'Sejarah cuti',
    zh: '请假记录',
    my: 'ခွင့်ယူမှုမှတ်တမ်း',
  },
  'leave.submit': { en: 'Submit', ms: 'Hantar', zh: '提交', my: 'တင်ရန်' },
  'leave.status.PENDING': {
    en: 'Pending',
    ms: 'Menunggu',
    zh: '待批准',
    my: 'စောင့်ဆိုင်းဆဲ',
  },
  'leave.status.APPROVED': {
    en: 'Approved',
    ms: 'Diluluskan',
    zh: '已批准',
    my: 'ခွင့်ပြုပြီး',
  },
  'leave.status.REJECTED': {
    en: 'Rejected',
    ms: 'Ditolak',
    zh: '已拒绝',
    my: 'ငြင်းပယ်ခံရ',
  },

  // ---- Common ----
  'common.days': { en: 'days', ms: 'hari', zh: '天', my: 'ရက်' },
  'common.hours': { en: 'hrs', ms: 'jam', zh: '小时', my: 'နာရီ' },
  'common.cancel': {
    en: 'Cancel',
    ms: 'Batal',
    zh: '取消',
    my: 'ပယ်ဖျက်ရန်',
  },
  'common.confirm': {
    en: 'Please confirm',
    ms: 'Sila sahkan',
    zh: '请确认',
    my: 'ကျေးဇူးပြု၍ အတည်ပြုပါ',
  },
  'common.continue': {
    en: 'Continue',
    ms: 'Teruskan',
    zh: '继续',
    my: 'ဆက်သွားရန်',
  },
  'common.back': {
    en: 'Back',
    ms: 'Kembali',
    zh: '返回',
    my: 'ပြန်သွား',
  },
  'common.loading': {
    en: 'Loading…',
    ms: 'Memuatkan…',
    zh: '加载中…',
    my: 'တင်နေသည်…',
  },
  'common.error': {
    en: 'Something went wrong',
    ms: 'Ada masalah',
    zh: '出错了',
    my: 'အမှား ဖြစ်နေပါသည်',
  },

  // ---- Announcements (office → worker) ----
  'home.announcements': {
    en: 'Announcements',
    ms: 'Pengumuman',
    zh: '公告',
    my: 'ကြေညာချက်များ',
  },
  'home.newBadge': {
    en: 'New',
    ms: 'Baru',
    zh: '新',
    my: 'အသစ်',
  },
  // Popup that demands the worker tap to acknowledge a new announcement.
  'home.announcementPopupTitle': {
    en: 'New Announcement',
    ms: 'Pengumuman Baru',
    zh: '新公告',
    my: 'ကြေညာချက် အသစ်',
  },
  'home.announcementGotIt': {
    en: 'Got it',
    ms: 'Faham',
    zh: '知道了',
    my: 'သဘောပေါက်ပါပြီ',
  },
  // Collapsed archive header + empty state for expired/hidden notices.
  'home.pastAnnouncements': {
    en: 'Past announcements',
    ms: 'Pengumuman lepas',
    zh: '过往公告',
    my: 'ယခင်ကြေညာချက်များ',
  },
  'home.noPastAnnouncements': {
    en: 'No past announcements',
    ms: 'Tiada pengumuman lepas',
    zh: '没有过往公告',
    my: 'ယခင်ကြေညာချက် မရှိပါ',
  },

  // ---- Location prompt (Feature B — cut "No GPS" punches) ----
  'home.locationNeededTitle': {
    en: 'Turn on location',
    ms: 'Hidupkan lokasi',
    zh: '请开启定位',
    my: 'တည်နေရာ ဖွင့်ပါ',
  },
  'home.locationNeededBody': {
    en: 'Please allow location so your clock-in records you At factory.',
    ms: 'Sila benarkan lokasi supaya daftar masuk anda direkod Di kilang.',
    zh: '请允许定位，这样您的打卡才能记录为「在工厂」。',
    my: 'အလုပ်ဝင်ချိန် "စက်ရုံတွင်" မှတ်တမ်းတင်နိုင်ရန် တည်နေရာကို ခွင့်ပြုပါ။',
  },
  'home.locationHowTo': {
    en: 'Tap the lock icon in your browser address bar → Location → Allow.',
    ms: 'Ketik ikon kunci di bar alamat pelayar → Lokasi → Benarkan.',
    zh: '点击浏览器地址栏的锁形图标 → 位置 → 允许。',
    my: 'ဘရောက်ဇာ လိပ်စာဘားရှိ သော့ပုံကို နှိပ်ပါ → တည်နေရာ → ခွင့်ပြုပါ။',
  },
  'home.locationRetry': {
    en: 'Try again',
    ms: 'Cuba lagi',
    zh: '重试',
    my: 'ထပ်စမ်းပါ',
  },
};

/**
 * Translate OUTSIDE React — the payslip document is built as a plain HTML
 * string, not a component tree, so it cannot use the useT() hook. Same table,
 * same English fallback; the caller passes the language explicitly because the
 * office prints a worker's payslip from its own session.
 */
export function translateFor(lang: WorkerLang, id: string): string {
  const row = dict[id];
  if (!row) return id;
  return row[lang] || row.en || id;
}

// Translate helper: t("home.hello") → lookup in chosen language with
// fallback to English if a string is missing in the chosen language.
export function useT() {
  const lang = useWorkerLang();
  return useCallback((id: string): string => {
    const row = dict[id];
    if (!row) return id; // expose missing keys loudly during dev
    return row[lang] || row.en || id;
  }, [lang]);
}

// Display labels for the language switcher itself — always shown
// in each language's native script so the user can pick.
export const LANG_LABELS: Record<WorkerLang, string> = {
  en: 'English',
  ms: 'Bahasa Melayu',
  zh: '中文',
  my: 'မြန်မာ',
};

// Apply <html lang> and dir on mount so screen readers + CSS lang()
// selectors behave correctly. Burmese is LTR like the others.
export function useApplyHtmlLang() {
  const lang = useWorkerLang();
  useEffect(() => {
    try {
      const el = document.documentElement;
      if (el) el.setAttribute('lang', lang);
    } catch { /* ignore */ }
  }, [lang]);
}

// One-shot helper for components that only need the current value.
export function getCurrentLang(): WorkerLang {
  return readStoredLang();
}

export function useLangState(): [WorkerLang, (l: WorkerLang) => void] {
  const lang = useWorkerLang();
  const [, force] = useState(0);
  const set = useCallback((l: WorkerLang) => {
    setWorkerLang(l);
    force((n) => n + 1);
  }, []);
  return [lang, set];
}

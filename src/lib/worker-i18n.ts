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
    en: 'Create a 4-digit PIN for this employee number. You\'ll use it every time.',
    ms: 'Buat PIN 4 digit untuk nombor pekerja ini. Anda akan gunakannya setiap kali.',
    zh: '为此工号创建一个 4 位 PIN 密码，以后每次登录都会用到。',
    my: 'ဤဝန်ထမ်းနံပါတ်အတွက် ၄လုံးပါ PIN တစ်ခု ဖန်တီးပါ။ အဆင်အမြဲ သုံးပါမည်။',
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
    en: 'Scan QR',
    ms: 'Imbas QR',
    zh: '扫描二维码',
    my: 'QR ကုဒ် စကင်န်',
  },
  'scan.aimHint': {
    en: 'Point the camera at the QR sticker — it scans automatically.',
    ms: 'Halakan kamera ke pelekat QR — imbas secara automatik.',
    zh: '将摄像头对准二维码贴纸，会自动识别。',
    my: 'ကင်မရာကို QR စတစ်ကာပေါ် ချိန်ရွှေ့ပါ — အလိုအလျောက် စကင်န်လုပ်သည်။',
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
    en: 'You already scanned this piece.',
    ms: 'Anda sudah imbas keping ini.',
    zh: '你已扫描过这件。',
    my: 'သင် ဤအပိုင်းကို စကင်န်ပြီးဖြစ်သည်။',
  },
  // Shown when the job card is already fully signed off by two other
  // workers (both PIC slots filled) — the Complete button is disabled.
  'scan.bothSlotsFilled': {
    en: 'Both PIC slots are already filled on this card.',
    ms: 'Kedua-dua slot PIC pada kad ini sudah penuh.',
    zh: '该工单两个 PIC 名额都已占用。',
    my: 'ဤကတ်တွင် PIC နှစ်နေရာလုံး ပြည့်နေပြီ။',
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
};

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

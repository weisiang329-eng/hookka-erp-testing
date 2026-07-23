# Day-1 PIN Reset Broadcast — Floor Communication

> Use after the foundation hardening deploy (2026-04-29). All worker PIN
> codes were flagged `must_reset = 1` so the next time each worker logs
> into the shop-floor portal, the system asks them to set a new
> **6-digit** PIN. This file is the message you forward to floor
> supervisors / WhatsApp groups.

---

## What changed

- The shop-floor app upgraded to **6-digit PINs** (was 4).
- Every worker MUST set a new PIN at their next login. The old 4-digit
  PIN no longer works.
- This is a one-time reset. After the worker sets their new PIN, normal
  login resumes.

## What workers will see

When a worker scans their badge / opens the shop-floor login page and
enters their old 4-digit PIN, the system shows:

> **PIN reset required**
> Set a new 6-digit PIN to continue.

Two fields appear:
1. **New PIN** — the worker types 6 digits
2. **Confirm PIN** — same 6 digits again

Tap "Set PIN" → done. They proceed to the normal scan screen.

## What floor supervisors should do

**Before each shift starts**, gather workers who need to clock in and:

1. Tell them the PIN length changed from 4 to 6.
2. Have them pick something memorable but NOT the same as their phone
   number / IC last 4 digits / birthday.
3. If a worker forgets the new PIN later, the supervisor can reset it
   from the office → Employee Master → Workers → click worker → "Reset
   PIN".

## WhatsApp / Group message — 中文版

复制这段发到 floor 微信群:

> **重要：今天起 PIN 改 6 位**
>
> 各位 worker 注意：
>
> 1. 今天上工第一次登录手机/平板，会要求你设新密码（PIN）
> 2. **要 6 个数字**，不是 4 个
> 3. 设完一次就可以了，以后跟以前一样输入登录
> 4. 选个好记的，不要选你的电话号码或生日
> 5. 忘了密码找主管帮你重置
>
> 上工时主管会一个个帮大家走完，不会大家一起停摆。

## WhatsApp / Group message — 马来文

> **PERHATIAN: PIN ditukar ke 6 angka mulai hari ini**
>
> 1. Bila log-in pertama kali hari ini, sistem akan minta anda set PIN
>    baru.
> 2. PIN baru mesti **6 angka**, bukan 4.
> 3. Set sekali sahaja, kemudian guna seperti biasa.
> 4. Pilih nombor yang anda boleh ingat — tetapi JANGAN guna nombor
>    telefon atau hari lahir.
> 5. Kalau lupa, jumpa supervisor untuk reset.

## English (for any English-speaking workers)

> **PIN length changed to 6 digits today**
>
> 1. Your first login today will ask you to set a new PIN.
> 2. New PIN must be **6 digits**, not 4.
> 3. Do it once, then login as normal afterwards.
> 4. Pick something memorable — but NOT your phone number or birthday.
> 5. Forgot? See your supervisor to reset.

## If anything goes wrong

- **Worker can't log in even after setting 6-digit PIN** → reset their
  PIN from office: Employee Master → Workers → click worker → "Reset
  PIN".
- **System shows error** → check connectivity. Production worker portal
  is at `https://hookka-erp-testing.pages.dev/worker`.
- **Office can't see worker activity** → make sure the worker actually
  completed the 6-digit reset; if they bailed out mid-flow they're
  still flagged `must_reset = 1`.

## Why this happened

Previously workers used 4-digit PINs. With 10,000 possible combinations
and no lockout, an attacker could brute-force any worker's account in
under a day. The 6-digit upgrade widens the search space to 1,000,000
and is paired with rate limiting (10 tries / 15 min per worker), so
brute-forcing is now infeasible.

This is a one-time floor inconvenience for permanent security.

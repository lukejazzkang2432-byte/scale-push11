/* SCALE 푸시 발송기 — GitHub Actions에서 15분마다 실행됩니다.
   1) 예약된 마감 알림 시각이 지났으면 알림을 만들고
   2) 아직 안 보낸 알림을 각자 폰으로 발송합니다. */
const admin = require('firebase-admin');
const KEY = process.env.SA_KEY;
if (!KEY) { console.error('SA_KEY 시크릿이 없습니다.'); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(KEY)) });
const db = admin.firestore();
const fcm = admin.messaging();
const NOW = Date.now();
const WINDOW = 6 * 3600 * 1000;   // 예약 시각을 6시간까지 놓치지 않고 따라잡음
const DEFAULT_PUSH = { post: true, rsvp: true, poll: true, dm: true, paid: true };
const dueAt = p => new Date(`${p.due}T${p.dueT || '23:59'}:59+09:00`).getTime();
function fireTime(p, r) {
  if (r.mode === 'abs') {
    if (!r.date) return null;
    return new Date(`${r.date}T${r.time || '09:00'}:00+09:00`).getTime();
  }
  const n = +r.n || 1;
  if (r.unit === 'h') return dueAt(p) - n * 3600 * 1000;
  const d = new Date(dueAt(p) - n * 86400 * 1000);
  const [hh, mm] = (r.time || '09:00').split(':');
  const ymd = new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  return new Date(`${ymd}T${hh}:${mm}:00+09:00`).getTime();
}
function weeklyFire(rem) {
  // 이번 주 해당 요일·시각 (KST)
  const kst = new Date(NOW + 9 * 3600 * 1000);
  const today = kst.getUTCDay();
  const diff = rem.dow - today;
  const target = new Date(kst.getTime() + diff * 86400 * 1000);
  const ymd = target.toISOString().slice(0, 10);
  const [hh, mm] = (rem.time || '19:00').split(':');
  return new Date(`${ymd}T${hh}:${mm}:00+09:00`).getTime();
}
const nid = () => Math.random().toString(36).slice(2, 10);
function addNotif(d, to, title, body, kind, red) {
  d.notifs = d.notifs || [];
  d.notifs.unshift({ id: nid(), to, title, body, kind, red: !!red, at: NOW, read: false, pushed: false });
  d.notifs = d.notifs.slice(0, 150);
}
async function run() {
  const snap = await db.collection('clubs').get();
  let sentTotal = 0;
  for (const doc of snap.docs) {
    const d = doc.data().data;
    if (!d) continue;
    let changed = false;
    const alive = (d.members || []).filter(m => !m.blocked);
    /* ── 1) 투표·설문 마감 알림 ── */
    for (const p of (d.polls || [])) {
      if (!p.rem || !p.rem.length) continue;
      if (dueAt(p) < NOW) continue;
      p.sent = p.sent || {};
      p.rem.forEach((r, i) => {
        const t = fireTime(p, r);
        if (t === null || p.sent[i]) return;
        if (NOW < t || NOW > t + WINDOW) return;
        const pool = p.to ? alive.filter(m => p.to.includes(m.id)) : alive;
        const targets = pool.filter(m => !(p.done || []).includes(m.id)).map(m => m.id);
        if (targets.length) {
          const left = Math.round((dueAt(p) - NOW) / 3600000);
          const urgent = left <= 2;
          addNotif(d, targets,
            `${urgent ? '🔴 ' : ''}${p.title} 마감 ${left <= 1 ? '1시간' : left + '시간'} 전`,
            '아직 참여하지 않으셨어요. 지금 참여해주세요.', 'poll', urgent);
        }
        p.sent[i] = NOW; changed = true;
      });
    }
    /* ── 2) 공지 반복 알림 ── */
    for (const po of (d.posts || [])) {
      if (!po.rem || !po.rem.length) continue;
      po.sent = po.sent || {};
      po.rem.forEach((r, i) => {
        const t = weeklyFire(r);
        const key = `${i}_${new Date(t + 9 * 3600 * 1000).toISOString().slice(0, 10)}`;
        if (po.sent[key]) return;
        if (NOW < t || NOW > t + WINDOW) return;
        const targets = alive.filter(m => !(po.readers || []).includes(m.id)).map(m => m.id);
        if (targets.length) addNotif(d, targets, '아직 안 읽으셨어요', po.title, 'post');
        po.sent[key] = NOW; changed = true;
      });
    }
    /* ── 3) 일정 참석 응답 마감 하루 전 ── */
    for (const ev of (d.events || [])) {
      if (!ev.rsvpDue) continue;
      const t = new Date(`${ev.rsvpDue}T23:59:59+09:00`).getTime() - 86400 * 1000;
      if (ev.rsvpSent) continue;
      if (NOW < t || NOW > t + WINDOW) continue;
      const targets = alive.filter(m => !((ev.rsvp || {})[m.id])).map(m => m.id);
      if (targets.length) addNotif(d, targets, '참석 여부를 알려주세요',
        `${ev.title} · 응답 마감 내일`, 'rsvp');
      ev.rsvpSent = NOW; changed = true;
    }
    /* ── 4) 아직 안 보낸 알림 발송 ── */
    for (const n of (d.notifs || [])) {
      if (n.pushed) continue;
      if (NOW - n.at > 24 * 3600 * 1000) { n.pushed = true; changed = true; continue; }
      const pool = n.to ? alive.filter(m => n.to.includes(m.id)) : alive;
      const tokens = pool
        .filter(m => m.token && ((m.push || DEFAULT_PUSH)[n.kind] !== false))
        .map(m => m.token);
      if (tokens.length) {
        try {
          const APP = process.env.APP_URL || '';
          const res = await fcm.sendEachForMulticast({
            tokens,
            webpush: {
              headers: { Urgency: n.red ? 'high' : 'normal', TTL: '86400' },
              notification: {
                title: n.title || 'SCALE',
                body: n.body || '',
                icon: APP ? APP + (n.red ? '/icon-urgent.png' : '/icon-192.png') : undefined,
                badge: APP ? APP + '/icon-192.png' : undefined,
                tag: n.id,
                requireInteraction: !!n.red
              },
              fcmOptions: APP ? { link: APP + '/index.html' } : undefined
            }
          });
          sentTotal += res.successCount;
          // 만료된 토큰 정리
          res.responses.forEach((r, i) => {
            if (!r.success && /registration-token-not-registered|invalid-argument/.test(r.error?.code || '')) {
              const m = pool.find(x => x.token === tokens[i]);
              if (m) { delete m.token; changed = true; }
            }
          });
          console.log(`[${d.name}] "${n.title}" → ${res.successCount}/${tokens.length}`);
        } catch (e) { console.error('발송 실패', e.message); }
      }
      n.pushed = true; changed = true;
    }
    if (changed) {
      await doc.ref.set({ data: d, updatedAt: Date.now() }, { merge: true });
    }
  }
  console.log(`완료 · 총 ${sentTotal}건 발송 · ${new Date(NOW + 9 * 3600 * 1000).toISOString()}`);
}
run().catch(e => { console.error(e); process.exit(1); });

'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, shell } = require('electron');

const config = require('./config');
const { WrlClient } = require('./wrl');
const { Tracker, MAX_PER_QUERY } = require('./tracker');
const { EtsyReader } = require('./etsy');
const { CsvDownloader, dueSlot, parseTimes, parseCsvTypes, vietnamNow } = require('./csv-download');
const { ProfilePool } = require('./profile-pool');
const { InboxReader } = require('./inbox');
const { HidemyaccClient, guessProfile, fold } = require('./hidemyacc');
const updater = require('./updater');

/**
 * Track17 Agent — the half of Dakuho's shipment tracking that no server can do.
 *
 * Two lanes, because no single source answers for every carrier:
 *
 *   17track  DHL, Yanwen, YunExpress, UniUni, UPS, OnTrac, SPX … — forty
 *            numbers at a time in 17track.net's search box.
 *   Etsy     everything else, which in practice means USPS. Measured on
 *            2026-09-28, no free third-party route for a USPS number is left,
 *            and tools.usps.com blocks automated browsers outright — but Etsy
 *            has already resolved the carrier and shows the answer on the
 *            seller's own order list, read inside each shop's Hidemyacc
 *            profile. See src/etsy.js and src/hidemyacc.js.
 *
 * The queue and the answers both go through WrL (wearelucky.io.vn), which stays
 * the only thing that writes to the CMS.
 */

let controlWindow = null;
let tracker = null;
let etsy = null;
let csv = null;
let inbox = null;
/** Set while a CSV round is running — it has its own timer, apart from `running`. */
let csvRunning = false;
/** Set while an inbox round is running (src/inbox.js), on its own timer too. */
let inboxRunning = false;

/** Set while the loop is working, so Start cannot stack two loops. */
let running = false;
let stopRequested = false;

const stats = {
  batches: 0,
  looked: 0,
  matched: 0,
  updated: 0,
  delivered: 0,
  etsyOrders: 0,
  errors: 0,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function send(channel, payload) {
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send(channel, payload);
  }
}

/**
 * Where the log is kept between runs.
 *
 * The window's log pane is gone the moment the app restarts, which is no use
 * for something meant to sit running for days: the one thing you want after an
 * unattended night is what it did. Appended to, never rotated in-process — the
 * file is trimmed at startup instead, so a long run cannot fill a disk.
 */
const NEWLINE = "\n";

function logPath() {
  return path.join(app.getPath('userData'), 'agent.log');
}

function trimLogFile() {
  try {
    const file = logPath();
    if (!fs.existsSync(file)) return;
    if (fs.statSync(file).size < 2 * 1024 * 1024) return;
    // Keep the tail: the end of a long run is the part worth reading.
    const kept = fs.readFileSync(file, 'utf8').split(NEWLINE).slice(-2000).join(NEWLINE);
    fs.writeFileSync(file, kept, 'utf8');
  } catch {
    // A log we cannot tidy is not a reason to refuse to start.
  }
}

function log(message) {
  const now = new Date();
  const stamp = now.toLocaleTimeString('vi-VN', { hour12: false });
  send('agent:log', `${stamp}  ${message}`);
  try {
    fs.appendFileSync(logPath(), now.toISOString() + '  ' + message + NEWLINE, 'utf8');
  } catch {
    // Logging must never take the run down with it.
  }
}

function pushState(extra = {}) {
  send('agent:state', { running, stats: { ...stats }, ...extra });
}

// --------------------------------------------------------- lane 1: 17track

/**
 * Claim a batch, look it up, hand the answers back.
 *
 * Returns `{ done }` when the queue is empty, so the caller knows to idle
 * rather than hammer the site with nothing to ask about.
 */
async function runOnce() {
  const settings = config.load(app);
  const client = new WrlClient(settings);

  const batch = await client.pending(Math.min(settings.batchSize || MAX_PER_QUERY, MAX_PER_QUERY));
  if (!batch.count) {
    log(`Hàng đợi trống — không có mã nào cần tra.`);
    return { done: true, remaining: 0 };
  }

  log(`Nhận ${batch.count} mã từ WrL (còn lại trong hàng đợi: ${batch.remaining}).`);
  stats.batches += 1;
  stats.looked += batch.count;
  pushState();

  const { results, via } = await lookupSerial(batch.numbers, {
    timeoutMs: (settings.lookupTimeoutSeconds || 60) * 1000,
  });

  if (!results.length) {
    // The numbers stay claimed for ten minutes on WrL's side and then come back
    // round on their own, so there is nothing to undo here.
    log('17track không trả về kết quả nào cho lượt này.');
    stats.errors += 1;
    pushState();
    return { done: false, remaining: batch.remaining };
  }

  log(`Đọc được ${results.length}/${batch.count} mã (nguồn: ${via}). Đang gửi về WrL…`);
  const applied = await client.submit(results);

  stats.matched += applied.matched || 0;
  stats.updated += applied.updated || 0;
  stats.delivered += applied.delivered || 0;
  pushState();

  log(
    `WrL đã nhận: ${applied.updated || 0} đơn đổi trạng thái, ${applied.delivered || 0} đã giao` +
      (applied.unknown && applied.unknown.length ? `, ${applied.unknown.length} mã lạ` : '') +
      (applied.unmapped && applied.unmapped.length
        ? `, ${applied.unmapped.length} mã chưa đọc được trạng thái`
        : '') +
      '.',
  );

  return { done: false, remaining: batch.remaining };
}

/**
 * The 17track window serves two lanes (statuses for WrL, last miles for the CMS),
 * so lookups queue up here instead of typing into the same box at once.
 */
let trackerQueue = Promise.resolve();
function lookupSerial(numbers, options) {
  const run = trackerQueue.then(() => tracker.lookup(numbers, options));
  trackerQueue = run.catch(() => {});
  return run;
}

// ------------------------------------------------------- lane 1b: last mile

/**
 * Factories in China hand over only the first-mile number (Yanwen UL…YP,
 * YunExpress YT…) and the last-mile one late or never — but 17track already
 * knows it: `misc_info.local_number` in the same response (src/status.js).
 * The CMS keeps those orders under "Chờ mã chặng cuối"; this lane looks their
 * first-mile numbers up and hands back the last mile, which becomes the number
 * pushed to Etsy (Sếp, 21/10/2026). The CMS counts the CN waiting days from the
 * day the last mile appeared.
 */
let lastMileRunning = false;

async function cmsAgentCall(settings, path, body) {
  const base = String(settings.cmsApiUrl || '').replace(/\/$/, '');
  const res = await fetch(`${base}/fulfillment-tracking/agent/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-token': String(settings.inboxToken || '').trim() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  if (res.status === 401) throw new Error('CMS từ chối token agent (401) — kiểm tra ô "Token tin nhắn"');
  if (!res.ok) throw new Error(`CMS trả lỗi ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

async function runLastMileRound(reason) {
  if (lastMileRunning) return { ok: false, message: 'Đang có một lượt tra mã chặng cuối' };
  lastMileRunning = true;
  try {
    const settings = config.load(app);
    if (!settings.cmsApiUrl || !settings.inboxToken) throw new Error('chưa điền địa chỉ CMS hoặc token agent');
    const maxBatches = Math.max(1, Number(settings.lastMileBatchesPerRound) || 10);
    let looked = 0;
    let found = 0;
    let updated = 0;
    let waiting = 0;
    for (let n = 0; n < maxBatches; n += 1) {
      const claim = await cmsAgentCall(settings, 'last-mile/claim', { limit: MAX_PER_QUERY });
      waiting = claim.waiting || 0;
      const numbers = claim.numbers || [];
      if (!numbers.length) break;
      if (n) await sleep((settings.batchDelaySeconds || 25) * 1000);
      const { results } = await lookupSerial(numbers, { timeoutMs: (settings.lookupTimeoutSeconds || 60) * 1000 });
      looked += numbers.length;
      const payload = results.map((r) => ({
        firstMileNumber: r.trackingNumber,
        lastMileNumber: r.lastMileNumber || null,
        lastMileCarrier: r.lastMileCarrier || null,
        lastMileSince: r.lastMileSince || null,
        status: r.status || null,
        statusText: r.statusText || null,
        lastEvent: r.lastEvent || null,
        lastEventAt: r.lastEventAt || null,
      }));
      if (payload.length) {
        const applied = await cmsAgentCall(settings, 'last-mile/results', { results: payload });
        found += applied.found || 0;
        updated += applied.updated || 0;
      }
    }
    const summary = `tra ${looked} mã chặng đầu, ${found} mã có chặng cuối, ${updated} đơn có mã để đẩy (còn ${waiting} đơn chờ trên CMS)`;
    if (reason !== 'lịch' || looked) log(`Mã chặng cuối (${reason}): ${summary}.`);
    return { ok: true, message: `Mã chặng cuối: ${summary}` };
  } catch (error) {
    log(`Tra mã chặng cuối lỗi: ${error.message}`);
    return { ok: false, message: error.message };
  } finally {
    lastMileRunning = false;
  }
}

/** Every `lastMileIntervalHours`; the CMS itself spaces re-checks of one number (6 h). */
function startLastMileTimer() {
  const next = () => {
    const hours = Math.max(0.5, Number(config.load(app).lastMileIntervalHours) || 3);
    setTimeout(tick, hours * 3600000);
  };
  const tick = async () => {
    try {
      const settings = config.load(app);
      if (settings.lastMileEnabled && settings.inboxToken && settings.cmsApiUrl) await runLastMileRound('lịch');
    } finally {
      next();
    }
  };
  setTimeout(tick, 90000);
}

// ------------------------------------------------------------- lane 2: Etsy

/**
 * Pair each shop with the Hidemyacc profile that reads it.
 *
 * The operator's choice in the window wins; a shop with no choice saved falls
 * back to a name match, which is only made when it is unambiguous. Returns the
 * profile list too, so the window can offer it as choices.
 */
async function resolveProfiles(settings, shops) {
  const profiles = await new HidemyaccClient(settings).profiles();
  const known = new Set(profiles.map((profile) => profile.id));
  const chosen = settings.hmaProfiles || {};

  const rows = shops.map((shop) => {
    const saved = chosen[shop.shopName];
    if (saved && known.has(saved)) return { ...shop, profileId: saved, guessed: false };
    const guess = guessProfile(shop.shopName, profiles);
    return { ...shop, profileId: guess ? guess.id : null, guessed: Boolean(guess) };
  });
  return { rows, profiles };
}

/**
 * Walk every shop that has parcels waiting and read their order pages.
 *
 * A shop with no profile, or whose profile is not signed in to Etsy, is
 * skipped rather than retried in a loop — it is named in the log for the
 * operator and comes round again next cycle.
 */
async function runEtsyPass() {
  const settings = config.load(app);
  const client = new WrlClient(settings);

  const plan = await client.etsyPlan();
  const waitingShops = (plan.shops || []).filter((shop) => shop.waiting > 0);

  if (!waitingShops.length) {
    log('Không shop nào còn đơn cần đọc trạng thái từ Etsy.');
    return { needsLogin: [] };
  }

  const { rows: shops } = await resolveProfiles(settings, waitingShops);
  log(`Đọc Etsy cho ${shops.length} shop (${plan.waiting} vận đơn đang chờ) qua Hidemyacc.`);
  const needsLogin = [];

  for (const shop of shops) {
    if (stopRequested) break;

    if (!shop.profileId) {
      log(`${shop.shopName}: chưa chọn profile Hidemyacc — chọn trong mục "Profile Hidemyacc".`);
      continue;
    }

    let read;
    try {
      read = await etsy.readShop(shop.shopName, {
        settings,
        profileId: shop.profileId,
        pages: settings.etsyPagesPerShop || 5,
        pageDelayMs: (settings.etsyPageDelaySeconds || 8) * 1000,
      });
    } catch (error) {
      // One shop's profile failing to open must not cost the other shops
      // their turn.
      stats.errors += 1;
      pushState();
      log(`${shop.shopName}: không đọc được qua Hidemyacc — ${error.message}`);
      continue;
    }
    const { needsLogin: lapsed, orders } = read;

    if (lapsed) {
      needsLogin.push(shop.shopName);
      continue;
    }
    if (!orders.length) {
      log(`${shop.shopName}: không đọc được trạng thái nào.`);
      continue;
    }

    // WrL takes at most 500 orders a request; a big shop's three lists can
    // run past that.
    const applied = { matched: 0, updated: 0, delivered: 0, unknown: [], leftToOtherLane: 0 };
    for (let start = 0; start < orders.length; start += 500) {
      const part = await client.submitEtsy(orders.slice(start, start + 500));
      applied.matched += part.matched || 0;
      applied.updated += part.updated || 0;
      applied.delivered += part.delivered || 0;
      applied.unknown.push(...(part.unknown || []));
      applied.leftToOtherLane += part.leftToOtherLane || 0;
    }
    stats.etsyOrders += applied.matched || 0;
    stats.updated += applied.updated || 0;
    stats.delivered += applied.delivered || 0;
    pushState();

    log(
      `${shop.shopName}: gửi ${orders.length} đơn — ${applied.updated || 0} đổi trạng thái, ` +
        `${applied.delivered || 0} đã giao` +
        (applied.unknown && applied.unknown.length ? `, ${applied.unknown.length} đơn WrL chưa có` : '') +
        (applied.leftToOtherLane ? `, ${applied.leftToOtherLane} để 17track lo` : '') +
        '.',
    );
  }

  return { needsLogin };
}

// --------------------------------------------------------- job 3: CSV export

/**
 * Download every shop's Etsy CSV for the current month (src/csv-download.js).
 *
 * Runs beside the status loop, not inside it: it has its own timer and its
 * own busy flag, and borrows the profiles through the same pool. Every shop
 * WrL knows is fetched, not only those with parcels waiting.
 */
async function runCsvRound(reason) {
  if (csvRunning) return { ok: false, message: 'Đang có một lượt tải CSV chạy' };
  csvRunning = true;
  try {
    const settings = config.load(app);
    const cmsConfig = await csv.fetchConfig(settings);
    const plan = await new WrlClient(settings).etsyPlan();
    const { rows } = await resolveProfiles(settings, plan.shops || []);
    const { month, year } = vietnamNow();
    const csvTypes = parseCsvTypes(cmsConfig.csvType);
    if (!csvTypes.length) throw new Error('CMS chưa chọn loại CSV nào — tích ít nhất một loại ở trang "Tải Etsy CSV"');
    log(`Tải CSV Etsy (${reason}): ${csvTypes.join(' + ')}, tháng ${month}/${year}, ${rows.length} shop.`);

    // Etsy now emails the export instead of handing it over (see
    // src/csv-download.js), so most rounds end in "requested", not "saved".
    // Counted per shop × type: 5 shops with 2 types each is 10 exports.
    const total = rows.filter((shop) => shop.profileId).length * csvTypes.length;
    let saved = 0;
    let requested = 0;
    // Types that never reached the button (profile would not open, page did
    // not load…) get one more go at the end of the round. A type whose button
    // was pressed is never tried again: that would be a second export and email.
    const retry = [];
    const fetchShop = async (shop, types) => {
      try {
        const result = await csv.downloadShop(shop.shopName, { settings, profileId: shop.profileId, csvTypes: types });
        if (result.needsLogin) {
          stats.errors += 1;
          pushState();
          log(`${shop.shopName}: không tải CSV được — profile chưa đăng nhập Etsy.`);
          return [];
        }
        const results = result.results || [];
        const failed = results.filter((one) => one.error).length;
        saved += results.filter((one) => one.file).length;
        requested += results.filter((one) => one.requested).length;
        if (failed) {
          stats.errors += failed;
          pushState();
        }
        return results.filter((one) => one.error && !one.clicked).map((one) => one.csvType);
      } catch (error) {
        stats.errors += 1;
        pushState();
        log(`${shop.shopName}: tải CSV lỗi — ${error.message}`);
        return types;
      }
    };
    for (const shop of rows) {
      if (!shop.profileId) {
        log(`${shop.shopName}: chưa chọn profile Hidemyacc — bỏ qua tải CSV.`);
        continue;
      }
      const left = await fetchShop(shop, csvTypes);
      if (left.length) retry.push({ shop, types: left });
    }
    for (const { shop, types } of retry) {
      log(`${shop.shopName}: thử lại tải CSV ${types.join(' + ')} (lượt đầu chưa bấm được nút).`);
      const left = await fetchShop(shop, types);
      if (left.length) log(`${shop.shopName}: vẫn chưa tải được CSV ${left.join(' + ')} — xem lỗi ở trên.`);
    }
    const summary =
      `${requested}/${total} lượt (shop × loại CSV) đã gửi yêu cầu (Etsy sẽ email link tải)` +
      (saved ? `, ${saved} lượt tải được file ngay vào ${settings.csvDownloadDir}` : '');
    log(`CSV xong: ${summary}.`);
    return { ok: true, message: `CSV: ${summary}` };
  } catch (error) {
    log(`Tải CSV lỗi: ${error.message}`);
    return { ok: false, message: error.message };
  } finally {
    csvRunning = false;
  }
}

/**
 * Check the CMS timetable once a minute and run a round when a slot comes due.
 *
 * The slot is recorded before the round starts, so a round that fails or a
 * restart in the middle does not fire the same slot twice.
 */
function startCsvTimer() {
  let cached = null;
  let cachedAt = 0;

  const tick = async () => {
    const settings = config.load(app);
    if (!settings.csvEnabled || csvRunning || !settings.baseUrl || !settings.token) return;
    try {
      // The timetable changes rarely; asking the CMS every minute is not needed.
      if (!cached || Date.now() - cachedAt > 5 * 60000) {
        cached = await csv.fetchConfig(settings);
        cachedAt = Date.now();
      }
    } catch (error) {
      return; // CMS unreachable this minute — try again next tick, quietly.
    }
    if (!cached.scheduleEnabled || !parseTimes(cached.scheduleTimes).length) return;

    const done = Array.isArray(settings.csvDoneSlots) ? settings.csvDoneSlots : [];
    const slot = dueSlot(cached.scheduleTimes, done);
    if (!slot) return;

    config.save(app, { csvDoneSlots: [...done, slot].slice(-50) });
    cached = null; // pick up any change made in the CMS since
    await runCsvRound(`khung giờ ${slot.slice(11)}`);
  };

  setInterval(() => tick().catch(() => {}), 60000);
  setTimeout(() => tick().catch(() => {}), 15000);
}

// ------------------------------------------------------------ job 4: inbox

/**
 * The shops whose inbox is read, without asking WrL: one per Hidemyacc
 * profile named "Wakeup 24/7 - <shop>" (the agent's own profile of each shop),
 * plus any shop paired with a profile by hand in the window. A hand pairing
 * wins, and its spelling of the shop name is kept (the CMS keys on it).
 */
async function inboxShops(settings) {
  const profiles = await new HidemyaccClient(settings).profiles();
  const known = new Set(profiles.map((profile) => profile.id));
  const chosen = Object.entries(settings.hmaProfiles || {}).filter(([, id]) => known.has(id));
  const rows = chosen.map(([shopName, profileId]) => ({ shopName, profileId }));
  const taken = new Set(rows.map((row) => fold(row.shopName)));
  for (const profile of profiles) {
    const match = /^\s*wake\s*up\s*24\s*\/\s*7\s*-\s*(.+?)\s*$/i.exec(profile.name || '');
    if (!match || taken.has(fold(match[1]))) continue;
    taken.add(fold(match[1]));
    rows.push({ shopName: match[1], profileId: profile.id });
  }
  return rows.sort((a, b) => a.shopName.localeCompare(b.shopName));
}

/**
 * Read every shop's Etsy inbox into the CMS and send the replies written there
 * (src/inbox.js). Same shops and profiles as the other jobs, borrowed through
 * the same pool; one shop after another.
 */
async function runInboxRound(reason) {
  if (inboxRunning) return { ok: false, message: 'Đang có một lượt quét tin nhắn chạy' };
  inboxRunning = true;
  try {
    const settings = config.load(app);
    if (!settings.inboxToken) throw new Error('chưa điền token tin nhắn');
    const rows = await inboxShops(settings);
    if (!rows.length) throw new Error('không thấy profile "Wakeup 24/7 - <shop>" nào trong Hidemyacc');
    let sent = 0;
    let threads = 0;
    const failed = [];
    // A different order each round, not the same shop first every five minutes.
    for (const shop of shuffled(rows)) {
      if (!shop.profileId) {
        failed.push(`${shop.shopName} (chưa chọn profile)`);
        continue;
      }
      try {
        const result = await inbox.syncShop(shop.shopName, { settings, profileId: shop.profileId });
        sent += result.sent;
        threads += result.threads;
      } catch (error) {
        stats.errors += 1;
        pushState();
        failed.push(shop.shopName);
        log(`${shop.shopName}: quét tin nhắn lỗi — ${error.message}`);
      }
    }
    const summary =
      `${rows.length - failed.length}/${rows.length} shop, đọc ${threads} hội thoại, gửi ${sent} câu trả lời` +
      (failed.length ? `; lỗi: ${failed.join(', ')}` : '');
    // A quiet round is the normal case every five minutes; only say something when there was work.
    if (reason !== 'lịch' || threads || sent || failed.length) log(`Tin nhắn (${reason}): ${summary}.`);
    return { ok: true, message: `Tin nhắn: ${summary}` };
  } catch (error) {
    log(`Quét tin nhắn lỗi: ${error.message}`);
    return { ok: false, message: error.message };
  } finally {
    inboxRunning = false;
  }
}

/**
 * The quick lane for replies: every REPLY_POLL_MS ask the CMS which shops have
 * replies waiting (one cheap call) and send them right away, instead of
 * leaving them for the next inbox round — that one comes every few minutes and
 * walks the shops one by one, so a reply could wait five minutes and more.
 */
const REPLY_POLL_MS = 15000;
let replyRunning = false;

async function runReplyLane() {
  if (replyRunning) return;
  replyRunning = true;
  try {
    const settings = config.load(app);
    const waiting = await inbox.pendingShops(settings);
    // The CMS answered: an outage reported earlier is over.
    if (replyLaneDown) log('Gửi câu trả lời: CMS đã trả lời lại bình thường.');
    replyLaneDown = null;
    if (!waiting.length) return;
    const rows = await inboxShops(settings);
    for (const { shopName, queued } of waiting) {
      const shop = rows.find((row) => fold(row.shopName) === fold(shopName));
      if (!shop?.profileId) continue; // the round reports the missing profile
      try {
        const sent = await inbox.sendNow(shop.shopName, { settings, profileId: shop.profileId });
        if (sent) log(`${shop.shopName}: đã gửi ${sent}/${queued} câu trả lời từ CMS.`);
      } catch (error) {
        log(`${shop.shopName}: gửi câu trả lời lỗi — ${error.message}`);
      }
    }
  } catch (error) {
    // This runs every few seconds: say an outage once (and its end), not on every tick.
    const short = shortError(error.message);
    if (replyLaneDown !== short) log(`Gửi câu trả lời: ${short} — sẽ thử lại mỗi ${REPLY_POLL_MS / 1000} giây, chỉ báo lại khi CMS chạy lại.`);
    replyLaneDown = short;
  } finally {
    replyRunning = false;
  }
}

/** The last reply-lane error, while the CMS keeps failing (null when fine). */
let replyLaneDown = null;

/** "CMS trả lỗi 502: <html>…nginx…" → "CMS trả lỗi 502 (Bad Gateway)": one line for the log. */
function shortError(message) {
  const text = String(message || '');
  const status = /lỗi (\d{3})/.exec(text);
  if (status && /<html/i.test(text)) {
    const title = /<title>\s*\d*\s*([^<]*)<\/title>/i.exec(text);
    return `CMS trả lỗi ${status[1]}${title && title[1].trim() ? ` (${title[1].trim()})` : ''} — máy chủ CMS đang tắt hoặc khởi động lại`;
  }
  return text.slice(0, 200);
}

function startReplyTimer() {
  const tick = async () => {
    try {
      const settings = config.load(app);
      if (settings.inboxEnabled && settings.inboxToken) await runReplyLane();
    } finally {
      setTimeout(tick, REPLY_POLL_MS);
    }
  };
  setTimeout(tick, 20000);
}

/** A shuffled copy (Fisher–Yates). */
function shuffled(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const k = Math.floor(Math.random() * (i + 1));
    [out[i], out[k]] = [out[k], out[i]];
  }
  return out;
}

/** Every `inboxIntervalMinutes` (± a little), counted from the end of the last round. */
function startInboxTimer() {
  const next = () => {
    const minutes = Math.max(2, Number(config.load(app).inboxIntervalMinutes) || 5);
    // Uneven, like a person checking in now and then: 80–140 % of the set interval.
    setTimeout(tick, minutes * 60000 * (0.8 + Math.random() * 0.6));
  };
  const tick = async () => {
    try {
      const settings = config.load(app);
      if (settings.inboxEnabled && settings.inboxToken && settings.baseUrl && settings.token) await runInboxRound('lịch');
    } finally {
      next();
    }
  };
  setTimeout(tick, 30000);
}

// --------------------------------------------------------------------- loop

/** "07:00" from settings, falling back to 07:00 when the field is empty or malformed. */
function dailyTime(settings) {
  return parseTimes(settings.dailyRunTime)[0] || '07:00';
}

/** Today's round is due: past the set time and not yet finished today (Vietnam time). */
function dailyDue(settings) {
  const now = vietnamNow();
  return settings.lastDailyRun !== now.date && now.time >= dailyTime(settings);
}

/** Wait, a minute at a time so Stop still answers, until today's round is due. */
async function waitForDailyRound() {
  let announced = false;
  while (!stopRequested) {
    const settings = config.load(app);
    if (!settings.autoRun || dailyDue(settings)) return;
    if (!announced) {
      const today = vietnamNow();
      const when = settings.lastDailyRun === today.date ? 'ngày mai' : 'hôm nay';
      log(`Lượt quét tiếp theo: ${dailyTime(settings)} ${when} (giờ VN). Agent chờ đến lúc đó.`);
      announced = true;
    }
    await sleep(60000);
  }
}

async function loop() {
  const settings = config.load(app);
  const lanes = settings.lanes || 'both';
  const wantsTrack17 = lanes === 'both' || lanes === 'track17';
  const wantsEtsy = lanes === 'both' || lanes === 'etsy';

  running = true;
  stopRequested = false;
  if (etsy) etsy.setStopped(false);
  pushState();

  try {
    // Continuous mode works to a daily timetable: wait for the set time, run
    // the whole round, then wait for tomorrow. Without autoRun, Start runs one
    // batch straight away as before.
    if (settings.autoRun) await waitForDailyRound();

    while (!stopRequested) {
      // 17track first, one batch per turn: it is the cheaper lane and its
      // queue is what fills up fastest.
      let track17 = { done: true, remaining: 0 };
      if (wantsTrack17) {
        try {
          track17 = await runOnce();
        } catch (error) {
          stats.errors += 1;
          log(`Lỗi (17track): ${error.message}`);
          pushState();
          // A wrong token or a server that is down will not fix itself inside a
          // few seconds, so back off further than between ordinary batches.
          await sleep(60000);
          continue;
        }
      }

      if (stopRequested) break;

      // While 17track still has work, keep at it — reading Etsy's order pages
      // is much slower and would stall the queue behind it.
      if (!track17.done) {
        if (!settings.autoRun) break;
        const gap = settings.batchDelaySeconds || 25;
        log(`Chờ ${gap} giây trước lượt tiếp theo.`);
        await sleep(gap * 1000);
        continue;
      }

      if (wantsEtsy) {
        try {
          const { needsLogin } = await runEtsyPass();
          if (needsLogin.length) {
            log(`Cần đăng nhập Etsy trong profile Hidemyacc của: ${needsLogin.join(', ')}.`);
          }
        } catch (error) {
          stats.errors += 1;
          log(`Lỗi (Etsy): ${error.message}`);
          pushState();
        }
      }

      if (stopRequested || !settings.autoRun) break;

      // The round is complete — 17track's queue is empty and every shop has
      // been read. Mark today done and sleep until tomorrow's slot.
      config.save(app, { lastDailyRun: vietnamNow().date });
      log('Xong lượt quét hôm nay.');
      await waitForDailyRound();
    }
  } finally {
    running = false;
    stopRequested = false;
    pushState();
    log('Đã dừng.');
  }
}

// ------------------------------------------------------------------ windows

function createControlWindow() {
  controlWindow = new BrowserWindow({
    width: 760,
    height: 780,
    title: 'Track17 Agent',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  controlWindow.setMenuBarVisibility(false);
  controlWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Links in the window open in the operator's own browser, not inside the app.
  controlWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  controlWindow.on('closed', () => {
    controlWindow = null;
  });
}

// ---------------------------------------------------------------------- IPC

ipcMain.handle('config:get', () => config.load(app));

ipcMain.handle('config:save', (_event, patch) => {
  const next = config.save(app, patch);
  if (tracker) tracker.setVisible(Boolean(next.showBrowser));
  // Keep "start with Windows" in step with autoRun, so the box only brings the
  // agent back if it is meant to be working unattended.
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: Boolean(next.autoRun), args: ['--autostart'] });
  }
  return next;
});

ipcMain.handle('agent:start', async () => {
  if (running) return { ok: false, message: 'Đang chạy rồi' };
  const settings = config.load(app);
  if (!settings.token || !settings.baseUrl) {
    return { ok: false, message: 'Điền địa chỉ WrL và token trước đã' };
  }
  log(settings.autoRun ? 'Bắt đầu chạy liên tục.' : 'Chạy một lượt.');
  loop();
  return { ok: true };
});

ipcMain.handle('agent:stop', () => {
  if (!running) return { ok: false, message: 'Chưa chạy' };
  stopRequested = true;
  // Walking a shop's status pages takes minutes; let it break out mid-walk.
  if (etsy) etsy.setStopped(true);
  log('Đã yêu cầu dừng — sẽ dừng sau khi xong lượt hiện tại.');
  return { ok: true };
});

ipcMain.handle('agent:test', async () => {
  const settings = config.load(app);
  const client = new WrlClient(settings);
  const batch = await client.pending(1);
  const plan = await client.etsyPlan();
  return {
    ok: true,
    // The one number this claims is released by WrL's lease after ten minutes.
    message:
      `Kết nối tốt. 17track: ${batch.remaining + batch.count} mã chờ tra. ` +
      `Etsy: ${plan.waiting} vận đơn chờ, ${(plan.shops || []).filter((s) => s.waiting > 0).length} shop cần mở.`,
  };
});

ipcMain.handle('browser:show', async () => {
  await tracker.open({ show: true });
  return { ok: true };
});

/**
 * The shop ↔ profile table for the window: every shop WrL knows, the profile
 * each is paired with (saved or guessed), and every profile to choose from.
 */
ipcMain.handle('hma:mapping', async () => {
  const settings = config.load(app);
  let shops;
  try {
    shops = (await new WrlClient(settings).etsyPlan()).shops || [];
  } catch (error) {
    // WrL down: still show the shops the inbox reads, so pairing keeps working.
    log(`Bảng profile: WrL lỗi (${error.message}) — hiện các shop theo profile Hidemyacc.`);
    shops = (await inboxShops(settings)).map((row) => ({ shopName: row.shopName, waiting: 0 }));
  }
  const { rows, profiles } = await resolveProfiles(settings, shops);
  return { shops: rows, profiles };
});

/**
 * Start every shop's profile through Hidemyacc.
 *
 * This replaces opening them by hand: a profile opened from the Hidemyacc
 * window has no DevTools port, so the agent could never read it. Signing in to
 * Etsy inside a profile stays the operator's job — the agent types nothing.
 */
/** "Tải CSV ngay": one round now, whatever the timetable says. */
ipcMain.handle('csv:run', async () => {
  if (csvRunning) return { ok: false, message: 'Đang có một lượt tải CSV chạy' };
  // Answer at once; a round takes a minute or two per shop and reports in the log.
  runCsvRound('bấm tay');
  return { ok: true, message: 'Bắt đầu tải CSV — theo dõi ở nhật ký.' };
});

ipcMain.handle('inbox:run', () => runInboxRound('bấm tay'));
ipcMain.handle('lastmile:run', () => runLastMileRound('bấm tay'));

/** What the CMS timetable says, for the window. */
ipcMain.handle('csv:status', async () => {
  const settings = config.load(app);
  const cms = await csv.fetchConfig(settings);
  return {
    csvType: parseCsvTypes(cms.csvType).join(' + '),
    scheduleEnabled: Boolean(cms.scheduleEnabled),
    times: parseTimes(cms.scheduleTimes),
    now: vietnamNow(),
  };
});

ipcMain.handle('hma:open', async () => {
  const settings = config.load(app);
  const plan = await new WrlClient(settings).etsyPlan();
  const { rows } = await resolveProfiles(settings, plan.shops || []);
  const entries = rows.filter((row) => row.profileId);
  const missing = rows.filter((row) => !row.profileId).map((row) => row.shopName);
  if (!entries.length) return { ok: false, message: 'Chưa shop nào có profile Hidemyacc — chọn ở bảng bên dưới trước' };

  const { opened, failed } = await etsy.openProfiles(settings, entries);
  for (const line of failed) log(`Không mở được profile: ${line}`);
  return {
    ok: true,
    message:
      `Đã mở ${opened.length}/${entries.length} profile qua Hidemyacc` +
      (missing.length ? `. Chưa chọn profile: ${missing.join(', ')}` : '') +
      '.',
  };
});

// --------------------------------------------------------------------- boot

// One instance only: two copies would claim overlapping batches and race each
// other through the same 17track session.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (controlWindow) {
      if (controlWindow.isMinimized()) controlWindow.restore();
      controlWindow.focus();
    }
  });

  app.whenReady().then(() => {
    trimLogFile();
    createControlWindow();
    tracker = new Tracker(log);
    // One pool for every job, so none closes a profile another is using or
    // starts one another is starting (src/profile-pool.js).
    const pool = new ProfilePool(log);
    etsy = new EtsyReader(log, pool);
    csv = new CsvDownloader(log, pool);
    inbox = new InboxReader(log, pool, app.getVersion(), app.getPath('userData'));
    startCsvTimer();
    startInboxTimer();
    startLastMileTimer();
    startReplyTimer();

    // Watch for new releases and restart into them when nothing is in flight.
    // `running` is the whole definition of busy: while it is true a batch is
    // claimed from WrL or a shop's order pages are half-read.
    updater.start({ log });

    // Nobody is at the keyboard of a machine left running, so the app has to
    // start working by itself after a reboot, a crash restart, or the restart
    // an update does. `autoRun` is the setting that means "keep going on a
    // timer", so it is also what decides this; `--autostart` forces one launch
    // for an operator who leaves autoRun off.
    const boot = config.load(app);
    if (boot.autoRun || process.argv.includes('--autostart')) {
      if (boot.baseUrl && boot.token) {
        log(boot.autoRun ? 'Tự chạy khi khởi động (autoRun).' : 'Khởi chạy kèm --autostart.');
        loop();
      } else {
        log('Chưa tự chạy được: thiếu địa chỉ WrL hoặc token.');
      }
    }

    // On the 24/7 box the app must come back after a Windows reboot, and it
    // must come back already working. Driven from the same setting so turning
    // autoRun off in the window also stops it reappearing at login.
    if (app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: Boolean(boot.autoRun), args: ['--autostart'] });
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createControlWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}

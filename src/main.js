'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, shell } = require('electron');

const config = require('./config');
const { WrlClient } = require('./wrl');
const { Tracker, MAX_PER_QUERY } = require('./tracker');
const { EtsyReader } = require('./etsy');
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
 *            seller's own order list. See src/etsy.js.
 *
 * The queue and the answers both go through WrL (wearelucky.io.vn), which stays
 * the only thing that writes to the CMS.
 */

let controlWindow = null;
let tracker = null;
let etsy = null;

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

  const { results, via } = await tracker.lookup(batch.numbers, {
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

// ------------------------------------------------------------- lane 2: Etsy

/**
 * Walk every shop that has parcels waiting and read their order pages.
 *
 * A shop whose Etsy session has lapsed is skipped, not retried in a loop: its
 * window is brought to the front for the operator to sign in, and it comes
 * round again next cycle.
 */
async function runEtsyPass() {
  const settings = config.load(app);
  const client = new WrlClient(settings);

  const plan = await client.etsyPlan();
  const shops = (plan.shops || []).filter((shop) => shop.waiting > 0);

  if (!shops.length) {
    log('Không shop nào còn đơn cần đọc trạng thái từ Etsy.');
    return { needsLogin: [] };
  }

  log(`Đọc Etsy cho ${shops.length} shop (${plan.waiting} vận đơn đang chờ).`);
  const needsLogin = [];

  for (const shop of shops) {
    if (stopRequested) break;

    const { needsLogin: lapsed, orders } = await etsy.readShop(shop.shopName, {
      pages: settings.etsyPagesPerShop || 5,
      pageDelayMs: (settings.etsyPageDelaySeconds || 8) * 1000,
    });

    if (lapsed) {
      needsLogin.push(shop.shopName);
      continue;
    }
    if (!orders.length) {
      log(`${shop.shopName}: không đọc được trạng thái nào.`);
      continue;
    }

    const applied = await client.submitEtsy(orders);
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

// --------------------------------------------------------------------- loop

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
            log(`Cần đăng nhập Etsy cho: ${needsLogin.join(', ')}.`);
          }
        } catch (error) {
          stats.errors += 1;
          log(`Lỗi (Etsy): ${error.message}`);
          pushState();
        }
      }

      if (stopRequested || !settings.autoRun) break;

      const minutes = settings.idleMinutes || 30;
      log(`Nghỉ ${minutes} phút rồi kiểm tra lại.`);
      await sleep(minutes * 60000);
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
  if (etsy) etsy.setVisible(Boolean(next.showBrowser));
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
 * Open a shop's Etsy window so the operator can sign in before a run.
 *
 * Signing in is theirs to do — the app never types credentials. It only keeps
 * the session, one browser profile per shop.
 */
ipcMain.handle('etsy:login', async () => {
  const settings = config.load(app);
  const client = new WrlClient(settings);
  const plan = await client.etsyPlan();
  const shops = plan.shops || [];
  if (!shops.length) return { ok: false, message: 'WrL chưa có shop Etsy nào đang kết nối' };

  for (const shop of shops) await etsy.open(shop.shopName, { show: true });
  return {
    ok: true,
    message: `Đã mở ${shops.length} cửa sổ Etsy: ${shops.map((s) => s.shopName).join(', ')}. Sếp tự đăng nhập từng shop.`,
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
    etsy = new EtsyReader(log);

    // Watch for new releases and restart into them when nothing is in flight.
    // `running` is the whole definition of busy: while it is true a batch is
    // claimed from WrL or a shop's order pages are half-read.
    updater.start({ log, isBusy: () => running });

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

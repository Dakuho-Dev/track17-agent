'use strict';

const fs = require('fs');
const path = require('path');
const { signInScript } = require('./etsy');

/**
 * Downloads each shop's Etsy CSV export on a timetable set in the CMS.
 *
 * The CMS page "Tải Etsy CSV" holds one config: which CSV (Order Items, Orders,
 * Etsy Payments Sales, Etsy Payments Deposits) and the times of day to fetch
 * it. At each of those times the agent, for every shop that has a Hidemyacc
 * profile, does what a person would on
 *
 *     https://www.etsy.com/your/shops/me/download
 *
 * pick the CSV type, pick the CURRENT month and year, press "Download CSV" —
 * in a tab of its own inside the shop's profile, alongside whatever the status
 * reader is doing in another tab.
 *
 * The form is driven by its field ids (#filter-csv-type, #filter-month,
 * #filter-year), the same ones the old Chrome extension used; options are
 * matched loosely on value or label, because Etsy's values and the CMS's names
 * ("OrderItems" vs "Order Items") do not have to agree letter for letter.
 *
 * The file is caught over DevTools rather than left to the profile's own
 * download folder, so it lands in one known place, named per shop:
 *
 *     <csvDownloadDir>/<shop>/<shop> - <Etsy's file name>.csv
 *
 * A later run in the same month overwrites the earlier file — the later one
 * holds everything the earlier one did, and more.
 */

const DOWNLOAD_URL = 'https://www.etsy.com/your/shops/me/download';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Current month and year in Vietnam, where the timetable is written. */
function vietnamNow(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Ho_Chi_Minh',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${hour}:${parts.minute}`,
    month: Number(parts.month),
    year: Number(parts.year),
  };
}

/** "08:00,14:30" → ["08:00", "14:30"], invalid entries dropped. */
function parseTimes(raw) {
  return String(raw || '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(t))
    .map((t) => t.padStart(5, '0'));
}

const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * Which slot, if any, is due now.
 *
 * A slot is due from its time until an hour after, and only once per day —
 * `done` remembers the slots already run, and survives a restart because the
 * caller keeps it in config. An agent that was off for the whole hour skips
 * that slot rather than firing it late.
 */
function dueSlot(times, done, now = vietnamNow()) {
  const current = minutesOf(now.time);
  for (const time of parseTimes(times)) {
    const key = `${now.date} ${time}`;
    const late = current - minutesOf(time);
    if (late >= 0 && late < 60 && !done.includes(key)) return key;
  }
  return null;
}

/** Runs in the page: fill the Orders form. Returns what was chosen, or why not. */
function fillFormScript(csvType, month, year) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const pick = (select, wanted) => {
    if (!select) return null;
    const options = [...select.options].filter((o) => o.value);
    const target = wanted.map(norm);
    const hit =
      options.find((o) => target.includes(norm(o.value))) ||
      options.find((o) => target.includes(norm(o.text))) ||
      options.find((o) => target.some((t) => t && norm(o.text).startsWith(t)));
    if (!hit) return null;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(select, hit.value);
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return { value: hit.value, text: hit.text.trim() };
  };

  const typeSelect = document.querySelector('#filter-csv-type');
  const monthSelect = document.querySelector('#filter-month');
  const yearSelect = document.querySelector('#filter-year');
  if (!typeSelect || !monthSelect || !yearSelect) {
    return { error: 'không thấy form tải CSV (#filter-csv-type / #filter-month / #filter-year)' };
  }

  const type = pick(typeSelect, [csvType]);
  // Month options read "10 - October"; the value is usually "10".
  const monthPicked = pick(monthSelect, [String(month), String(month).padStart(2, '0'), `${month} -`]);
  const yearPicked = pick(yearSelect, [String(year)]);
  if (!type) return { error: `không có loại CSV "${csvType}" trong danh sách: ${[...typeSelect.options].map((o) => o.text.trim()).join(', ')}` };
  if (!monthPicked) return { error: `không chọn được tháng ${month}` };
  if (!yearPicked) return { error: `không chọn được năm ${year}` };
  return { type, month: monthPicked, year: yearPicked };
}

/** Runs in the page: the "Download CSV" button that belongs to the Orders form. */
function orderButtonScript() {
  const year = document.querySelector('#filter-year');
  const buttons = [...document.querySelectorAll('button, input[type="submit"], a')].filter((el) =>
    /download csv/i.test(el.innerText || el.value || ''),
  );
  // The page has one per section; the Orders one is the first after the year box.
  return buttons.find((el) => year && year.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) || null;
}

function safeName(text) {
  return String(text).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'shop';
}

class CsvDownloader {
  /**
   * @param {(message: string) => void} log
   * @param {import('./profile-pool').ProfilePool} pool shared with the status reader
   */
  constructor(log, pool) {
    this.log = log;
    this.pool = pool;
  }

  /** The CMS config: { csvType, scheduleTimes, scheduleEnabled, … }. */
  async fetchConfig(settings) {
    const base = String(settings.cmsApiUrl || 'https://apiserver.dakuho.com').replace(/\/$/, '');
    const res = await fetch(`${base}/etsy-download-config`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`CMS trả lỗi ${res.status} khi đọc cấu hình tải CSV`);
    const text = await res.text();
    if (!text) throw new Error('CMS chưa có cấu hình tải CSV — lưu một lần ở trang "Tải Etsy CSV"');
    return JSON.parse(text);
  }

  /**
   * Download one shop's CSV for the current month. Returns `{ file }`, or
   * `{ needsLogin }` when the profile is not signed in to Etsy.
   */
  async downloadShop(shopName, { settings, profileId, csvType }) {
    const { month, year } = vietnamNow();
    const dir = path.join(settings.csvDownloadDir, safeName(shopName));
    fs.mkdirSync(dir, { recursive: true });

    return this.pool.use(settings, profileId, async (browser, profile) => {
      const page = await browser.newPage();
      // Browser-wide setting: catch downloads into our folder under their guid,
      // then rename. Put back to the profile's normal behaviour when done, so
      // the operator's own downloads go where they always do.
      const cdp = await browser.target().createCDPSession();
      try {
        await page.goto(DOWNLOAD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        const state = await page.evaluate(signInScript()).catch((error) => ({ signedIn: false, reason: error.message }));
        if (!state.signedIn) {
          this.log(`${shopName}: profile "${profile.name}" chưa đăng nhập Etsy (${state.reason}).`);
          return { needsLogin: true };
        }

        await page.waitForSelector('#filter-csv-type', { timeout: 30000 }).catch(() => {});
        // Let Etsy's own script settle before touching the form, as a person would.
        await sleep(1500 + Math.random() * 1500);

        const chosen = await page.evaluate(fillFormScript, csvType, month, year);
        if (chosen.error) throw new Error(chosen.error);
        await sleep(800 + Math.random() * 700);

        const button = await page.evaluateHandle(orderButtonScript);
        if (!button.asElement()) throw new Error('không thấy nút "Download CSV" của mục Orders');

        await cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: dir, eventsEnabled: true });
        const done = waitForDownload(cdp, 120000);
        await button.asElement().click();
        const { guid, suggestedFilename } = await done;

        const finalName = `${safeName(shopName)} - ${safeName(suggestedFilename || `${chosen.type.value}-${year}-${month}.csv`)}`;
        const finalPath = path.join(dir, finalName);
        fs.rmSync(finalPath, { force: true });
        fs.renameSync(path.join(dir, guid), finalPath);

        this.log(`${shopName}: đã tải ${chosen.type.text} tháng ${month}/${year} → ${finalPath}`);
        return { file: finalPath };
      } finally {
        await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' }).catch(() => {});
        await cdp.detach().catch(() => {});
        await page.close().catch(() => {});
      }
    });
  }
}

/** Resolve with { guid, suggestedFilename } once the download has finished. */
function waitForDownload(cdp, timeoutMs) {
  return new Promise((resolve, reject) => {
    let started = null;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(started ? 'tải CSV quá lâu, chưa xong' : 'bấm Download CSV nhưng Etsy không trả file'));
    }, timeoutMs);
    const onBegin = (event) => {
      if (!started) started = event;
    };
    const onProgress = (event) => {
      if (!started || event.guid !== started.guid) return;
      if (event.state === 'completed') {
        cleanup();
        resolve({ guid: started.guid, suggestedFilename: started.suggestedFilename });
      } else if (event.state === 'canceled') {
        cleanup();
        reject(new Error('Etsy/Chrome đã huỷ lượt tải'));
      }
    };
    function cleanup() {
      clearTimeout(timer);
      cdp.off('Browser.downloadWillBegin', onBegin);
      cdp.off('Browser.downloadProgress', onProgress);
    }
    cdp.on('Browser.downloadWillBegin', onBegin);
    cdp.on('Browser.downloadProgress', onProgress);
  });
}

module.exports = { CsvDownloader, dueSlot, parseTimes, vietnamNow, fillFormScript, orderButtonScript, waitForDownload, DOWNLOAD_URL };

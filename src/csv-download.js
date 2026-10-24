'use strict';

const fs = require('fs');
const path = require('path');
const { signInScript } = require('./etsy');

/**
 * Downloads each shop's Etsy CSV export on a timetable set in the CMS.
 *
 * The CMS page "Tải Etsy CSV" holds one config: which CSVs (any of Order
 * Items, Orders, Etsy Payments Sales, Etsy Payments Deposits — stored as
 * "OrderItems,EtsyPaymentsDeposits") and the times of day to fetch them. At
 * each of those times the agent, for every shop that has a Hidemyacc profile,
 * does what a person would on
 *
 *     https://www.etsy.com/your/shops/me/download
 *
 * once per chosen type: pick the CSV type, pick the CURRENT month and year,
 * press "Download CSV". The types go one after another in one tab of the
 * shop's profile, alongside whatever the status reader is doing in another.
 *
 * The form is driven by its field ids (#filter-csv-type, #filter-month,
 * #filter-year), the same ones the old Chrome extension used; options are
 * matched loosely on value or label, because Etsy's values and the CMS's names
 * ("OrderItems" vs "Order Items") do not have to agree letter for letter.
 *
 * What happens after the click, measured on 2026-10-08 across four shops:
 * Etsy no longer hands the file over. The form's GET /your/orders/sold.csv
 * answers 302 back to the download page, which now says "We're generating
 * your download and will email you a link to it when it's ready." So a click
 * is a REQUEST for the export; the file arrives by email to the account.
 * That message is what counts as success here.
 *
 * Should Etsy ever answer with the file directly again, it is still caught
 * over DevTools into one known place, named per shop:
 *
 *     <csvDownloadDir>/<shop>/<shop> - <Etsy's file name>.csv
 *
 * Every click makes Etsy build an export and send an email, so nothing here
 * retries or re-submits on its own.
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

/** CMS csvType "OrderItems, EtsyPaymentsDeposits" → ["OrderItems", "EtsyPaymentsDeposits"]. */
function parseCsvTypes(raw) {
  return [...new Set(String(raw || '').split(',').map((t) => t.trim()).filter(Boolean))];
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

/** How long to wait after the click for Etsy's notice (or, rarely, a file). */
const CLICK_WAIT_MS = 30000;

/** Pause between two CSV types of the same shop (plus up to 10 s of jitter). */
const BETWEEN_TYPES_MS = 20000;

/** The request the Orders form sends on "Download CSV" (GET /your/orders/sold.csv). */
const EXPORT_URL = /\/your\/orders\/sold\.csv/i;

/** Runs in the page: Etsy's "we're generating your download" notice, if shown. */
function generatingNoticeScript() {
  const match = (document.body.innerText || '').match(/We['’]re generating your download[^\n]*/i);
  return match ? match[0].trim() : null;
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
   * Request every chosen CSV type for one shop, current month, in one visit to
   * its profile. Returns `{ results: [{ csvType, requested?, file?, error?, clicked? }] }`,
   * or `{ needsLogin }` when the profile is not signed in to Etsy.
   *
   * The types go one after another in a single tab, with a pause between
   * them. They used to run in parallel tabs a second or two apart, and some
   * shops then got only one of their two emails (or none) although every tab
   * had read Etsy's "we're generating your download" notice: the notice is
   * shared by the whole session, so a tab can read the one meant for its
   * neighbour, and Etsy does not seem to take two exports from one shop at
   * the same instant. A type that fails does not stop the next: its error is
   * logged and kept in its result, with `clicked` saying whether the button
   * was pressed (only an unpressed type is safe to try again).
   */
  async downloadShop(shopName, { settings, profileId, csvTypes }) {
    const types = Array.isArray(csvTypes) ? csvTypes : parseCsvTypes(csvTypes);
    const dir = path.join(settings.csvDownloadDir, safeName(shopName));
    fs.mkdirSync(dir, { recursive: true });

    return this.pool.use(settings, profileId, async (browser, profile) => {
      // Browser-wide setting: catch downloads into our folder under their guid,
      // then rename. Put back to the profile's normal behaviour when done, so
      // the operator's own downloads go where they always do.
      const cdp = await browser.target().createCDPSession();
      let page = null;
      try {
        await cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: dir, eventsEnabled: true });
        page = await browser.newPage();
        const results = [];
        for (const [index, csvType] of types.entries()) {
          if (index > 0) await sleep(BETWEEN_TYPES_MS + Math.random() * 10000);
          try {
            const one = await this.requestOne(page, cdp, { shopName, profile, csvType, dir });
            if (one.needsLogin) return { needsLogin: true };
            results.push({ csvType, ...one });
          } catch (error) {
            this.log(`${shopName}: tải CSV ${csvType} lỗi — ${error.message}`);
            results.push({ csvType, error: error.message, clicked: Boolean(error.clicked) });
          }
        }
        return { results };
      } finally {
        await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' }).catch(() => {});
        await cdp.detach().catch(() => {});
        if (page) await page.close().catch(() => {});
      }
    });
  }

  /** One CSV type: load the download page, fill the form, click, read the outcome. */
  async requestOne(page, cdp, { shopName, profile, csvType, dir }) {
    const { month, year } = vietnamNow();
    await page.goto(DOWNLOAD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const state = await page.evaluate(signInScript()).catch((error) => ({ signedIn: false, reason: error.message }));
    if (!state.signedIn) {
      this.log(`${shopName}: profile "${profile.name}" chưa đăng nhập Etsy (${state.reason}).`);
      return { needsLogin: true };
    }

    await page.waitForSelector('#filter-csv-type', { timeout: 30000 }).catch(() => {});
    // Let Etsy's own script settle before touching the form, as a person would.
    await sleep(1500 + Math.random() * 1500);

    // A notice already on the page before the click belongs to an earlier
    // request, so it cannot be taken as this one's answer.
    const staleNotice = await page.evaluate(generatingNoticeScript).catch(() => null);

    const chosen = await page.evaluate(fillFormScript, csvType, month, year);
    if (chosen.error) throw new Error(chosen.error);
    await sleep(800 + Math.random() * 700);

    const button = await page.evaluateHandle(orderButtonScript);
    if (!button.asElement()) throw new Error('không thấy nút "Download CSV" của mục Orders');

    // What the page asks for after the click — the evidence when no file comes,
    // and, for the export request itself, the proof that Etsy got it.
    const requests = [];
    let exportRequest = null;
    const onRequest = (request) => {
      if (requests.length < 15) requests.push(`${request.method()} ${request.url().slice(0, 140)}`);
    };
    const onResponse = (response) => {
      if (!exportRequest && EXPORT_URL.test(response.url())) {
        exportRequest = { url: response.url(), status: response.status() };
      }
    };
    page.on('request', onRequest);
    page.on('response', onResponse);

    const download = waitForDownload(cdp, CLICK_WAIT_MS, page.mainFrame()._id).catch(() => null);
    try {
      await button.asElement().click();
      // The usual outcome: the page reloads with Etsy's "we'll email you" notice.
      await page.waitForNavigation({ timeout: CLICK_WAIT_MS }).catch(() => {});
      await sleep(1500);
    } finally {
      page.off('request', onRequest);
      page.off('response', onResponse);
    }

    const notice = await page.evaluate(generatingNoticeScript).catch(() => null);
    const accepted = exportRequest && exportRequest.status < 400;
    if (notice && (accepted || !staleNotice)) {
      const sent = exportRequest ? ` (${exportRequest.status} ${exportRequest.url.slice(0, 160)})` : '';
      this.log(`${shopName}: đã yêu cầu ${chosen.type.text} tháng ${month}/${year} — Etsy: "${notice}"${sent}`);
      return { requested: true, notice };
    }

    const file = await download;
    if (file) {
      const fallbackName = `EtsySold${chosen.type.value}${year}-${String(month).padStart(2, '0')}.csv`;
      const finalPath = path.join(dir, `${safeName(shopName)} - ${safeName(file.suggestedFilename || fallbackName)}`);
      fs.rmSync(finalPath, { force: true });
      fs.renameSync(path.join(dir, file.guid), finalPath);
      this.log(`${shopName}: đã tải ${chosen.type.text} tháng ${month}/${year} → ${finalPath}`);
      return { file: finalPath };
    }

    // Neither the notice nor a file: say what the page did, and do not
    // click again — each click is another export and another email.
    const error = new Error(
      `bấm Download CSV nhưng Etsy không báo đang tạo file, cũng không trả file` +
        (staleNotice ? ' (thông báo trên trang có từ trước khi bấm)' : '') +
        `. Trang: ${page.url()}. Request sau khi bấm: ${requests.join(' | ') || 'không có'}`,
    );
    error.clicked = true;
    throw error;
  }
}

/**
 * Resolve with { guid, suggestedFilename } once the download has finished.
 * With `frameId`, only a download started from that frame (one tab) counts.
 */
function waitForDownload(cdp, timeoutMs, frameId) {
  return new Promise((resolve, reject) => {
    let started = null;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(started ? 'tải CSV quá lâu, chưa xong' : 'bấm Download CSV nhưng Etsy không trả file'));
    }, timeoutMs);
    const onBegin = (event) => {
      if (frameId && event.frameId && event.frameId !== frameId) return;
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

module.exports = { CsvDownloader, dueSlot, parseTimes, parseCsvTypes, vietnamNow, fillFormScript, orderButtonScript, waitForDownload, DOWNLOAD_URL };

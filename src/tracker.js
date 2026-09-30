'use strict';

const { BrowserWindow } = require('electron');
const { fromApiResponse, PAGE_PHRASES } = require('./status');

/**
 * Drives 17track.net in a real browser window.
 *
 * No free API covers the carriers Etsy sellers actually use outside USPS — DHL,
 * Yanwen, YunExpress, UniUni, SPX and friends — but the site's own search box
 * does, forty numbers at a time. So the agent does what a person would: paste
 * the batch, submit, read the answers.
 *
 * Reading them is the part worth explaining. The page renders from a call it
 * makes to its own /restapi/track, so instead of guessing at CSS classes that
 * change with every redesign, the window's DevTools protocol connection copies
 * that response as it arrives. Scraping the rendered text is only the fallback
 * for when no such response shows up.
 */

/**
 * The batch box lives on www; submitting it navigates the window to t., where
 * the results render. Both were confirmed by hand on 2026-09-28.
 */
const HOME_URL = 'https://www.17track.net/en';
/** Where the results land, and the address that also accepts a batch directly. */
const RESULT_URL = 'https://t.17track.net/en';
/** POST https://t.17track.net/track/restapi — match loosely, the path has moved before. */
const RESULT_ENDPOINT = 'restapi';

/** 17track.net's search box accepts this many numbers per query. */
const MAX_PER_QUERY = 40;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fill the search box and submit it, exactly as a person would.
 *
 * Three things here were learned the hard way against the live page:
 *  - there are two textareas in the DOM and only one is on screen, so the
 *    first match is the wrong one;
 *  - the submit control is a `span` reading "TRACK", not a button, and its
 *    label carries a count once numbers are entered ("Track(2)");
 *  - a first-time visitor gets an onboarding tour that swallows the click.
 */
function submitScript(numbers) {
  return `(async () => {
    const numbers = ${JSON.stringify(numbers)};
    const text = numbers.join(String.fromCharCode(10));

    const onScreen = (el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 20 && rect.height > 10 && getComputedStyle(el).visibility !== 'hidden';
    };

    // Clear the welcome tour if this profile has never been here before.
    if (document.body.innerText.includes('Welcome!')) {
      for (const el of document.querySelectorAll('button, [role="button"], span, i, div')) {
        const label = (el.innerText || '').trim();
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        if (label === '\\u00d7' || label === 'Skip' || label === 'Got it' || aria.includes('close')) {
          try { el.click(); } catch (error) { /* an overlay that refuses to close is not fatal */ }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }

    const box =
      Array.from(document.querySelectorAll('textarea')).find(onScreen) ||
      Array.from(document.querySelectorAll('input[type="search"], input[name="num"], input[placeholder*="racking" i]')).find(onScreen);
    if (!box) return { ok: false, reason: 'no-input' };

    // The site is a reactive app, so assigning .value directly is ignored — the
    // native setter plus an input event is what its bindings listen for.
    const proto = box.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    box.focus();
    setter.call(box, text);
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new Event('change', { bubbles: true }));

    // Give the count on the button time to catch up with what we just typed.
    await new Promise((resolve) => setTimeout(resolve, 800));

    const label = /^track\\s*(\\(\\d+\\))?$/i;
    const hit = Array.from(document.querySelectorAll('button, a, input[type="submit"], [role="button"], span, div'))
      .find((el) => label.test((el.innerText || el.value || '').trim()) && onScreen(el));
    if (hit) {
      // Submitting navigates the window, which tears this script down before it
      // can return. Let the call answer first, then click a tick later.
      const target = hit.closest('button, a, [role="button"]') || hit;
      setTimeout(() => target.click(), 50);
      return { ok: true, via: 'button', count: numbers.length };
    }

    const form = box.closest('form');
    if (form) {
      if (form.requestSubmit) form.requestSubmit(); else form.submit();
      return { ok: true, via: 'form', count: numbers.length };
    }

    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    return { ok: true, via: 'enter', count: numbers.length };
  })()`;
}

/**
 * Last resort: read the answers off the rendered page.
 *
 * Deliberately structural rather than selector-based — find the line carrying a
 * number we asked about, then take the nearest status phrase after it. Layout
 * changes break CSS selectors; they rarely change that ordering.
 */
function scrapeScript(numbers) {
  return `(() => {
    const numbers = ${JSON.stringify(numbers)};
    const phrases = ${JSON.stringify(PAGE_PHRASES)};
    const lines = document.body.innerText
      .split(String.fromCharCode(10))
      .map((line) => line.trim())
      .filter(Boolean);

    const out = [];
    for (const number of numbers) {
      const at = lines.findIndex((line) => line.toUpperCase().includes(number.toUpperCase()));
      if (at === -1) continue;

      const nearby = lines.slice(at, at + 8);
      let statusText = null;
      for (const line of nearby) {
        const hit = phrases.find((phrase) => line.toLowerCase() === phrase.toLowerCase());
        if (hit) { statusText = hit; break; }
      }
      if (!statusText) {
        for (const line of nearby) {
          const hit = phrases.find((phrase) => line.toLowerCase().includes(phrase.toLowerCase()));
          if (hit) { statusText = hit; break; }
        }
      }
      if (!statusText) continue;

      out.push({
        trackingNumber: number,
        statusText,
        lastEvent: nearby.find((line) => line.length > 25 && !line.includes(number)) || null,
      });
    }
    return out;
  })()`;
}

class Tracker {
  /** @param {(message: string) => void} log */
  constructor(log) {
    this.log = log;
    this.window = null;
    this.captured = [];
    this.pendingBodies = new Map();
  }

  /** Open (or reveal) the 17track window and start copying its result traffic. */
  async open({ show = true } = {}) {
    if (this.window && !this.window.isDestroyed()) {
      if (show) this.window.show();
      return this.window;
    }

    this.window = new BrowserWindow({
      width: 1180,
      height: 820,
      show,
      title: '17track.net',
      webPreferences: {
        // A named partition keeps cookies between runs, so the site treats the
        // agent as the same returning visitor rather than a brand new one.
        partition: 'persist:17track',
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    this.window.on('closed', () => {
      this.window = null;
    });

    this.#attachCapture(this.window.webContents);
    await this.window.loadURL(HOME_URL);
    return this.window;
  }

  close() {
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }

  setVisible(show) {
    if (!this.window || this.window.isDestroyed()) return;
    if (show) this.window.show();
    else this.window.hide();
  }

  #attachCapture(webContents) {
    try {
      webContents.debugger.attach('1.3');
    } catch (error) {
      this.log(`Không gắn được bộ đọc kết quả: ${error.message}`);
      return;
    }

    webContents.debugger.on('detach', (_event, reason) => {
      this.log(`Bộ đọc kết quả ngắt kết nối (${reason})`);
    });

    webContents.debugger.on('message', async (_event, method, params) => {
      if (method === 'Network.responseReceived') {
        if (String(params.response.url || '').includes(RESULT_ENDPOINT)) {
          this.pendingBodies.set(params.requestId, true);
        }
        return;
      }

      if (method !== 'Network.loadingFinished') return;
      if (!this.pendingBodies.delete(params.requestId)) return;

      try {
        const { body, base64Encoded } = await webContents.debugger.sendCommand(
          'Network.getResponseBody',
          { requestId: params.requestId },
        );
        const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
        const parsed = fromApiResponse(JSON.parse(text));
        if (parsed.length) this.captured.push(...parsed);
      } catch (error) {
        // A body we cannot read is not fatal — the scrape fallback still runs.
        this.log(`Bỏ qua một phản hồi không đọc được: ${error.message}`);
      }
    });

    webContents.debugger.sendCommand('Network.enable').catch((error) => {
      this.log(`Không bật được theo dõi mạng: ${error.message}`);
    });
  }

  /**
   * Look one batch up and return whatever could be resolved.
   *
   * Returns `{ results, via }` — `via` says which path produced the answers, so
   * a change on 17track's side shows up in the log as a switch to 'scrape'
   * rather than as silence.
   */
  async lookup(numbers, { timeoutMs = 60000 } = {}) {
    if (!numbers.length) return { results: [], via: 'none' };
    if (numbers.length > MAX_PER_QUERY) {
      throw new Error(`Mỗi lượt tối đa ${MAX_PER_QUERY} mã, nhận được ${numbers.length}`);
    }

    const window = await this.open({ show: true });
    const webContents = window.webContents;

    // Start each batch from the home page: the site keeps previous results on
    // screen, and a stale row would otherwise be read as this batch's answer.
    await webContents.loadURL(HOME_URL);
    await sleep(1200);

    this.captured = [];

    let submitted;
    try {
      submitted = await webContents.executeJavaScript(submitScript(numbers), true);
    } catch (error) {
      submitted = { ok: false, reason: error.message };
    }

    if (!submitted || !submitted.ok) {
      // The search box moved or is not rendered yet. The site also accepts a
      // batch straight off the address bar, which is what the tracking links in
      // the CMS already use, so fall back to that.
      this.log(`Không thấy ô nhập (${submitted && submitted.reason}); dùng địa chỉ #nums`);
      await webContents.loadURL(`${RESULT_URL}#nums=${numbers.map(encodeURIComponent).join(',')}`);
    } else {
      this.log(`Đã dán ${submitted.count} mã và bấm tra (${submitted.via})`);
    }

    const results = await this.#awaitResults(numbers, timeoutMs);
    if (results.length) return { results, via: 'api' };

    this.log('Không bắt được dữ liệu; đọc thẳng trên trang');
    const scraped = await webContents.executeJavaScript(scrapeScript(numbers), true).catch(() => []);
    return { results: scraped, via: scraped.length ? 'scrape' : 'none' };
  }

  /**
   * Wait for the captured answers, settling once they stop arriving.
   *
   * The site answers in several responses when a batch is large, so "we have
   * one" is not "we have them all" — but waiting for every number would stall
   * on the ones 17track simply has no data for. A short quiet period after the
   * last arrival is the compromise.
   */
  async #awaitResults(numbers, timeoutMs) {
    const wanted = new Set(numbers.map((number) => number.toUpperCase()));
    const deadline = Date.now() + timeoutMs;
    const QUIET_MS = 2500;
    let lastCount = 0;
    let lastChangeAt = Date.now();

    while (Date.now() < deadline) {
      await sleep(400);

      const matched = this.captured.filter((item) =>
        wanted.has(String(item.trackingNumber).toUpperCase()),
      );

      if (matched.length !== lastCount) {
        lastCount = matched.length;
        lastChangeAt = Date.now();
      }

      if (matched.length >= wanted.size) return this.#dedupe(matched);
      if (matched.length > 0 && Date.now() - lastChangeAt > QUIET_MS) return this.#dedupe(matched);
    }

    return this.#dedupe(
      this.captured.filter((item) => wanted.has(String(item.trackingNumber).toUpperCase())),
    );
  }

  /** Keep the last answer per number — a retry inside the batch supersedes the first. */
  #dedupe(items) {
    const byNumber = new Map();
    for (const item of items) byNumber.set(String(item.trackingNumber).toUpperCase(), item);
    return [...byNumber.values()];
  }
}

// submitScript / scrapeScript are exported so their generated source can be
// syntax-checked without launching a window — they are the most breakage-prone
// part of the agent.
module.exports = { Tracker, MAX_PER_QUERY, HOME_URL, RESULT_URL, submitScript, scrapeScript };

'use strict';

const { BrowserWindow } = require('electron');

/**
 * Reads transit status off a seller's own Etsy order pages.
 *
 * This is the lane that covers USPS, and in practice everything else too. Every
 * free third-party route for a USPS number is closed (17track's site answers
 * "Access Restricted — USPS policy change", parcelsapp has no data, and
 * tools.usps.com sits behind Akamai Bot Manager, which hands an automated
 * browser a blank page). Etsy, though, has already resolved the carrier.
 *
 * The important part is how: Etsy's order list takes the shipping status as a
 * URL parameter —
 *
 *     /your/orders/sold/all?completed_status=pre_transit
 *
 * so the page itself is the filter. Every order listed is in that status, and
 * the agent only has to collect order numbers. Nothing depends on reading a
 * label out of a row, which is what made the earlier version fragile: Etsy
 * rewrites its markup often, but "#" followed by digits is the order number and
 * always will be.
 *
 * Each shop gets its own browser session, because each is a separate Etsy
 * login. Nothing is typed for the operator: they sign in themselves, once per
 * shop, and the session persists from then on.
 */

const ORDERS_URL = 'https://www.etsy.com/your/orders/sold/all';

/**
 * Which status pages to walk, and what each one means in our vocabulary.
 *
 * The two moving states are what the team watches, so they are polled every
 * round. `delivered` is walked as well — without it a parcel that arrives would
 * sit at IN_TRANSIT in the CMS for ever, because an order simply stops
 * appearing in the first two lists when it lands. Drop it from this array if
 * the extra page load per shop is ever not worth it.
 */
const STATUS_PAGES = [
  { param: 'pre_transit', status: 'PRE_TRANSIT' },
  { param: 'in_transit', status: 'IN_TRANSIT' },
  { param: 'delivered', status: 'DELIVERED' },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function statusUrl(param, page) {
  const base = `${ORDERS_URL}?completed_status=${encodeURIComponent(param)}`;
  return page > 1 ? `${base}&page=${page}` : base;
}

/**
 * Collect the order numbers on the page.
 *
 * Deliberately not selector-based. The page is already filtered to one status,
 * so there is nothing to interpret — an order number is "#" followed by at
 * least six digits, and the only other numbers on the page (prices, dates,
 * quantities) do not carry that prefix.
 */
function scrapeScript() {
  return `(() => {
    const text = document.body.innerText || '';
    const ids = [];
    const seen = new Set();

    for (const match of text.matchAll(/#(\\d{6,})\\b/g)) {
      const id = match[1];
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }

    return {
      ids,
      // Reported so an empty page can be told apart from a page that did not
      // render: Etsy says so in words when a filter matches nothing.
      looksEmpty: /no orders|nothing to see|0 orders/i.test(text),
      length: text.length,
    };
  })()`;
}

/** Is this page asking us to sign in? */
function signInScript() {
  return `(() => {
    if (/\\/signin/.test(location.href)) return { signedIn: false, reason: 'signin-page' };
    const text = (document.body.innerText || '').slice(0, 400);
    if (/Sign in|Log in to continue/i.test(text)) return { signedIn: false, reason: 'signin-form' };
    return { signedIn: true, sample: text.slice(0, 160) };
  })()`;
}

class EtsyReader {
  /** @param {(message: string) => void} log */
  constructor(log) {
    this.log = log;
    /** One window per shop — each is a separate Etsy login. */
    this.windows = new Map();
    /** Set while the operator has asked to stop; a shop walk can take minutes. */
    this.stopped = false;
  }

  /** Let the control window interrupt a walk between pages. */
  setStopped(stopped) {
    this.stopped = Boolean(stopped);
  }

  /**
   * Open (or reuse) the window for a shop.
   *
   * The partition name is what keeps the logins apart, and `persist:` is what
   * keeps them across restarts, so the operator signs in once per shop.
   */
  async open(shopName, { show = true } = {}) {
    const existing = this.windows.get(shopName);
    if (existing && !existing.isDestroyed()) {
      if (show) existing.show();
      return existing;
    }

    const window = new BrowserWindow({
      width: 1280,
      height: 900,
      show,
      title: `Etsy — ${shopName}`,
      webPreferences: {
        partition: `persist:etsy-${encodeURIComponent(shopName)}`,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    window.on('closed', () => this.windows.delete(shopName));
    this.windows.set(shopName, window);
    await window.loadURL(statusUrl(STATUS_PAGES[0].param, 1));
    return window;
  }

  closeAll() {
    for (const window of this.windows.values()) {
      if (!window.isDestroyed()) window.destroy();
    }
    this.windows.clear();
  }

  setVisible(show) {
    for (const window of this.windows.values()) {
      if (window.isDestroyed()) continue;
      if (show) window.show();
      else window.hide();
    }
  }

  /**
   * Walk a shop's status pages and return one entry per order found.
   *
   * Returns `{ needsLogin }` when the session has lapsed — the window is left
   * open and in front so the operator can sign in, and the shop is picked up on
   * the next round.
   */
  async readShop(shopName, { pages = 5, pageDelayMs = 8000 } = {}) {
    const window = await this.open(shopName, { show: true });
    const webContents = window.webContents;

    // One entry per order. A number can only be in one status list at a time,
    // but the lists are walked newest-first and a parcel can move between two
    // reads, so the later page wins.
    const collected = new Map();

    for (const { param, status } of STATUS_PAGES) {
      if (this.stopped) break;

      for (let page = 1; page <= pages; page += 1) {
        if (this.stopped) break;
        await webContents.loadURL(statusUrl(param, page));
        // Etsy renders the list after load; give it room before reading.
        await sleep(3000);

        const state = await webContents.executeJavaScript(signInScript(), true).catch((error) => ({
          signedIn: false,
          reason: error.message,
        }));

        if (!state.signedIn) {
          window.show();
          this.log(`${shopName}: cần đăng nhập Etsy trong cửa sổ vừa mở (${state.reason}).`);
          return { needsLogin: true, orders: [] };
        }

        const result = await webContents.executeJavaScript(scrapeScript(), true).catch((error) => {
          this.log(`${shopName}/${param}: đọc trang ${page} lỗi — ${error.message}`);
          return { ids: [], looksEmpty: false, length: 0 };
        });

        if (!result.ids.length) {
          // No orders is a normal answer for a filter; a page that never
          // rendered is not. Say which one this was.
          if (page === 1 && !result.looksEmpty) {
            this.log(
              `${shopName}/${param}: không thấy mã đơn nào và trang cũng không báo rỗng` +
                ` (đọc được ${result.length} ký tự) — có thể Etsy đã đổi trang.`,
            );
          }
          break;
        }

        let added = 0;
        for (const orderId of result.ids) {
          if (!collected.has(orderId)) added += 1;
          collected.set(orderId, { orderId, status });
        }

        this.log(`${shopName}/${param}: trang ${page} — ${result.ids.length} đơn (${added} mới).`);

        // Etsy repeats the last page when you ask past the end, so a page that
        // adds nothing new is the end of the list.
        if (!added) break;
        if (page < pages) await sleep(pageDelayMs);
      }
    }

    return { needsLogin: false, orders: [...collected.values()] };
  }
}

module.exports = {
  EtsyReader,
  ORDERS_URL,
  STATUS_PAGES,
  statusUrl,
  scrapeScript,
  signInScript,
};

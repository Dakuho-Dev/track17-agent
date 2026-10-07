'use strict';

const { HidemyaccClient } = require('./hidemyacc');

/**
 * Reads transit status off a seller's own Etsy order list.
 *
 * This is the lane that covers USPS, and in practice everything else too. Every
 * free third-party route for a USPS number is closed (17track's site answers
 * "Access Restricted — USPS policy change", parcelsapp has no data, and
 * tools.usps.com sits behind Akamai Bot Manager, which hands an automated
 * browser a blank page). Etsy, though, has already resolved the carrier.
 *
 * How it reads, measured on a live shop on 2026-10-05:
 *
 * The order list is drawn from one JSON call the page makes for itself,
 *
 *     /api/v3/ajax/bespoke/shop/<shopId>/mission-control/orders/data
 *         ?filters[completed_status]=pre_transit&limit=50&offset=0 …
 *
 * and every order in it carries Etsy's own label at
 * fulfillment.status.physical_status.shipping_status.tracking_status.summary
 * ("Pre-transit", "In transit", "Out for delivery", "Delivered"). The agent
 * makes that same call from inside the shop's page, so it goes out with the
 * profile's own cookies, fingerprint and proxy, exactly like the page's own.
 *
 * Two things that were tried first and do not work:
 *
 *   - Opening /your/orders/sold/all?completed_status=… directly. Etsy sends you
 *     back to whichever tab was last viewed and drops the filter, so all three
 *     "status pages" came back as the same page.
 *   - Reading "#" + digits off the rendered page. Even when the filter holds,
 *     that only sees the 20 rows drawn on screen.
 *
 * Each shop is read inside its own Hidemyacc profile — the clean Chrome profile
 * with the shop's fingerprint, proxy and Etsy login that the team already uses.
 * The agent keeps no Etsy logins of its own: it asks Hidemyacc's local API to
 * start the profile, attaches over DevTools, reads in a tab of its own, closes
 * that tab and lets go. See src/hidemyacc.js for why the profile has to be
 * started through the API rather than by hand.
 */

const ORDERS_URL = 'https://www.etsy.com/your/orders/sold';

/** Etsy quietly falls back to 20 rows when asked for more than 50. */
const PAGE_SIZE = 50;

/**
 * Which status lists to walk.
 *
 * The two moving states are what the team watches, and they are short (tens
 * of orders a shop), so they are read in full. `delivered` is read as well —
 * without it a parcel that arrives would sit at IN_TRANSIT in the CMS for ever,
 * because an order simply drops out of the first two lists when it lands. It
 * is also huge (10,000+ orders on one shop), so it is cut to orders shipped in
 * the last 90 days, newest first.
 */
const STATUS_LISTS = [
  { param: 'pre_transit', status: 'PRE_TRANSIT', completedDate: 'all', sortOrder: 'asc' },
  { param: 'in_transit', status: 'IN_TRANSIT', completedDate: 'all', sortOrder: 'asc' },
  { param: 'delivered', status: 'DELIVERED', completedDate: 'last_90_days', sortOrder: 'desc' },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Is this page asking us to sign in? */
function signInScript() {
  return `(() => {
    if (/\\/signin/.test(location.href)) return { signedIn: false, reason: 'signin-page' };
    const text = (document.body.innerText || '').slice(0, 400);
    if (/Sign in|Log in to continue/i.test(text)) return { signedIn: false, reason: 'signin-form' };
    return { signedIn: true };
  })()`;
}

/**
 * The shop's numeric id, which the orders call is keyed on.
 *
 * The order page embeds it in its own data. Reported as a list so a page that
 * somehow names two shops is caught rather than read from the wrong one.
 */
function shopIdScript() {
  return `(() => {
    const html = document.documentElement.innerHTML;
    return [...new Set([...html.matchAll(/"shop_id"\\s*:\\s*"?(\\d+)/g)].map((m) => m[1]))];
  })()`;
}

/**
 * One page of one status list, read in the shop's own page.
 *
 * Returns only what the agent needs — order number and Etsy's label — so no
 * buyer name or address ever leaves the browser.
 */
async function fetchOrders(page, shopId, list, offset) {
  return page.evaluate(
    async ({ shopId, param, completedDate, sortOrder, offset, limit }) => {
      const query = new URLSearchParams({
        'filters[completed_status]': param,
        'filters[completed_date]': completedDate,
        'filters[order_state_id]': 'all',
        limit: String(limit),
        offset: String(offset),
        sort_by: 'expected_ship_date',
        sort_order: sortOrder,
      });
      const res = await fetch(`/api/v3/ajax/bespoke/shop/${shopId}/mission-control/orders/data?${query}`, {
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
      });
      if (!res.ok) return { error: `HTTP ${res.status}` };

      let body;
      try {
        body = await res.json();
      } catch {
        return { error: 'không phải JSON' };
      }
      const search = body && body.orders_search;
      if (!search || !Array.isArray(search.orders)) return { error: 'thiếu orders_search.orders' };

      return {
        total: Number(search.total_count) || 0,
        orders: search.orders.map((order) => {
          const tracking =
            order.fulfillment &&
            order.fulfillment.status &&
            order.fulfillment.status.physical_status &&
            order.fulfillment.status.physical_status.shipping_status &&
            order.fulfillment.status.physical_status.shipping_status.tracking_status;
          return {
            orderId: String(order.order_id),
            summary: tracking && tracking.summary ? String(tracking.summary) : null,
            canceled: Boolean(order.is_canceled),
          };
        }),
      };
    },
    {
      shopId,
      param: list.param,
      completedDate: list.completedDate,
      sortOrder: list.sortOrder,
      offset,
      limit: PAGE_SIZE,
    },
  );
}

class EtsyReader {
  /**
   * @param {(message: string) => void} log
   * @param {import('./profile-pool').ProfilePool} pool shared with the CSV downloader
   */
  constructor(log, pool) {
    this.log = log;
    this.pool = pool;
    /** Set while the operator has asked to stop; a shop walk can take minutes. */
    this.stopped = false;
  }

  /** Let the control window interrupt a walk between pages. */
  setStopped(stopped) {
    this.stopped = Boolean(stopped);
  }

  /**
   * Start every given profile so each has a DevTools port, ready for a run.
   *
   * This is the "open all my shops" button: the operator keeps the Hidemyacc
   * app open and signed in, the agent opens the profiles through it.
   */
  async openProfiles(settings, entries) {
    const hma = new HidemyaccClient(settings);
    const opened = [];
    const failed = [];
    for (const { shopName, profileId } of entries) {
      try {
        await hma.start(profileId);
        opened.push(shopName);
      } catch (error) {
        failed.push(`${shopName} (${error.message})`);
      }
    }
    return { opened, failed };
  }

  /**
   * Read a shop's status lists inside its Hidemyacc profile and return one
   * entry per order found.
   *
   * `pages` caps the calls per list, 50 orders each. Returns `{ needsLogin }`
   * when the profile is not signed in to Etsy — that is the operator's to fix
   * inside the profile, and the shop comes round again next cycle.
   */
  async readShop(shopName, { settings, profileId, pages = 5, pageDelayMs = 8000 }) {
    return this.pool.use(settings, profileId, async (browser, profile) => {
      this.log(`${shopName}: dùng profile Hidemyacc "${profile.name}"${profile.openedByAgent ? ' (agent vừa mở)' : ''}.`);

      // A tab of the agent's own, so whatever the operator has open in the
      // profile is left exactly where it was.
      const page = await browser.newPage();

      // One entry per order. An order is only in one list at a time, but it can
      // move between two reads, so the later list wins.
      const collected = new Map();

      try {
        await page.goto(ORDERS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(3000);

        const state = await page.evaluate(signInScript()).catch((error) => ({
          signedIn: false,
          reason: error.message,
        }));
        if (!state.signedIn) {
          this.log(`${shopName}: profile "${profile.name}" chưa đăng nhập Etsy (${state.reason}).`);
          return { needsLogin: true, orders: [] };
        }

        const shopIds = await page.evaluate(shopIdScript());
        if (shopIds.length !== 1) {
          throw new Error(`không xác định được mã shop trên trang đơn (thấy ${shopIds.length})`);
        }
        const [shopId] = shopIds;

        for (const list of STATUS_LISTS) {
          let offset = 0;
          let total = 0;
          let read = 0;

          for (let call = 1; call <= pages; call += 1) {
            if (this.stopped) break;
            if (call > 1) await sleep(pageDelayMs);

            const result = await fetchOrders(page, shopId, list, offset);
            if (result.error) {
              this.log(`${shopName}/${list.param}: đọc lỗi ở vị trí ${offset} — ${result.error}`);
              break;
            }

            total = result.total;
            for (const order of result.orders) {
              if (order.canceled) continue;
              collected.set(order.orderId, {
                orderId: order.orderId,
                // Etsy's own wording when it gave one — WrL maps it, and it is
                // finer than the list ("Out for delivery" sits in in_transit).
                // The list's status covers the rare row without a label.
                ...(order.summary ? { statusText: order.summary } : { status: list.status }),
              });
            }
            read += result.orders.length;
            offset += result.orders.length;
            if (!result.orders.length || offset >= total) break;
          }

          this.log(`${shopName}/${list.param}: đọc ${read}/${total} đơn.`);
          // pre_transit and in_transit are the lists that matter; say so when
          // the cap cut one short. delivered is cut on purpose.
          if (list.param !== 'delivered' && read < total && !this.stopped) {
            this.log(`${shopName}/${list.param}: còn ${total - read} đơn chưa đọc — tăng "Số lượt đọc mỗi trạng thái".`);
          }
          if (this.stopped) break;
        }
      } finally {
        await page.close().catch(() => {});
      }

      return { needsLogin: false, orders: [...collected.values()] };
    });
  }
}

module.exports = {
  EtsyReader,
  ORDERS_URL,
  PAGE_SIZE,
  STATUS_LISTS,
  signInScript,
  shopIdScript,
};

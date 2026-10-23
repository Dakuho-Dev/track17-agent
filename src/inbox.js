'use strict';

const { signInScript } = require('./etsy');

/**
 * Etsy messages of every shop, gathered into the CMS ("Tin nhắn") and answered
 * from there.
 *
 * Etsy's Open API has no messages at all, so this reads each shop's inbox
 * inside the shop's Hidemyacc profile, through the same JSON the Etsy inbox
 * page itself calls (measured on TheQuartzStoneShop, 2026-10-19):
 *
 *   list    GET  /api/v3/ajax/bespoke/member/conversations/message-list-data
 *                ?tag=system_tag.inbox&page=N  — 20 conversations a page
 *   thread  GET  /api/v3/ajax/bespoke/member/conversations/detail-view-data
 *                ?conversation_id=…  — the 6 newest messages + who / which order
 *   older   GET  /api/v3/ajax/member/conversations/detail/<id>/message-list
 *                ?offset=<order>&fetch_older=true  — the 6 messages up to and
 *                including message_order <offset>
 *   reply   POST /api/v3/ajax/member/conversations/<id>  (form: message,
 *                attachments, api_context) with the page's csrf_nonce
 *   image   POST /api/v3/ajax/member/conversations/attachment-upload
 *                (multipart, field "attachment") → image_id; the reply then
 *                sends attachments={"0":id,…}, at most 3 (read from Etsy's
 *                composer code 2026-10-19, not yet tried with a real send)
 *
 * None of these marks a conversation read on Etsy: the inbox page does that
 * with a separate tag change when a person opens a thread, and that is never
 * called here. So the reader never navigates to a conversation either — it
 * keeps one tab on the inbox list and calls the JSON from there.
 *
 * Every round, per shop: send the replies waiting in the CMS, then read the
 * first page of the inbox (more pages only while everything on a page is new
 * or changed), then read the messages of the conversations the CMS asks for.
 *
 * A reply cannot be taken back, so a send is never repeated here: if the
 * outcome is unclear (no answer, a network error) it is reported "unknown" and
 * a person checks Etsy before sending again.
 */

/*
 * Four rules this file keeps, each enforced in code rather than left to habit:
 *
 *   1. Only the shop's own inbox, in its own profile and sign-in, slowly.
 *      The signed-in Etsy user must be the one the CMS knows for this shop
 *      (`checkIdentity`), calls are spaced 2–6 s with the odd longer break,
 *      and a shop gets at most ETSY_CALLS_PER_SHOP_ROUND calls a round.
 *   2. Never open a conversation, never change what Etsy shows as read.
 *      The agent works in a tab of its own on the inbox list (`inboxTab`), and
 *      every Etsy call goes through an allow-list (`assertAllowed`): reading the
 *      list and a thread's JSON, uploading an image, posting a reply. Nothing
 *      that tags, marks read/unread, archives or deletes can be called.
 *   3. Each reply is sent exactly once, and only one a person wrote on the CMS.
 *      A claim is recorded on disk before it is posted (`SentLog`), so even a
 *      crash and restart cannot send it twice; a reply with no author is refused.
 *   4. Never a message to someone who has not written to the shop.
 *      Only replies into an existing conversation in which the customer has
 *      written (the CMS says so with each claim); never a new conversation.
 */

const fs = require('fs');
const path = require('path');

const INBOX_URL = 'https://www.etsy.com/messages?ref=seller-platform-mcnav';
/** window.name of the agent's own inbox tab: it never uses or moves a tab a person opened. */
const TAB_MARK = 'dakuho-inbox-agent';
/** The tab is reloaded after this long, for a fresh csrf nonce and session. */
const TAB_MAX_AGE_MS = 30 * 60000;
/** At most this many conversations' messages are read per shop per round. */
const THREADS_PER_ROUND = 12;
/** Older-message calls per conversation per round (6 messages each). */
const OLDER_CALLS_PER_THREAD = 10;
/** Etsy calls (reads) per shop per round; the rest waits for the next round. */
const ETSY_CALLS_PER_SHOP_ROUND = 45;
/** Etsy's composer allows 3 attachments a message. */
const MAX_IMAGES = 3;
/** Pages of "Order help requests" (20 conversations each) read when it is read. */
const HELP_LIST_PAGES = 2;
/** "Order help requests" is read every this many rounds of a shop, not every round. */
const HELP_LIST_EVERY_ROUNDS = 3;
/** The signed-in user is checked again after this long (rule 1). */
const IDENTITY_MAX_AGE_MS = 30 * 60000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * An uneven pause between Etsy calls, like a person clicking through: 2–6 s,
 * and now and then (1 in 10) a longer break of 8–20 s.
 */
const pause = () => sleep(2000 + Math.random() * 4000 + (Math.random() < 0.1 ? 6000 + Math.random() * 12000 : 0));

/**
 * Rule 2: the only Etsy endpoints this agent may call. Reading the inbox list,
 * a thread's messages, uploading an image for a reply and posting a reply to an
 * existing conversation (a number in the path) — nothing else.
 */
const ALLOWED_CALLS = [
  ['GET', /^\/api\/v3\/ajax\/bespoke\/member\/conversations\/message-list-data\?/],
  ['GET', /^\/api\/v3\/ajax\/bespoke\/member\/conversations\/detail-view-data\?conversation_id=\d+&/],
  ['GET', /^\/api\/v3\/ajax\/member\/conversations\/detail\/\d+\/message-list\?offset=\d+&fetch_older=true&/],
  ['POST', /^\/api\/v3\/ajax\/member\/conversations\/attachment-upload$/],
  ['POST', /^\/api\/v3\/ajax\/member\/conversations\/\d+$/],
];
function assertAllowed(method, url) {
  if (!ALLOWED_CALLS.some(([m, re]) => m === method && re.test(url))) {
    throw new Error(`agent chặn lệnh gọi Etsy ngoài danh sách cho phép: ${method} ${url.split('?')[0]}`);
  }
}

/**
 * The inbox list, not a conversation: /messages, /messages/inbox… but never
 * /messages/<number> (rule 2 — opening a conversation can mark it read).
 */
function isInboxList(url) {
  let pathname;
  try {
    ({ pathname } = new URL(url));
  } catch {
    return false;
  }
  if (pathname !== '/messages' && !pathname.startsWith('/messages/')) return false;
  return !pathname.split('/').some((part) => /^\d+$/.test(part));
}

/** Thrown when a shop has used its Etsy calls for this round (rule 1). */
class BudgetSpent extends Error {}

/**
 * Rule 3: every claim the agent has started to send, kept on disk. A claim is
 * written here *before* its POST, so a crash between the two can never lead to
 * a second POST — the CMS turns the reply "unknown" and a person checks Etsy.
 * A key is reply id + claim time: a reply a person sends again after checking
 * is a new claim, with a new time.
 */
class SentLog {
  constructor(dir) {
    this.file = dir ? path.join(dir, 'inbox-sent.json') : null;
    this.keys = new Set();
    try {
      if (this.file) this.keys = new Set(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      // No file yet.
    }
  }

  has(key) {
    return this.keys.has(key);
  }

  add(key) {
    this.keys.add(key);
    if (!this.file) return;
    // The last 5000 are plenty: an old claim is never handed out again.
    fs.writeFileSync(this.file, JSON.stringify([...this.keys].slice(-5000)), 'utf8');
  }
}

/** Etsy sends message text with <br /> for line breaks and the odd entity. */
function plainText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>\n?/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function imageOf(image) {
  if (!image || typeof image !== 'object') return null;
  // Conversation images (seen 2026-10-19): { image_id, image_data: { url, sources: [{ width, url }] } },
  // url being the full size and sources running full → 300 → 150 → 75.
  const data = image.image_data;
  if (data && typeof data === 'object') {
    const sources = Array.isArray(data.sources) ? data.sources : [];
    const small = sources.find((s) => s.width === 300) || sources.find((s) => s.width > 0) || null;
    const full = data.url || sources[0]?.url;
    if (full || small) return { url: small?.url || full, urlLarge: full || small.url };
  }
  const url = image.url_170x135 || image.url_300x300 || image.url_570xN || image.url || image.image_url || image.src || image.url_fullxfull;
  const urlLarge = image.url_fullxfull || image.url_570xN || image.url || url;
  if (url) return { url, urlLarge };
  // Any other shape: take whatever Etsy image links it carries.
  const links = etsyImageLinks(image);
  if (!links.length) return null;
  const pick = (re) => links.find((link) => re.test(link));
  return { url: pick(/_300x300\.|_170x135\.|_150x150\./) || links[0], urlLarge: pick(/_fullxfull\.|_570xN\./) || links[0] };
}

/** Every i.etsystatic.com link anywhere inside `value`. */
function etsyImageLinks(value, out = [], depth = 0) {
  if (depth > 6 || value == null) return out;
  if (typeof value === 'string') {
    if (/^https:\/\/i\.etsystatic\.com\//.test(value) && !out.includes(value)) out.push(value);
  } else if (typeof value === 'object') {
    for (const item of Object.values(value)) etsyImageLinks(item, out, depth + 1);
  }
  return out;
}

/**
 * The order a conversation is about — what Etsy shows on the right of its
 * messages page ("Ordered … / Ship in … / Ship To"). It comes with
 * detail-view-data, at the top level (read from Etsy's own code 2026-10-20):
 *
 *   order_details.order_info            order_id, order_date, order_url, is_shipped,
 *                                       order_transactions[{ title, listing_id, sku, image_url,
 *                                       item_price, quantity, variations[{ variation, value }] }],
 *                                       to_address{ name, city, state, country, … }, …
 *   order_details.order_shipping_status shipping_method_name, estimated_delivery_date,
 *                                       tracking_status, carrier_name, tracking_number, tracking_url, …
 *
 * Returns null when the conversation has no order. Street lines, zip and the
 * buyer's email are left out — the CMS only needs to say which order and where it is.
 */
function orderOf(data) {
  const details = pick(data, 'order_details', 'orderDetails');
  const info = pick(details, 'order_info', 'orderInfo');
  const orderId = Number(pick(info, 'order_id', 'orderId'));
  if (!info || !(orderId > 0)) return null;
  const status = pick(details, 'order_shipping_status', 'orderShippingStatus');
  const address = pick(info, 'to_address', 'toAddress');
  const transactions = pick(info, 'order_transactions', 'orderTransactions');
  return {
    orderId,
    orderDate: pick(info, 'order_date', 'orderDate'),
    orderUrl: pick(info, 'order_url', 'orderUrl'),
    isShipped: Boolean(pick(info, 'is_shipped', 'isShipped')),
    isDigital: Boolean(pick(info, 'is_digital_delivery', 'isDigitalDelivery')),
    isGift: Boolean(pick(info, 'is_gift', 'isGift')),
    shippingPrice: pick(info, 'shipping_price', 'shippingPrice'),
    items: (Array.isArray(transactions) ? transactions : []).map((t) => ({
      title: plainText(pick(t, 'title')),
      listingId: pick(t, 'listing_id', 'listingId'),
      sku: pick(t, 'sku'),
      imageUrl: pick(t, 'image_url', 'imageUrl'),
      price: pick(t, 'item_price', 'itemPrice'),
      quantity: pick(t, 'quantity'),
      variations: (Array.isArray(pick(t, 'variations')) ? pick(t, 'variations') : []).map((v) => ({
        name: plainText(pick(v, 'variation')),
        value: plainText(pick(v, 'value')),
      })),
    })),
    shipping: status
      ? {
          method: pick(status, 'shipping_method_name', 'shippingMethodName'),
          estimatedDelivery: pick(status, 'estimated_delivery_date', 'estimatedDeliveryDate'),
          trackingStatus: pick(status, 'tracking_status', 'trackingStatus'),
          carrier: pick(status, 'carrier_name', 'carrierName'),
          trackingNumber: pick(status, 'tracking_number', 'trackingNumber'),
          trackingUrl: pick(status, 'tracking_url', 'trackingUrl'),
          overdueStatus: pick(status, 'overdue_status', 'overdueStatus'),
        }
      : null,
    shipTo: address
      ? {
          name: pick(address, 'name'),
          city: pick(address, 'city'),
          state: pick(address, 'state'),
          country: pick(address, 'country'),
        }
      : null,
  };
}

/** The first of `keys` present on `obj` (Etsy's JSON is snake_case; camelCase just in case). */
function pick(obj, ...keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const key of keys) if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  return undefined;
}

/** One conversation of an inbox list, as the CMS takes it. */
function cardOf(c) {
  return {
    conversationId: c.conversation_id,
    title: c.title,
    excerpt: plainText(c.excerpt),
    isUnread: c.is_unread,
    hasReplied: c.has_replied,
    messageCount: c.message_count,
    isOrderHelp: c.is_order_help_request,
    // Etsy's "Refunded" label on the list (read from its code 2026-10-23: card.orderHasRefund).
    hasRefund: Boolean(c.order_has_refund ?? c.orderHasRefund),
    isCustomOrder: c.is_custom_order,
    isEtsyNotification: c.is_etsy_notification,
    otherUser: c.other_user && {
      userId: c.other_user.user_id,
      displayName: c.other_user.display_name,
      username: c.other_user.username,
      avatarUrl: c.other_user.avatar_url,
    },
  };
}

function toMessage(m) {
  let images = (Array.isArray(m.images) ? m.images : []).map(imageOf).filter(Boolean);
  // Etsy says there are images but none were in a shape read above: fall back
  // to every image link on the message, so a photo from a customer is never
  // silently dropped (an empty bubble on the CMS).
  if (!images.length && m.has_images) {
    images = etsyImageLinks({ images: m.images, attachments: m.attachments })
      .filter((link) => !/_75x75\.|_150x150\./.test(link))
      .map((link) => ({ url: link, urlLarge: link }));
  }
  return {
    messageId: m.conversation_message_id,
    order: m.message_order,
    senderId: m.sender_id,
    isSystem: Boolean(m.is_system_message) || m.type === 'system',
    // Etsy's own flags: its auto-reply ("outside of my normal hours") comes as 146, a typed message as 128 (2026-10-19).
    // The CMS uses them to tell an auto-reply from a real answer.
    flags: m.message_flags,
    body: plainText(m.message),
    images,
    sentAt: m.create_date,
  };
}

/** The CMS side: the etsy-inbox module of apiserver.dakuho.com. */
class InboxApi {
  constructor(settings) {
    this.base = String(settings.cmsApiUrl || '').replace(/\/$/, '');
    this.token = String(settings.inboxToken || '').trim();
  }

  async post(path, body) {
    let res;
    try {
      res = await fetch(`${this.base}/etsy-inbox/agent/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-agent-token': this.token },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
      });
    } catch (error) {
      throw new Error(`không gọi được CMS (${error.message})`);
    }
    const text = await res.text();
    if (res.status === 401) throw new Error('CMS từ chối token tin nhắn (401) — kiểm tra ô "Token tin nhắn"');
    if (res.status === 503) throw new Error('CMS chưa bật hộp thư (máy chủ chưa đặt ETSY_INBOX_AGENT_TOKEN)');
    if (!res.ok) throw new Error(`CMS trả lỗi ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  }
}

/**
 * Why a claimed reply must not go out (rules 3 and 4), or null when it may.
 * Nothing is posted for a refused reply; the CMS shows it as failed.
 */
function refuseReason(reply) {
  const conversationId = Number(reply.conversationId);
  if (!Number.isSafeInteger(conversationId) || conversationId <= 0) return 'không có hội thoại hợp lệ (agent không mở hội thoại mới)';
  if (!reply.createdBy) return 'câu trả lời không có người viết trên CMS';
  if (reply.customerMessaged !== true) return 'khách chưa từng nhắn trong hội thoại này — agent không gửi tin chủ động';
  if (!String(reply.body || '').trim() && !(reply.images || []).length) return 'câu trả lời trống';
  return null;
}

class InboxReader {
  constructor(log, pool, version, dataDir) {
    this.log = log;
    this.pool = pool;
    this.version = version;
    /** Rule 3: claims already started, kept across restarts. */
    this.sentLog = new SentLog(dataDir);
    /** Rule 1: profileId → { userId, at } of the Etsy user last seen signed in. */
    this.identity = new Map();
    /** Rule 1: Etsy calls made in the current job (a round or a quick send). */
    this.calls = 0;
    this.callLimit = Infinity;
    /** shopName → rounds read, for reading "Order help requests" every few rounds. */
    this.rounds = new Map();
    /** profileId → when its inbox tab was last loaded. */
    this.loadedAt = new Map();
    /** shopName → the job running in its inbox tab (see `exclusive`). */
    this.busy = new Map();
    /** Shops whose replies should go out mid-round, between two conversations. */
    this.urgent = new Set();
  }

  /**
   * One round for one shop. Returns counts for the log; throws only when the
   * shop could not be reached at all (no profile, not signed in, CMS down).
   */
  async syncShop(shopName, { settings, profileId }) {
    const api = new InboxApi(settings);
    if (!api.base || !api.token) throw new Error('chưa điền địa chỉ CMS hoặc token tin nhắn');

    try {
      return await this.exclusive(shopName, () => this.pool.use(settings, profileId, async (browser, profile) => {
        const page = await this.inboxTab(browser, profileId);
        const state = await page.evaluate(signInScript()).catch((error) => ({ signedIn: false, reason: error.message }));
        if (!state.signedIn) throw new Error(`profile "${profile.name}" chưa đăng nhập Etsy (${state.reason})`);

        this.calls = 0;
        this.callLimit = ETSY_CALLS_PER_SHOP_ROUND;
        this.urgent.delete(shopName);
        let sent = await this.sendReplies(api, page, shopName, profileId);
        const { threads, conversations, sentMidway } = await this.readInbox(api, page, shopName, settings, profileId);
        sent += sentMidway;
        return { sent, threads, conversations };
      }));
    } catch (error) {
      await api.post('sync', { shopName, agentVersion: this.version, error: error.message }).catch(() => {});
      throw error;
    }
  }

  /** Which shops have replies waiting on the CMS — one cheap call, asked every few seconds. */
  async pendingShops(settings) {
    const api = new InboxApi(settings);
    if (!api.base || !api.token) return [];
    const { shops = [] } = await api.post('replies/pending', {});
    return shops;
  }

  /**
   * Send one shop's waiting replies now, without waiting for the inbox round.
   *
   * If the round is inside this very shop, it is asked to send between two
   * conversations (`urgent`), so a reply never waits for a whole shop's read.
   */
  async sendNow(shopName, { settings, profileId }) {
    const api = new InboxApi(settings);
    if (!api.base || !api.token) return 0;
    if (this.busy.has(shopName)) {
      this.urgent.add(shopName);
      return 0;
    }
    return this.exclusive(shopName, () =>
      this.pool.use(settings, profileId, async (browser, profile) => {
        const page = await this.inboxTab(browser, profileId);
        const state = await page.evaluate(signInScript()).catch((error) => ({ signedIn: false, reason: error.message }));
        if (!state.signedIn) throw new Error(`profile "${profile.name}" chưa đăng nhập Etsy (${state.reason})`);
        this.calls = 0;
        this.callLimit = Infinity; // a send is a handful of calls, all wanted
        return this.sendReplies(api, page, shopName, profileId);
      }),
    );
  }

  /**
   * Rule 1: the Etsy user signed in to this profile, read from the inbox list
   * (user_data.user_id) at most every IDENTITY_MAX_AGE_MS. The CMS compares it
   * with the user it knows for the shop and refuses replies on a mismatch.
   */
  async signedInUser(page, profileId, fromList) {
    const known = this.identity.get(profileId);
    if (fromList) {
      this.identity.set(profileId, { userId: Number(fromList), at: Date.now() });
      return Number(fromList);
    }
    if (known && Date.now() - known.at < IDENTITY_MAX_AGE_MS) return known.userId;
    const data = await this.get(
      page,
      '/api/v3/ajax/bespoke/member/conversations/message-list-data?tag=system_tag.inbox&page=1&is_search=false&search_query=&load_shop_convos=true',
    );
    const userId = Number(data.user_data?.user_id);
    if (!(userId > 0)) throw new Error('không đọc được tài khoản Etsy đang đăng nhập trong profile');
    this.identity.set(profileId, { userId, at: Date.now() });
    return userId;
  }

  /** One job at a time in a shop's inbox tab (the round and the quick send share it). */
  async exclusive(shopName, work) {
    while (this.busy.has(shopName)) await this.busy.get(shopName).catch(() => {});
    const running = work();
    this.busy.set(shopName, running);
    try {
      return await running;
    } finally {
      if (this.busy.get(shopName) === running) this.busy.delete(shopName);
    }
  }

  /**
   * Rule 2: the agent's own inbox tab — marked with window.name — or a new one.
   * A tab a person opened (a conversation, the inbox, anything) is never used,
   * reloaded or navigated. The agent's tab only ever shows the inbox list, so no
   * conversation is ever opened. Reloaded when old, for a fresh csrf nonce.
   */
  async inboxTab(browser, profileId) {
    let page = null;
    for (const candidate of await browser.pages()) {
      if (!candidate.url().startsWith('https://www.etsy.com/messages')) continue;
      const name = await candidate.evaluate(() => window.name).catch(() => '');
      if (name === TAB_MARK) {
        page = candidate;
        break;
      }
    }
    const fresh = Date.now() - (this.loadedAt.get(profileId) || 0) < TAB_MAX_AGE_MS;
    if (page && fresh && isInboxList(page.url())) return page;
    if (!page) page = await browser.newPage();
    await page.goto(INBOX_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3000);
    if (!isInboxList(page.url())) throw new Error(`tab hộp thư không ở trang danh sách (${page.url().split('?')[0]}) — dừng, không làm gì`);
    await page.evaluate((mark) => {
      window.name = mark;
    }, TAB_MARK);
    this.loadedAt.set(profileId, Date.now());
    return page;
  }

  /** Runs in the page: GET Etsy's JSON with the shop's own session (allow-listed, counted). */
  async get(page, url) {
    assertAllowed('GET', url);
    if (this.calls >= this.callLimit) throw new BudgetSpent(`đã dùng hết ${this.callLimit} lần gọi Etsy của lượt này`);
    this.calls += 1;
    const result = await page.evaluate(async (target) => {
      const res = await fetch(target, { credentials: 'include', headers: { accept: 'application/json' } });
      return { status: res.status, text: await res.text() };
    }, url);
    if (result.status !== 200) throw new Error(`Etsy trả ${result.status} cho ${url.split('?')[0]}: ${result.text.slice(0, 200)}`);
    return JSON.parse(result.text);
  }

  async readInbox(api, page, shopName, settings, profileId) {
    const maxPages = Math.max(1, Number(settings.inboxMaxPages) || 5);
    let need = [];
    let conversations = 0;
    let shopUserId = null;
    for (let n = 1; n <= maxPages; n += 1) {
      const data = await this.get(
        page,
        `/api/v3/ajax/bespoke/member/conversations/message-list-data?tag=system_tag.inbox&page=${n}&is_search=false&search_query=&load_shop_convos=true`,
      );
      shopUserId = data.user_data?.user_id || shopUserId;
      if (n === 1 && shopUserId) await this.signedInUser(page, profileId, shopUserId);
      const rows = (data.conversations || []).map(cardOf);
      conversations += rows.length;
      const answer = await api.post('sync', {
        shopName,
        shopUserId,
        totalCount: data.pagination?.total_count,
        agentVersion: this.version,
        page: n,
        conversations: rows,
      });
      need = need.concat(answer.need || []);
      if (!answer.morePages || n >= (data.pagination?.total_pages || 1)) break;
      await pause();
    }

    // "Order help requests" too, a page or two each round: that is where Etsy keeps the
    // Refunded / Help request conversations, often months old and long off the first
    // inbox page — so their labels stay current on the CMS.
    // Every HELP_LIST_EVERY_ROUNDS rounds of the shop, not every round (rule 1: fewer calls).
    const round = (this.rounds.get(shopName) || 0) + 1;
    this.rounds.set(shopName, round);
    const helpPages = round % HELP_LIST_EVERY_ROUNDS === 1 ? HELP_LIST_PAGES : 0;
    for (let n = 1; n <= helpPages; n += 1) {
      await pause();
      const data = await this.get(
        page,
        `/api/v3/ajax/bespoke/member/conversations/message-list-data?tag=system_tag.order_help_requests&page=${n}&is_search=false&search_query=&load_shop_convos=true`,
      ).catch((error) => {
        this.log(`${shopName}: đọc danh sách Order help requests lỗi — ${error.message}`);
        return null;
      });
      if (!data) break;
      const rows = (data.conversations || []).map(cardOf);
      if (!rows.length) break;
      const answer = await api.post('sync', { shopName, agentVersion: this.version, list: 'order_help', page: n, conversations: rows });
      const known = new Set(need.map((item) => Number(item.conversationId)));
      need = need.concat((answer.need || []).filter((item) => !known.has(Number(item.conversationId))));
      if (n >= (data.pagination?.total_pages || 1)) break;
    }

    let threads = 0;
    let sentMidway = 0;
    // A reply written while this shop is being read goes out between two conversations.
    const sendIfAsked = async () => {
      if (!this.urgent.delete(shopName)) return;
      sentMidway += await this.sendReplies(api, page, shopName).catch((error) => {
        this.log(`${shopName}: gửi câu trả lời giữa lượt lỗi — ${error.message}`);
        return 0;
      });
    };
    await sendIfAsked();
    for (const item of need.slice(0, THREADS_PER_ROUND)) {
      await pause();
      await sendIfAsked();
      try {
        await this.readThread(api, page, shopName, item.conversationId, item.syncedOrder || 0, item.oldestOrder || null);
        threads += 1;
      } catch (error) {
        // Rule 1: the shop's calls for this round are spent; the rest comes next round.
        if (error instanceof BudgetSpent) break;
        this.log(`${shopName}: đọc hội thoại ${item.conversationId} lỗi — ${error.message}`);
      }
    }
    await sendIfAsked();
    return { threads, conversations, sentMidway };
  }

  /**
   * Messages of one conversation the CMS does not have yet: first the new ones,
   * reading back until the ones it already has (syncedOrder), then — for a long
   * thread a past round could not finish — the history below the oldest one it
   * has (oldestOrder). With `newestOnly` just the newest few (right after a send).
   */
  async readThread(api, page, shopName, conversationId, syncedOrder, oldestOrder, { newestOnly = false } = {}) {
    const data = await this.get(
      page,
      `/api/v3/ajax/bespoke/member/conversations/detail-view-data?conversation_id=${conversationId}&load_shop_convos=true`,
    );
    const detail = data.detail || {};
    const byId = new Map();
    for (const m of detail.messages || []) byId.set(m.conversation_message_id, m);
    const lowest = () => Math.min(...[...byId.values()].map((m) => m.message_order));

    if (newestOnly || !byId.size) {
      await api.post('messages', {
        shopName,
        conversationId,
        receiptId: detail.receipt_id || null,
        // The order panel of this conversation (null: none) — every read refreshes it.
        orderChecked: true,
        order: orderOf(data),
        ...(newestOnly ? { caughtUp: false } : { caughtUp: true, complete: true }),
        messages: [...byId.values()].map(toMessage),
      });
      return;
    }

    let calls = 0;
    let reachedStart = false;
    /** One older-messages call ending at `offset`; returns the new lowest order, or null at the start. */
    const readBefore = async (offset) => {
      await pause();
      const older = await this.get(
        page,
        `/api/v3/ajax/member/conversations/detail/${conversationId}/message-list?offset=${offset}&fetch_older=true&load_shop_convos=true`,
      );
      calls += 1;
      const found = (older.messages || []).filter((m) => m.message_order <= offset);
      for (const m of found) byId.set(m.conversation_message_id, m);
      if (!found.length) return null; // nothing older came back
      return Math.min(...found.map((m) => m.message_order));
    };

    // 1) the new messages, down to what the CMS has
    let oldest = lowest();
    const target = syncedOrder > 0 ? syncedOrder + 1 : 1;
    while (oldest > target && oldest > 1 && calls < OLDER_CALLS_PER_THREAD) {
      const next = await readBefore(oldest - 1);
      if (next === null || next >= oldest) {
        reachedStart = true;
        break;
      }
      oldest = next;
    }
    if (oldest <= 1) reachedStart = true;
    const caughtUp = syncedOrder === 0 || reachedStart || oldest <= syncedOrder + 1;

    // 2) the history still missing below the oldest message the CMS has
    let low = caughtUp && syncedOrder > 0 && oldestOrder ? Math.min(oldest, oldestOrder) : oldest;
    if (low <= 1) reachedStart = true;
    while (caughtUp && !reachedStart && calls < OLDER_CALLS_PER_THREAD) {
      const next = await readBefore(low - 1);
      if (next === null || next >= low) reachedStart = true;
      else low = next;
      if (low <= 1) reachedStart = true;
    }

    const answer = await api.post('messages', {
      shopName,
      conversationId,
      receiptId: detail.receipt_id || null,
      // The order panel of this conversation (null: none) — every read refreshes it.
      orderChecked: true,
      order: orderOf(data),
      caughtUp,
      complete: caughtUp && reachedStart,
      messages: [...byId.values()].map(toMessage),
    });
    // The CMS keeps the rest of a thread when one message will not save; say which.
    for (const item of answer.skipped || []) {
      this.log(`${shopName}: hội thoại ${conversationId}, CMS không lưu được tin ${item.messageId} — ${item.error}`);
    }
  }

  /**
   * Send the replies written in the CMS for this shop.
   *
   * Each is posted once. Etsy's answer decides the outcome: 2xx sent, 4xx
   * failed (Etsy refused, nothing went out), anything else unknown. The thread
   * is read again right after, so the CMS sees the message and ties it to the
   * reply.
   *
   * Before anything is posted (rules 1, 3 and 4): the Etsy user signed in here
   * must be the shop's own — the CMS checks it and hands out nothing otherwise;
   * the reply must have been written by a person on the CMS, into a conversation
   * in which the customer has written; and its claim must not have been started
   * before — it is recorded on disk first, so it is never posted twice.
   */
  async sendReplies(api, page, shopName, profileId) {
    const shopUserId = await this.signedInUser(page, profileId);
    const { replies = [] } = await api.post('replies/claim', { shopName, shopUserId });
    let sent = 0;
    for (const reply of replies) {
      let outcome = 'unknown';
      let error = null;
      let imageIds = [];
      const refused = refuseReason(reply);
      const key = `${reply.id}@${reply.claimedAt || ''}`;
      if (refused) {
        await api.post(`replies/${reply.id}/result`, { outcome: 'failed', error: `agent không gửi: ${refused}` }).catch(() => {});
        this.log(`${shopName}: không gửi câu trả lời #${reply.id} — ${refused}`);
        continue;
      }
      if (this.sentLog.has(key)) {
        // Started before (a crash, a restart): never posted a second time.
        await api
          .post(`replies/${reply.id}/result`, { outcome: 'unknown', error: 'agent đã bắt đầu gửi câu này trước đó — không gửi lại; xem trên Etsy đã có tin chưa' })
          .catch(() => {});
        continue;
      }
      this.sentLog.add(key);
      try {
        // Images first: until the message itself is posted nothing has reached
        // the customer, so a failed upload is a plain "failed".
        imageIds = await this.uploadImages(page, reply.images || []);
      } catch (e) {
        outcome = 'failed';
        error = `không đưa được ảnh lên Etsy, tin chưa gửi: ${e.message}`;
      }
      if (outcome !== 'failed') try {
        assertAllowed('POST', `/api/v3/ajax/member/conversations/${reply.conversationId}`);
        const result = await page.evaluate(
          async ({ conversationId, body, attachments }) => {
            const csrf = document.querySelector('meta[name="csrf_nonce"]')?.content;
            if (!csrf) return { status: 0, text: 'không thấy csrf_nonce trên trang' };
            const form = new URLSearchParams();
            form.set('message', body);
            form.set('attachments', attachments);
            form.set('api_context', 'seller_conversations');
            form.set('message_source', '');
            const res = await fetch(`/api/v3/ajax/member/conversations/${conversationId}`, {
              method: 'POST',
              credentials: 'include',
              headers: {
                accept: 'application/json, text/javascript, */*; q=0.01',
                'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'x-csrf-token': csrf,
                'x-etsy-protection': '1',
                'x-requested-with': 'XMLHttpRequest',
              },
              body: form.toString(),
            });
            return { status: res.status, text: await res.text() };
          },
          {
            conversationId: reply.conversationId,
            body: reply.body,
            // Etsy's own composer sends JSON.stringify({...[id, id]}) → {"0":id,"1":id}.
            attachments: JSON.stringify({ ...imageIds }),
          },
        );
        if (result.status === 0) {
          outcome = 'failed';
          error = result.text;
        } else if (result.status >= 200 && result.status < 300) {
          outcome = 'sent';
        } else if (result.status >= 400 && result.status < 500) {
          outcome = 'failed';
          error = `Etsy trả ${result.status}: ${result.text.slice(0, 500)}`;
        } else {
          error = `Etsy trả ${result.status}: ${result.text.slice(0, 500)}`;
        }
      } catch (e) {
        error = `lỗi khi gửi, không chắc Etsy đã nhận: ${e.message}`;
      }
      await api.post(`replies/${reply.id}/result`, { outcome, error }).catch((e) => this.log(`${shopName}: không báo được kết quả câu trả lời #${reply.id} — ${e.message}`));
      if (outcome === 'sent') sent += 1;
      else this.log(`${shopName}: câu trả lời #${reply.id} ${outcome === 'failed' ? 'bị Etsy từ chối' : 'chưa rõ đã gửi chưa'} — ${error}`);
      await pause();
      await this.readThread(api, page, shopName, reply.conversationId, 0, null, { newestOnly: true }).catch(() => {});
    }
    return sent;
  }

  /**
   * Put a reply's images (public URLs from the CMS) on Etsy the way its own
   * composer does: one POST per file to attachment-upload, field "attachment",
   * answered with an image_id that the message then lists. Returns the ids.
   */
  async uploadImages(page, urls) {
    const ids = [];
    for (const [i, url] of urls.slice(0, MAX_IMAGES).entries()) {
      // Fetched here rather than in the page: the image host need not allow etsy.com.
      const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`tải ảnh ${i + 1} về lỗi ${res.status}`);
      const type = (res.headers.get('content-type') || 'image/png').split(';')[0];
      const buffer = Buffer.from(await res.arrayBuffer());
      const ext = (type.split('/')[1] || 'png').replace('jpeg', 'jpg');
      assertAllowed('POST', '/api/v3/ajax/member/conversations/attachment-upload');
      const result = await page.evaluate(
        async ({ base64, type, name }) => {
          const csrf = document.querySelector('meta[name="csrf_nonce"]')?.content;
          if (!csrf) return { status: 0, text: 'không thấy csrf_nonce trên trang' };
          const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
          const form = new FormData();
          form.append('attachment', new File([bytes], name, { type }));
          const r = await fetch('/api/v3/ajax/member/conversations/attachment-upload', {
            method: 'POST',
            credentials: 'include',
            headers: { 'x-csrf-token': csrf, 'x-etsy-protection': '1', 'x-requested-with': 'XMLHttpRequest' },
            body: form,
          });
          return { status: r.status, text: await r.text() };
        },
        { base64: buffer.toString('base64'), type, name: `screenshot-${Date.now()}-${i + 1}.${ext}` },
      );
      if (result.status < 200 || result.status >= 300) throw new Error(`Etsy trả ${result.status} khi tải ảnh ${i + 1}: ${result.text.slice(0, 300)}`);
      let data;
      try {
        data = JSON.parse(result.text);
      } catch {
        throw new Error(`Etsy trả nội dung lạ khi tải ảnh ${i + 1}: ${result.text.slice(0, 300)}`);
      }
      const id = data.image_id ?? data.imageId ?? data.result?.image_id;
      if (!id) throw new Error(`Etsy không trả image_id cho ảnh ${i + 1}: ${result.text.slice(0, 300)}`);
      ids.push(id);
      await pause();
    }
    return ids;
  }
}

module.exports = { InboxReader, plainText };

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

const INBOX_URL = 'https://www.etsy.com/messages?ref=seller-platform-mcnav';
/** The tab is reloaded after this long, for a fresh csrf nonce and session. */
const TAB_MAX_AGE_MS = 30 * 60000;
/** At most this many conversations' messages are read per shop per round. */
const THREADS_PER_ROUND = 15;
/** Older-message calls per conversation per round (6 messages each). */
const OLDER_CALLS_PER_THREAD = 10;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** A short, uneven pause between Etsy calls, like a person clicking through. */
const pause = () => sleep(1200 + Math.random() * 1800);

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
  const url = image.url_170x135 || image.url_300x300 || image.url_570xN || image.url || image.image_url || image.src || image.url_fullxfull;
  const urlLarge = image.url_fullxfull || image.url_570xN || image.url || url;
  return url ? { url, urlLarge } : null;
}

function toMessage(m) {
  return {
    messageId: m.conversation_message_id,
    order: m.message_order,
    senderId: m.sender_id,
    isSystem: Boolean(m.is_system_message) || m.type === 'system',
    body: plainText(m.message),
    images: (Array.isArray(m.images) ? m.images : []).map(imageOf).filter(Boolean),
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

class InboxReader {
  constructor(log, pool, version) {
    this.log = log;
    this.pool = pool;
    this.version = version;
    /** profileId → when its inbox tab was last loaded. */
    this.loadedAt = new Map();
  }

  /**
   * One round for one shop. Returns counts for the log; throws only when the
   * shop could not be reached at all (no profile, not signed in, CMS down).
   */
  async syncShop(shopName, { settings, profileId }) {
    const api = new InboxApi(settings);
    if (!api.base || !api.token) throw new Error('chưa điền địa chỉ CMS hoặc token tin nhắn');

    try {
      return await this.pool.use(settings, profileId, async (browser, profile) => {
        const page = await this.inboxTab(browser, profileId);
        const state = await page.evaluate(signInScript()).catch((error) => ({ signedIn: false, reason: error.message }));
        if (!state.signedIn) throw new Error(`profile "${profile.name}" chưa đăng nhập Etsy (${state.reason})`);

        const sent = await this.sendReplies(api, page, shopName);
        const { threads, conversations } = await this.readInbox(api, page, shopName, settings);
        return { sent, threads, conversations };
      });
    } catch (error) {
      await api.post('sync', { shopName, agentVersion: this.version, error: error.message }).catch(() => {});
      throw error;
    }
  }

  /**
   * The shop's inbox tab: the one left open by the last round, or a new one.
   * Reloaded when old, so the csrf nonce on it stays valid.
   */
  async inboxTab(browser, profileId) {
    const pages = await browser.pages();
    let page = pages.find((p) => p.url().startsWith('https://www.etsy.com/messages'));
    const fresh = Date.now() - (this.loadedAt.get(profileId) || 0) < TAB_MAX_AGE_MS;
    if (page && fresh) return page;
    if (!page) page = await browser.newPage();
    await page.goto(INBOX_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3000);
    this.loadedAt.set(profileId, Date.now());
    return page;
  }

  /** Runs in the page: GET Etsy's JSON with the shop's own session. */
  static async get(page, url) {
    const result = await page.evaluate(async (target) => {
      const res = await fetch(target, { credentials: 'include', headers: { accept: 'application/json' } });
      return { status: res.status, text: await res.text() };
    }, url);
    if (result.status !== 200) throw new Error(`Etsy trả ${result.status} cho ${url.split('?')[0]}: ${result.text.slice(0, 200)}`);
    return JSON.parse(result.text);
  }

  async readInbox(api, page, shopName, settings) {
    const maxPages = Math.max(1, Number(settings.inboxMaxPages) || 5);
    let need = [];
    let conversations = 0;
    let shopUserId = null;
    for (let n = 1; n <= maxPages; n += 1) {
      const data = await InboxReader.get(
        page,
        `/api/v3/ajax/bespoke/member/conversations/message-list-data?tag=system_tag.inbox&page=${n}&is_search=false&search_query=&load_shop_convos=true`,
      );
      shopUserId = data.user_data?.user_id || shopUserId;
      const rows = (data.conversations || []).map((c) => ({
        conversationId: c.conversation_id,
        title: c.title,
        excerpt: plainText(c.excerpt),
        isUnread: c.is_unread,
        hasReplied: c.has_replied,
        messageCount: c.message_count,
        isOrderHelp: c.is_order_help_request,
        isCustomOrder: c.is_custom_order,
        isEtsyNotification: c.is_etsy_notification,
        otherUser: c.other_user && {
          userId: c.other_user.user_id,
          displayName: c.other_user.display_name,
          username: c.other_user.username,
          avatarUrl: c.other_user.avatar_url,
        },
      }));
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

    let threads = 0;
    for (const item of need.slice(0, THREADS_PER_ROUND)) {
      await pause();
      try {
        await this.readThread(api, page, shopName, item.conversationId, item.syncedOrder || 0);
        threads += 1;
      } catch (error) {
        this.log(`${shopName}: đọc hội thoại ${item.conversationId} lỗi — ${error.message}`);
      }
    }
    return { threads, conversations };
  }

  /** New messages of one conversation, reading back until the ones the CMS already has. */
  async readThread(api, page, shopName, conversationId, syncedOrder) {
    const data = await InboxReader.get(
      page,
      `/api/v3/ajax/bespoke/member/conversations/detail-view-data?conversation_id=${conversationId}&load_shop_convos=true`,
    );
    const detail = data.detail || {};
    const byId = new Map();
    for (const m of detail.messages || []) byId.set(m.conversation_message_id, m);

    let oldest = Math.min(...[...byId.values()].map((m) => m.message_order), Infinity);
    let calls = 0;
    while (oldest > syncedOrder + 1 && oldest > 1 && calls < OLDER_CALLS_PER_THREAD) {
      await pause();
      const older = await InboxReader.get(
        page,
        `/api/v3/ajax/member/conversations/detail/${conversationId}/message-list?offset=${oldest - 1}&fetch_older=true&load_shop_convos=true`,
      );
      calls += 1;
      const before = byId.size;
      for (const m of older.messages || []) byId.set(m.conversation_message_id, m);
      const next = Math.min(...[...byId.values()].map((m) => m.message_order));
      if (byId.size === before || next >= oldest) break; // nothing older came back
      oldest = next;
    }

    await api.post('messages', {
      shopName,
      conversationId,
      receiptId: detail.receipt_id || null,
      complete: !(oldest > syncedOrder + 1 && oldest > 1),
      messages: [...byId.values()].map(toMessage),
    });
  }

  /**
   * Send the replies written in the CMS for this shop.
   *
   * Each is posted once. Etsy's answer decides the outcome: 2xx sent, 4xx
   * failed (Etsy refused, nothing went out), anything else unknown. The thread
   * is read again right after, so the CMS sees the message and ties it to the
   * reply.
   */
  async sendReplies(api, page, shopName) {
    const { replies = [] } = await api.post('replies/claim', { shopName });
    let sent = 0;
    for (const reply of replies) {
      let outcome = 'unknown';
      let error = null;
      try {
        const result = await page.evaluate(
          async ({ conversationId, body }) => {
            const csrf = document.querySelector('meta[name="csrf_nonce"]')?.content;
            if (!csrf) return { status: 0, text: 'không thấy csrf_nonce trên trang' };
            const form = new URLSearchParams();
            form.set('message', body);
            form.set('attachments', '{}');
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
          { conversationId: reply.conversationId, body: reply.body },
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
      await this.readThread(api, page, shopName, reply.conversationId, 0).catch(() => {});
    }
    return sent;
  }
}

module.exports = { InboxReader, plainText };

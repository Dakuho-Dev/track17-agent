'use strict';

/**
 * The Hidemyacc app's local API — how the Etsy lane gets into each shop.
 *
 * Every shop already lives in its own clean Hidemyacc profile (own fingerprint,
 * own sticky proxy, own Etsy login), so the agent reads orders inside that
 * profile instead of keeping logins of its own.
 *
 * One thing decides how this has to work, measured on 2026-10-05: a profile
 * opened by hand from the Hidemyacc window starts Chrome with no
 * `--remote-debugging-port`, so nothing outside can drive it. Only a profile
 * started through `POST /profiles/start/:id` comes up with a DevTools port, and
 * the reply carries its `wsUrl`. Asking to start a profile the API already
 * started is harmless — it hands back the same `wsUrl` — so the agent simply
 * asks every time instead of remembering ports across restarts.
 *
 * The API is only served while the Hidemyacc app is open and signed in, and
 * only on a Team plan or above (402 otherwise).
 */

const DEFAULT_URL = 'http://127.0.0.1:2268';

function trimSlash(url) {
  return String(url || DEFAULT_URL).trim().replace(/\/$/, '');
}

/** Lower-case, accents and punctuation stripped — for matching shop names. */
function fold(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

class HidemyaccClient {
  constructor({ hmaUrl } = {}) {
    this.baseUrl = trimSlash(hmaUrl);
  }

  async #request(path, init = {}) {
    let res;
    try {
      res = await fetch(`${this.baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(90000) });
    } catch (error) {
      throw new Error(`Không gọi được Hidemyacc ở ${this.baseUrl} — app Hidemyacc đã mở và đăng nhập chưa? (${error.message})`);
    }
    const text = await res.text();
    if (res.status === 402) throw new Error('Hidemyacc từ chối API (402) — API chỉ có từ gói Team trở lên');
    if (!res.ok) throw new Error(`Hidemyacc trả lỗi ${res.status}: ${text.slice(0, 200)}`);

    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error('Hidemyacc trả về nội dung không phải JSON');
    }
    if (body.code !== 1) throw new Error(`Hidemyacc báo lỗi: ${text.slice(0, 200)}`);
    return body.data;
  }

  /**
   * Every profile on the account, trimmed to what the agent uses.
   *
   * The raw list carries each profile's proxy password; it is dropped here so
   * it never reaches the control window or the log.
   */
  async profiles() {
    const data = await this.#request('/profiles');
    return (data || []).map((profile) => ({
      id: profile.id,
      name: profile.name,
      status: profile.status,
    }));
  }

  /**
   * Start a profile, or get the running one's DevTools endpoint.
   *
   * Returns `{ wsUrl, port }`. A profile opened by hand has no DevTools port,
   * so the endpoint is checked before it is handed out — otherwise the failure
   * would surface later as a puzzling connect timeout.
   */
  async start(profileId) {
    let data;
    try {
      data = await this.#request(`/profiles/start/${encodeURIComponent(profileId)}`, { method: 'POST' });
    } catch (error) {
      // Measured 2026-10-06: a shared profile that is open on someone else's
      // machine answers a bare 400 "Bad Request", nothing more specific.
      if (/lỗi 400/.test(error.message)) {
        throw new Error(
          'Hidemyacc từ chối mở profile (400) — thường do profile đang được người khác mở trên máy khác. ' +
            'Đợi họ đóng, hoặc chọn profile khác của shop này',
        );
      }
      throw error;
    }
    if (!data || !data.wsUrl || !data.port) {
      throw new Error('Hidemyacc mở profile nhưng không trả về cổng điều khiển (wsUrl)');
    }
    try {
      const res = await fetch(`http://127.0.0.1:${data.port}/json/version`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      throw new Error(
        'profile đang mở nhưng không điều khiển được — có lẽ nó được mở tay từ cửa sổ Hidemyacc. ' +
          'Đóng profile đó rồi bấm "Mở profile các shop" trong agent',
      );
    }
    return { wsUrl: data.wsUrl, port: data.port };
  }

  stop(profileId) {
    return this.#request(`/profiles/stop/${encodeURIComponent(profileId)}`, { method: 'POST' });
  }
}

/**
 * Guess which profile belongs to a shop when the operator has not said.
 *
 * Profile names on this account look like "Quỳnh Anh - Macievision - Phương"
 * or "Backup - Macievision": the shop name is in there, but often in several
 * profiles at once. A guess is only made when it is unambiguous — exactly one
 * match, or exactly one match that is already running. Anything else returns
 * null and the operator picks in the window, because reading orders from the
 * wrong shop's login would quietly report nothing.
 */
function guessProfile(shopName, profiles) {
  const key = fold(shopName);
  if (!key) return null;
  const matches = profiles.filter((profile) => fold(profile.name).includes(key));
  if (matches.length === 1) return matches[0];
  const running = matches.filter((profile) => profile.status === 'running');
  if (running.length === 1) return running[0];
  return null;
}

module.exports = { HidemyaccClient, guessProfile, fold, DEFAULT_URL };

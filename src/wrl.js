'use strict';

/**
 * The only server this agent talks to.
 *
 * WrL hands out the queue and takes the answers; it is also the only thing that
 * writes to the CMS. Keeping the agent one hop away from the CMS means a wrong
 * answer typed on someone's laptop still goes through the same validation and
 * the same outbox as everything else.
 */

function trimSlash(url) {
  return String(url || '').trim().replace(/\/$/, '');
}

class WrlClient {
  constructor({ baseUrl, token }) {
    this.baseUrl = trimSlash(baseUrl);
    this.token = String(token || '').trim();
  }

  get isConfigured() {
    return Boolean(this.baseUrl && this.token);
  }

  async #request(path, init = {}) {
    if (!this.isConfigured) throw new Error('Chưa điền địa chỉ WrL hoặc token');

    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        'x-agent-token': this.token,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers || {}),
      },
    });

    const text = await res.text();
    if (!res.ok) {
      // 401 is the one an operator can fix themselves, so name it plainly.
      if (res.status === 401) throw new Error('Token sai — kiểm tra MANUAL_TRACKING_TOKEN trên WrL');
      throw new Error(`WrL trả lỗi ${res.status}: ${text.slice(0, 200)}`);
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new Error('WrL trả về nội dung không phải JSON');
    }
  }

  /** Claim the next batch of non-USPS numbers. */
  pending(limit = 40) {
    return this.#request(`/api/tracking/manual/pending?limit=${encodeURIComponent(limit)}`);
  }

  /** Hand back what 17track said. */
  submit(results) {
    return this.#request('/api/tracking/manual/results', {
      method: 'POST',
      body: JSON.stringify({ results }),
    });
  }

  /** Which Etsy shops to open, and how many parcels in each are waiting. */
  etsyPlan() {
    return this.#request('/api/tracking/etsy/plan');
  }

  /** Hand back what a seller's own Etsy order pages said. */
  submitEtsy(orders) {
    return this.#request('/api/tracking/etsy/results', {
      method: 'POST',
      body: JSON.stringify({ orders }),
    });
  }
}

module.exports = { WrlClient };

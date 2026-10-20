'use strict';

const puppeteer = require('puppeteer-core');
const { HidemyaccClient } = require('./hidemyacc');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits between tries when Hidemyacc answers 400 to a start (see `endpoint`). */
const START_RETRY_MS = [10000, 20000, 30000];

/**
 * Shared access to the shops' Hidemyacc profiles.
 *
 * Several jobs work inside the same profiles, each on its own timer — reading
 * order status (src/etsy.js), downloading the CSV exports (src/csv-download.js)
 * and the inbox (src/inbox.js) — each in a tab of its own. Two things must not
 * happen between them:
 *
 *   One closing a profile under another: with "close after reading" on, the
 *   first job to finish would stop the browser the other is still using. So
 *   the pool counts users per profile and only asks Hidemyacc to stop one when
 *   the last user lets go, and only if the agent opened it — a profile the
 *   operator opened stays open.
 *
 *   Two asking Hidemyacc to start the same profile at once. Measured
 *   2026-10-20: while a start is still under way (the tracking pass opening
 *   the shop), a second start of the same profile (the inbox round) is
 *   answered with a bare 400 — the same answer as "open on another machine".
 *   So there is one start per profile at a time and the others share it, the
 *   DevTools endpoint of a profile the agent started is kept and reused while
 *   it answers, and a 400 is tried again a few times before it is believed.
 */
class ProfilePool {
  constructor(log = () => {}) {
    this.log = log;
    /** profileId → { users, openedByAgent } */
    this.leases = new Map();
    /** profileId → { wsUrl, port } of a profile the agent started. */
    this.endpoints = new Map();
    /** profileId → the start under way. */
    this.starting = new Map();
    /** profileId → the stop under way. */
    this.stopping = new Map();
  }

  /**
   * Run `work(browser, profile)` with the profile started and attached.
   *
   * The browser handle is the caller's own connection; it is disconnected
   * (never closed) when `work` returns or throws.
   */
  async use(settings, profileId, work) {
    const hma = new HidemyaccClient(settings);
    // A profile being closed has to finish closing before it is opened again.
    await this.stopping.get(profileId);

    let lease = this.leases.get(profileId);
    let profile;
    if (lease) {
      profile = { id: profileId, name: lease.name };
    } else {
      profile = (await hma.profiles()).find((candidate) => candidate.id === profileId);
      if (!profile) throw new Error(`không còn profile ${profileId} trên Hidemyacc`);
    }
    lease = this.leases.get(profileId) || { users: 0, name: profile.name, openedByAgent: profile.status !== 'running' };
    lease.users += 1;
    this.leases.set(profileId, lease);

    let browser = null;
    try {
      const { wsUrl } = await this.endpoint(hma, profileId);
      // defaultViewport null: leave the profile's own window size alone — an
      // emulated viewport is one more thing that would differ from a person.
      browser = await puppeteer.connect({ browserWSEndpoint: wsUrl, defaultViewport: null });
      return await work(browser, { ...profile, openedByAgent: lease.openedByAgent });
    } finally {
      if (browser) await browser.disconnect().catch(() => {});
      lease.users -= 1;
      if (lease.users <= 0) {
        this.leases.delete(profileId);
        // Closing is Hidemyacc's job, so it can sync the profile back to the cloud.
        if (lease.openedByAgent && settings.hmaCloseAfterRead) {
          this.endpoints.delete(profileId);
          const stop = hma
            .stop(profileId)
            .catch(() => {})
            .finally(() => this.stopping.delete(profileId));
          this.stopping.set(profileId, stop);
          await stop;
        }
      }
    }
  }

  /** The profile's DevTools endpoint: the one the agent already has, or a start (shared, retried on 400). */
  async endpoint(hma, profileId) {
    const known = this.endpoints.get(profileId);
    if (known && (await alive(known.port))) return known;

    let start = this.starting.get(profileId);
    if (!start) {
      start = this.startWithRetry(hma, profileId).finally(() => this.starting.delete(profileId));
      this.starting.set(profileId, start);
    }
    const found = await start;
    this.endpoints.set(profileId, found);
    return found;
  }

  async startWithRetry(hma, profileId) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await hma.start(profileId);
      } catch (error) {
        if (!/\(400\)/.test(error.message) || attempt >= START_RETRY_MS.length) throw error;
        this.log(`Hidemyacc trả 400 khi mở profile ${profileId} — có thể profile đang khởi động, thử lại sau ${START_RETRY_MS[attempt] / 1000} giây.`);
        await sleep(START_RETRY_MS[attempt]);
        // Something else may have brought it up in the meantime.
        const known = this.endpoints.get(profileId);
        if (known && (await alive(known.port))) return known;
      }
    }
  }
}

/** Whether a DevTools port still answers. */
async function alive(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

module.exports = { ProfilePool };

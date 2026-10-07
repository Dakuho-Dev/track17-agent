'use strict';

const puppeteer = require('puppeteer-core');
const { HidemyaccClient } = require('./hidemyacc');

/**
 * Shared access to the shops' Hidemyacc profiles.
 *
 * Two jobs now work inside the same profiles at the same time — reading order
 * status (src/etsy.js) and downloading the CSV exports (src/csv-download.js) —
 * each in a tab of its own. What they must not do is close a profile under each
 * other: with "close after reading" on, the first job to finish would stop the
 * browser the other is still using.
 *
 * So profiles are borrowed through here. The pool counts users per profile and
 * only asks Hidemyacc to stop one when the last user lets go, and only if it
 * was not already running before the agent first borrowed it — a profile the
 * operator opened stays open.
 */
class ProfilePool {
  constructor() {
    /** profileId → { users, openedByAgent } */
    this.leases = new Map();
  }

  /**
   * Run `work(browser, profile)` with the profile started and attached.
   *
   * The browser handle is the caller's own connection; it is disconnected
   * (never closed) when `work` returns or throws.
   */
  async use(settings, profileId, work) {
    const hma = new HidemyaccClient(settings);
    const profile = (await hma.profiles()).find((candidate) => candidate.id === profileId);
    if (!profile) throw new Error(`không còn profile ${profileId} trên Hidemyacc`);

    const lease = this.leases.get(profileId) || { users: 0, openedByAgent: profile.status !== 'running' };
    lease.users += 1;
    this.leases.set(profileId, lease);

    let browser = null;
    try {
      const { wsUrl } = await hma.start(profileId);
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
          await hma.stop(profileId).catch(() => {});
        }
      }
    }
  }
}

module.exports = { ProfilePool };

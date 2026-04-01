/**
 * @fileoverview Handles auto-save and draft restoration.
 * A single "current draft" is stored in IndexedDB under the key 'current'.
 */

import { get, put, del, STORES } from './db.js';

/** Primary key used for the single draft record. */
const DRAFT_KEY = 'current';

/** Auto-save interval in milliseconds. */
const AUTO_SAVE_INTERVAL_MS = 30_000;

/**
 * @typedef {Object} DraftRecord
 * @property {string} templateFilename  - The template the draft was created from.
 * @property {string} xmlContent        - Serialised XML document string.
 * @property {string} savedAt           - ISO 8601 timestamp of last save.
 */

export class DraftManager {
  /**
   * @param {import('./db.js').IDBDatabase} db  - Kept for API symmetry.
   */
  constructor(db) {
    /** @private */
    this._db = db;

    /**
     * Handle for the setInterval timer.
     * @private
     * @type {number|null}
     */
    this._timer = null;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Immediately save the current editing state as a draft.
   *
   * @param {string} templateFilename  - Filename of the template in use.
   * @param {string} xmlContent        - Full serialised XML string.
   * @returns {Promise<void>}
   */
  async save(templateFilename, xmlContent) {
    if (!templateFilename || xmlContent == null) {
      throw new Error('DraftManager.save: templateFilename 與 xmlContent 為必填');
    }

    const record = {
      id: DRAFT_KEY,
      templateFilename,
      xmlContent,
      savedAt: new Date().toISOString(),
    };

    await put(STORES.DRAFT, record);
  }

  /**
   * Load the saved draft from IndexedDB.
   *
   * @returns {Promise<DraftRecord|null>} The draft record, or null if none exists.
   */
  async load() {
    const record = await get(STORES.DRAFT, DRAFT_KEY);
    if (!record) return null;

    return {
      templateFilename: record.templateFilename,
      xmlContent:       record.xmlContent,
      savedAt:          record.savedAt,
    };
  }

  /**
   * Delete the saved draft.
   *
   * @returns {Promise<void>}
   */
  async clear() {
    await del(STORES.DRAFT, DRAFT_KEY);
  }

  /**
   * Start the auto-save timer.
   * Every 30 seconds, `getStateFn` is called and its result is saved.
   * A previous timer is cleared first (idempotent).
   *
   * @param {() => {templateFilename: string, xmlContent: string}} getStateFn
   *   A function that returns the current editor state.  May return null/undefined
   *   to indicate that there is nothing to save.
   */
  startAutoSave(getStateFn) {
    this.stopAutoSave();

    this._timer = setInterval(async () => {
      let state;
      try {
        state = getStateFn();
      } catch (err) {
        console.warn('[DraftManager] getStateFn 執行失敗：', err);
        return;
      }

      if (!state || !state.templateFilename || state.xmlContent == null) return;

      try {
        await this.save(state.templateFilename, state.xmlContent);
      } catch (err) {
        console.warn('[DraftManager] 自動儲存失敗：', err);
      }
    }, AUTO_SAVE_INTERVAL_MS);
  }

  /**
   * Stop the auto-save timer.
   * Safe to call even when no timer is running.
   */
  stopAutoSave() {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}

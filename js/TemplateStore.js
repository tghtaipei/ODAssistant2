/**
 * @fileoverview Manages DI template files loaded from Google Drive or IndexedDB cache.
 * Templates are stored locally in IndexedDB and identified by filename.
 */

import { getAll, put, get, STORES } from './db.js';

/**
 * @typedef {Object} TemplateRecord
 * @property {string} filename      - The template filename (e.g. "8-1_函復議會協調案件.di")
 * @property {string} content       - Full DI XML file content
 * @property {string} modifiedTime  - ISO 8601 timestamp from Google Drive
 */

/**
 * @typedef {Object} TemplateMeta
 * @property {string} filename
 * @property {string} modifiedTime
 */

export class TemplateStore {
  /**
   * @param {import('./db.js').IDBDatabase} db - Not used directly; kept for API symmetry.
   *   All DB calls go through the db.js helper functions.
   */
  constructor(db) {
    /** @private */
    this._db = db;

    /**
     * In-memory list of loaded template records.
     * @private
     * @type {TemplateRecord[]}
     */
    this._templates = [];
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Load all templates from IndexedDB into memory.
   * Call once at application startup.
   *
   * @returns {Promise<void>}
   */
  async init() {
    try {
      const records = await getAll(STORES.TEMPLATES);
      this._templates = Array.isArray(records) ? records : [];
    } catch (err) {
      console.error('[TemplateStore] init failed:', err);
      this._templates = [];
    }
  }

  /**
   * Return a lightweight list of templates (without the full content).
   *
   * @returns {TemplateMeta[]}
   */
  getList() {
    return this._templates.map(({ filename, modifiedTime }) => ({
      filename,
      modifiedTime,
    }));
  }

  /**
   * Get the full XML content of a template by filename.
   *
   * @param {string} filename
   * @returns {Promise<string>} Resolves with the content string.
   * @throws {Error} If the template is not found.
   */
  async getContent(filename) {
    // Try in-memory cache first for speed.
    const cached = this._templates.find((t) => t.filename === filename);
    if (cached) {
      return cached.content;
    }

    // Fall back to direct DB read in case in-memory state is stale.
    const record = await get(STORES.TEMPLATES, filename);
    if (!record) {
      throw new Error(`範本「${filename}」不存在`);
    }
    return record.content;
  }

  /**
   * Insert or update a template in both IndexedDB and the in-memory cache.
   *
   * @param {TemplateRecord} template
   * @returns {Promise<void>}
   */
  async saveTemplate({ filename, content, modifiedTime }) {
    const record = { filename, content, modifiedTime };

    await put(STORES.TEMPLATES, record);

    // Update in-memory list.
    const idx = this._templates.findIndex((t) => t.filename === filename);
    if (idx >= 0) {
      this._templates[idx] = record;
    } else {
      this._templates.push(record);
    }
  }

  /**
   * Extract the case-type code from a template filename.
   *
   * Supports two separator styles:
   *   "8-1_函復議會協調案件.di"  → "8-1"
   *   "8-1 函復議會協調案件.di"  → "8-1"
   *   "12_某某公文.di"           → "12"
   *
   * Returns an empty string if no case-type prefix can be found.
   *
   * @param {string} filename
   * @returns {string}
   */
  getCaseType(filename) {
    if (!filename) return '';

    // Strip directory component if any.
    const base = filename.split('/').pop() ?? filename;

    // Pattern: one or more digits (and hyphens/dots between digit groups)
    // followed by an underscore or space, before any Chinese character or
    // remaining filename content.
    const match = base.match(/^([\d][\d\-.]*)[ _]/);
    if (match) {
      return match[1];
    }

    return '';
  }

  /**
   * Return a human-readable display name for a template.
   * Removes the case-type prefix and the ".di" extension.
   *
   * Examples:
   *   "8-1_函復議會協調案件.di"  → "函復議會協調案件"
   *   "8-1 函復議會協調案件.di"  → "函復議會協調案件"
   *   "generic_letter.di"        → "letter"
   *
   * @param {string} filename
   * @returns {string}
   */
  getDisplayName(filename) {
    if (!filename) return '';

    const base = filename.split('/').pop() ?? filename;

    // Remove .di extension (case-insensitive).
    let name = base.replace(/\.di$/i, '');

    // Remove leading case-type prefix (digits with hyphens/dots) followed by
    // an underscore or space separator.
    name = name.replace(/^[\d][\d\-.]*[ _]/, '');

    // Remove trailing _匯出 suffix (common in exported template filenames).
    name = name.replace(/_匯出$/, '');

    return name;
  }
}

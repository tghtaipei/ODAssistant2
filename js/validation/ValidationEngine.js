/**
 * @fileoverview Orchestrates all document validators.
 *
 * Validators are registered for a specific case type or for `'*'` (all case
 * types).  When {@link ValidationEngine#validate} is called, it runs every
 * applicable validator concurrently and merges the results.
 *
 * Built-in registrations (performed automatically in the constructor):
 *  - {@link LegislatorValidator} → `'*'`
 *  - {@link GroupValidator}      → `'*'`
 *  - {@link CaseType81Validator} → `'8-1'`
 */

import { LegislatorValidator } from './LegislatorValidator.js';
import { GroupValidator }       from './GroupValidator.js';
import { CaseType81Validator }  from './CaseType81Validator.js';

/**
 * @typedef {import('./ValidatorBase.js').ValidationResult} ValidationResult
 */

/**
 * Wildcard token — validators registered under this key run for every case type.
 * @type {string}
 */
const WILDCARD = '*';

/**
 * Orchestrates validation across all registered validators.
 *
 * Usage:
 * ```js
 * const engine = new ValidationEngine(dataRepo);
 * const findings = await engine.validate(xmlDoc, '8-1');
 * ```
 */
export class ValidationEngine {
  /**
   * @param {import('../DataRepository.js').DataRepository} dataRepo
   *   Application data repository passed through to every validator.
   */
  constructor(dataRepo) {
    /** @private @type {import('../DataRepository.js').DataRepository} */
    this._dataRepo = dataRepo;

    /**
     * Map from case-type string (or `'*'`) to an array of validators.
     * @private
     * @type {Map<string, import('./ValidatorBase.js').ValidatorBase[]>}
     */
    this._registry = new Map();

    // Register built-in validators.
    this.register(WILDCARD, new LegislatorValidator());
    this.register(WILDCARD, new GroupValidator());
    this.register('8-1',    new CaseType81Validator());
  }

  /**
   * Register a validator for a given case type.
   *
   * @param {string} caseType
   *   The case type this validator applies to, or `'*'` for all case types.
   * @param {import('./ValidatorBase.js').ValidatorBase} validator
   *   The validator instance to register.
   * @returns {void}
   */
  register(caseType, validator) {
    if (!this._registry.has(caseType)) {
      this._registry.set(caseType, []);
    }
    this._registry.get(caseType).push(validator);
  }

  /**
   * Run all validators applicable to `caseType` against `xmlDoc`.
   *
   * Validators registered under `'*'` are always included.  Validators
   * registered under the exact `caseType` string are also included.  All
   * validators run concurrently via `Promise.all`; results are merged into a
   * single flat array preserving registration order.
   *
   * @param {Document} xmlDoc    - The parsed DI document DOM.
   * @param {string}   caseType  - The case type identifier (e.g. `'8-1'`).
   * @returns {Promise<ValidationResult[]>} All findings from every applicable validator.
   */
  async validate(xmlDoc, caseType) {
    /** @type {import('./ValidatorBase.js').ValidatorBase[]} */
    const validators = [
      ...(this._registry.get(WILDCARD) ?? []),
      // Only add type-specific validators when caseType is not itself the wildcard.
      ...(caseType !== WILDCARD ? (this._registry.get(caseType) ?? []) : []),
    ];

    const resultArrays = await Promise.all(
      validators.map((v) => {
        try {
          return v.validate(xmlDoc, this._dataRepo);
        } catch (err) {
          console.error(`[ValidationEngine] 驗證器「${v.name}」執行失敗：`, err);
          return Promise.resolve([
            {
              field: v.name,
              message: `驗證器執行時發生錯誤：${err instanceof Error ? err.message : String(err)}`,
            },
          ]);
        }
      })
    );

    return resultArrays.flat();
  }
}

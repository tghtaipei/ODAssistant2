/**
 * @fileoverview Abstract base class for all document validators.
 *
 * Concrete validators should extend {@link ValidatorBase} and override
 * {@link ValidatorBase#validate}.
 */

/**
 * @typedef {Object} ValidationResult
 * @property {string} field   - Human-readable field name (e.g. `'主旨'`, `'議員名稱'`).
 * @property {string} message - Localised warning or error message to display to the user.
 */

/**
 * Abstract base class for validators.
 *
 * Each validator encapsulates a single concern (e.g. checking legislator names,
 * verifying group assignments, enforcing case-type-specific template rules).
 * Validators are registered with and executed by {@link ValidationEngine}.
 */
export class ValidatorBase {
  /**
   * @param {string} name - A short identifier for this validator, used in logs.
   */
  constructor(name) {
    /** @type {string} */
    this.name = name;
  }

  /**
   * Run the validation logic against the given XML document.
   *
   * Subclasses must override this method.  The base implementation returns an
   * empty array (no findings), making it safe to call on a base instance.
   *
   * @param {Document}         xmlDoc    - The parsed DI document DOM.
   * @param {import('../DataRepository.js').DataRepository} dataRepo - Application data repository.
   * @returns {Promise<ValidationResult[]>} Zero or more validation findings.
   */
  // eslint-disable-next-line no-unused-vars
  async validate(xmlDoc, dataRepo) {
    return [];
  }
}

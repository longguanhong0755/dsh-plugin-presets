/** Typed, user-safe failures for preset operations. */

export class PresetError extends Error {
  /**
   * @param {string} code stable machine code
   * @param {string} message user-facing summary
   * @param {{nextStep?: string, details?: Record<string, unknown>, cause?: unknown}} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'PresetError'
    this.code = code
    this.nextStep = options.nextStep
    this.details = options.details
  }
}

export function presetError(code, message, nextStep, details) {
  return new PresetError(code, message, { nextStep, details })
}

export function isPresetError(error) {
  return error instanceof PresetError
}

/** Describe an unknown thrown value without leaking a stack or file contents. */
export function describeError(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

export function errorPayload(error) {
  if (error instanceof PresetError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.nextStep === undefined ? {} : { nextStep: error.nextStep }),
      ...(error.details === undefined ? {} : { details: error.details }),
    }
  }
  return {
    code: 'operation-error',
    message: describeError(error),
    nextStep: 'Run /plugin-presets doctor and retry after resolving the reported problem.',
  }
}

export function asPresetError(error, fallbackCode = 'operation-error', nextStep) {
  if (error instanceof PresetError) return error
  return new PresetError(fallbackCode, describeError(error), {
    nextStep,
    cause: error,
  })
}

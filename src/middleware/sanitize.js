import { body, param, query, validationResult } from 'express-validator'

// ─── Validation error handler ────────────────────────────────────────────────
export function handleValidation(req, res, next) {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Ugyldig input', details: errors.array().map(e => e.msg) })
  }
  next()
}

// ─── Auth route validators ───────────────────────────────────────────────────
export const validateRegister = [
  body('name').trim().notEmpty().withMessage('Navn er påkrevd').escape(),
  body('email').isEmail().normalizeEmail().withMessage('Ugyldig e-postadresse'),
  body('password').isLength({ min: 8 }).withMessage('Passord må være minst 8 tegn'),
  handleValidation
]

export const validateLogin = [
  body('email').isEmail().normalizeEmail().withMessage('Ugyldig e-postadresse'),
  body('password').notEmpty().withMessage('Passord er påkrevd'),
  handleValidation
]

// ─── Content generation validator ────────────────────────────────────────────
export const validateGenerate = [
  body('platforms').isArray({ min: 1 }).withMessage('Velg minst én plattform'),
  body('platforms.*').isString().trim().escape(),
  body('customPrompt').optional().isString().trim(),
  body('templateId').optional().isString().trim().escape(),
  body('projectId').optional().isString().trim().escape(),
  body('extraContext').optional().isString().trim(),
  handleValidation
]

// ─── Generic ID param validator ──────────────────────────────────────────────
export const validateIdParam = [
  param('id').isUUID().withMessage('Ugyldig ID-format'),
  handleValidation
]

// ─── Query sanitizer for pagination / filters ────────────────────────────────
export const sanitizeQuery = [
  query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  query('offset').optional().isInt({ min: 0 }).toInt(),
  query('page').optional().isInt({ min: 1 }).toInt(),
  handleValidation
]

// ─── Recursive string trimmer (applies to all string fields in req.body) ────
export function trimStrings(req, res, next) {
  if (req.body && typeof req.body === 'object') {
    trimObject(req.body)
  }
  next()
}

function trimObject(obj) {
  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === 'string') {
      obj[key] = obj[key].trim()
    } else if (obj[key] && typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
      trimObject(obj[key])
    }
  }
}

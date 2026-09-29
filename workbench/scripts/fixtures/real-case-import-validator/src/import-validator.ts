export type ImportFile = {
  name: string
  sizeBytes: number
}

export type ImportValidationResult = {
  valid: boolean
  errors: string[]
}

export function validateImportFile(file: ImportFile): ImportValidationResult {
  const errors: string[] = []
  if (!file.name.trim()) errors.push('file_name_required')
  return { valid: errors.length === 0, errors }
}

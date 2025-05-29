/**
 * Utility to extract all possible extension variations from a file path
 * For example, "file.scss.d.ts" would return ["ts", "d.ts", "scss.d.ts"]
 */
export function extract_extension_variations(file_path: string): string[] {
  const filename = file_path.split(/[\\/]/).pop() || ''
  const parts = filename.split('.')

  // If there's only one part or none, there's no extension
  if (parts.length <= 1) {
    return []
  }

  // Remove the base name
  parts.shift()

  // Generate all possible extensions from right to left
  const extensions: string[] = []
  let current_ext = ''

  for (let i = parts.length - 1; i >= 0; i--) {
    current_ext = parts[i] + (current_ext ? '.' + current_ext : '')
    extensions.push(current_ext)
  }

  return extensions
}

/**
 * Checks if a file should be ignored based on its extensions
 */
export function should_ignore_file(
  file_path: string,
  ignored_extensions: Set<string>
): boolean {
  const extensions = extract_extension_variations(file_path)

  // Check if any of the extension variations should be ignored
  return extensions.some((ext) => ignored_extensions.has(ext))
}


export function format_token_count(count: number | 'loading' | undefined): string {
  if (count === 'loading') return '…';
  if (count === undefined || count === 0) return ''; // Don't display 0
  return count >= 1000 ? `${Math.floor(count / 1000)}k` : `${count}`;
}
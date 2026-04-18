/**
 * Minimal glob matcher supporting double-star and single-star wildcards.
 * Good enough for patterns like "dir/file.prompt", "**\/prompts/**",
 * "src/prompts/**", and "prompts/expensive/**".
 */

export function matchesPattern(filePath: string, pattern: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const normalizedPattern = pattern.replace(/\\/g, "/");

  const regexStr = normalizedPattern
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "<<GLOBSTAR>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<GLOBSTAR>>/g, ".*");

  const regex = new RegExp(`^${regexStr}$`);
  return regex.test(normalized);
}

export function matchesAnyPattern(filePath: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesPattern(filePath, p));
}

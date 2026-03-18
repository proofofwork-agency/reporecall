/**
 * Checks if a file path is a test/spec/fixture/benchmark/example file.
 */
export function isTestFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return /(?:^|\/)(test|spec|__tests__|__fixtures__|fixtures|benchmark|examples)\//.test(lower)
    || /\.(test|spec)\.[^.]+$/.test(lower);
}

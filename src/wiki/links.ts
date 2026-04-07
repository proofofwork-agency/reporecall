/**
 * Wiki link extraction and management.
 *
 * Extracts [[slug]] style interlinks from wiki page markdown content
 * and manages the wiki_links table in MemoryStore.
 */

/**
 * Extract all [[slug]] references from markdown content.
 * Returns deduplicated list of slugs.
 */
export function extractWikiLinks(content: string): string[] {
  const re = /\[\[([a-zA-Z0-9_-]+)\]\]/g;
  const links = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    if (match[1]) links.add(match[1]);
  }
  return Array.from(links);
}

/**
 * Merge explicit links array from frontmatter with [[slug]] links
 * found in the body content. Returns deduplicated list.
 */
export function resolveAllLinks(
  frontmatterLinks: string[] | undefined,
  bodyContent: string
): string[] {
  const all = new Set<string>(frontmatterLinks ?? []);
  for (const link of extractWikiLinks(bodyContent)) {
    all.add(link);
  }
  return Array.from(all);
}

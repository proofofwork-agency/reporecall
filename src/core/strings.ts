export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function humanizeSlug(name: string): string {
  return name
    .replace(/^business-/, "")
    .split("-")
    .filter(Boolean)
    .map((part) => part[0] ? `${part[0].toUpperCase()}${part.slice(1)}` : part)
    .join(" ");
}

export function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function extractSectionText(content: string, heading: string): string {
  const match = content.match(new RegExp(`## ${escapeRegExp(heading)}\\n([\\s\\S]*?)(?=\\n## |$)`));
  if (!match?.[1]) return "";
  return match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("- "))
    .join(" ")
    .trim();
}

export function extractBulletSection(content: string, heading: string): string[] {
  const match = content.match(new RegExp(`## ${escapeRegExp(heading)}\\n([\\s\\S]*?)(?=\\n## |$)`));
  if (!match?.[1]) return [];
  return match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter((line) => line.length > 0);
}

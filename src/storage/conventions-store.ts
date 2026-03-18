import { z } from "zod";
import type { ConventionsReport } from "../analysis/conventions.js";
import type { StatsStore } from "./stats-store.js";

const ConventionsSchema = z.object({
  namingStyle: z.object({
    functions: z.enum(["camelCase", "snake_case", "PascalCase", "mixed"]),
    classes: z.enum(["camelCase", "snake_case", "PascalCase", "mixed"]),
  }),
  docstringCoverage: z.number().min(0).max(1),
  averageFunctionLength: z.number().min(0),
  medianFunctionLength: z.number().min(0),
  topCallTargets: z.array(z.string()),
  languageDistribution: z.record(z.string(), z.number().min(0)),
  totalFunctions: z.number().min(0).int(),
  totalClasses: z.number().min(0).int(),
});

export class ConventionsStore {
  constructor(private readonly stats: StatsStore) {}

  setConventions(report: ConventionsReport): void {
    this.stats.setStat("conventions", JSON.stringify(report));
  }

  getConventions(): ConventionsReport | undefined {
    const raw = this.stats.getStat("conventions");
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw);
      const validated = ConventionsSchema.parse(parsed);
      return validated;
    } catch {
      return undefined;
    }
  }
}

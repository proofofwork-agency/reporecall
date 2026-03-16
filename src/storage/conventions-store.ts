import type { ConventionsReport } from "../analysis/conventions.js";
import type { StatsStore } from "./stats-store.js";

export class ConventionsStore {
  constructor(private readonly stats: StatsStore) {}

  setConventions(report: ConventionsReport): void {
    this.stats.setStat("conventions", JSON.stringify(report));
  }

  getConventions(): ConventionsReport | undefined {
    const raw = this.stats.getStat("conventions");
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as ConventionsReport;
    } catch {
      return undefined;
    }
  }
}

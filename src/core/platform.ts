/**
 * Platform-aware process checking utility.
 *
 * On Windows, process.kill(pid, 0) behaves differently — EPERM means the
 * process is alive but we lack permission, not that it's dead.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    // EPERM = process exists but we don't have permission to signal it
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

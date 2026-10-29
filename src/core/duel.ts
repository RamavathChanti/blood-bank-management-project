export type DuelMode = "NAIVE" | "ATOMIC";
export type DuelResult = { mode: DuelMode; owners: readonly string[]; doubleAllocations: number; steps: readonly string[] };

/** Deliberately scheduled interleaving on an isolated fixture. No registry imports or network. */
export function runDuel(mode: DuelMode): DuelResult {
  if (mode === "NAIVE") {
    const shelf = { available: true };
    const aRead = shelf.available, bRead = shelf.available;
    const owners: string[] = [];
    if (aRead) { shelf.available = false; owners.push("Hospital A"); }
    if (bRead) { shelf.available = false; owners.push("Hospital B"); }
    return { mode, owners, doubleAllocations: Math.max(0, owners.length - 1), steps: ["A reads AVAILABLE", "B reads AVAILABLE before A writes", "A writes its claim", "B writes using its stale read: two claims"] };
  }
  let owner: string | null = null;
  const owners: string[] = [];
  for (const hospital of ["Hospital A", "Hospital B"]) {
    if (owner === null) { owner = hospital; owners.push(hospital); }
  }
  return { mode, owners, doubleAllocations: Math.max(0, owners.length - 1), steps: ["A conditionally claims only if AVAILABLE", "A changes the fixture to RESERVED", "B rechecks AVAILABLE: condition fails", "One owner; the loser must search another candidate"] };
}

import { GROUPS, parseComponent, parseGroup, type Component, type Group } from "./domain";

const antigens = { O: 0, A: 1, B: 2, AB: 3 } as const;
export function abo(group: Group): keyof typeof antigens { return group.slice(0, -1) as keyof typeof antigens; }
/** Production algorithm uses antigen sets; tests use separately authored literal truth tables. */
export function isCompatible(donor: Group, recipient: Group, component: Component): boolean {
  parseGroup(donor); parseGroup(recipient); parseComponent(component);
  if (component === "PLATELETS") return donor === recipient;
  const d = antigens[abo(donor)], r = antigens[abo(recipient)];
  if (component === "FFP") return (r & d) === r; // Reverse ABO, RhD ignored.
  return (d & r) === d && (recipient.endsWith("+") || donor.endsWith("-"));
}
/** Each alternative is a separate preference tier. Project policy, not clinical ranking. */
export function compatibilityPreference(recipient: Group, component: Component): readonly Group[] {
  parseGroup(recipient); parseComponent(component);
  const allowed = GROUPS.filter(group => isCompatible(group, recipient, component));
  if (component === "FFP") {
    return allowed.sort((a, b) => Number(abo(b) === abo(recipient)) - Number(abo(a) === abo(recipient)) || GROUPS.indexOf(a) - GROUPS.indexOf(b));
  }
  return allowed.sort((a, b) => Number(b === recipient) - Number(a === recipient) || Number(a === "O-") - Number(b === "O-") || GROUPS.indexOf(a) - GROUPS.indexOf(b));
}
export function preferenceTier(donor: Group, recipient: Group, component: Component): number {
  const order = compatibilityPreference(recipient, component);
  // Plasma Rh variants are equal preference, so FEFO applies across both.
  return component === "FFP" ? order.filter((g, i) => order.findIndex(x => abo(x) === abo(g)) === i).findIndex(g => abo(g) === abo(donor)) : order.indexOf(donor);
}
export function explainCompatibility(donor: Group, recipient: Group, component: Component): string {
  const compatible = isCompatible(donor, recipient, component);
  if (component === "PLATELETS") return `${compatible ? "Allowed" : "Rejected"}: teaching policy requires identical ABO and RhD platelets; specialist exceptions are excluded.`;
  if (component === "FFP") return `${compatible ? "Allowed" : "Rejected"}: plasma uses reverse ABO compatibility; RhD is ignored. ABO-identical stock is preferred.`;
  return `${compatible ? "Allowed" : "Rejected"}: red-cell donor antigens must fit the recipient's ABO/RhD rules. Exact group first; O-negative last for other recipients.`;
}

/**
 * Ground-target archetypes, shared by the server that sites them and the HUD
 * that has to name them.
 *
 * This exists because the two halves used to disagree about what a
 * 'GroundUnit' entity's 'typeId' meant. The server wrote a 'GroundType' out of
 * its own enum; the HUD ran every contact's typeId through the *aircraft*
 * table, so a 20 mm flak pit at 2 km came up on the marker layer reading
 * "Bf 109 G-6" and the emplacement next to it read "Spitfire Mk IX" — in the
 * team colour of whoever owned the field, which for a pilot flying over his
 * own airfield is cyan. That is a single shared numbering away from being
 * impossible, so here it is.
 *
 * The numbering is on the wire (4 bits, see 'writeEntity'), so it is
 * append-only: never renumber, never insert.
 */
export enum GroundType {
  AaLight = 0,
  AaMedium = 1,
  AaHeavy = 2,
  Truck = 3,
  Armour = 4,
  Wagon = 5,
  Factory = 6,
  Railyard = 7,
  Bridge = 8,
}

/** Marker/killfeed name for each archetype. Indexed by 'GroundType'. */
const GROUND_LABEL: readonly string[] = [
  '20 mm flak',
  '40 mm flak',
  '88 mm flak',
  'Lorry',
  'Armour',
  'Goods wagon',
  'Factory',
  'Rail yard',
  'Bridge',
];

/** Never throws and never returns an aircraft name. */
export function groundLabel(typeId: number): string {
  return GROUND_LABEL[typeId] ?? 'Ground target';
}

/** True for the three AA classes, which are the ones that shoot back. */
export const isAaType = (typeId: number): boolean =>
  typeId >= GroundType.AaLight && typeId <= GroundType.AaHeavy;

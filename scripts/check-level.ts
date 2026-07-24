// Quick offline sanity check of the procedural generator: npm run check:level
import { ARCHETYPES, FINALE_THEMES, THEMES, ZONES_PER_RUN, generateLevelDebug, validateLevel } from 'shared';

let failed = false;
for (const seed of ['alpha', 'bravo', 'charlie', 'delta', 'echo7', 'kitchen-sink']) {
  const { level, steps } = generateLevelDebug(seed);
  const issues = validateLevel(steps);
  const gadgetCounts: Record<string, number> = {};
  for (const g of level.gadgets) gadgetCounts[g.kind] = (gadgetCounts[g.kind] ?? 0) + 1;
  const itemCounts: Record<string, number> = {};
  for (const it of level.items) itemCounts[it.type] = (itemCounts[it.type] ?? 0) + 1;
  console.log(
    `seed=${seed.padEnd(13)} height=${level.totalHeight.toFixed(0).padStart(4)}m nodes=${level.nodes.length} ` +
      `props=${level.props.length} checkpoints=${level.checkpoints.length} ` +
      `gadgets=${JSON.stringify(gadgetCounts)} items=${JSON.stringify(itemCounts)} issues=${issues.length}`,
  );
  console.log(`  zones: ${level.zones.map((z) => z.label).join(' → ')}`);
  for (const iss of issues) {
    console.log(`  ! step ${iss.step}: ${iss.msg}`);
    failed = true;
  }
  // Structural invariants
  if (level.checkpoints.length !== ZONES_PER_RUN) { console.log(`  ! expected ${ZONES_PER_RUN} checkpoints`); failed = true; }
  if (level.zones.length !== ZONES_PER_RUN) { console.log(`  ! expected ${ZONES_PER_RUN} zones`); failed = true; }
  if (new Set(level.zones.map((z) => z.theme)).size !== level.zones.length) { console.log('  ! duplicate zone theme'); failed = true; }
  // rooms are always entered bottom-up, and every run ends with the same sky zones
  const floors = level.zones.map((z) => THEMES.find((t) => t.id === z.theme)!.floor);
  for (let i = 1; i < floors.length; i++) {
    if (floors[i] <= floors[i - 1]) { console.log('  ! zones out of narrative order'); failed = true; }
  }
  const tail = level.zones.slice(-FINALE_THEMES.length).map((z) => z.theme).join(',');
  if (tail !== FINALE_THEMES.map((t) => t.id).join(',')) { console.log(`  ! run does not end with the finale zones (got ${tail})`); failed = true; }
  // every prop the generator emitted must exist in the catalog with a sane top surface
  for (const p of level.props) {
    const arch = ARCHETYPES[p.archetype];
    if (!arch) { console.log(`  ! unknown archetype ${p.archetype}`); failed = true; continue; }
    if (arch.colliders.length === 0 && p.solid) { console.log(`  ! solid prop ${p.archetype} has no colliders`); failed = true; }
  }
  for (let i = 1; i < level.checkpoints.length; i++) {
    if (level.checkpoints[i].pos.y <= level.checkpoints[i - 1].pos.y) { console.log('  ! checkpoints not ascending'); failed = true; }
  }
  if (level.flagPos.y < level.totalHeight - 0.01) { console.log('  ! flag below total height'); failed = true; }
}
if (failed) { console.error('LEVEL CHECK FAILED'); process.exit(1); }
console.log('All seeds OK');

// Quick offline sanity check of the procedural generator: npm run check:level
import { generateLevelDebug, validateLevel } from 'shared';

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
  for (const iss of issues) {
    console.log(`  ! step ${iss.step}: ${iss.msg}`);
    failed = true;
  }
  // Structural invariants
  if (level.checkpoints.length !== 10) { console.log('  ! expected 10 checkpoints'); failed = true; }
  for (let i = 1; i < level.checkpoints.length; i++) {
    if (level.checkpoints[i].pos.y <= level.checkpoints[i - 1].pos.y) { console.log('  ! checkpoints not ascending'); failed = true; }
  }
  if (level.flagPos.y < level.totalHeight - 0.01) { console.log('  ! flag below total height'); failed = true; }
}
if (failed) { console.error('LEVEL CHECK FAILED'); process.exit(1); }
console.log('All seeds OK');

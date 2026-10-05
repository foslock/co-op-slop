// Offline sanity check of the procedural generator: npm run check:level [-- --sweep N]
//
// For a set of seeds, in both solo and team runs, verifies jump reachability,
// zone/checkpoint structure, that co-op contraptions never appear solo, and —
// rebuilt independently from the final level data — that no two props
// intersect and nothing hangs into the headroom above a platform.
import {
  ARCHETYPES, FINALE_THEMES, THEMES, ZONES_PER_RUN, generateLevelDebug, headroomAtZone, propVols,
  validateLevel, volsOverlap, circle, type LevelData, type Vol,
} from 'shared';

const COOP_KINDS = new Set(['seesaw', 'cranklift']);

function geometryIssues(level: LevelData): string[] {
  const out: string[] = [];
  const solids: Vol[][] = [];
  const heads: Vol[] = [];
  level.props.forEach((p, i) => {
    if (!p.solid) return;
    solids[i] = propVols(p, i).filter((v) => v.kind === 'solid');
    const arch = ARCHETYPES[p.archetype];
    const top = p.pos.y + arch.topY;
    // platforms near a zone boundary may belong to either side: use the smaller headroom
    const zone = Math.max(0, level.zones.findIndex((z) => top <= z.yEnd + 3));
    heads[i] = circle('clear', p.pos.x, p.pos.z, arch.topRadius, top + 0.05, top + headroomAtZone(zone) - 0.05, [i]);
  });
  for (let i = 0; i < level.props.length; i++) {
    if (!solids[i]) continue;
    for (let j = i + 1; j < level.props.length; j++) {
      if (!solids[j]) continue;
      if (solids[i].some((a) => solids[j].some((b) => volsOverlap(a, b, -0.02)))) {
        out.push(`props intersect: ${level.props[i].archetype} #${i} / ${level.props[j].archetype} #${j}`);
      }
    }
  }
  for (let i = 0; i < level.props.length; i++) {
    if (!heads[i]) continue;
    for (let j = 0; j < level.props.length; j++) {
      if (i === j || !solids[j]) continue;
      if (solids[j].some((b) => volsOverlap(heads[i], b))) {
        out.push(`low ceiling over ${level.props[i].archetype} #${i}: ${level.props[j].archetype} #${j}`);
      }
    }
  }
  return out;
}

function checkSeed(seed: string, team: number, verbose: boolean): number {
  const { level, steps, issues: genIssues } = generateLevelDebug(seed, team);
  const problems: string[] = [];
  for (const iss of validateLevel(steps)) problems.push(`step ${iss.step}: ${iss.msg}`);
  for (const g of genIssues) problems.push(`generator: ${g}`);
  for (const g of geometryIssues(level)) problems.push(g);

  // structural invariants
  if (level.checkpoints.length !== ZONES_PER_RUN) problems.push(`expected ${ZONES_PER_RUN} checkpoints`);
  if (level.zones.length !== ZONES_PER_RUN) problems.push(`expected ${ZONES_PER_RUN} zones`);
  if (new Set(level.zones.map((z) => z.theme)).size !== level.zones.length) problems.push('duplicate zone theme');
  const floors = level.zones.map((z) => THEMES.find((t) => t.id === z.theme)!.floor);
  for (let i = 1; i < floors.length; i++) if (floors[i] <= floors[i - 1]) problems.push('zones out of narrative order');
  const tail = level.zones.slice(-FINALE_THEMES.length).map((z) => z.theme).join(',');
  if (tail !== FINALE_THEMES.map((t) => t.id).join(',')) problems.push(`run does not end with the finale zones (got ${tail})`);
  for (const p of level.props) {
    const arch = ARCHETYPES[p.archetype];
    if (!arch) { problems.push(`unknown archetype ${p.archetype}`); continue; }
    if (arch.colliders.length === 0 && p.solid) problems.push(`solid prop ${p.archetype} has no colliders`);
  }
  for (let i = 1; i < level.checkpoints.length; i++) {
    if (level.checkpoints[i].pos.y <= level.checkpoints[i - 1].pos.y) problems.push('checkpoints not ascending');
  }
  if (level.flagPos.y < level.totalHeight - 0.01) problems.push('flag below total height');

  // co-op contraptions only exist for teams
  const counts: Record<string, number> = {};
  for (const g of level.gadgets) {
    const key = g.kind === 'bridge' ? `bridge:${g.mode}` : g.kind === 'mover' ? g.motion : g.kind;
    counts[key] = (counts[key] ?? 0) + 1;
    const coop = COOP_KINDS.has(g.kind) || (g.kind === 'bridge' && (g.mode === 'duo' || g.mode === 'twin'));
    if (coop && team < 2) problems.push(`co-op gadget ${key} in a solo run`);
    if (g.kind === 'bridge' && g.mode === 'twin' && g.plates.length !== 2) problems.push('twin bridge without two plates');
    if (g.kind === 'mover' && !(g.period > 0)) problems.push(`mover ${g.id} has no period`);
    if (g.kind === 'seesaw' && g.target.y < g.pivot.y + 4) problems.push(`seesaw ${g.id} target is jumpable`);
  }
  if (team >= 2 && !level.gadgets.some((g) => COOP_KINDS.has(g.kind) || (g.kind === 'bridge' && (g.mode === 'duo' || g.mode === 'twin')))) {
    problems.push('team run without any co-op contraption');
  }

  if (verbose) {
    const items: Record<string, number> = {};
    for (const it of level.items) items[it.type] = (items[it.type] ?? 0) + 1;
    console.log(
      `seed=${seed.padEnd(13)} team=${team} height=${level.totalHeight.toFixed(0).padStart(4)}m nodes=${level.nodes.length} ` +
        `props=${level.props.length} items=${JSON.stringify(items)} problems=${problems.length}`,
    );
    console.log(`  gadgets: ${Object.entries(counts).map(([k, n]) => `${k}×${n}`).join(' ')}`);
    console.log(`  zones: ${level.zones.map((z) => z.label).join(' → ')}`);
    for (const p of problems.slice(0, 12)) console.log(`  ! ${p}`);
    if (problems.length > 12) console.log(`  ! …and ${problems.length - 12} more`);
  }
  return problems.length;
}

const sweepArg = process.argv.indexOf('--sweep');
let failed = 0;
if (sweepArg >= 0) {
  const n = Number(process.argv[sweepArg + 1] ?? 100);
  let bad = 0;
  const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    for (const team of [1, 2]) {
      const seed = `sweep${i}`;
      const k = checkSeed(seed, team, false);
      if (k > 0) {
        bad++;
        if (bad <= 8) checkSeed(seed, team, true);
      }
    }
  }
  console.log(`${bad}/${n * 2} sweep levels with problems (${((Date.now() - t0) / (n * 2)).toFixed(0)} ms/level)`);
  failed = bad;
} else {
  for (const seed of ['alpha', 'bravo', 'charlie', 'delta', 'echo7', 'kitchen-sink']) {
    for (const team of [1, 3]) failed += checkSeed(seed, team, true);
  }
}
if (failed) {
  console.error('LEVEL CHECK FAILED');
  process.exit(1);
}
console.log('All seeds OK');

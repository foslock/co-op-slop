import pg from 'pg';
import type { RunRow } from 'shared';

// Postgres when DATABASE_URL is set (Render), in-memory fallback for local dev.
let pool: pg.Pool | null = null;
const memory: { names: string[]; durationMs: number; seed: string; date: Date }[] = [];

export async function initDb(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log('[db] DATABASE_URL not set — using in-memory leaderboard');
    return;
  }
  pool = new pg.Pool({
    connectionString: url,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false },
  });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS runs (
      id SERIAL PRIMARY KEY,
      player_names JSONB NOT NULL,
      player_count INT NOT NULL,
      seed TEXT NOT NULL,
      duration_ms INT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS runs_duration_idx ON runs (duration_ms);
  `);
  console.log('[db] connected to Postgres');
}

export async function saveRun(names: string[], seed: string, durationMs: number): Promise<number | null> {
  if (pool) {
    await pool.query('INSERT INTO runs (player_names, player_count, seed, duration_ms) VALUES ($1, $2, $3, $4)', [
      JSON.stringify(names), names.length, seed, Math.round(durationMs),
    ]);
    const res = await pool.query('SELECT COUNT(*)::int AS faster FROM runs WHERE duration_ms < $1', [Math.round(durationMs)]);
    return res.rows[0].faster + 1;
  }
  memory.push({ names, durationMs, seed, date: new Date() });
  memory.sort((a, b) => a.durationMs - b.durationMs);
  return memory.findIndex((r) => r.durationMs >= durationMs) + 1;
}

export async function topRuns(limit = 10): Promise<RunRow[]> {
  if (pool) {
    const res = await pool.query(
      'SELECT player_names, duration_ms, seed, created_at FROM runs ORDER BY duration_ms ASC LIMIT $1',
      [limit],
    );
    return res.rows.map((r) => ({
      names: r.player_names as string[],
      durationMs: r.duration_ms as number,
      seed: r.seed as string,
      date: (r.created_at as Date).toISOString(),
    }));
  }
  return memory.slice(0, limit).map((r) => ({
    names: r.names, durationMs: r.durationMs, seed: r.seed, date: r.date.toISOString(),
  }));
}

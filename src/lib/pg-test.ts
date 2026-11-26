/** Test helper (not used by production code): find the local Postgres for integration tests. */
import pg from "pg";

/** DATABASE_URL, or the docker-compose database by default. */
export const TEST_DATABASE_URL = process.env.DATABASE_URL ?? "postgres://pipeline:pipeline@localhost:5432/adtech";

/**
 * Returns false when Postgres answers, or a skip reason when it does not, for `describe(..., { skip })`.
 * So `npm test` passes without Docker.
 */
export async function postgresSkipReason(url: string = TEST_DATABASE_URL): Promise<string | false> {
  const probe = new pg.Client({ connectionString: url, connectionTimeoutMillis: 1500 });
  probe.on("error", () => {});
  try {
    await probe.connect();
    return false;
  } catch (err) {
    return `Postgres not reachable (${(err as Error).message || (err as Error).name}); start it with docker compose up -d`;
  } finally {
    await probe.end().catch(() => {});
  }
}

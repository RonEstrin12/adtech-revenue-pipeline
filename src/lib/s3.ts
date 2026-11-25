/**
 * Thin wrapper around the AWS S3 SDK for the raw zone.
 * Locally it points at S3Mock; in production, at a real bucket.
 * Only the env vars change, never the code.
 */
import { createHash } from "node:crypto";
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const endpoint = process.env.S3_ENDPOINT; // unset in production -> real AWS S3
export const BUCKET = process.env.S3_BUCKET ?? "raw";

export const s3 = new S3Client({
  region: process.env.S3_REGION ?? "us-east-1",
  ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
});

export function sha256(body: string | Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

/** All keys under a prefix, sorted (our keys sort by time). */
export async function listKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }),
    );
    for (const obj of page.Contents ?? []) if (obj.Key) keys.push(obj.Key);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return keys.sort();
}

export async function getText(key: string): Promise<string> {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return (await res.Body?.transformToString("utf-8")) ?? "";
}

export interface RawPutResult {
  key: string;
  status: "stored" | "unchanged";
  bytes: number;
}

/**
 * Store a raw file exactly as received, under
 *   <prefix>/fetched_at=<timestamp>.<ext>
 *
 * The raw zone is append-only: we never overwrite what a partner sent.
 * If the newest file under the prefix has the same content (same sha256),
 * we skip the upload, so re-running a day does not pile up identical copies.
 */
export async function putRaw(
  prefix: string,
  ext: "json" | "csv",
  body: string,
  meta: Record<string, string>,
): Promise<RawPutResult> {
  const hash = sha256(body);
  const bytes = Buffer.byteLength(body);

  const existing = await listKeys(`${prefix}/`);
  const latest = existing.at(-1);
  if (latest) {
    const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: latest }));
    if (head.Metadata?.sha256 === hash) return { key: latest, status: "unchanged", bytes };
  }

  const fetchedAt = new Date().toISOString().replace(/[:.]/g, "-");
  const key = `${prefix}/fetched_at=${fetchedAt}.${ext}`;
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: ext === "json" ? "application/json" : "text/csv",
      Metadata: { ...meta, sha256: hash },
    }),
  );
  return { key, status: "stored", bytes };
}

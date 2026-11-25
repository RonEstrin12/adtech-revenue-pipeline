/**
 * List what is in the S3 raw zone:  npm run raw:ls [-- prefix]
 */
import { BUCKET, listKeys } from "../lib/s3.js";

const prefix = process.argv[2] ?? "";
const keys = await listKeys(prefix);
console.log(`s3://${BUCKET}/${prefix} (${keys.length} files)`);
for (const k of keys) console.log(`  ${k}`);

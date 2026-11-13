import {
  GetBucketLifecycleConfigurationCommand,
  GetPublicAccessBlockCommand,
  PutBucketEncryptionCommand,
  PutBucketLifecycleConfigurationCommand,
  PutPublicAccessBlockCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { env } from "@relay/core";

/*
 * One-time (and repeatable) setup of the files bucket: private, encrypted, and the lifecycle rules
 * Relay relies on. Run: pnpm --filter @relay/worker s3:setup
 *   exports/   deleted after 1 day
 *   imports/   deleted after 30 days
 *   files/     Intelligent-Tiering after 30 days (cold files get cheaper on their own)
 * Unfinished multipart uploads are cleaned after 1 day.
 */

const config = env();
if (!config.S3_BUCKET) {
  console.error("Set S3_BUCKET (and S3_REGION, AWS keys) in .env first.");
  process.exit(1);
}
const Bucket = config.S3_BUCKET;
const s3 = new S3Client({ region: config.S3_REGION });

await s3.send(
  new PutPublicAccessBlockCommand({
    Bucket,
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      IgnorePublicAcls: true,
      BlockPublicPolicy: true,
      RestrictPublicBuckets: true,
    },
  }),
);
await s3.send(
  new PutBucketEncryptionCommand({
    Bucket,
    ServerSideEncryptionConfiguration: {
      Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" }, BucketKeyEnabled: true }],
    },
  }),
);
await s3.send(
  new PutBucketLifecycleConfigurationCommand({
    Bucket,
    LifecycleConfiguration: {
      Rules: [
        { ID: "exports-1-day", Status: "Enabled", Filter: { Prefix: "exports/" }, Expiration: { Days: 1 } },
        {
          ID: "imports-30-days",
          Status: "Enabled",
          Filter: { Prefix: "imports/" },
          Expiration: { Days: 30 },
        },
        {
          ID: "files-intelligent-tiering",
          Status: "Enabled",
          Filter: { Prefix: "files/" },
          Transitions: [{ Days: 30, StorageClass: "INTELLIGENT_TIERING" }],
        },
        {
          ID: "abort-incomplete-uploads",
          Status: "Enabled",
          Filter: { Prefix: "" },
          AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
        },
      ],
    },
  }),
);

const block = await s3.send(new GetPublicAccessBlockCommand({ Bucket }));
const rules = await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket }));
console.log(`Bucket ${Bucket} (${config.S3_REGION})`);
console.log("  private:", Object.values(block.PublicAccessBlockConfiguration ?? {}).every(Boolean));
console.log("  encrypted by default: AES256");
console.log("  lifecycle:", (rules.Rules ?? []).map((r) => r.ID).join(", "));

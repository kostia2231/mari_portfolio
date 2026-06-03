import { S3Client, PutObjectCommand, ListObjectsV2Command, HeadObjectCommand } from "@aws-sdk/client-s3";

const requiredEnv = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_ENDPOINT"];
for (const k of requiredEnv) {
    if (!process.env[k]) {
        throw new Error(`Missing env var: ${k} (see v2/.env.example)`);
    }
}

const BUCKET = process.env.R2_BUCKET;

export const r2 = new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
});

const CONTENT_TYPE = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    avif: "image/avif",
    mp4: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm",
    json: "application/json",
};

function contentTypeFor(key) {
    const ext = key.split(".").pop()?.toLowerCase() ?? "";
    return CONTENT_TYPE[ext] ?? "application/octet-stream";
}

/**
 * Uploads a Buffer to R2 under `key`. Cache-Control set to 1 year (immutable).
 */
export async function putObject(key, body, options = {}) {
    await r2.send(
        new PutObjectCommand({
            Bucket: BUCKET,
            Key: key,
            Body: body,
            ContentType: options.contentType ?? contentTypeFor(key),
            CacheControl: options.cacheControl ?? "public, max-age=31536000, immutable",
        }),
    );
}

/** Returns true if object `key` already exists in the bucket. */
export async function objectExists(key) {
    try {
        await r2.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
        return true;
    } catch (err) {
        if (err?.$metadata?.httpStatusCode === 404) return false;
        throw err;
    }
}

/** Lists all object keys with a given prefix. */
export async function listKeys(prefix = "") {
    const keys = [];
    let token;
    do {
        const res = await r2.send(
            new ListObjectsV2Command({
                Bucket: BUCKET,
                Prefix: prefix,
                ContinuationToken: token,
            }),
        );
        for (const obj of res.Contents ?? []) {
            if (obj.Key) keys.push(obj.Key);
        }
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return keys;
}

// R2 over its S3 API, for laptop scripts. Needs an R2 API token (Object Read & Write on the data
// bucket) in .env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (see .env.example).
import { S3Client } from "bun";
import { DATA_BUCKET } from "../../shared/deploy.ts";

export function r2() {
	const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
	if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) throw new Error("set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY in .env (see .env.example)");
	return new S3Client({
		accessKeyId: R2_ACCESS_KEY_ID,
		secretAccessKey: R2_SECRET_ACCESS_KEY,
		bucket: DATA_BUCKET,
		endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
	});
}

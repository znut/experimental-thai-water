// Deployment names shared by cloudflare.config.ts and scripts (kept free of Worker imports).
export const DATA_BUCKET = "thai-water-way-data";
// The app and Worker (cron, ingest API). Not the data domain: see DATA_ORIGIN.
export const APP_HOST = "water.experiment.tripsters.me";

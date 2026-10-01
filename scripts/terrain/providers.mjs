// Elevation providers. Each one turns a lon/lat bbox into a regular grid of ground heights
// (metres, approximately MSL). build-terrain.mjs only talks to this interface, so adding a
// source (e.g. a government ImageServer export) means adding one entry here.
//
// Provider shape:
//   id, label, license, attribution
//   kind: "dtm" (bare earth) | "dsm" (includes buildings/trees: biased high in cities)
//   datum: vertical datum as published; offset_m is added to every value to reach MSL
//   resolution_m: nominal pixel size
//   load(bbox) -> Promise<Grid[]>  (one grid per source tile; build-terrain reads them all)
//
// Grid: { width, height, lon0, lat0, dLon, dLat, data: Float32Array, nodata }
//   pixel (i, j) centre = (lon0 + (i + 0.5) * dLon, lat0 + (j + 0.5) * dLat); dLat is negative.

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { fromFile } from "geotiff";

const DEM_DIR = new URL("../../data/dem/", import.meta.url);

async function download(url, file) {
	const path = new URL(file, DEM_DIR);
	if (existsSync(path)) return path;
	await mkdir(DEM_DIR, { recursive: true });
	console.log(`downloading ${url}`);
	const res = await fetch(url);
	if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
	await writeFile(path, Buffer.from(await res.arrayBuffer()));
	return path;
}

/** Reads the bbox window out of a (Cloud-Optimised) GeoTIFF in EPSG:4326. */
export async function gridFromGeoTiff(path, [west, south, east, north]) {
	const tiff = await fromFile(path.pathname ?? path);
	const img = await tiff.getImage();
	const [x0, , , y1] = img.getBoundingBox();
	const [rx, ry] = img.getResolution(); // ry < 0
	const col = (lon) => Math.floor((lon - x0) / rx);
	const row = (lat) => Math.floor((lat - y1) / ry);
	const window = [
		Math.max(0, col(west)),
		Math.max(0, row(north)),
		Math.min(img.getWidth(), col(east) + 1),
		Math.min(img.getHeight(), row(south) + 1),
	];
	const [band] = await img.readRasters({ window });
	const nodata = img.getGDALNoData();
	return {
		width: window[2] - window[0],
		height: window[3] - window[1],
		lon0: x0 + window[0] * rx,
		lat0: y1 + window[1] * ry,
		dLon: rx,
		dLat: ry,
		data: Float32Array.from(band),
		nodata: nodata ?? -32767,
	};
}

/** Lists the 1-degree tile names (e.g. N13E100) a bbox touches. */
function tiles([west, south, east, north]) {
	const out = [];
	for (let lat = Math.floor(south); lat <= Math.floor(north); lat++)
		for (let lon = Math.floor(west); lon <= Math.floor(east); lon++) out.push({ lat, lon });
	return out;
}


export const PROVIDERS = {
	copernicus: {
		id: "copernicus",
		label: "Copernicus GLO-30 DSM",
		license: "Copernicus DEM licence (free, attribution)",
		attribution: "© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the European Union and ESA",
		kind: "dsm",
		datum: "EGM2008",
		offset_m: 0,
		resolution_m: 30,
		async load(bbox) {
			const grids = [];
			for (const { lat, lon } of tiles(bbox)) {
				const name = `Copernicus_DSM_COG_10_N${String(lat).padStart(2, "0")}_00_E${String(lon).padStart(3, "0")}_00_DEM`;
				const path = await download(`https://copernicus-dem-30m.s3.amazonaws.com/${name}/${name}.tif`, `copernicus_N${lat}_E${lon}.tif`);
				grids.push(await gridFromGeoTiff(path, bbox));
			}
			return grids;
		},
	},

	fabdem: {
		id: "fabdem",
		label: "FABDEM v1-2 (bare earth)",
		license: "CC BY-NC-SA 4.0",
		attribution: "FABDEM V1-2, Hawker et al. 2022, University of Bristol; derived from Copernicus GLO-30",
		kind: "dtm",
		datum: "EGM2008",
		offset_m: 0,
		resolution_m: 30,
		async load(bbox) {
			// Bristol only publishes 10x10-degree zips (1.7 GB here); this mirror serves single tiles.
			const base = "https://huggingface.co/buckets/links-ads/fabdem/resolve/tiles";
			const grids = [];
			for (const { lat, lon } of tiles(bbox)) {
				const pack = `N${Math.floor(lat / 10) * 10}E${Math.floor(lon / 10) * 10}-N${Math.floor(lat / 10) * 10 + 10}E${Math.floor(lon / 10) * 10 + 10}_FABDEM_V1-2`;
				const name = `N${lat}E${lon}_FABDEM_V1-2.tif`;
				grids.push(await gridFromGeoTiff(await download(`${base}/${pack}/${name}`, name), bbox));
			}
			return grids;
		},
	},
};

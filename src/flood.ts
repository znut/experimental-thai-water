// Flood shading on the ground raster (public/data/ground.*): estimated water depth per 100 m
// cell, drawn as an image layer, darker = deeper.
import type * as maplibregl from "maplibre-gl";
import type { GroundMeta } from "../shared/types.ts";

export interface Ground {
	meta: GroundMeta;
	z: Int16Array; // cm, -32768 = none
	node: Uint16Array; // 65535 = none
}

export async function loadGround(networkBuild: string | undefined): Promise<Ground | null> {
	const [m, b] = await Promise.all([fetch("/data/ground.json"), fetch("/data/ground.bin")]);
	if (!m.ok || !b.ok) return null;
	const meta: GroundMeta = await m.json();
	if (meta.builtFrom !== networkBuild) return null; // stale against this network
	const buf = await b.arrayBuffer();
	const cells = meta.width * meta.height;
	return { meta, z: new Int16Array(buf, 0, cells), node: new Uint16Array(buf, cells * 2, cells) };
}

// Depth (cm) -> RGBA. Starts at 5 cm so damp streets don't paint the whole city.
const RAMP: [number, [number, number, number, number]][] = [
	[5, [253, 208, 162, 110]],
	[15, [253, 141, 60, 150]],
	[30, [230, 85, 13, 180]],
	[60, [166, 54, 3, 210]],
	[100, [103, 0, 13, 230]],
];
function color(cm: number): [number, number, number, number] | null {
	if (cm < RAMP[0][0]) return null;
	let c = RAMP[0][1];
	for (const [t, rgba] of RAMP) if (cm >= t) c = rgba;
	return c;
}

export const FLOOD_LEGEND = RAMP.map(([t, [r, g, b]]) => ({ from_cm: t, css: `rgb(${r},${g},${b})` }));

export class FloodShade {
	private canvas: HTMLCanvasElement;
	private ctx: CanvasRenderingContext2D;
	private img: ImageData;

	constructor(
		private map: maplibregl.Map,
		private id: string,
		private g: Ground,
		visible: boolean,
		beforeLayer?: string,
	) {
		const { width, height, lon0, lat0, dLon, dLat } = g.meta;
		this.canvas = document.createElement("canvas");
		this.canvas.width = width;
		this.canvas.height = height;
		this.ctx = this.canvas.getContext("2d")!;
		this.img = this.ctx.createImageData(width, height);
		const east = lon0 + width * dLon, south = lat0 + height * dLat;
		map.addSource(id, { type: "image", coordinates: [[lon0, lat0], [east, lat0], [east, south], [lon0, south]] } as maplibregl.ImageSourceSpecification);
		map.addLayer(
			{ id, type: "raster", source: id, layout: { visibility: visible ? "visible" : "none" }, paint: { "raster-resampling": "nearest", "raster-fade-duration": 0 } },
			beforeLayer,
		);
	}

	/** Paints depth(cell) in cm; return <= 0 for dry. */
	async paint(depthCm: (cell: number) => number) {
		const d = this.img.data;
		d.fill(0);
		const cells = this.g.meta.width * this.g.meta.height;
		for (let c = 0; c < cells; c++) {
			const rgba = color(depthCm(c));
			if (rgba) d.set(rgba, 4 * c);
		}
		this.ctx.putImageData(this.img, 0, 0);
		const bitmap = await createImageBitmap(this.canvas);
		(this.map.getSource(this.id) as maplibregl.ImageSource).updateImage({ image: bitmap } as never);
	}

	/**
	 * Live estimate from road flood sensors: each wet sensor sets a water surface (its ground
	 * + reported depth); nearby cells whose ground is below that surface are shaded. Rough:
	 * the ground raster is about ±0.8 m, so depth is capped at 1.5x the sensor reading.
	 */
	paintFromSensors(points: { lon: number; lat: number; depth_cm: number }[], radiusM = 500) {
		const depth = this.sensorDepth(points, radiusM);
		return this.paint((c) => depth[c]);
	}

	/** Simulation: shading around road hotspots, optionally plus canal-overflow water (surface per node, m). */
	paintSim(points: { lon: number; lat: number; depth_cm: number }[], surfaceM: Float32Array | null) {
		const depth = this.sensorDepth(points, 500);
		const { z, node } = this.g;
		return this.paint((c) => {
			let d = depth[c];
			const k = node[c];
			if (surfaceM && k !== 65535 && z[c] !== -32768) {
				const s = surfaceM[k];
				if (!Number.isNaN(s)) d = Math.max(d, s * 100 - z[c]);
			}
			return d;
		});
	}

	private sensorDepth(points: { lon: number; lat: number; depth_cm: number }[], radiusM: number) {
		const { width, height, lon0, lat0, dLon, dLat, cell_m } = this.g.meta;
		const depth = new Float32Array(width * height);
		const r = Math.ceil(radiusM / cell_m);
		for (const p of points) {
			const i0 = Math.floor((p.lon - lon0) / dLon), j0 = Math.floor((p.lat - lat0) / dLat);
			if (i0 < 0 || j0 < 0 || i0 >= width || j0 >= height) continue;
			const g0 = this.g.z[j0 * width + i0];
			if (g0 === -32768) continue;
			const surface = g0 + p.depth_cm;
			for (let j = Math.max(0, j0 - r); j <= Math.min(height - 1, j0 + r); j++)
				for (let i = Math.max(0, i0 - r); i <= Math.min(width - 1, i0 + r); i++) {
					if ((i - i0) ** 2 + (j - j0) ** 2 > r * r) continue;
					const c = j * width + i, g = this.g.z[c];
					if (g === -32768) continue;
					const dd = Math.min(surface - g, p.depth_cm * 1.5);
					if (dd > depth[c]) depth[c] = dd;
				}
		}
		return depth;
	}

	/** Simulation: water surface per graph node (m) against each cell's ground. */
	paintFromSurface(surfaceM: Float32Array) {
		const { z, node } = this.g;
		return this.paint((c) => {
			const k = node[c];
			if (k === 65535 || z[c] === -32768) return 0;
			const s = surfaceM[k];
			return Number.isNaN(s) ? 0 : s * 100 - z[c];
		});
	}

	setVisible(v: boolean) {
		this.map.setLayoutProperty(this.id, "visibility", v ? "visible" : "none");
	}
}

export const LAYERS = ["flood", "pump", "smallpump", "flow", "level", "rain", "river", "reports", "news"] as const;
export type LayerName = (typeof LAYERS)[number];

export type Props = Record<string, string | number | boolean | null>;

export interface PointFeature {
	type: "Feature";
	geometry: { type: "Point"; coordinates: [number, number] };
	properties: Props & { id: string; name: string };
}

export interface Snapshot {
	type: "FeatureCollection";
	layer: LayerName;
	source: string;
	fetchedAt: string;
	features: PointFeature[];
}

export interface SourceStatus {
	ok: boolean;
	fetchedAt: string;
	count?: number;
	error?: string;
}

// public/data/sensors.json: station code -> where it sits on the canal graph.
export interface SensorSnap {
	kind: "flow" | "level" | "pump";
	edge: number;
	frac: number; // 0 at edge node a, 1 at node b
	node: number;
	dist_m: number;
	at: [number, number];
	source?: "thaiwater"; // default: BMA DDS
	tw_id?: number; // ThaiWater station id (history endpoint)
	datum_offset_m?: number; // ThaiWater minus co-located BMA gauge (m); subtract to get BMA reference
	datum_pair?: string;
}

// public/data/infra.json: drainage structures placed on the canal graph (node ids from network.geojson).
export interface Infra {
	builtFrom: string; // network.geojson build stamp these node ids belong to
	pumps: { code: string; name: string; node: number; capacity_m3s: number; outlet: "river" | "canal"; source: string }[];
	tunnels: { name: string; inlets: number[]; capacity_m3s: number; status: "open" | "construction"; source: string }[];
	ponds: { name: string; node: number; storage_m3: number; source: string }[];
	// Canal ends that drain by gravity through gates to the Gulf or the tidal river (one-way).
	gravity?: { node: number; name: string; kind: "sea" | "river"; source: string }[];
}

// public/data/terrain.json: ground elevation per graph node, from a pluggable DEM provider
// (scripts/terrain/providers.mjs). q[node] = ground heights (m) at `quantiles` of its catchment.
export interface Terrain {
	source: string;
	label: string;
	license: string;
	attribution: string;
	kind: "dtm" | "dsm";
	datum: string;
	resolution_m: number;
	builtFrom: string;
	quantiles: number[];
	catch_m2: number[];
	q: (number[] | null)[];
}

// public/data/ground.json + ground.bin: a coarse ground raster for drawing flood extent.
// ground.bin = Int16 ground height in cm (width*height, row 0 = north, -32768 = no data)
//              followed by Uint16 canal-graph node id per cell (65535 = drains to no node).
export interface GroundMeta {
	lon0: number; // west edge
	lat0: number; // north edge
	dLon: number; // > 0
	dLat: number; // < 0
	width: number;
	height: number;
	cell_m: number;
	builtFrom: string; // network build
	source: string; // terrain label incl. calibration
}

// public/data/scenarios/<id>.json: a recorded event to replay through the simulation.
export interface Scenario {
	id: string;
	title: string;
	start: string; // ISO, Asia/Bangkok offset
	step_min: number;
	steps: number;
	rain: { code: string; lon: number; lat: number; mm: (number | null)[] }[]; // rainfall per step
	river_level_msl?: (number | null)[]; // Chao Phraya level at Bangkok (pump outlet head)
	observed?: {
		flood: { code: string; lon: number; lat: number; depth_cm: (number | null)[] }[];
		level: { code: string; lon: number; lat: number; level_m: (number | null)[] }[];
		reports?: { lon: number; lat: number; time: string; hours_open: number | null }[]; // Traffy
	};
	// Water level outside the city edge (boundary.json gauges), m MSL per step: model input.
	boundary?: { code: string; lon: number; lat: number; level_m: (number | null)[] }[];
	sources: string[];
}

export type Status = Partial<Record<LayerName | "tide", SourceStatus>>;

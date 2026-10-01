// Places BMA drainage structures (pumps, tunnels, retention ponds) on the canal graph.
// Input: public/data/network.geojson (run build-network.mjs first). Output: public/data/infra.json.
// Run: bun scripts/build-infra.mjs
//   EXTRA=samutprakan  also place data/extra/pumps-<name>.json (outlets beyond BMA, e.g. RID sea pumps)
//   OUT_DIR=data/staging  read network.geojson from / write infra.json to that directory
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cachedJson, chaoPhraya, ckanCsv, distToLines, loadNetwork, overpass, seaMask, toXY, dist } from "./lib/data.mjs";

// metres from the nearest canal line. Ponds and tunnel intakes sit back from canals and connect
// through short culverts, so they get a wider radius.
const PUMP_SNAP = 300, TUNNEL_SNAP = 800, POND_SNAP = 1500;
// A pump discharges to the river if it is within RIVER_OUTLET of the Chao Phraya, or within
// RIVER_VIA_CANAL and on a canal whose own mouth reaches the river (e.g. Phra Khanong, 155 m³/s,
// sits ~1.8 km up Khlong Phra Khanong and pumps down it to the river).
const RIVER_OUTLET = 500, RIVER_VIA_CANAL = 2500;

const net = await loadNetwork();
const river = await chaoPhraya();
const unmatched = [];
const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

// ---- Pumps --------------------------------------------------------------------------------
// CKAN water-station: the header is shifted by one column, so `gp_gate` holds the total pump
// capacity (m³/s) and `gp_pump` holds "<count>\n<n>(<m³/s each>)+...". The two agree on 269 of
// 272 rows; we take the composition sum when present and fall back to the total column.
const ws = await ckanCsv("water-station");
const composition = (s) => {
	const m = [...String(s).matchAll(/(\d+(?:\.\d+)?)\s*\(\s*(\d+(?:\.\d+)?)\s*\)/g)];
	return m.length ? m.reduce((a, x) => a + Number(x[1]) * Number(x[2]), 0) : null;
};

// Live BMA codes (ST.*) so the simulation can join live pump on/off status.
const live = (await cachedJson("https://weather.bangkok.go.th/Station/Map/GetData?id=0")).LastPump.map((r) => ({
	code: r.pumpStation_code,
	xy: toXY([r.longitude, r.latitude]),
}));

// Canal names with a node within RIVER_OUTLET of the river (their mouth is on the river).
const riverCanals = new Set(
	[...net.edgeNames].filter(([id]) => distToLines(net.nodes.get(id), river) <= RIVER_OUTLET).flatMap(([, names]) => [...names]),
);
function isRiverOutlet(ll, canal) {
	const d = distToLines(ll, river);
	return d <= RIVER_OUTLET || (d <= RIVER_VIA_CANAL && riverCanals.has(canal));
}

const pumps = [];
for (const r of ws.rows) {
	const name = clean(r.gp_name);
	const cap = composition(r.gp_pump) ?? Number(r.gp_gate);
	if (!Number.isFinite(cap) || cap <= 0) continue;
	// Tunnel outlet pumps lift tunnel water into the river; that capacity is the tunnel's own.
	if (/อุโมงค์/.test(name)) continue;
	const ll = [Number(r.gp_long), Number(r.gp_lat)];
	if (!Number.isFinite(ll[0]) || !Number.isFinite(ll[1])) continue;
	const node = net.nearestEdgeNode(ll, PUMP_SNAP);
	if (!node) {
		unmatched.push(`pump:${name}`);
		continue;
	}
	const xy = toXY(ll);
	const liveMatch = live.map((l) => ({ ...l, d: dist(l.xy, xy) })).filter((l) => l.d <= 200).sort((a, b) => a.d - b.d)[0];
	pumps.push({
		code: liveMatch?.code ?? `CKAN-${r.gp_id}`,
		name,
		node: node.id,
		capacity_m3s: Math.round(cap * 100) / 100,
		outlet: isRiverOutlet(ll, node.name) ? "river" : "canal",
		source: `data.bangkok.go.th water-station gp_id ${r.gp_id} (${r.gp_type})`,
	});
}

// ---- Tunnels ------------------------------------------------------------------------------
// Capacities/status from CKAN water-drainage-tunnel. Inlet locations: the inland end of the
// ArcGIS Drainage MapServer layer 3 line where one exists, otherwise the canal junction the
// project description names. Planned/under-study tunnels are left out.
const tun = await ckanCsv("water-drainage-tunnel");
const geo = await cachedJson(
	"https://cpudgiapp.bangkok.go.th/arcgis/rest/services/Thematic/Drainage/MapServer/3/query?where=1%3D1&outFields=OBJECTID,NAME&outSR=4326&f=geojson&geometryPrecision=5",
);
const inlandEnd = (objectId) => {
	const f = geo.features.find((x) => x.properties.OBJECTID === objectId);
	const c = f.geometry.type === "MultiLineString" ? f.geometry.coordinates.flat() : f.geometry.coordinates;
	return [c[0], c.at(-1)].sort((p, q) => distToLines(q, river) - distToLines(p, river))[0];
};
// Nodes where two named canals meet (the junction a tunnel intake sits at).
const junctionOf = (a, b) => [...net.edgeNames].filter(([, names]) => names.has(a) && names.has(b)).map(([id]) => id);
const onCanal = (name) => [...net.edgeNames].filter(([, names]) => names.has(name)).map(([id]) => id);

const BUENG_NONG_BON = [100.6587, 13.6956]; // OSM water area centroid

const TUNNEL_INLETS = {
	1: { how: "ArcGIS layer 3 OBJECTID 1, inland end", inlets: () => nodesNear(inlandEnd(1)) },
	2: { how: "ArcGIS layer 3 OBJECTID 5 (Bueng Makkasan), inland end", inlets: () => nodesNear(inlandEnd(5)) },
	3: { how: "ArcGIS layer 3 OBJECTID 6, inland end", inlets: () => nodesNear(inlandEnd(6)) },
	4: {
		how: "junction of คลองบางซื่อ and คลองลาดพร้าว (tunnel runs under Khlong Bang Sue from Khlong Lat Phrao)",
		inlets: () => {
			const j = junctionOf("คลองบางซื่อ", "คลองลาดพร้าว");
			if (j.length) return j;
			// Fallback: the Khlong Bang Sue node farthest from the river.
			const far = onCanal("คลองบางซื่อ").sort((a, b) => distToLines(net.nodes.get(b), river) - distToLines(net.nodes.get(a), river));
			return far.slice(0, 1);
		},
	},
	5: { how: "nearest node to Bueng Nong Bon (OSM)", inlets: () => nodesNear(BUENG_NONG_BON) },
	// Khlong Bang Bua is not in the BMA canal layer; use HII station BKK021 "คลองลาดพร้าว วัดบางบัว".
	6: { how: "nearest canal to HII station BKK021 (Khlong Lat Phrao at Wat Bang Bua)", inlets: () => nodesNear([100.58746, 13.85402]) },
	// 7 (Saen Saep extension) drains into tunnel 3, not the river; 8 (Thawi Watthana) is an
	// in-canal bypass. Neither fits the inlet->river model, so they're skipped.
};
function nodesNear(ll) {
	const n = net.nearestEdgeNode(ll, TUNNEL_SNAP);
	return n ? [n.id] : [];
}

const tunnels = [];
for (const r of tun.rows) {
	const id = Number(r.tun_id);
	const status = /เปิดใช้งาน/.test(r.status) ? "open" : /ระหว่างก่อสร้าง/.test(r.status) ? "construction" : null;
	const spec = TUNNEL_INLETS[id];
	if (!status || !spec) continue;
	const inlets = spec.inlets();
	if (!inlets.length) {
		unmatched.push(`tunnel:${clean(r.tun_name)}`);
		continue;
	}
	tunnels.push({
		name: clean(r.tun_name),
		inlets,
		capacity_m3s: Number(r.capacity),
		status,
		source: `data.bangkok.go.th water-drainage-tunnel tun_id ${id}; inlet: ${spec.how}`,
	});
}

// ---- Retention ponds (แก้มลิง) -----------------------------------------------------------
// The CKAN list has no coordinates, so we geocode by name against OSM water bodies.
const kam = await ckanCsv("water-kamling");
const nameVariants = (n) => {
	const base = clean(n);
	const out = new Set([base, base.replace(/\s*\(.*?\)\s*/g, "").trim()]);
	for (const m of base.matchAll(/\(([^)]+)\)/g)) out.add(m[1].trim());
	for (const part of base.split(/\s*และ\s*/)) out.add(part.trim()); // "บึง A และบึง B"
	for (const v of [...out]) out.add(v.replace(/(\D)(\d)/g, "$1 $2")); // "บึงพระราม9" -> "บึงพระราม 9"
	return [...out].filter((v) => v.length > 3);
};
// All named water bodies in Bangkok, matched by name locally (a big name regex times out Overpass).
const osm = await overpass(
	"named-water",
	'[out:json][timeout:120];(nwr["natural"="water"]["name"](13.49,100.32,13.96,100.94);nwr["landuse"="reservoir"]["name"](13.49,100.32,13.96,100.94););out center tags;',
);
const waterBodies = osm.elements;

const ponds = [];
for (const r of kam.rows) {
	const variants = nameVariants(r.kamling_name);
	const hit = waterBodies.find((e) => variants.includes(e.tags.name));
	const storage = Number(r.stor_vol);
	if (!hit || !Number.isFinite(storage)) {
		unmatched.push(`pond:${clean(r.kamling_name)}`);
		continue;
	}
	const ll = [hit.center?.lon ?? hit.lon, hit.center?.lat ?? hit.lat];
	const node = net.nearestEdgeNode(ll, POND_SNAP);
	if (!node) {
		unmatched.push(`pond:${clean(r.kamling_name)} (no canal within ${POND_SNAP} m)`);
		continue;
	}
	ponds.push({
		name: clean(r.kamling_name),
		node: node.id,
		storage_m3: storage,
		source: `data.bangkok.go.th water-kamling id ${r.id}; location: OSM ${hit.type}/${hit.id}`,
	});
}

// Gravity outlets: canal ends (degree 1) at open water that FABDEM flattens to 0 m: the Gulf
// coast (Bang Khun Thian) and the tidal lower Chao Phraya. They drain through flap/sluice
// gates whenever the canal is above the outside water; the model never lets water back in.
const { distToSea } = await seaMask();
const extraEnd = new Map(); // node -> widest extra-dataset edge touching it
for (const f of net.features)
	if (f.properties.dataset)
		for (const k of [f.properties.a, f.properties.b]) {
			const w = f.properties.width_m ?? 0, named = !/^\(/.test(f.properties.name ?? "(");
			const cur = extraEnd.get(k);
			if (!cur || w > cur.width) extraEnd.set(k, { width: w, named });
		}
const degree = new Map();
for (const f of net.features) for (const k of [f.properties.a, f.properties.b]) degree.set(k, (degree.get(k) ?? 0) + 1);
const pumpNodes = new Set(pumps.map((p) => p.node));
const gravity = [];
for (const [node, ll] of net.nodes) {
	if (degree.get(node) !== 1 || pumpNodes.has(node)) continue;
	// Extra (OSM) datasets: skip pond ditches and drains at the coast; only real canals get a gate.
	const ext = extraEnd.get(node);
	if (ext && !(ext.width >= 6 || ext.named)) continue;
	const d = distToSea(ll[0], ll[1], 60);
	if (!Number.isFinite(d)) continue;
	// South of 13.60 N the 0 m water is the Gulf; north of it, the tidal river.
	gravity.push({ node, name: [...net.edgeNames.get(node)].join(" / "), kind: ll[1] < 13.6 ? "sea" : "river", source: "FABDEM 0 m open water within 60 m of a canal end" });
}

// ---- Extra outlets beyond BMA (EXTRA=...) ------------------------------------------------
// Sea/river outlets are stored as "river" pumps: water they lift leaves the modelled system.
// Stations without a cited per-station capacity use their estimate_m3s (flagged in source).
for (const name of (process.env.EXTRA ?? "").split(",").filter(Boolean)) {
	const extra = JSON.parse(await readFile(new URL(`../data/extra/pumps-${name}.json`, import.meta.url), "utf8"));
	for (const p of extra) {
		const node = net.nearestEdgeNode([p.lon, p.lat], PUMP_SNAP);
		const cap = p.capacity_m3s ?? p.estimate_m3s ?? null;
		if (!node || !cap) {
			unmatched.push(`extra pump:${p.name}${node ? " (no capacity)" : ""}`);
			continue;
		}
		pumps.push({
			code: `${name.toUpperCase()}:${p.name}`,
			name: p.name,
			node: node.id,
			capacity_m3s: cap,
			outlet: p.outlet === "canal" ? "canal" : "river",
			source: `${p.capacity_m3s === null ? "ESTIMATED capacity; " : ""}${p.source}`,
		});
	}
}

const infra = { builtFrom: net.build, pumps, tunnels, ponds, gravity };
await writeFile(process.env.OUT_DIR ? resolve(process.env.OUT_DIR, "infra.json") : new URL("../public/data/infra.json", import.meta.url), JSON.stringify(infra));

const sum = (a) => Math.round(a.reduce((s, x) => s + x, 0));
console.log(`network build ${net.build}`);
console.log(
	`pumps ${pumps.length} (${sum(pumps.map((p) => p.capacity_m3s))} m³/s; river outlets ${pumps.filter((p) => p.outlet === "river").length} = ${sum(pumps.filter((p) => p.outlet === "river").map((p) => p.capacity_m3s))} m³/s; live-coded ${pumps.filter((p) => p.code.startsWith("ST.")).length})`,
);
console.log(`tunnels ${tunnels.length}: ${tunnels.map((t) => `${t.capacity_m3s}${t.status === "open" ? "" : "*"}`).join(", ")} (* = under construction)`);
console.log(`gravity outlets ${gravity.length}: sea ${gravity.filter((g) => g.kind === "sea").length}, river ${gravity.filter((g) => g.kind === "river").length}`);
console.log(`ponds ${ponds.length} (${sum(ponds.map((p) => p.storage_m3))} m³) of ${kam.rows.length}`);
console.log(`unmatched ${unmatched.length}: ${unmatched.join("; ")}`);

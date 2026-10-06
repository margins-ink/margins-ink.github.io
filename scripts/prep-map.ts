// Natural Earth 1:50m admin-0 countries (public domain) -> small Europe subset for the wall map.
// usage: bun scripts/prep-map.ts <countries.geojson> static/geo/europe.json
const [src, out] = Bun.argv.slice(2);
const gj = await Bun.file(src).json();
const r = (n: number) => Math.round(n * 100) / 100;
const inBox = (c: number[]) => c[0] > -25 && c[0] < 45 && c[1] > 33 && c[1] < 72;
const round = (rings: number[][][]) => rings.map((ring) => ring.map(([x, y]) => [r(x), r(y)]));
const features = gj.features
	.filter((f: any) => {
		const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
		return polys.some((p: number[][][]) => p[0].some(inBox));
	})
	.map((f: any) => ({
		iso: f.properties.ISO_A3_EH ?? f.properties.ADM0_A3,
		name: f.properties.NAME,
		polys: (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates)
			.filter((p: number[][][]) => p[0].some(inBox))
			.map(round)
	}));
await Bun.write(out, JSON.stringify(features));
console.log(features.length, 'countries');

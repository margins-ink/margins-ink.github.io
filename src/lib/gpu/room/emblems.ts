/**
 * Cover art for the magazines and pamphlets in the dollhouse: one recognisable
 * emblem per article, drawn as original Canvas2D vector paths (no raster assets),
 * plus the cover layouts that frame them.
 *
 * Logos are redrawn from scratch as simplified marks. Licence notes and sources:
 * docs/upstream/emblems/SOURCE.md. Where a logo is not clearly reusable the
 * emblem is a generic symbol of the subject, not a copy of the mark.
 *
 * slug                      kind      emblem (main)                         secondary mark
 * ------------------------- --------- ------------------------------------- ---------------------------
 * ifd                       magazine  official Nix snowflake (CC BY 4.0)    n/a
 * hyperion                  magazine  isometric Minecraft-style grass block  swarm of tiny blocks behind
 * mcp-not-enough            magazine  official MCP mark, 3 strokes          n/a
 * notes-on-errors           magazine  official Rust logo (CC BY)            `?` operator badge
 * rust-named-parameters     magazine  official Rust logo (CC BY)            `x: 1` named-field tag
 * gpt4-hals-and-rest-libs   magazine  chip with AI sparkle (generic)        thin wrapper pins
 * optimal-parkour           pamphlet  blocks, jump arc, A* path nodes       n/a
 * nushell-tui               pamphlet  terminal with prompt chevron + `nu`   pipe bar
 * snuon                     pamphlet  curly braces with struck backslash    n/a
 * commit (hidden)           pamphlet  official Git icon (CC BY 3.0)         short commit hash
 * initial-thought (hidden)  pamphlet  ID badge with `swift-otter-42`        n/a
 *
 * Emblems draw in a unit box [-1,1]^2 (y down) centred on the origin; the cover
 * layout translates and scales. Line widths are in unit coordinates.
 */

export interface Pal {
	ink: string;
	accent: string;
	/** colour of the panel behind the emblem, for cut-outs */
	bg: string;
	mute: string;
}

type Ctx = CanvasRenderingContext2D;
type Pt = [number, number];

function poly(c: Ctx, pts: Pt[], fill?: string, stroke?: string, lw = 0.04) {
	c.beginPath();
	pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
	c.closePath();
	if (fill) {
		c.fillStyle = fill;
		c.fill();
	}
	if (stroke) {
		c.strokeStyle = stroke;
		c.lineWidth = lw;
		c.lineJoin = 'round';
		c.stroke();
	}
}
function line(c: Ctx, pts: Pt[], stroke: string, lw: number, dash?: number[]) {
	c.beginPath();
	pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
	c.strokeStyle = stroke;
	c.lineWidth = lw;
	c.lineCap = 'round';
	c.lineJoin = 'round';
	c.setLineDash(dash ?? []);
	c.stroke();
	c.setLineDash([]);
}
function rrect(c: Ctx, x: number, y: number, w: number, h: number, r: number) {
	c.beginPath();
	c.roundRect(x, y, w, h, r);
}
function text(c: Ctx, s: string, x: number, y: number, size: number, fill: string, font = '500', fam = '"Fira Code", monospace', align: CanvasTextAlign = 'center') {
	c.fillStyle = fill;
	c.font = `${font} ${size}px ${fam}`;
	c.textAlign = align;
	c.textBaseline = 'alphabetic';
	c.fillText(s, x, y);
}


// Path data copied verbatim from the upstream SVGs, see docs/upstream/emblems/SOURCE.md
const NIX_ARM_D = ('m 309.54892,-710.38827 122.19683,211.67512 -56.15706,0.5268 -32.6236,-56.8692 -32.85645,56.5653 -27.90237,-0.011 -14.29086,-24.6896 46.81047,-80.4901 -33.22946,-57.8257 z');
const RUST_GEAR_D = ('m -27.738119,3.0510736 a 0.39691469,0.39691469 0 0 0 -0.295073,0.190169 l -0.706416,1.177189 c -0.12378,0.01028 -0.247255,0.02128 -0.370004,0.03514 l -0.921391,-1.015442 a 0.39691469,0.39691469 0 0 0 -0.668175,0.132809 l -0.463021,1.29191 c -0.119407,0.03439 -0.238634,0.06915 -0.356567,0.10697 l -1.101225,-0.81597 a 0.39691469,0.39691469 0 0 0 -0.629419,0.260449 l -0.202571,1.361674 c -0.108552,0.05626 -0.216809,0.112772 -0.323494,0.172082 l -1.244369,-0.587561 a 0.39691469,0.39691469 0 0 0 -0.565856,0.378272 l 0.06718,1.379244 c -0.09428,0.0753 -0.187523,0.151522 -0.279569,0.229443 l -1.339453,-0.334863 a 0.39691469,0.39691469 0 0 0 -0.481625,0.481624 l 0.334864,1.339454 c -0.07792,0.09205 -0.154146,0.18529 -0.229444,0.27957 l -1.379244,-0.06718 a 0.39691469,0.39691469 0 0 0 -0.378271,0.565857 l 0.587561,1.2443684 c -0.05931,0.106686 -0.115818,0.214943 -0.172083,0.323495 l -1.361674,0.202571 a 0.39691469,0.39691469 0 0 0 -0.260449,0.629419 l 0.815971,1.101225 c -0.03782,0.117933 -0.07258,0.23716 -0.10697,0.356567 l -1.291911,0.463021 a 0.39691469,0.39691469 0 0 0 -0.132808,0.668176 l 1.015441,0.921391 c -0.01386,0.122749 -0.02486,0.246224 -0.03514,0.370004 l -1.177189,0.706416 a 0.39691469,0.39691469 0 0 0 0,0.681096 l 1.177189,0.706416 c 0.01028,0.12378 0.02128,0.247255 0.03514,0.370004 l -1.015441,0.921391 a 0.39691469,0.39691469 0 0 0 0.132808,0.668176 l 1.291911,0.463021 c 0.03439,0.119407 0.06915,0.238633 0.10697,0.356567 l -0.815971,1.101225 a 0.39691469,0.39691469 0 0 0 0.260449,0.629419 l 1.361674,0.202571 c 0.05626,0.108552 0.112773,0.216809 0.172083,0.323495 l -0.587561,1.244368 a 0.39691469,0.39691469 0 0 0 0.378271,0.565857 l 1.379244,-0.06718 c 0.0753,0.09428 0.151523,0.187523 0.229444,0.27957 l -0.334864,1.339453 a 0.39691469,0.39691469 0 0 0 0.481625,0.481624 l 1.339453,-0.334863 c 0.09205,0.07792 0.18529,0.154145 0.279569,0.229443 l -0.06718,1.379244 a 0.39691469,0.39691469 0 0 0 0.565856,0.378272 l 1.244369,-0.58756 c 0.106686,0.05931 0.214942,0.115816 0.323494,0.172082 l 0.202571,1.361673 a 0.39691469,0.39691469 0 0 0 0.629419,0.26045 l 1.101225,-0.815972 c 0.117934,0.03782 0.23716,0.07258 0.356567,0.106971 l 0.463021,1.29191 a 0.39691469,0.39691469 0 0 0 0.668175,0.132808 l 0.921391,-1.015442 c 0.12275,0.01386 0.246224,0.02486 0.370004,0.03514 l 0.706416,1.177187 a 0.39691469,0.39691469 0 0 0 0.681096,0 l 0.706416,-1.177187 c 0.12378,-0.01028 0.247255,-0.02128 0.370004,-0.03514 l 0.921391,1.015442 a 0.39691469,0.39691469 0 0 0 0.668176,-0.132808 l 0.463021,-1.29191 c 0.119407,-0.03439 0.238633,-0.06915 0.356567,-0.106971 l 1.101225,0.815972 a 0.39691469,0.39691469 0 0 0 0.629419,-0.26045 l 0.202571,-1.361673 c 0.108552,-0.05627 0.216809,-0.112773 0.323495,-0.172082 l 1.244368,0.58756 a 0.39691469,0.39691469 0 0 0 0.565857,-0.378272 l -0.06718,-1.379244 c 0.09428,-0.0753 0.187523,-0.151522 0.27957,-0.229443 l 1.339453,0.334863 a 0.39691469,0.39691469 0 0 0 0.481624,-0.481624 l -0.334863,-1.339453 c 0.07792,-0.09205 0.154145,-0.185291 0.229443,-0.27957 l 1.379244,0.06718 a 0.39691469,0.39691469 0 0 0 0.378272,-0.565857 l -0.58756,-1.244368 c 0.05931,-0.106686 0.115816,-0.214943 0.172082,-0.323495 l 1.361673,-0.202571 a 0.39691469,0.39691469 0 0 0 0.26045,-0.629419 l -0.815972,-1.101225 c 0.03782,-0.117934 0.07258,-0.23716 0.106971,-0.356567 l 1.29191,-0.463021 a 0.39691469,0.39691469 0 0 0 0.132809,-0.668176 l -1.015443,-0.921391 c 0.01386,-0.122749 0.02486,-0.246224 0.03514,-0.370004 l 1.177187,-0.706416 a 0.39691469,0.39691469 0 0 0 0,-0.681096 l -1.177187,-0.706416 c -0.01028,-0.12378 -0.02128,-0.247255 -0.03514,-0.370004 l 1.015443,-0.921391 a 0.39691469,0.39691469 0 0 0 -0.132809,-0.668176 l -1.29191,-0.463021 c -0.03439,-0.119407 -0.06915,-0.238634 -0.106971,-0.356567 l 0.815972,-1.101225 a 0.39691469,0.39691469 0 0 0 -0.26045,-0.629419 L -16.5295,11.179777 c -0.05627,-0.108552 -0.112773,-0.216809 -0.172082,-0.323495 l 0.58756,-1.2443684 a 0.39691469,0.39691469 0 0 0 -0.378272,-0.565857 l -1.379244,0.06718 c -0.0753,-0.09428 -0.151522,-0.187523 -0.229443,-0.279569 l 0.334863,-1.339454 a 0.39691469,0.39691469 0 0 0 -0.481624,-0.481624 l -1.339453,0.334863 c -0.09205,-0.07792 -0.185291,-0.154145 -0.27957,-0.229443 l 0.06718,-1.379244 a 0.39691469,0.39691469 0 0 0 -0.565858,-0.378272 l -1.244368,0.587561 c -0.106686,-0.05931 -0.214943,-0.115817 -0.323495,-0.172082 l -0.202571,-1.361674 a 0.39691469,0.39691469 0 0 0 -0.629419,-0.260449 l -1.101225,0.81597 c -0.117934,-0.03782 -0.23716,-0.07258 -0.356567,-0.10697 l -0.463021,-1.291911 a 0.39691469,0.39691469 0 0 0 -0.668176,-0.132809 l -0.921391,1.015442 c -0.122749,-0.01386 -0.246224,-0.02486 -0.370004,-0.03514 l -0.706416,-1.177189 a 0.39691469,0.39691469 0 0 0 -0.386023,-0.190169 z m 0.04547,2.510957 a 0.79375,0.79375 0 0 1 0.79375,0.79375 0.79375,0.79375 0 0 1 -0.79375,0.79375 0.79375,0.79375 0 0 1 -0.79375,-0.79375 0.79375,0.79375 0 0 1 0.79375,-0.79375 z m -1.874821,1.364258 1.313615,1.313616 a 0.79382937,0.79382937 0 0 0 1.122412,0 l 1.313615,-1.313616 c 3.059306,0.56594 5.632484,2.489834 7.07192,5.1288864 l -0.846977,1.661915 a 0.79382937,0.79382937 0 0 0 0.347266,1.067635 l 1.653129,0.842325 c 0.05493,0.42977 0.0863,0.866979 0.0863,1.312065 0,0.267449 -0.01351,0.531587 -0.03359,0.79375 h -1.024744 a 0.1323049,0.1323049 0 0 0 -0.132292,0.132292 v 0.529166 c 0,0.501606 -0.15366,0.842941 -0.375687,1.068669 -0.222028,0.225729 -0.519483,0.338358 -0.821656,0.353467 -0.302172,0.01511 -0.605633,-0.0696 -0.825789,-0.227377 -0.220156,-0.157778 -0.358118,-0.37896 -0.358118,-0.665592 a 0.1323049,0.1323049 0 0 0 -0.0026,-0.02584 c -0.137613,-0.688068 -0.47783,-1.298555 -0.818554,-1.741496 -0.170362,-0.22147 -0.340845,-0.40108 -0.490409,-0.52865 -0.05455,-0.04652 -0.10331,-0.07805 -0.152446,-0.110587 0.877372,-0.518194 1.464247,-1.139701 1.739429,-1.809709 0.298613,-0.727059 0.272181,-1.491622 0.01395,-2.180229 -0.516427,-1.377211 -1.950367,-2.46703 -3.596661,-2.46703 h -10.829306 c 1.460694,-1.5970444 3.426089,-2.7227774 5.647198,-3.1336604 z m -8.167975,5.9489914 a 0.79375,0.79375 0 0 1 0.222726,0.03876 0.79375,0.79375 0 0 1 0.509529,0.999939 0.79375,0.79375 0 0 1 -0.999939,0.509529 0.79375,0.79375 0 0 1 -0.509529,-0.999939 0.79375,0.79375 0 0 1 0.777213,-0.548287 z m 20.085594,0 a 0.79375,0.79375 0 0 1 0.777213,0.548287 0.79375,0.79375 0 0 1 -0.509529,0.999939 0.79375,0.79375 0 0 1 -0.999939,-0.509529 0.79375,0.79375 0 0 1 0.509529,-0.999939 0.79375,0.79375 0 0 1 0.222726,-0.03876 z m -18.38854,0.359668 h 1.73116 v 6.614584 h -3.150194 c -0.272994,-0.921912 -0.42168,-1.898081 -0.42168,-2.910417 0,-0.445086 0.03137,-0.882295 0.0863,-1.312065 l 1.653129,-0.842325 a 0.79382937,0.79382937 0 0 0 0.347265,-1.067635 z m 6.229075,0 h 3.307292 c 0.507118,0 0.874682,0.127104 1.111043,0.304375 0.236361,0.17727 0.344165,0.401181 0.344165,0.621667 0,0.220486 -0.107804,0.444397 -0.344165,0.621667 -0.236361,0.177271 -0.603925,0.304375 -1.111043,0.304375 h -3.307292 z m 0,4.7625 h 2.513542 c 0.693528,0 1.085448,0.252991 1.363224,0.654224 0.277777,0.401232 0.426433,0.965001 0.558106,1.557528 0.131672,0.592526 0.246868,1.211574 0.488859,1.730127 0.241991,0.518552 0.627946,0.940528 1.265039,1.082104 a 0.1323049,0.1323049 0 0 0 0.02894,0.0031 h 4.076753 c -0.238422,0.320363 -0.496773,0.624508 -0.770495,0.914156 l -1.840198,-0.291455 a 0.79382937,0.79382937 0 0 0 -0.907955,0.659391 l -0.291972,1.841748 c -1.322628,0.626124 -2.802506,0.977201 -4.367175,0.977201 -1.564669,0 -3.044546,-0.351077 -4.367174,-0.977201 l -0.291973,-1.841747 a 0.79382937,0.79382937 0 0 0 -0.907955,-0.659391 l -1.840198,0.291455 c -0.27372,-0.289648 -0.532072,-0.593793 -0.770494,-0.914156 h 8.310085 a 0.1323049,0.1323049 0 0 0 0.132291,-0.132292 v -2.910417 a 0.1323049,0.1323049 0 0 0 -0.132291,-0.132291 h -2.248959 z m -4.058665,6.711218 a 0.79375,0.79375 0 0 1 0.421162,0.150379 0.79375,0.79375 0 0 1 0.1757,1.108976 0.79375,0.79375 0 0 1 -1.108976,0.175183 0.79375,0.79375 0 0 1 -0.175183,-1.108459 0.79375,0.79375 0 0 1 0.687297,-0.326079 z m 12.350666,0 a 0.79375,0.79375 0 0 1 0.687296,0.326079 0.79375,0.79375 0 0 1 -0.175183,1.108459 0.79375,0.79375 0 0 1 -1.108976,-0.175183 0.79375,0.79375 0 0 1 0.1757,-1.108976 0.79375,0.79375 0 0 1 0.421163,-0.150379 z'); // viewBox 0 0 27.7818 27.7816, group translate(41.583546 -3.0484439)
const GIT_ICON_D = ('M5,58c-2.76142,0 -5,-2.23858 -5,-5v-48c0,-2.76142 2.23858,-5 5,-5h33v12.54404c-2.06553,0.94801 -3.5,3.03446 -3.5,5.45596c0,0.73514 0.13221,1.43941 0.37415,2.09031l-15.28384,15.28384c-0.6509,-0.24194 -1.35517,-0.37415 -2.09031,-0.37415c-3.31371,0 -6,2.68629 -6,6c0,3.31371 2.68629,6 6,6c3.31371,0 6,-2.68629 6,-6c0,-0.73514 -0.13221,-1.43941 -0.37415,-2.09031l14.87415,-14.87415l0,11.50851c-2.06553,0.94801 -3.5,3.03446 -3.5,5.45596c0,3.31371 2.68629,6 6,6c3.31371,0 6,-2.68629 6,-6c0,-2.42149 -1.43447,-4.50795 -3.5,-5.45596l0,-12.08808c2.06553,-0.94801 3.5,-3.03446 3.5,-5.45596c0,-2.42149 -1.43447,-4.50795 -3.5,-5.45596l0,-12.54404h10c2.76142,0 5,2.23858 5,5v48c0,2.76142 -2.23858,5 -5,5z'); // viewBox 0 0 78 78, fill #f03c2e
const MCP_D: string[] = ['M25 97.8528L92.8823 29.9706C102.255 20.598 117.451 20.598 126.823 29.9706V29.9706C136.196 39.3431 136.196 54.5391 126.823 63.9117L75.5581 115.177', 'M76.2653 114.47L126.823 63.9117C136.196 54.5391 151.392 54.5391 160.765 63.9117L161.118 64.2652C170.491 73.6378 170.491 88.8338 161.118 98.2063L99.7248 159.6C96.6006 162.724 96.6006 167.789 99.7248 170.913L112.331 183.52', 'M109.853 46.9411L59.6482 97.1457C50.2757 106.518 50.2757 121.714 59.6482 131.087V131.087C69.0208 140.459 84.2168 140.459 93.5894 131.087L143.794 80.8822']; // viewBox 0 0 1338 195, stroke 12, round caps

let cache: { nix: Path2D; rust: Path2D; git: Path2D; mcp: Path2D[] } | undefined;
/** Path2D objects are built lazily so importing this module is safe during SSR. */
const paths = () => (cache ??= { nix: new Path2D(NIX_ARM_D), rust: new Path2D(RUST_GEAR_D), git: new Path2D(GIT_ICON_D), mcp: MCP_D.map((d) => new Path2D(d)) });

/** The Rust gear logo: exact path from rust-artwork (CC BY), filled with the scheme ink. */
function gear(c: Ctx, p: Pal, scale = 1) {
	c.save();
	c.scale((scale * 1.94) / 27.7818, (scale * 1.94) / 27.7818);
	c.translate(-13.89, -13.89);
	c.translate(41.583546, -3.0484439);
	c.fillStyle = p.ink;
	c.fill(paths().rust);
	c.restore();
}

// ---------------------------------------------------------------------------

/** Nix snowflake: the official six-arm logo (CC BY 4.0), exact path and gradients. */
function nixFlake(c: Ctx, _p: Pal) {
	const arm = paths().nix;
	const k = 2.0 / 501.5625;
	c.save();
	c.scale(k, k);
	c.translate(-250.78, -250.78);
	c.translate(-156.41121, 933.30685);
	c.transform(0.99994059, 0, 0, 0.99994059, -0.06321798, 33.188377);
	const grad = (x1: number, y1: number, x2: number, y2: number, stops: [number, string][]) => {
		const g = c.createLinearGradient(x1, y1, x2, y2);
		for (const [o, col] of stops) g.addColorStop(o, col);
		return g;
	};
	const light = grad(200.59668 + 70.650339, 351.41116 - 1055.1511, 290.08701 + 70.650339, 506.18814 - 1055.1511, [[0, '#699ad7'], [0.24345198, '#7eb1dd'], [1, '#7ebae4']]);
	const dark = grad(-584.19934 + 864.69589, 782.33563 - 1491.3405, -496.29703 + 864.69589, 937.71399 - 1491.3405, [[0, '#415e9a'], [0.23168644, '#4a6baf'], [1, '#5277c3']]);
	const use = (angle: number, cx: number, cy: number, fill: CanvasGradient) => {
		c.save();
		c.translate(cx, cy);
		c.rotate((angle * Math.PI) / 180);
		c.translate(-cx, -cy);
		c.fillStyle = fill;
		c.fill(arm, 'evenodd');
		c.restore();
	};
	use(0, 407.11155, -715.78724, light);
	use(60, 407.11155, -715.78724, light);
	use(-60, 407.31177, -715.70016, light);
	use(180, 407.41868, -715.7565, light);
	use(0, 407.11155, -715.78724, dark);
	use(120, 407.33916, -716.08356, dark);
	use(-120, 407.28823, -715.86995, dark);
	c.restore();
}

/** Isometric block with a grass-style top, plus a swarm of tiny blocks. */
function isoCube(c: Ctx, cx: number, cy: number, s: number, top: string, left: string, right: string, edge: string, grid: boolean) {
	const dx = s * 0.866;
	const dy = s * 0.5;
	const T: Pt[] = [[cx, cy - s], [cx + dx, cy - dy], [cx, cy], [cx - dx, cy - dy]];
	const L: Pt[] = [[cx - dx, cy - dy], [cx, cy], [cx, cy + s], [cx - dx, cy + dy]];
	const R: Pt[] = [[cx, cy], [cx + dx, cy - dy], [cx + dx, cy + dy], [cx, cy + s]];
	poly(c, L, left);
	poly(c, R, right);
	poly(c, T, top);
	if (grid) {
		const q = 4;
		c.strokeStyle = 'rgba(0,0,0,0.22)';
		c.lineWidth = Math.max(0.012, s * 0.012);
		const face = (o: Pt, u: Pt, v: Pt) => {
			for (let i = 1; i < q; i++) {
				const f = i / q;
				line(c, [[o[0] + u[0] * f, o[1] + u[1] * f], [o[0] + u[0] * f + v[0], o[1] + u[1] * f + v[1]]], 'rgba(0,0,0,0.22)', c.lineWidth);
				line(c, [[o[0] + v[0] * f, o[1] + v[1] * f], [o[0] + v[0] * f + u[0], o[1] + v[1] * f + u[1]]], 'rgba(0,0,0,0.22)', c.lineWidth);
			}
		};
		face(T[3], [dx, -dy], [dx, dy]);
		face(L[0], [dx, dy], [0, s]);
		face(R[0], [dx, -dy], [0, s]);
	}
	poly(c, T, undefined, edge, Math.max(0.02, s * 0.03));
	line(c, [[cx - dx, cy - dy], [cx - dx, cy + dy], [cx, cy + s], [cx + dx, cy + dy], [cx + dx, cy - dy]], edge, Math.max(0.02, s * 0.03));
	line(c, [[cx, cy], [cx, cy + s]], edge, Math.max(0.02, s * 0.03));
}

function minecraftBlock(c: Ctx, p: Pal) {
	// swarm: a field of tiny blocks (100,000 players)
	const pts: Pt[] = [[-1.1, -0.55], [-0.95, -0.8], [1.0, -0.74], [1.15, -0.4], [-1.15, 0.4], [1.12, 0.5], [-0.95, 0.75], [0.95, 0.8], [0.0, -0.98]];
	for (const [x, y] of pts) isoCube(c, x, y, 0.1, p.accent, p.mute, p.ink, p.ink, false);
	isoCube(c, 0, -0.1, 0.8, p.accent, '#6b4a2b', '#533821', p.ink, true);
	// grass overhang on the side faces
	c.save();
	c.fillStyle = p.accent;
	const s = 0.8;
	const dx = s * 0.866;
	const dy = s * 0.5;
	const cy = -0.1;
	poly(c, [[-dx, cy - dy], [0, cy], [0, cy + 0.2], [-dx * 0.5, cy + 0.08], [-dx, cy - dy + 0.24]], p.accent);
	poly(c, [[0, cy], [dx, cy - dy], [dx, cy - dy + 0.24], [dx * 0.55, cy + 0.02], [0, cy + 0.2]], p.accent);
	c.restore();
	c.strokeStyle = p.ink;
	c.lineWidth = 0.02;
}

function parkour(c: Ctx, p: Pal) {
	const sq = (x: number, y: number, s: number, f: string) => {
		rrect(c, x, y, s, s, 0.03);
		c.fillStyle = f;
		c.fill();
		c.strokeStyle = p.ink;
		c.lineWidth = 0.035;
		c.stroke();
		c.strokeStyle = 'rgba(0,0,0,0.25)';
		c.lineWidth = 0.014;
		for (let i = 1; i < 3; i++) {
			line(c, [[x + (s * i) / 3, y], [x + (s * i) / 3, y + s]], 'rgba(0,0,0,0.25)', 0.014);
			line(c, [[x, y + (s * i) / 3], [x + s, y + (s * i) / 3]], 'rgba(0,0,0,0.25)', 0.014);
		}
	};
	const bs = 0.42;
	const blocks: Pt[] = [[-0.98, 0.1], [-0.2, -0.22], [0.58, -0.54]];
	// a stack under each platform
	for (const [x, y] of blocks) {
		sq(x, y, bs, p.mute);
		sq(x, y + bs, bs, p.mute);
		sq(x, y + bs * 2, bs, p.mute);
	}
	for (const [x, y] of blocks) {
		rrect(c, x, y, bs, 0.1, 0.03);
		c.fillStyle = p.accent;
		c.fill();
		c.strokeStyle = p.ink;
		c.lineWidth = 0.035;
		c.stroke();
	}
	// jump arcs with A* style nodes
	for (let k = 0; k < 2; k++) {
		const a = blocks[k];
		const b = blocks[k + 1];
		const x0 = a[0] + bs * 0.8;
		const y0 = a[1] - 0.04;
		const x1 = b[0] + bs * 0.2;
		const y1 = b[1] - 0.04;
		c.beginPath();
		c.moveTo(x0, y0);
		c.quadraticCurveTo((x0 + x1) / 2, Math.min(y0, y1) - 0.5, x1, y1);
		c.strokeStyle = p.ink;
		c.lineWidth = 0.05;
		c.setLineDash([0.1, 0.09]);
		c.lineCap = 'round';
		c.stroke();
		c.setLineDash([]);
		for (const t of [0, 0.5, 1]) {
			const mt = 1 - t;
			const qx = mt * mt * x0 + 2 * mt * t * ((x0 + x1) / 2) + t * t * x1;
			const qy = mt * mt * y0 + 2 * mt * t * (Math.min(y0, y1) - 0.5) + t * t * y1;
			c.beginPath();
			c.arc(qx, qy, 0.06, 0, Math.PI * 2);
			c.fillStyle = t === 0.5 ? p.accent : p.ink;
			c.fill();
		}
	}
	// goal flag
	line(c, [[0.98, -0.54], [0.98, -0.98]], p.ink, 0.04);
	poly(c, [[0.98, -0.98], [1.0 + 0.0, -0.98], [1.0, -0.98]], p.accent);
	poly(c, [[0.98, -0.98], [0.98, -0.8], [0.78, -0.89]], p.accent, p.ink, 0.025);
}

function resultFork(c: Ctx, p: Pal) {
	// `?` operator badge
	c.save();
	c.translate(0.72, 0.62);
	c.beginPath();
	c.arc(0, 0, 0.34, 0, Math.PI * 2);
	c.fillStyle = p.accent;
	c.fill();
	c.strokeStyle = p.bg;
	c.lineWidth = 0.05;
	c.stroke();
	text(c, '?', 0, 0.17, 0.5, '#fff', '800', 'Newsreader, Georgia, serif');
	c.restore();
}
function fieldTag(c: Ctx, p: Pal) {
	c.save();
	c.translate(0.62, 0.64);
	rrect(c, -0.5, -0.24, 1.0, 0.48, 0.12);
	c.fillStyle = p.accent;
	c.fill();
	c.strokeStyle = p.bg;
	c.lineWidth = 0.05;
	c.stroke();
	text(c, 'x: 1', 0, 0.09, 0.28, '#fff', '700');
	c.restore();
}

function chipAI(c: Ctx, p: Pal) {
	c.strokeStyle = p.ink;
	c.lineCap = 'round';
	for (let i = 0; i < 4; i++) {
		const o = -0.45 + i * 0.3;
		line(c, [[o, -0.9], [o, -0.58]], p.ink, 0.075);
		line(c, [[o, 0.58], [o, 0.9]], p.ink, 0.075);
		line(c, [[-0.9, o], [-0.58, o]], p.ink, 0.075);
		line(c, [[0.58, o], [0.9, o]], p.ink, 0.075);
	}
	rrect(c, -0.6, -0.6, 1.2, 1.2, 0.12);
	c.fillStyle = p.ink;
	c.fill();
	rrect(c, -0.47, -0.47, 0.94, 0.94, 0.07);
	c.strokeStyle = p.bg;
	c.lineWidth = 0.03;
	c.stroke();
	// four-point spark
	c.beginPath();
	const R = 0.36;
	const r = 0.09;
	for (let k = 0; k < 8; k++) {
		const a = (k * Math.PI) / 4 - Math.PI / 2;
		const rad = k % 2 ? r : R;
		c.lineTo(Math.cos(a) * rad, Math.sin(a) * rad);
	}
	c.closePath();
	c.fillStyle = p.accent;
	c.fill();
	// wrapper dots (thin one-to-one wrappers)
	for (const [x, y] of [[-0.37, -0.37], [0.37, 0.37]] as Pt[]) {
		c.beginPath();
		c.arc(x, y, 0.045, 0, Math.PI * 2);
		c.fillStyle = p.bg;
		c.fill();
	}
}

function terminal(c: Ctx, p: Pal) {
	rrect(c, -0.98, -0.72, 1.96, 1.44, 0.14);
	c.fillStyle = p.ink;
	c.fill();
	line(c, [[-0.98, -0.44], [0.98, -0.44]], p.mute, 0.03);
	for (let i = 0; i < 3; i++) {
		c.beginPath();
		c.arc(-0.8 + i * 0.16, -0.58, 0.05, 0, Math.PI * 2);
		c.fillStyle = i === 0 ? p.accent : p.mute;
		c.fill();
	}
	// prompt chevron, `nu`, cursor
	line(c, [[-0.78, -0.16], [-0.58, 0.02], [-0.78, 0.2]], p.accent, 0.1);
	text(c, 'gdb', -0.26, 0.2, 0.46, p.bg, '700');
	rrect(c, 0.3, -0.17, 0.26, 0.4, 0.03);
	c.fillStyle = p.accent;
	c.fill();
	// pipe bar
	line(c, [[-0.78, 0.5], [0.0, 0.5]], p.mute, 0.07);
	text(c, '|', 0.12, 0.6, 0.34, p.accent, '700');
	line(c, [[0.28, 0.5], [0.76, 0.5]], p.mute, 0.07);
}

function braces(c: Ctx, p: Pal) {
	const brace = (dir: number) => {
		c.save();
		c.scale(dir, 1);
		c.beginPath();
		c.moveTo(-0.3, -0.9);
		c.bezierCurveTo(-0.62, -0.9, -0.62, -0.8, -0.62, -0.5);
		c.lineTo(-0.62, -0.2);
		c.bezierCurveTo(-0.62, -0.08, -0.74, 0, -0.9, 0);
		c.bezierCurveTo(-0.74, 0, -0.62, 0.08, -0.62, 0.2);
		c.lineTo(-0.62, 0.5);
		c.bezierCurveTo(-0.62, 0.8, -0.62, 0.9, -0.3, 0.9);
		c.strokeStyle = p.ink;
		c.lineWidth = 0.14;
		c.lineCap = 'round';
		c.lineJoin = 'round';
		c.stroke();
		c.restore();
	};
	brace(1);
	brace(-1);
	// backslash escape, struck out
	line(c, [[-0.2, -0.34], [0.2, 0.34]], p.ink, 0.12);
	c.beginPath();
	c.arc(0, 0, 0.46, 0, Math.PI * 2);
	c.strokeStyle = p.accent;
	c.lineWidth = 0.09;
	c.stroke();
	line(c, [[-0.33, 0.33], [0.33, -0.33]], p.accent, 0.09);
}

function plugSocket(c: Ctx, p: Pal) {
	// the MCP mark: three exact stroke paths from the protocol's logo (viewBox 0 0 1338 195)
	c.save();
	c.scale(2 / 165, 2 / 165);
	c.translate(-98, -104);
	c.lineWidth = 12;
	c.lineCap = 'round';
	paths().mcp.forEach((d, i) => {
		c.strokeStyle = i === 1 ? p.accent : p.ink;
		c.stroke(d);
	});
	c.restore();
}

function gitDiamond(c: Ctx, p: Pal) {
	// official Git icon (CC BY 3.0, Jason Long), exact path, tinted with the accent
	c.save();
	c.translate(0, -0.12);
	c.scale(1.5 / 78, 1.5 / 78);
	c.translate(-39, -39);
	c.translate(10, 10);
	c.translate(29, 29);
	c.rotate(-Math.PI / 4);
	c.translate(-29, -29);
	c.fillStyle = p.accent;
	c.fill(paths().git);
	c.restore();
	text(c, '9f3a1c2', 0, 0.95, 0.28, p.ink, '700');
}

function idBadge(c: Ctx, p: Pal) {
	rrect(c, -0.55, -0.9, 1.1, 1.8, 0.14);
	c.fillStyle = p.ink;
	c.fill();
	rrect(c, -0.16, -0.8, 0.32, 0.07, 0.035);
	c.fillStyle = p.bg;
	c.fill();
	c.beginPath();
	c.arc(0, -0.3, 0.2, 0, Math.PI * 2);
	c.fillStyle = p.accent;
	c.fill();
	c.beginPath();
	c.ellipse(0, 0.14, 0.34, 0.2, 0, Math.PI, 0);
	c.fill();
	text(c, 'swift-', 0, 0.54, 0.2, p.bg, '700');
	text(c, 'otter-42', 0, 0.78, 0.2, p.bg, '700');
}

export const EMBLEMS: Record<string, (c: Ctx, p: Pal) => void> = {
	ifd: nixFlake,
	hyperion: minecraftBlock,
	'mcp-not-enough': plugSocket,
	'notes-on-errors': (c, p) => {
		gear(c, p, 0.88);
		resultFork(c, p);
	},
	'rust-named-parameters': (c, p) => {
		gear(c, p, 0.88);
		fieldTag(c, p);
	},
	'gpt4-hals-and-rest-libs': chipAI,
	'optimal-parkour': parkour,
	'nushell-tui': terminal,
	snuon: braces,
	commit: gitDiamond,
	'initial-thought': idBadge
};

/** Generic fallback: an accent seal, for slugs without an emblem yet. */
function seal(c: Ctx, p: Pal) {
	c.beginPath();
	c.arc(0, 0, 0.8, 0, Math.PI * 2);
	c.fillStyle = p.accent;
	c.fill();
}

/** Long essays are magazines, short notes pamphlets. */
const PAMPHLETS = new Set(['optimal-parkour', 'nushell-tui', 'snuon', 'commit', 'initial-thought']);

// ---------------------------------------------------------------------------
// Cover layout

export interface CoverScheme {
	paper: string;
	ink: string;
	mute: string;
}
export const COVER_LIGHT: CoverScheme = { paper: '#f1ead9', ink: '#1d1a16', mute: '#6b6252' };
export const COVER_DARK: CoverScheme = { paper: '#d8cdb6', ink: '#171410', mute: '#5a5242' };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortDate(iso: string) {
	const d = new Date(iso);
	return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
const roman = (n: number) => {
	const t: [number, string][] = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
	let s = '';
	for (const [v, r] of t) while (n >= v) ((s += r), (n -= v));
	return s;
};

function hexRgb(h: string): [number, number, number] {
	const n = parseInt(h.replace('#', '').slice(0, 6), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mix(a: string, b: string, t: number) {
	const A = hexRgb(a);
	const B = hexRgb(b);
	const m = A.map((v, i) => Math.round(v + (B[i] - v) * t));
	return `rgb(${m[0]},${m[1]},${m[2]})`;
}

function wrap(c: Ctx, s: string, maxW: number, maxLines: number): { lines: string[]; cut: boolean } {
	const words = s.replace(/`/g, '').split(/\s+/);
	const lines: string[] = [];
	let cur = '';
	for (const w of words) {
		const next = cur ? `${cur} ${w}` : w;
		if (c.measureText(next).width > maxW && cur) {
			lines.push(cur);
			cur = w;
		} else cur = next;
	}
	if (cur) lines.push(cur);
	if (lines.length <= maxLines) return { lines, cut: false };
	const out = lines.slice(0, maxLines);
	let last = out[maxLines - 1];
	while (last.length > 1 && c.measureText(`${last}...`).width > maxW) last = last.slice(0, -1);
	out[maxLines - 1] = `${last}...`;
	return { lines: out, cut: true };
}

function fitTitle(c: Ctx, title: string, maxW: number, sizes: number[], maxLines: number) {
	for (const sz of sizes) {
		c.font = `800 ${sz}px Newsreader, Georgia, serif`;
		const r = wrap(c, title, maxW, 99);
		if (r.lines.length <= maxLines) return { size: sz, lines: r.lines };
	}
	const sz = sizes[sizes.length - 1];
	c.font = `800 ${sz}px Newsreader, Georgia, serif`;
	return { size: sz, lines: wrap(c, title, maxW, maxLines).lines };
}

function stamp(c: Ctx, x: number, y: number, label: string, col: string) {
	c.save();
	c.translate(x, y);
	c.rotate(-0.12);
	c.font = '500 9px "Fira Code", monospace';
	const w = c.measureText(label).width + 12;
	rrect(c, -w, -9, w, 15, 3);
	c.strokeStyle = col;
	c.lineWidth = 1.3;
	c.stroke();
	c.fillStyle = col;
	c.textAlign = 'right';
	c.fillText(label, -6, 2);
	c.restore();
}

export interface CoverThought {
	slug: string;
	title: string;
	dek: string;
	date: string;
	archived: boolean;
	no: number;
}

/** Paints one cover into the 256x340 tile at (x, y). */
export function drawCover(c: Ctx, t: CoverThought, accent: string, rect: { x: number; y: number; w: number; h: number }, dark: boolean) {
	const s = dark ? COVER_DARK : COVER_LIGHT;
	const { w, h } = rect;
	const pam = PAMPHLETS.has(t.slug);
	const emblem = EMBLEMS[t.slug] ?? seal;
	c.save();
	c.translate(rect.x, rect.y);
	c.beginPath();
	c.rect(0, 0, w, h);
	c.clip();
	c.textBaseline = 'alphabetic';

	if (!pam) {
		// ---- magazine: masthead, big emblem panel, title, dek, footer
		c.fillStyle = s.paper;
		c.fillRect(0, 0, w, h);
		c.fillStyle = accent;
		c.fillRect(0, 0, w, 34);
		c.fillStyle = '#fff';
		c.textAlign = 'left';
		c.font = '800 italic 20px Newsreader, Georgia, serif';
		c.fillText('Thoughts', 14, 24);
		c.textAlign = 'right';
		c.font = '500 11px "Fira Code", monospace';
		c.fillText(`No. ${String(t.no).padStart(2, '0')}`, w - 14, 22);
		// panel
		const panel = mix(accent, s.paper, 0.86);
		const px = 12;
		const py = 44;
		const pw = w - 24;
		const ph = 124;
		c.fillStyle = panel;
		c.fillRect(px, py, pw, ph);
		c.strokeStyle = s.ink;
		c.lineWidth = 1.5;
		c.strokeRect(px, py, pw, ph);
		c.save();
		c.translate(px + pw / 2, py + ph / 2);
		c.scale(ph * 0.47, ph * 0.47);
		emblem(c, { ink: s.ink, accent, bg: panel, mute: mix(s.ink, panel, 0.55) });
		c.restore();
		// title
		c.fillStyle = s.ink;
		c.textAlign = 'left';
		const ft = fitTitle(c, t.title, w - 28, [26, 24, 22, 20], 3);
		c.font = `800 ${ft.size}px Newsreader, Georgia, serif`;
		let y = 191;
		for (const l of ft.lines) {
			c.fillText(l, 14, y);
			y += ft.size * 1.07;
		}
		// dek
		c.fillStyle = s.mute;
		c.font = 'italic 500 12.5px Newsreader, Georgia, serif';
		y += 3;
		const room = Math.max(1, Math.min(4, Math.floor((h - 32 - y) / 14.5)));
		for (const l of wrap(c, t.dek, w - 28, room).lines) {
			c.fillText(l, 14, y);
			y += 14.5;
		}
		// footer
		c.fillStyle = s.ink;
		c.fillRect(14, h - 28, w - 28, 1.5);
		c.fillStyle = s.mute;
		c.font = '500 10px "Fira Code", monospace';
		c.textAlign = 'left';
		c.fillText(shortDate(t.date).toUpperCase(), 14, h - 11);
		stamp(c, w - 12, h - 12, t.archived ? 'ARCHIVE' : `ED. ${roman(1)}`, accent);
	} else {
		// ---- pamphlet: tinted stock, spine strip, emblem in a ring, tighter type
		const stock = mix(accent, s.paper, 0.8);
		c.fillStyle = stock;
		c.fillRect(0, 0, w, h);
		// spine
		c.fillStyle = accent;
		c.fillRect(0, 0, 30, h);
		c.save();
		c.translate(21, h - 14);
		c.rotate(-Math.PI / 2);
		c.fillStyle = '#fff';
		c.font = '500 11px "Fira Code", monospace';
		c.textAlign = 'left';
		c.fillText(`PAMPHLET  No. ${String(t.no).padStart(2, '0')}`, 0, 0);
		c.restore();
		c.fillStyle = 'rgba(255,255,255,0.85)';
		c.font = '800 italic 19px Newsreader, Georgia, serif';
		c.textAlign = 'center';
		c.fillText(String(t.no), 15, 24);
		// frame
		c.strokeStyle = s.ink;
		c.lineWidth = 1.5;
		c.strokeRect(40, 12, w - 52, h - 24);
		// emblem circle
		const cx = 40 + (w - 52) / 2;
		const cy = 104;
		const R = 70;
		c.beginPath();
		c.arc(cx, cy, R, 0, Math.PI * 2);
		const ring = mix(accent, s.paper, 0.93);
		c.fillStyle = ring;
		c.fill();
		c.lineWidth = 3;
		c.strokeStyle = s.ink;
		c.stroke();
		c.save();
		c.translate(cx, cy);
		c.scale(R * 0.66, R * 0.66);
		emblem(c, { ink: s.ink, accent, bg: ring, mute: mix(s.ink, ring, 0.55) });
		c.restore();
		// title
		c.fillStyle = s.ink;
		c.textAlign = 'left';
		const ft = fitTitle(c, t.title, w - 76, [25, 23, 21, 19], 3);
		c.font = `800 ${ft.size}px Newsreader, Georgia, serif`;
		let y = 200;
		for (const l of ft.lines) {
			c.fillText(l, 50, y);
			y += ft.size * 1.07;
		}
		c.fillStyle = s.mute;
		c.font = 'italic 500 12px Newsreader, Georgia, serif';
		y += 2;
		const room = Math.max(1, Math.min(4, Math.floor((h - 44 - y) / 14)));
		for (const l of wrap(c, t.dek, w - 76, room).lines) {
			c.fillText(l, 50, y);
			y += 14;
		}
		c.font = '500 10px "Fira Code", monospace';
		c.fillText(shortDate(t.date).toUpperCase(), 50, h - 20);
		stamp(c, w - 20, h - 20, t.archived ? 'ARCHIVE' : 'NEW', accent);
	}
	c.restore();
}

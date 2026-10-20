// palettes.js — waterfall colour maps. Each is a list of RGB stops, t = 0..1.
// SPDX-License-Identifier: GPL-2.0-only
//
// t = 0 is the weakest reflection shown (deep null, good match); t = 1 is 0 dB.
// Viridis / Inferno are perceptually uniform (matplotlib). Turbo is Google's
// improved rainbow — not uniform, included because people expect a rainbow.
// Classic SDR is the black→blue→cyan→yellow→red of SDR# and friends.

export const PALETTES = {
  viridis: { name: 'Viridis', stops: [[68,1,84],[72,36,117],[65,68,135],[53,95,141],[42,120,142],[33,145,140],[34,168,132],[68,191,112],[122,209,81],[189,223,38],[253,231,37]] },
  inferno: { name: 'Inferno', stops: [[0,0,4],[27,12,65],[74,12,107],[120,28,109],[165,44,96],[207,68,70],[237,105,37],[251,155,6],[247,209,61],[252,255,164]] },
  turbo:   { name: 'Turbo',   stops: [[48,18,59],[70,107,227],[42,176,234],[25,228,159],[109,252,90],[200,236,52],[253,183,50],[246,109,25],[200,46,6],[122,4,3]] },
  sdr:     { name: 'Classic SDR', stops: [[0,0,0],[0,0,100],[0,0,255],[0,200,255],[255,255,0],[255,80,0],[255,0,0]] },
  grey:    { name: 'Grey',    stops: [[20,20,22],[245,245,245]] },
};
export const DEFAULT_PALETTE = 'viridis';

/** Build a 256-entry lookup of 'rgb(r,g,b)' strings for a palette key. */
export function buildLut(key) {
  const stops = (PALETTES[key] || PALETTES[DEFAULT_PALETTE]).stops;
  const lut = new Array(256);
  for (let i = 0; i < 256; i++) {
    const t = i / 255 * (stops.length - 1), k = Math.min(stops.length - 2, Math.floor(t)), u = t - k;
    const c = stops[k].map((v, j) => Math.round(v + (stops[k + 1][j] - v) * u));
    lut[i] = `rgb(${c[0]},${c[1]},${c[2]})`;
  }
  return lut;
}
/** CSS gradient string for a legend swatch. */
export function cssGradient(key) {
  const stops = (PALETTES[key] || PALETTES[DEFAULT_PALETTE]).stops;
  return `linear-gradient(90deg, ${stops.map(c => `rgb(${c.join(',')})`).join(', ')})`;
}

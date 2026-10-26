// Static SVG charts and drawings for the business-model PDF. Every number comes from the model or the research
// data; nothing here invents values. Single-series marks in brand navy, values always labeled (gold fails 3:1).
import { COLORS } from "./theme";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const NEG = "#b42318";
const INK = COLORS.charcoal;
const MUTED = "#6e695f";
const GRID = "#e2d9c8";

/** Horizontal bars, one row per item, value label at the bar end. */
export function barsH(rows: { label: string; value: number; accent?: boolean }[], fmt: (x: number) => string, width = 170): string {
  const W = width * 3.78; // mm → px at 96 dpi
  const labelW = W * 0.42;
  const barW = W - labelW - 70;
  const rowH = 22;
  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1);
  const H = rows.length * rowH + 6;
  const body = rows
    .map((r, i) => {
      const y = i * rowH + 4;
      const w = Math.max((Math.abs(r.value) / max) * barW, 2);
      const fill = r.value < 0 ? NEG : r.accent ? COLORS.gold : COLORS.navy;
      return (
        `<text x="${labelW - 8}" y="${y + 13}" text-anchor="end" font-size="10" fill="${INK}">${esc(r.label)}</text>` +
        `<rect x="${labelW}" y="${y + 3}" width="${w.toFixed(1)}" height="13" rx="2" fill="${fill}"/>` +
        `<text x="${(labelW + w + 6).toFixed(1)}" y="${y + 13}" font-size="10" font-weight="600" fill="${INK}">${esc(fmt(r.value))}</text>`
      );
    })
    .join("");
  return `<svg viewBox="0 0 ${W.toFixed(0)} ${H}" width="100%" xmlns="http://www.w3.org/2000/svg" font-family="Montserrat,sans-serif">${body}</svg>`;
}

/** Vertical bars around a zero baseline (scenario profit). */
export function barsV(rows: { label: string; value: number; sub?: string }[], fmt: (x: number) => string): string {
  const W = 300;
  const H = 190;
  const top = 22;
  const bottom = 40;
  const plotH = H - top - bottom;
  const maxV = Math.max(...rows.map((r) => r.value), 0);
  const minV = Math.min(...rows.map((r) => r.value), 0);
  const span = maxV - minV || 1;
  const y0 = top + (maxV / span) * plotH;
  const slot = W / rows.length;
  const bw = Math.min(46, slot * 0.5);
  const body = rows
    .map((r, i) => {
      const cx = slot * i + slot / 2;
      const h = (Math.abs(r.value) / span) * plotH;
      const y = r.value >= 0 ? y0 - h : y0;
      const ly = r.value >= 0 ? y - 5 : y + h + 12;
      return (
        `<rect x="${(cx - bw / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(h, 1.5).toFixed(1)}" rx="2" fill="${r.value < 0 ? NEG : COLORS.navy}"/>` +
        `<text x="${cx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" font-size="10" font-weight="700" fill="${INK}">${esc(fmt(r.value))}</text>` +
        `<text x="${cx.toFixed(1)}" y="${H - 22}" text-anchor="middle" font-size="10" font-weight="600" fill="${INK}">${esc(r.label)}</text>` +
        (r.sub ? `<text x="${cx.toFixed(1)}" y="${H - 9}" text-anchor="middle" font-size="8.5" fill="${MUTED}">${esc(r.sub)}</text>` : "")
      );
    })
    .join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" xmlns="http://www.w3.org/2000/svg" font-family="Montserrat,sans-serif"><line x1="0" x2="${W}" y1="${y0.toFixed(1)}" y2="${y0.toFixed(1)}" stroke="${MUTED}" stroke-width="1"/>${body}</svg>`;
}

/** Cumulative cash after the investment: −CAPEX + monthly profit × month, with the payback point marked. */
export function paybackLine(capex: number, monthly: number, fmt: (x: number) => string): string {
  const W = 300;
  const H = 190;
  const L = 46;
  const R = 10;
  const T = 14;
  const B = 28;
  const payback = monthly > 0 ? capex / monthly : null;
  const months = Math.max(12, Math.ceil(((payback ?? 12) * 1.5) / 6) * 6);
  const vals = Array.from({ length: months + 1 }, (_, m) => -capex + monthly * m);
  const maxV = Math.max(...vals, 0);
  const minV = Math.min(...vals, 0);
  const span = maxV - minV || 1;
  const x = (m: number) => L + (m / months) * (W - L - R);
  const y = (v: number) => T + ((maxV - v) / span) * (H - T - B);
  const pts = vals.map((v, m) => `${x(m).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const ticks = Array.from({ length: months / 6 + 1 }, (_, i) => i * 6)
    .map((m) => `<text x="${x(m).toFixed(1)}" y="${H - 12}" text-anchor="middle" font-size="8.5" fill="${MUTED}">${m}</text>`)
    .join("");
  const mark =
    payback !== null && payback <= months
      ? `<circle cx="${x(payback).toFixed(1)}" cy="${y(0).toFixed(1)}" r="4.5" fill="${COLORS.gold}" stroke="#fff" stroke-width="2"/>` +
        `<text x="${x(payback).toFixed(1)}" y="${(y(0) - 9).toFixed(1)}" text-anchor="middle" font-size="9.5" font-weight="700" fill="${INK}">${esc(payback.toFixed(1))} oy</text>`
      : "";
  return (
    `<svg viewBox="0 0 ${W} ${H}" width="100%" xmlns="http://www.w3.org/2000/svg" font-family="Montserrat,sans-serif">` +
    `<line x1="${L}" x2="${W - R}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" stroke="${MUTED}" stroke-width="1"/>` +
    `<text x="${L - 5}" y="${(y(0) + 3).toFixed(1)}" text-anchor="end" font-size="8.5" fill="${MUTED}">$0</text>` +
    `<text x="${L - 5}" y="${(y(-capex) + 3).toFixed(1)}" text-anchor="end" font-size="8.5" fill="${MUTED}">${esc(fmt(-capex))}</text>` +
    `<line x1="${L}" x2="${W - R}" y1="${y(-capex).toFixed(1)}" y2="${y(-capex).toFixed(1)}" stroke="${GRID}" stroke-width="1"/>` +
    `<polyline points="${pts}" fill="none" stroke="${COLORS.navy}" stroke-width="2"/>${mark}${ticks}` +
    `<text x="${W - R}" y="${H - 1}" text-anchor="end" font-size="8.5" fill="${MUTED}">oy</text></svg>`
  );
}

const mm = (x: number) => `${x.toLocaleString("en-US").replace(/,/g, " ")} mm`;

/** Dimension line with end ticks and a centered label. */
function dim(x1: number, y1: number, x2: number, y2: number, label: string, vertical = false): string {
  const t = 4;
  const ends = vertical
    ? `<line x1="${x1 - t}" x2="${x1 + t}" y1="${y1}" y2="${y1}"/><line x1="${x2 - t}" x2="${x2 + t}" y1="${y2}" y2="${y2}"/>`
    : `<line x1="${x1}" x2="${x1}" y1="${y1 - t}" y2="${y1 + t}"/><line x1="${x2}" x2="${x2}" y1="${y2 - t}" y2="${y2 + t}"/>`;
  const tx = vertical ? x1 + 13 : (x1 + x2) / 2;
  const ty = vertical ? (y1 + y2) / 2 : y1 - 6;
  const text = vertical
    ? `<text x="${tx}" y="${ty}" text-anchor="middle" font-size="10" fill="${INK}" transform="rotate(-90 ${tx} ${ty})">${esc(label)}</text>`
    : `<text x="${tx}" y="${ty}" text-anchor="middle" font-size="10" fill="${INK}">${esc(label)}</text>`;
  return `<g stroke="${MUTED}" stroke-width="1"><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>${ends}</g>${text}`;
}

/** Schematic drawing of the machine: top view with work area, side view with height. Proportional, not a factory drawing. */
export function machineDrawing(d: { length: number; width: number; height: number }, work?: { x: number; y: number }): string {
  const W = 640;
  const H = 260;
  // Top view: the long side horizontal.
  const long = Math.max(d.length, d.width);
  const short = Math.min(d.length, d.width);
  const s = Math.min(380 / long, 170 / short, 170 / d.height);
  const tw = long * s;
  const th = short * s;
  const tx = 40;
  const ty = 50;
  let work_ = "";
  if (work) {
    const wl = Math.max(work.x, work.y) * s;
    const ws = Math.min(work.x, work.y) * s;
    const wx = tx + (tw - wl) / 2;
    const wy = ty + (th - ws) / 2;
    work_ =
      `<rect x="${wx.toFixed(1)}" y="${wy.toFixed(1)}" width="${wl.toFixed(1)}" height="${ws.toFixed(1)}" fill="${COLORS.ivory}" stroke="${COLORS.gold}" stroke-width="1.5" stroke-dasharray="5 3"/>` +
      `<text x="${(wx + wl / 2).toFixed(1)}" y="${(wy + ws / 2 - 4).toFixed(1)}" text-anchor="middle" font-size="10" font-weight="600" fill="${INK}">Ish maydoni</text>` +
      `<text x="${(wx + wl / 2).toFixed(1)}" y="${(wy + ws / 2 + 10).toFixed(1)}" text-anchor="middle" font-size="10" fill="${INK}">${esc(`${Math.min(work.x, work.y)} × ${Math.max(work.x, work.y)} mm`)}</text>`;
  }
  const top =
    `<text x="${tx}" y="${ty - 28}" font-size="10" font-weight="700" fill="${COLORS.navy}" letter-spacing="1">USTIDAN KO'RINISH</text>` +
    `<rect x="${tx}" y="${ty}" width="${tw.toFixed(1)}" height="${th.toFixed(1)}" fill="#fff" stroke="${COLORS.navy}" stroke-width="2" rx="2"/>` +
    work_ +
    dim(tx, ty - 10, tx + tw, ty - 10, mm(long)) +
    dim(tx + tw + 14, ty, tx + tw + 14, ty + th, mm(short), true);
  // Side view: length × height.
  const sx = tx + tw + 70;
  const sw = W - sx - 40;
  const ss = Math.min(sw / long, 170 / d.height);
  const sh = d.height * ss;
  const sl = long * ss;
  const sy = ty + th - sh;
  const side =
    `<text x="${sx}" y="${ty - 28}" font-size="10" font-weight="700" fill="${COLORS.navy}" letter-spacing="1">YON TOMONDAN</text>` +
    `<rect x="${sx}" y="${(sy + sh * 0.45).toFixed(1)}" width="${sl.toFixed(1)}" height="${(sh * 0.55).toFixed(1)}" fill="#fff" stroke="${COLORS.navy}" stroke-width="2" rx="2"/>` +
    `<rect x="${(sx + sl * 0.3).toFixed(1)}" y="${sy.toFixed(1)}" width="${(sl * 0.12).toFixed(1)}" height="${(sh * 0.45).toFixed(1)}" fill="#fff" stroke="${COLORS.navy}" stroke-width="2"/>` +
    `<line x1="${sx - 10}" x2="${sx + sl + 10}" y1="${ty + th}" y2="${ty + th}" stroke="${MUTED}" stroke-width="1"/>` +
    dim(sx + sl + 14, sy, sx + sl + 14, ty + th, mm(d.height), true);
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" xmlns="http://www.w3.org/2000/svg" font-family="Montserrat,sans-serif">${top}${side}</svg>`;
}

export interface LayoutItem {
  name: string;
  length_mm: number;
  width_mm: number;
  kind?: "machine" | "zone";
}

/** Floor plan to scale: items in production-flow order along the hall, arrows between them, 1 m grid. */
export function layoutPlan(hallL: number, hallW: number, items: LayoutItem[]): string {
  const W = 640;
  const s = Math.min((W - 50) / hallL, 230 / hallW); // px per metre
  const hw = hallL * s;
  const hh = hallW * s;
  const ox = 20;
  const oy = 26;
  const grid = [
    ...Array.from({ length: Math.floor(hallL) - 1 }, (_, i) => `<line x1="${(ox + (i + 1) * s).toFixed(1)}" x2="${(ox + (i + 1) * s).toFixed(1)}" y1="${oy}" y2="${(oy + hh).toFixed(1)}"/>`),
    ...Array.from({ length: Math.floor(hallW) - 1 }, (_, i) => `<line x1="${ox}" x2="${(ox + hw).toFixed(1)}" y1="${(oy + (i + 1) * s).toFixed(1)}" y2="${(oy + (i + 1) * s).toFixed(1)}"/>`),
  ].join("");
  const total = items.reduce((a, it) => a + it.length_mm / 1000, 0);
  const gap = Math.max((hallL - total) / (items.length + 1), 0.3);
  let cursor = gap;
  const boxes: { x: number; y: number; w: number; h: number }[] = [];
  const shapes = items
    .map((it, i) => {
      const w = (it.length_mm / 1000) * s;
      const h = (it.width_mm / 1000) * s;
      const x = ox + cursor * s;
      const y = oy + (hh - h) / 2;
      cursor += it.length_mm / 1000 + gap;
      boxes.push({ x, y, w, h });
      const zone = it.kind === "zone";
      const label = `${i + 1}`;
      return (
        `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${zone ? COLORS.ivory : COLORS.navy}" stroke="${zone ? COLORS.gold : COLORS.navy}" stroke-width="1.5"${zone ? ' stroke-dasharray="5 3"' : ""}/>` +
        `<text x="${(x + w / 2).toFixed(1)}" y="${(y + h / 2 + 4).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="700" fill="${zone ? INK : "#fff"}">${label}</text>` +
        `<text x="${(x + w / 2).toFixed(1)}" y="${(y + h + 13).toFixed(1)}" text-anchor="middle" font-size="8.5" fill="${MUTED}">${esc(`${(it.length_mm / 1000).toFixed(1)}×${(it.width_mm / 1000).toFixed(1)} m`)}</text>`
      );
    })
    .join("");
  const arrows = boxes
    .slice(0, -1)
    .map((b, i) => {
      const n = boxes[i + 1]!;
      const y = oy + hh / 2;
      return `<line x1="${(b.x + b.w + 3).toFixed(1)}" x2="${(n.x - 5).toFixed(1)}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${COLORS.gold}" stroke-width="2" marker-end="url(#ar)"/>`;
    })
    .join("");
  const H = oy + hh + 40;
  return (
    `<svg viewBox="0 0 ${W} ${H.toFixed(0)}" width="100%" xmlns="http://www.w3.org/2000/svg" font-family="Montserrat,sans-serif">` +
    `<defs><marker id="ar" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="${COLORS.gold}"/></marker></defs>` +
    `<rect x="${ox}" y="${oy}" width="${hw.toFixed(1)}" height="${hh.toFixed(1)}" fill="#fff"/>` +
    `<g stroke="${GRID}" stroke-width=".6">${grid}</g>` +
    `<rect x="${ox}" y="${oy}" width="${hw.toFixed(1)}" height="${hh.toFixed(1)}" fill="none" stroke="${COLORS.navy}" stroke-width="3"/>` +
    dim(ox, oy - 10, ox + hw, oy - 10, `${hallL} m`) +
    `<text x="${(ox + hw + 12).toFixed(1)}" y="${(oy + hh / 2).toFixed(1)}" font-size="10" fill="${INK}" transform="rotate(90 ${(ox + hw + 12).toFixed(1)} ${(oy + hh / 2).toFixed(1)})" text-anchor="middle">${hallW} m</text>` +
    shapes +
    arrows +
    `<g transform="translate(${ox},${(oy + hh + 28).toFixed(1)})"><rect width="${s.toFixed(1)}" height="4" fill="${COLORS.navy}"/><text x="${(s + 6).toFixed(1)}" y="5" font-size="8.5" fill="${MUTED}">1 m · katakcha 1×1 m</text></g>` +
    `</svg>`
  );
}

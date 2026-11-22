// Two HTML canvases replace tens of thousands of individual Leaflet polylines.
// Roads are rasterised once per map view; only active fluid edges are redrawn.
import { distanceMetres } from "./network.mjs";
import { SOURCE_CONCENTRATION } from "./physics.mjs";
import { fluidLineStyle } from "./map-style.mjs";

function splitShape(shape) {
  if (shape.length === 2) {
    const mid = [(shape[0][0] + shape[1][0]) / 2, (shape[0][1] + shape[1][1]) / 2];
    return [[shape[0], mid], [mid, shape[1]]];
  }
  const distances = [];
  let total = 0;
  for (let i = 1; i < shape.length; i++) {
    const length = distanceMetres(
      { lat: shape[i - 1][0], lng: shape[i - 1][1] },
      { lat: shape[i][0], lng: shape[i][1] }
    );
    distances.push(length);
    total += length;
  }
  let walked = 0;
  for (let i = 1; i < shape.length; i++) {
    const length = distances[i - 1];
    if (walked + length >= total / 2) {
      const fraction = length ? (total / 2 - walked) / length : 0;
      const mid = [
        shape[i - 1][0] + fraction * (shape[i][0] - shape[i - 1][0]),
        shape[i - 1][1] + fraction * (shape[i][1] - shape[i - 1][1])
      ];
      return [[...shape.slice(0, i), mid], [mid, ...shape.slice(i)]];
    }
    walked += length;
  }
  return [shape, shape];
}

function level(c) {
  if (c < 0.002) return 0;
  return Math.min(12, Math.max(1, Math.ceil(12 * Math.sqrt(c / SOURCE_CONCENTRATION))));
}

function drawPath(ctx, coordinates) {
  if (!coordinates || coordinates.length < 4) return;
  ctx.moveTo(coordinates[0], coordinates[1]);
  for (let j = 2; j < coordinates.length; j += 2)
    ctx.lineTo(coordinates[j], coordinates[j + 1]);
}

export function createRoadCanvas(L, map, theme = "dark") {
  const RoadCanvas = L.Layer.extend({
    onAdd(host) {
      this._host = host;
      this._canvases = ["roads", "fluid"].map(name => {
        const el = L.DomUtil.create("canvas", "road-canvas road-canvas-" + name);
        el.style.pointerEvents = "none";
        host.getPanes().overlayPane.appendChild(el);
        return el;
      });
      host.on("moveend zoomend resize", this._rebuild, this);
      this._rebuild();
    },
    onRemove(host) {
      host.off("moveend zoomend resize", this._rebuild, this);
      for (const canvas of this._canvases) canvas.remove();
      this._canvases = [];
    },
    setGraph(graph) {
      this._graph = graph;
      this._halves = graph ? graph.edges.map(edge => splitShape(edge.shape)) : [];
      this._rebuild();
    },
    setTheme(next) {
      this._theme = next;
      this._drawBackground();
      this.render(this._concentration, this._activeEdges);
    },
    _rebuild() {
      if (!this._host || !this._canvases) return;
      const mapSize = this._host.getSize();
      const ratio = Math.min(2, typeof devicePixelRatio === "number" ? devicePixelRatio : 1);
      this._width = mapSize.x;
      this._height = mapSize.y;
      for (const canvas of this._canvases) {
        canvas.width = Math.ceil(mapSize.x * ratio);
        canvas.height = Math.ceil(mapSize.y * ratio);
        canvas.style.width = mapSize.x + "px";
        canvas.style.height = mapSize.y + "px";
        L.DomUtil.setPosition(canvas, this._host.containerPointToLayerPoint([0, 0]));
        canvas.getContext("2d").setTransform(ratio, 0, 0, ratio, 0, 0);
      }
      this._visible = [];
      this._projected = [];
      if (this._graph) {
        const project = shape => {
          const coords = new Float32Array(shape.length * 2);
          for (let i = 0; i < shape.length; i++) {
            const point = this._host.latLngToContainerPoint(shape[i]);
            coords[2 * i] = point.x;
            coords[2 * i + 1] = point.y;
          }
          return coords;
        };
        this._halves.forEach(([left, right], index) => {
          const a = project(left), b = project(right);
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const coords of [a, b]) for (let k = 0; k < coords.length; k += 2) {
            minX = Math.min(minX, coords[k]);
            maxX = Math.max(maxX, coords[k]);
            minY = Math.min(minY, coords[k + 1]);
            maxY = Math.max(maxY, coords[k + 1]);
          }
          const visible = maxX >= -12 && maxY >= -12
            && minX <= this._width + 12 && minY <= this._height + 12;
          this._projected[index] = { left: a, right: b, visible };
          if (visible) this._visible.push(index);
        });
      }
      this._drawBackground();
      this.render(this._concentration, this._activeEdges);
    },
    _drawBackground() {
      if (!this._canvases?.length) return;
      const ctx = this._canvases[0].getContext("2d");
      ctx.clearRect(0, 0, this._width, this._height);
      const style = fluidLineStyle(0, this._theme || "dark");
      ctx.strokeStyle = style.color;
      ctx.lineWidth = style.weight;
      ctx.globalAlpha = style.opacity;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();
      for (const index of this._visible || []) {
        const item = this._projected[index];
        drawPath(ctx, item.left);
        drawPath(ctx, item.right);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    },
    render(concentration, activeEdges) {
      this._concentration = concentration || null;
      this._activeEdges = activeEdges || null;
      if (!this._canvases?.length) return;
      const ctx = this._canvases[1].getContext("2d");
      ctx.clearRect(0, 0, this._width, this._height);
      if (!this._graph || !concentration) return;
      const buckets = Array.from({ length: 13 }, () => []);
      const candidates = activeEdges || this._visible;
      for (const index of candidates) {
        const shape = this._projected[index];
        if (!shape?.visible) continue;
        const edge = this._graph.edges[index];
        const left = level(concentration[edge.a]);
        const right = level(concentration[edge.b]);
        if (left) buckets[left].push(shape.left);
        if (right) buckets[right].push(shape.right);
      }
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      for (let n = 1; n <= 12; n++) {
        if (!buckets[n].length) continue;
        const style = fluidLineStyle(n, this._theme || "dark");
        ctx.lineWidth = style.weight;
        ctx.strokeStyle = style.color;
        ctx.globalAlpha = style.opacity;
        ctx.beginPath();
        for (const shape of buckets[n]) drawPath(ctx, shape);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  });
  const layer = new RoadCanvas();
  layer._theme = theme;
  layer.addTo(map);
  return layer;
}

import * as THREE from 'three';

/** Perspective camera looking straight down -z at the map plane (map = [-1,1]^2). */
export class View {
  camera = new THREE.PerspectiveCamera(28, 1, 0.01, 100);
  cx = 0;
  cy = 0;
  zoom = 1;
  width = 1;
  height = 1;
  enabled = false;
  onChange?: () => void;
  /** Return true to consume a one-finger drag (e.g. to spin the globe). */
  onDrag?: (dx: number, dy: number) => boolean;
  /** Zoom about the screen centre instead of the cursor, and disable panning. */
  lockCenter = false;
  private anim: { from: [number, number, number]; to: [number, number, number]; t: number; dur: number } | null = null;
  private readonly tanHalf = Math.tan(THREE.MathUtils.degToRad(28 / 2));

  resize(w: number, h: number) {
    this.width = w;
    this.height = h;
    this.camera.aspect = w / h;
    this.apply();
  }

  /** Camera distance at zoom 1: fit the square with a margin. */
  private fitDistance(): number {
    const margin = 1.08;
    const halfH = this.height < 720 || this.width < 720 ? margin : margin + 0.06;
    const dH = halfH / this.tanHalf;
    const dW = halfH / (this.tanHalf * this.camera.aspect);
    return Math.max(dH, dW);
  }

  distance(): number {
    return this.fitDistance() / this.zoom;
  }

  /** CSS pixels per map unit on the z = 0 plane. */
  pxPerUnit(): number {
    return this.height / (2 * this.distance() * this.tanHalf);
  }

  apply() {
    this.clamp();
    this.camera.position.set(this.cx, this.cy, this.distance());
    this.camera.lookAt(this.cx, this.cy, 0);
    this.camera.near = this.distance() * 0.05;
    this.camera.far = this.distance() * 10;
    this.camera.updateProjectionMatrix();
    this.onChange?.();
  }

  private clamp() {
    this.zoom = Math.min(40, Math.max(1, this.zoom));
    const lim = Math.max(0, 1 - 0.3 / this.zoom);
    this.cx = Math.min(lim, Math.max(-lim, this.cx));
    this.cy = Math.min(lim, Math.max(-lim, this.cy));
  }

  /** Screen (CSS px, relative to canvas) -> map uv in [0,1]^2 (v up). */
  screenToUv(x: number, y: number): [number, number] {
    const k = this.pxPerUnit();
    const mx = this.cx + (x - this.width / 2) / k;
    const my = this.cy - (y - this.height / 2) / k;
    return [(mx + 1) / 2, (my + 1) / 2];
  }

  zoomAt(x: number, y: number, factor: number) {
    if (this.lockCenter) {
      x = this.width / 2;
      y = this.height / 2;
    }
    const k0 = this.pxPerUnit();
    const mx = this.cx + (x - this.width / 2) / k0;
    const my = this.cy - (y - this.height / 2) / k0;
    this.zoom *= factor;
    this.clamp();
    const k1 = this.pxPerUnit();
    this.cx = mx - (x - this.width / 2) / k1;
    this.cy = my + (y - this.height / 2) / k1;
    this.apply();
  }

  reset() {
    this.anim = null;
    this.cx = this.cy = 0;
    this.zoom = 1;
    this.apply();
  }

  /** Smoothly move to a zoom level / centre (used by the buttons). */
  animateTo(zoom: number, cx = this.cx, cy = this.cy, dur = 0.35) {
    zoom = Math.min(40, Math.max(1, zoom));
    if (dur <= 0) {
      this.anim = null;
      Object.assign(this, { zoom, cx, cy });
      this.apply();
      return;
    }
    this.anim = { from: [this.zoom, this.cx, this.cy], to: [zoom, cx, cy], t: 0, dur };
  }

  /** Target zoom of any running animation (so repeated clicks compound). */
  targetZoom(): number {
    return this.anim ? this.anim.to[0] : this.zoom;
  }

  isHome(): boolean {
    return this.targetZoom() <= 1.0001 && Math.abs(this.cx) < 1e-4 && Math.abs(this.cy) < 1e-4 && !this.anim;
  }

  tick(dt: number) {
    const a = this.anim;
    if (!a) return;
    a.t = Math.min(1, a.t + dt / a.dur);
    const k = 1 - Math.pow(1 - a.t, 3);
    // interpolate zoom geometrically so the motion feels even
    this.zoom = a.from[0] * Math.pow(a.to[0] / a.from[0], k);
    this.cx = a.from[1] + (a.to[1] - a.from[1]) * k;
    this.cy = a.from[2] + (a.to[2] - a.from[2]) * k;
    if (a.t >= 1) this.anim = null;
    this.apply();
  }

  attach(el: HTMLElement) {
    const pts = new Map<number, { x: number; y: number }>();
    let pinch0 = 0;
    const rel = (e: PointerEvent | WheelEvent) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    el.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      this.anim = null;
      el.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, rel(e));
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch0 = Math.hypot(a.x - b.x, a.y - b.y);
      }
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.enabled || !pts.has(e.pointerId)) return;
      const p = rel(e);
      const prev = pts.get(e.pointerId)!;
      if (pts.size === 1) {
        if (this.onDrag?.(p.x - prev.x, p.y - prev.y)) {
          pts.set(e.pointerId, p);
          return;
        }
        const k = this.pxPerUnit();
        this.cx -= (p.x - prev.x) / k;
        this.cy += (p.y - prev.y) / k;
        pts.set(e.pointerId, p);
        this.apply();
      } else if (pts.size === 2) {
        pts.set(e.pointerId, p);
        const [a, b] = [...pts.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch0 > 0) this.zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, dist / pinch0);
        pinch0 = dist;
      }
    });
    const up = (e: PointerEvent) => {
      pts.delete(e.pointerId);
      pinch0 = 0;
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener(
      'wheel',
      (e) => {
        if (!this.enabled) return;
        e.preventDefault();
        this.anim = null;
        const p = rel(e);
        const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        this.zoomAt(p.x, p.y, Math.exp(-dy * 0.0015));
      },
      { passive: false },
    );
    el.addEventListener('dblclick', (e) => {
      if (!this.enabled) return;
      const p = rel(e as unknown as PointerEvent);
      this.zoomAt(p.x, p.y, e.shiftKey ? 0.5 : 2);
    });
  }
}

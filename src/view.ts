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
    this.cx = this.cy = 0;
    this.zoom = 1;
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

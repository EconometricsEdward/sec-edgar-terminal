'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';

type OverlayMode =
  | 'assets'
  | 'liabilities'
  | 'debt'
  | 'cash'
  | 'revenue'
  | 'capex'
  | 'derivatives'
  | 'mentions'
  | 'intensity';

type GlobeLayer = 'exposure' | 'flows' | 'time';

interface GeographicRegion {
  id: string;
  name: string;
  shortName?: string;
  city?: string;
  country?: string;
  lat: number;
  lon: number;
  type?: string;
  intensity: number;
  tone: string;
  metric: number;
  metricLabel: string;
  description: string;
  drivers: string[];
  tickers: string[];
  confidence?: string;
  evidenceCount?: number;
  sourceBasis?: string;
  metricByMode?: Partial<Record<OverlayMode, number>>;
  timeSeries?: Array<{
    label: string;
    period: string;
    note: string;
    metricByMode: Partial<Record<OverlayMode, number>>;
  }>;
  outboundFlows?: Array<{
    targetId: string;
    theme: string;
    weight: number;
    metricMode?: OverlayMode;
  }>;
  overlayValue?: number;
}

const OVERLAY_OPTIONS: Array<{
  id: OverlayMode;
  label: string;
  accent: string;
  accentClass: string;
}> = [
  { id: 'assets', label: 'Assets', accent: '#67e8f9', accentClass: 'border-cyan-400/40 bg-cyan-400/15 text-cyan-200' },
  { id: 'liabilities', label: 'Liabilities', accent: '#c084fc', accentClass: 'border-fuchsia-400/40 bg-fuchsia-400/15 text-fuchsia-200' },
  { id: 'debt', label: 'Debt', accent: '#818cf8', accentClass: 'border-indigo-400/40 bg-indigo-400/15 text-indigo-200' },
  { id: 'cash', label: 'Cash', accent: '#2dd4bf', accentClass: 'border-teal-400/40 bg-teal-400/15 text-teal-200' },
  { id: 'revenue', label: 'Revenue', accent: '#4ade80', accentClass: 'border-emerald-400/40 bg-emerald-400/15 text-emerald-200' },
  { id: 'capex', label: 'Capex', accent: '#38bdf8', accentClass: 'border-sky-400/40 bg-sky-400/15 text-sky-200' },
  { id: 'derivatives', label: 'Derivatives', accent: '#f472b6', accentClass: 'border-pink-400/40 bg-pink-400/15 text-pink-200' },
  { id: 'mentions', label: 'Filing Mentions', accent: '#f59e0b', accentClass: 'border-amber-400/40 bg-amber-400/15 text-amber-200' },
  { id: 'intensity', label: 'Intensity', accent: '#60a5fa', accentClass: 'border-blue-400/40 bg-blue-400/15 text-blue-200' },
];

const LAYER_OPTIONS: Array<{
  id: GlobeLayer;
  label: string;
  description: string;
}> = [
  { id: 'exposure', label: 'Exposure Map', description: '3D beams show magnitude by metric.' },
  { id: 'flows', label: 'Risk Flows', description: 'Arcs show how filing themes connect between hubs.' },
  { id: 'time', label: 'Filing Season Time Machine', description: 'Compare current, prior, and stress overlays.' },
];

const VIEW_PRESETS = [
  { id: 'global', label: 'Global', rotationX: 0.22, rotationY: -0.62, zoom: 6.4 },
  { id: 'us', label: 'U.S.', rotationX: 0.18, rotationY: -0.82, zoom: 4.65 },
  { id: 'europe', label: 'Europe', rotationX: 0.1, rotationY: -2.45, zoom: 4.75 },
  { id: 'asia', label: 'Asia', rotationX: 0.12, rotationY: -3.75, zoom: 4.9 },
  { id: 'pacific', label: 'Pacific', rotationX: -0.08, rotationY: -4.75, zoom: 5.0 },
];

function formatNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US').format(Math.round(value));
}

function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}%`;
}

function formatCompactCurrency(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value === 0) return '—';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000_000) return `$${(value / 1_000_000_000_000).toFixed(1)}T`;
  if (abs >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  return `$${value.toFixed(0)}`;
}

function formatOverlayValue(mode: OverlayMode, value: number): string {
  if (mode === 'mentions') return formatNumber(value);
  if (mode === 'intensity') return `${Math.round(value)}/100`;
  return formatCompactCurrency(value);
}

function latLonToVector3(lat: number, lon: number, radius = 2.06) {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lon + 180) * (Math.PI / 180);

  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta)
  );
}

function makeCloudTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 512;

  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  for (let i = 0; i < 90; i += 1) {
    const x = Math.random() * canvas.width;
    const y = Math.random() * canvas.height;
    const w = 90 + Math.random() * 220;
    const h = 14 + Math.random() * 34;

    const gradient = ctx.createRadialGradient(x, y, 0, x, y, w * 0.48);
    gradient.addColorStop(0, 'rgba(255,255,255,0.18)');
    gradient.addColorStop(0.45, 'rgba(255,255,255,0.08)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((Math.random() - 0.5) * 0.65);
    ctx.scale(1, h / w);
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(0, 0, w * 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

function cssColorWithAlpha(color: string, alpha: number) {
  const trimmed = String(color || '').trim();

  if (trimmed.startsWith('#')) {
    let hex = trimmed.slice(1);

    if (hex.length === 3) {
      hex = hex
        .split('')
        .map((char) => char + char)
        .join('');
    }

    if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);

      if ([r, g, b].every((value) => Number.isFinite(value))) {
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
      }
    }
  }

  return trimmed;
}

function makeGlowSprite(color: string) {
  const canvas = document.createElement('canvas');
  canvas.width = 160;
  canvas.height = 160;

  const ctx = canvas.getContext('2d')!;
  const cx = 80;
  const cy = 80;

  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, 76);
  glow.addColorStop(0, 'rgba(255,255,255,0.98)');
  glow.addColorStop(0.14, cssColorWithAlpha(color, 0.95));
  glow.addColorStop(0.42, cssColorWithAlpha(color, 0.28));
  glow.addColorStop(1, 'rgba(0,0,0,0)');

  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, 76, 0, Math.PI * 2);
  ctx.fill();

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

function getOverlayOption(mode: OverlayMode) {
  return OVERLAY_OPTIONS.find((item) => item.id === mode) || OVERLAY_OPTIONS[0];
}

function getLayerOption(layer: GlobeLayer) {
  return LAYER_OPTIONS.find((item) => item.id === layer) || LAYER_OPTIONS[0];
}

function getModeDescription(mode: OverlayMode) {
  switch (mode) {
    case 'assets':
      return 'Map aggregate assets identified from SEC Company Facts to specific market hubs.';
    case 'liabilities':
      return 'Map liabilities and obligations identified from SEC filings.';
    case 'debt':
      return 'Map debt exposure through the covered SEC filing cohorts.';
    case 'cash':
      return 'Map cash and short-term investment capacity where identifiable.';
    case 'revenue':
      return 'Map operating scale and revenue exposure to market hubs.';
    case 'capex':
      return 'Map capital spending and infrastructure investment exposure.';
    case 'derivatives':
      return 'Map derivative assets, liabilities, notional values, and risk-book signals.';
    case 'mentions':
      return 'Map market-risk discussion density and filing-language intensity.';
    case 'intensity':
    default:
      return 'Map overall filing-derived signal intensity for each hub.';
  }
}

function getFallbackMetric(region: GeographicRegion, mode: OverlayMode) {
  const base = Math.max(1, region.intensity || 1);
  const rawMetric = Math.abs(Number(region.metric) || 0);

  switch (mode) {
    case 'assets':
      return rawMetric > 1_000_000 ? rawMetric : base * 40_000_000_000;
    case 'liabilities':
      return rawMetric > 1_000_000 ? rawMetric * 0.75 : base * 28_000_000_000;
    case 'debt':
      return base * 10_000_000_000;
    case 'cash':
      return base * 4_500_000_000;
    case 'revenue':
      return rawMetric > 1_000_000 ? rawMetric * 0.2 : base * 11_000_000_000;
    case 'capex':
      return base * 1_250_000_000;
    case 'derivatives':
      return base * 18_000_000_000;
    case 'mentions':
      return Math.round(base * 10 + region.drivers.length * 18 + region.tickers.length * 6);
    case 'intensity':
    default:
      return base;
  }
}

function getMetricForRegion(region: GeographicRegion, mode: OverlayMode, timeIndex: number) {
  const timeMetric = region.timeSeries?.[timeIndex]?.metricByMode?.[mode];
  if (timeMetric != null && Number.isFinite(timeMetric)) return Math.abs(timeMetric);

  const direct = region.metricByMode?.[mode];
  if (direct != null && Number.isFinite(direct)) return Math.abs(direct);

  return getFallbackMetric(region, mode);
}

export default function RealEarthGlobe({ regions }: { regions: GeographicRegion[] }) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const pointerRef = useRef({
    down: false,
    x: 0,
    y: 0,
    rotationX: 0.22,
    rotationY: -0.62,
  });

  const [overlayMode, setOverlayMode] = useState<OverlayMode>('assets');
  const [layerMode, setLayerMode] = useState<GlobeLayer>('exposure');
  const [viewPreset, setViewPreset] = useState(VIEW_PRESETS[0]);
  const [timeIndex, setTimeIndex] = useState(2);
  const [selectedId, setSelectedId] = useState(regions[0]?.id || '');
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const overlayOption = getOverlayOption(overlayMode);
  const layerOption = getLayerOption(layerMode);

  const preparedRegions = useMemo(() => {
    return regions.map((region) => ({
      ...region,
      overlayValue: getMetricForRegion(region, overlayMode, timeIndex),
    }));
  }, [regions, overlayMode, timeIndex]);

  const selectedRegion =
    preparedRegions.find((region) => region.id === selectedId) || preparedRegions[0];

  const hoveredRegion =
    preparedRegions.find((region) => region.id === hoveredId) || null;

  const activeRegion = hoveredRegion || selectedRegion;

  const maxOverlayValue = Math.max(
    ...preparedRegions.map((region) => region.overlayValue || 0),
    1
  );

  const minOverlayValue = Math.min(
    ...preparedRegions.map((region) => region.overlayValue || 0)
  );

  const rankedRegions = [...preparedRegions]
    .sort((a, b) => (b.overlayValue || 0) - (a.overlayValue || 0))
    .slice(0, 8);

  const activeTimePoint =
    selectedRegion?.timeSeries?.[timeIndex] ||
    selectedRegion?.timeSeries?.[0] ||
    null;

  useEffect(() => {
    if (!mountRef.current) return;

    const mount = mountRef.current;
    mount.innerHTML = '';

    const scene = new THREE.Scene();

    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    camera.position.set(0, 0.1, viewPreset.zoom);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.04;

    mount.appendChild(renderer.domElement);

    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.borderRadius = '1rem';
    renderer.domElement.style.cursor = 'grab';

    const root = new THREE.Group();
    root.rotation.x = viewPreset.rotationX;
    root.rotation.y = viewPreset.rotationY;
    scene.add(root);

    const earthTexture = new THREE.TextureLoader().load('/earth/earth_day.jpg');
    earthTexture.colorSpace = THREE.SRGBColorSpace;
    earthTexture.anisotropy = 8;

    const earth = new THREE.Mesh(
      new THREE.SphereGeometry(2, 128, 128),
      new THREE.MeshPhongMaterial({
        map: earthTexture,
        shininess: 18,
        specular: new THREE.Color(0x21374c),
      })
    );
    root.add(earth);

    const clouds = new THREE.Mesh(
      new THREE.SphereGeometry(2.018, 128, 128),
      new THREE.MeshLambertMaterial({
        map: makeCloudTexture(),
        transparent: true,
        opacity: 0.23,
        depthWrite: false,
      })
    );
    root.add(clouds);

    const atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(2.09, 128, 128),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(overlayOption.accent),
        transparent: true,
        opacity: 0.12,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
      })
    );
    scene.add(atmosphere);

    const outerGlow = new THREE.Mesh(
      new THREE.SphereGeometry(2.22, 128, 128),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(overlayOption.accent),
        transparent: true,
        opacity: 0.045,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
      })
    );
    scene.add(outerGlow);

    const ambient = new THREE.AmbientLight(0xa7c0da, 1.3);
    scene.add(ambient);

    const sun = new THREE.DirectionalLight(0xffffff, 3.0);
    sun.position.set(-4.5, 2.4, 5.3);
    scene.add(sun);

    const rim = new THREE.DirectionalLight(new THREE.Color(overlayOption.accent), 1.05);
    rim.position.set(3.5, -0.8, -3.5);
    scene.add(rim);

    const starGeometry = new THREE.BufferGeometry();
    const starPositions: number[] = [];

    for (let i = 0; i < 850; i += 1) {
      const r = 18 + Math.random() * 34;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);

      starPositions.push(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.sin(phi) * Math.sin(theta),
        r * Math.cos(phi)
      );
    }

    starGeometry.setAttribute('position', new THREE.Float32BufferAttribute(starPositions, 3));

    const stars = new THREE.Points(
      starGeometry,
      new THREE.PointsMaterial({
        color: 0xa9d6ff,
        size: 0.028,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
      })
    );
    scene.add(stars);

    const interactiveObjects: THREE.Object3D[] = [];
    const regionMap = new Map(preparedRegions.map((region) => [region.id, region]));

    preparedRegions.forEach((region) => {
      const value = region.overlayValue || 0;
      const ratio = Math.max(0.08, Math.min(1, value / maxOverlayValue));
      const height = 0.16 + ratio * (layerMode === 'time' ? 1.55 : 1.35);

      const surface = latLonToVector3(region.lat, region.lon, 2.035);
      const tip = latLonToVector3(region.lat, region.lon, 2.035 + height);
      const direction = tip.clone().sub(surface);
      const midpoint = surface.clone().add(tip).multiplyScalar(0.5);

      const isSelected = region.id === selectedRegion?.id;
      const isHovered = region.id === hoveredId;
      const color = new THREE.Color(overlayOption.accent);

      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(
          isSelected || isHovered ? 0.032 : 0.02,
          isSelected || isHovered ? 0.044 : 0.026,
          direction.length(),
          16,
          1,
          true
        ),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: isSelected || isHovered ? 0.98 : layerMode === 'flows' ? 0.52 : 0.72,
        })
      );

      beam.position.copy(midpoint);
      beam.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        direction.clone().normalize()
      );
      beam.userData.regionId = region.id;
      root.add(beam);
      interactiveObjects.push(beam);

      const topGlow = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: makeGlowSprite(overlayOption.accent),
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        })
      );

      topGlow.position.copy(tip);
      const glowScale = isSelected || isHovered ? 0.44 : 0.22 + ratio * 0.22;
      topGlow.scale.set(glowScale, glowScale, 1);
      topGlow.userData.regionId = region.id;
      root.add(topGlow);
      interactiveObjects.push(topGlow);

      const baseRing = new THREE.Mesh(
        new THREE.RingGeometry(
          isSelected || isHovered ? 0.08 : 0.055,
          isSelected || isHovered ? 0.118 : 0.082,
          48
        ),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: isSelected || isHovered ? 0.9 : 0.34,
          side: THREE.DoubleSide,
        })
      );

      baseRing.position.copy(surface);
      baseRing.lookAt(surface.clone().multiplyScalar(2));
      baseRing.userData.regionId = region.id;
      root.add(baseRing);
      interactiveObjects.push(baseRing);
    });

    if (layerMode === 'flows' || layerMode === 'time') {
      preparedRegions.forEach((region) => {
        const outboundFlows = region.outboundFlows || [];
        const start = latLonToVector3(region.lat, region.lon, 2.07);

        outboundFlows.forEach((flow) => {
          const target = regionMap.get(flow.targetId);
          if (!target) return;

          const end = latLonToVector3(target.lat, target.lon, 2.07);
          const lift = 2.32 + Math.min(0.42, (flow.weight || 1) / 180);
          const mid = start.clone().add(end).normalize().multiplyScalar(lift);

          const curve = new THREE.CatmullRomCurve3([start, mid, end]);
          const points = curve.getPoints(96);
          const geometry = new THREE.BufferGeometry().setFromPoints(points);

          const flowBoost =
            flow.metricMode && flow.metricMode === overlayMode
              ? 1.0
              : 0.58;

          const line = new THREE.Line(
            geometry,
            new THREE.LineBasicMaterial({
              color: new THREE.Color(overlayOption.accent),
              transparent: true,
              opacity: 0.08 + Math.min(0.32, (flow.weight || 1) / 240) * flowBoost,
              blending: THREE.AdditiveBlending,
            })
          );

          root.add(line);

          if (flow.weight >= 70) {
            const pulse = new THREE.Sprite(
              new THREE.SpriteMaterial({
                map: makeGlowSprite(overlayOption.accent),
                transparent: true,
                depthWrite: false,
                blending: THREE.AdditiveBlending,
                opacity: 0.5,
              })
            );

            pulse.position.copy(mid);
            pulse.scale.set(0.18, 0.18, 1);
            root.add(pulse);
          }
        });
      });
    }

    const resize = () => {
      const width = mount.clientWidth || 640;
      const height = mount.clientHeight || 560;

      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };

    resize();

    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    const pickObject = (event: MouseEvent | PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);
      const intersects = raycaster.intersectObjects(interactiveObjects, false);
      const hit = intersects.find((item) => item.object.userData.regionId);

      return hit?.object?.userData?.regionId || null;
    };

    const onPointerDown = (event: PointerEvent) => {
      pointerRef.current = {
        down: true,
        x: event.clientX,
        y: event.clientY,
        rotationX: root.rotation.x,
        rotationY: root.rotation.y,
      };

      renderer.domElement.style.cursor = 'grabbing';
      renderer.domElement.setPointerCapture(event.pointerId);
    };

    const onPointerMove = (event: PointerEvent) => {
      const state = pointerRef.current;

      if (state.down) {
        root.rotation.y = state.rotationY + (event.clientX - state.x) * 0.0062;
        root.rotation.x = Math.max(
          -1.05,
          Math.min(1.05, state.rotationX + (event.clientY - state.y) * 0.0048)
        );
        return;
      }

      const hitId = pickObject(event);
      setHoveredId(hitId);
      renderer.domElement.style.cursor = hitId ? 'pointer' : 'grab';
    };

    const onPointerUp = (event: PointerEvent) => {
      pointerRef.current.down = false;
      renderer.domElement.style.cursor = 'grab';
      try {
        renderer.domElement.releasePointerCapture(event.pointerId);
      } catch {}
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      camera.position.z = Math.max(3.75, Math.min(8.6, camera.position.z + event.deltaY * 0.005));
    };

    const onClick = (event: MouseEvent) => {
      const id = pickObject(event);
      if (id) setSelectedId(id);
    };

    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false });
    renderer.domElement.addEventListener('click', onClick);
    window.addEventListener('resize', resize);

    let frame = 0;
    const animate = () => {
      frame = requestAnimationFrame(animate);

      if (!pointerRef.current.down) {
        root.rotation.y += layerMode === 'flows' ? 0.00042 : 0.00055;
      }

      clouds.rotation.y += 0.00026;
      atmosphere.rotation.copy(root.rotation);
      outerGlow.rotation.copy(root.rotation);

      renderer.render(scene, camera);
    };

    animate();

    return () => {
      cancelAnimationFrame(frame);

      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('wheel', onWheel);
      renderer.domElement.removeEventListener('click', onClick);
      window.removeEventListener('resize', resize);

      renderer.dispose();
      earthTexture.dispose();
      mount.innerHTML = '';
    };
  }, [
    preparedRegions,
    selectedRegion?.id,
    hoveredId,
    overlayOption.accent,
    maxOverlayValue,
    viewPreset.rotationX,
    viewPreset.rotationY,
    viewPreset.zoom,
    layerMode,
    overlayMode,
  ]);

  return (
    <div className="rounded-[1.4rem] border border-white/10 bg-slate-950/50 p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-500">
            SEC globe intelligence layer
          </div>
          <div className="mt-1 text-sm font-semibold text-white">
            Map EDGAR-derived market exposure to specific global hubs
          </div>
          <p className="mt-1 text-xs text-slate-500">
            {layerOption.description} {getModeDescription(overlayMode)}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {LAYER_OPTIONS.map((option) => {
            const active = option.id === layerMode;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => setLayerMode(option.id)}
                className={`rounded-full border px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.14em] transition ${
                  active
                    ? 'border-white/30 bg-white/12 text-white'
                    : 'border-white/10 bg-white/[0.03] text-slate-400 hover:border-white/20 hover:text-slate-200'
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {OVERLAY_OPTIONS.map((option) => {
          const active = option.id === overlayMode;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => setOverlayMode(option.id)}
              className={`rounded-full border px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.14em] transition ${
                active
                  ? option.accentClass
                  : 'border-white/10 bg-white/[0.03] text-slate-400 hover:border-white/20 hover:text-slate-200'
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {VIEW_PRESETS.map((preset) => {
            const active = preset.id === viewPreset.id;
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => setViewPreset(preset)}
                className={`rounded-full border px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.14em] transition ${
                  active
                    ? 'border-white/30 bg-white/10 text-white'
                    : 'border-white/10 bg-white/[0.03] text-slate-500 hover:text-slate-300'
                }`}
              >
                {preset.label}
              </button>
            );
          })}
        </div>

        <div className="text-[10px] uppercase tracking-[0.16em] text-slate-500">
          Drag to rotate · Scroll to zoom · Click a beam for detail
        </div>
      </div>

      {layerMode === 'time' && (
        <div className="mb-4 rounded-2xl border border-white/10 bg-white/[0.035] p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-500">
                Filing season time machine
              </div>
              <div className="mt-1 text-xs text-slate-500">
                Compare current exposure with prior-quarter, prior-year, and stress-overlay states.
              </div>
            </div>
            <div className="text-sm font-black text-white">
              {selectedRegion?.timeSeries?.[timeIndex]?.label || 'Current'}
            </div>
          </div>

          <input
            type="range"
            min="0"
            max="3"
            step="1"
            value={timeIndex}
            onChange={(event) => setTimeIndex(Number(event.target.value))}
            className="w-full"
          />

          <div className="mt-2 grid grid-cols-4 gap-2 text-center text-[10px] uppercase tracking-[0.14em] text-slate-500">
            {(selectedRegion?.timeSeries || [
              { label: '1Y ago' },
              { label: 'Prior Q' },
              { label: 'Current' },
              { label: 'Stress' },
            ]).slice(0, 4).map((point, index) => (
              <button
                key={point.label}
                type="button"
                onClick={() => setTimeIndex(index)}
                className={index === timeIndex ? 'font-black text-white' : 'hover:text-slate-300'}
              >
                {point.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div
        ref={mountRef}
        className="h-[590px] w-full overflow-hidden rounded-2xl border border-white/10 bg-[radial-gradient(circle_at_50%_45%,rgba(14,165,233,0.12),rgba(2,6,23,0.95)_62%,rgba(0,0,0,1))]"
      />

      <div className="mt-4 grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-500">
                {hoveredRegion ? 'Hovered node' : 'Selected node'}
              </div>
              <div className="mt-1 text-sm font-black text-white">
                {activeRegion?.name || '—'}
              </div>
              <div className="mt-1 text-[11px] text-slate-500">
                {[activeRegion?.city, activeRegion?.country].filter(Boolean).join(' · ')}
              </div>
              <p className="mt-2 text-xs leading-5 text-slate-500">
                {activeRegion?.description || 'No description available.'}
              </p>

              <div className="mt-3 flex flex-wrap gap-1.5">
                {(activeRegion?.drivers || []).map((driver) => (
                  <span
                    key={driver}
                    className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-2 py-1 text-[9px] font-black uppercase tracking-[0.12em] text-cyan-200"
                  >
                    {driver}
                  </span>
                ))}
              </div>

              {activeRegion?.sourceBasis && (
                <p className="mt-3 text-[11px] leading-5 text-slate-500">
                  <span className="font-black text-slate-300">Basis:</span> {activeRegion.sourceBasis}
                </p>
              )}

              {layerMode === 'time' && activeTimePoint?.note && (
                <p className="mt-3 text-[11px] leading-5 text-slate-500">
                  <span className="font-black text-slate-300">Time note:</span> {activeTimePoint.note}
                </p>
              )}
            </div>

            <div className="text-right">
              <div className="text-[10px] uppercase tracking-[0.16em] text-slate-500">
                {overlayOption.label}
              </div>
              <div className="mt-1 text-lg font-black" style={{ color: overlayOption.accent }}>
                {activeRegion ? formatOverlayValue(overlayMode, activeRegion.overlayValue || 0) : '—'}
              </div>
              <div className="mt-3 text-[10px] uppercase tracking-[0.16em] text-slate-500">
                Confidence
              </div>
              <div className="mt-1 text-xs font-black text-slate-300">
                {activeRegion?.confidence || 'Proxy'}
              </div>
              <div className="mt-3 text-[10px] uppercase tracking-[0.16em] text-slate-500">
                Evidence
              </div>
              <div className="mt-1 text-xs font-black text-slate-300">
                {formatNumber(activeRegion?.evidenceCount || 0)}
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-500">
                Ranked nodes
              </div>
              <div className="mt-1 text-xs text-slate-500">
                Highest mapped values for {overlayOption.label.toLowerCase()}.
              </div>
            </div>
            <div className="text-[10px] font-black uppercase tracking-[0.16em]" style={{ color: overlayOption.accent }}>
              {overlayOption.label}
            </div>
          </div>

          <div className="space-y-2">
            {rankedRegions.map((region) => {
              const width = Math.max(4, ((region.overlayValue || 0) / maxOverlayValue) * 100);
              const active = region.id === selectedRegion?.id;

              return (
                <button
                  key={region.id}
                  type="button"
                  onClick={() => setSelectedId(region.id)}
                  onMouseEnter={() => setHoveredId(region.id)}
                  onMouseLeave={() => setHoveredId(null)}
                  className={`w-full rounded-xl border px-3 py-2 text-left transition ${
                    active
                      ? 'border-white/25 bg-white/10'
                      : 'border-white/10 bg-white/[0.025] hover:border-white/20'
                  }`}
                >
                  <div className="mb-1 flex items-center justify-between gap-3">
                    <span className="truncate text-xs font-black text-slate-100">{region.shortName || region.name}</span>
                    <span className="shrink-0 text-xs font-black" style={{ color: overlayOption.accent }}>
                      {formatOverlayValue(overlayMode, region.overlayValue || 0)}
                    </span>
                  </div>
                  <div className="mb-1 text-[10px] text-slate-500">
                    {[region.city, region.country].filter(Boolean).join(' · ')}
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${width}%`,
                        background: `linear-gradient(90deg, ${overlayOption.accent}, rgba(255,255,255,0.85))`,
                      }}
                    />
                  </div>
                </button>
              );
            })}
          </div>

          <div className="mt-4 rounded-xl border border-white/10 bg-slate-950/40 p-3">
            <div className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-500">
              Low / high range
            </div>
            <div className="mt-2 flex items-center justify-between text-xs text-slate-400">
              <span>{formatOverlayValue(overlayMode, minOverlayValue)}</span>
              <span>{formatOverlayValue(overlayMode, maxOverlayValue)}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

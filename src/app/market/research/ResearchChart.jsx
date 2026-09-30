'use client';
import { useEffect, useRef, useState } from 'react';
import { ResponsiveContainer } from 'recharts';

/** Fixed-height parent reserves layout; offscreen SVG trees wait until needed. */
export default function ResearchChart({ children }) {
  const root = useRef(null);
  const [size, setSize] = useState(null);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    let intersection, resize, revealing = false;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      if (width <= 0 || height <= 0) return;
      setSize({ width, height });
      intersection?.disconnect();
      resize?.disconnect();
    };
    const reveal = () => {
      if (revealing) return;
      revealing = true;
      // A hidden tab can intersect at zero size. Wait for usable geometry rather
      // than rendering Recharts with its default -1 measurement.
      if (typeof ResizeObserver !== 'undefined') {
        resize = new ResizeObserver(measure);
        resize.observe(element);
      }
      measure();
    };
    if (typeof IntersectionObserver !== 'undefined') {
      intersection = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) reveal();
      }, { rootMargin: '160px' });
      intersection.observe(element);
    } else reveal();
    return () => { intersection?.disconnect(); resize?.disconnect(); };
  }, []);
  return <div ref={root} style={{ width: '100%', height: '100%', minWidth: 0 }}>
    {size && <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={size}>{children}</ResponsiveContainer>}
  </div>;
}

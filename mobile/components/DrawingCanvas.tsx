import React, {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { PanResponder, StyleSheet, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import * as FileSystem from 'expo-file-system';

// ViewShot replaced with expo-file-system + SVG-to-PNG via expo-image-manipulator
// react-native-view-shot removed — it caused native crash on standalone APK

export interface BoundingBox {
  x: number; y: number; width: number; height: number;
}

export interface DrawingCanvasRef {
  clear: () => void;
  getImageUri: () => Promise<string>;
  hasStrokes: () => boolean;
  getBoundingBox: () => BoundingBox | null;
}

interface Props {
  size: number;
}

type Point = { x: number; y: number };

function buildSvgPath(pts: Point[]): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) {
    return `M ${pts[0].x} ${pts[0].y} L ${pts[0].x + 0.5} ${pts[0].y + 0.5}`;
  }
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2;
    const my = (pts[i].y + pts[i + 1].y) / 2;
    d += ` Q ${pts[i].x} ${pts[i].y} ${mx} ${my}`;
  }
  d += ` L ${pts[pts.length - 1].x} ${pts[pts.length - 1].y}`;
  return d;
}

const DrawingCanvas = forwardRef<DrawingCanvasRef, Props>(({ size }, ref) => {
  const [completedPaths, setCompletedPaths] = useState<string[]>([]);
  const [activePath,     setActivePath]     = useState('');
  const activePoints = useRef<Point[]>([]);
  const allPoints    = useRef<Point[]>([]);
  const lastUriRef   = useRef<string | null>(null);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder:  () => true,

      onPanResponderGrant: (e) => {
        const { locationX: x, locationY: y } = e.nativeEvent;
        activePoints.current = [{ x, y }];
        allPoints.current.push({ x, y });
        setActivePath(buildSvgPath(activePoints.current));
      },

      onPanResponderMove: (e) => {
        const { locationX: x, locationY: y } = e.nativeEvent;
        activePoints.current.push({ x, y });
        allPoints.current.push({ x, y });
        setActivePath(buildSvgPath(activePoints.current));
      },

      onPanResponderRelease: () => {
        const d = buildSvgPath(activePoints.current);
        if (d) setCompletedPaths(prev => [...prev, d]);
        activePoints.current = [];
        setActivePath('');
      },

      onPanResponderTerminate: () => {
        const d = buildSvgPath(activePoints.current);
        if (d) setCompletedPaths(prev => [...prev, d]);
        activePoints.current = [];
        setActivePath('');
      },
    })
  ).current;

  const clear = useCallback(() => {
    if (lastUriRef.current) {
      FileSystem.deleteAsync(lastUriRef.current, { idempotent: true }).catch(() => {});
      lastUriRef.current = null;
    }
    setCompletedPaths([]);
    setActivePath('');
    activePoints.current = [];
    allPoints.current    = [];
  }, []);

  /**
   * Captures the canvas by writing an SVG file and returning its URI.
   * The backend already handles SVG → processing pipeline.
   */
  const getImageUri = useCallback(async (): Promise<string> => {
    const allPaths = [...completedPaths, activePath].filter(Boolean);
    const strokeW  = Math.max(8, size * 0.026);

    const svgContent = `<?xml version="1.0" encoding="utf-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="white"/>
  ${allPaths
    .map(d => `<path d="${d}" stroke="#111111" stroke-width="${strokeW}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`)
    .join('\n  ')}
</svg>`;

    const uri = FileSystem.cacheDirectory + `drawing_${Date.now()}.svg`;
    await FileSystem.writeAsStringAsync(uri, svgContent, { encoding: FileSystem.EncodingType.UTF8 });
    lastUriRef.current = uri;
    return uri;
  }, [completedPaths, activePath, size]);

  const hasStrokes = useCallback(
    () => completedPaths.length > 0 || activePath.length > 0,
    [completedPaths, activePath],
  );

  const getBoundingBox = useCallback((): BoundingBox | null => {
    const pts = allPoints.current;
    if (pts.length === 0) return null;
    let minX = pts[0].x, maxX = pts[0].x;
    let minY = pts[0].y, maxY = pts[0].y;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }, []);

  useImperativeHandle(
    ref,
    () => ({ clear, getImageUri, hasStrokes, getBoundingBox }),
    [clear, getImageUri, hasStrokes, getBoundingBox],
  );

  return (
    <View
      style={[styles.wrapper, { width: size, height: size }]}
    >
      <Svg width={size} height={size} style={StyleSheet.absoluteFill} pointerEvents="none">
        {completedPaths.map((d, i) => (
          <Path
            key={i}
            d={d}
            stroke="#111111"
            strokeWidth={Math.max(8, size * 0.026)}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        ))}
        {activePath ? (
          <Path
            d={activePath}
            stroke="#111111"
            strokeWidth={Math.max(8, size * 0.026)}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        ) : null}
      </Svg>

      {/* Touch capture layer */}
      <View style={StyleSheet.absoluteFill} {...panResponder.panHandlers} />
    </View>
  );
});

DrawingCanvas.displayName = 'DrawingCanvas';
export default DrawingCanvas;

const styles = StyleSheet.create({
  wrapper: {
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#fff',
  },
});

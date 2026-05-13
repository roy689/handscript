import React, {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { PanResponder, StyleSheet, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import ViewShot from 'react-native-view-shot';

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
  const viewShotRef    = useRef<ViewShot>(null);
  const [completedPaths, setCompletedPaths] = useState<string[]>([]);
  const [activePath,     setActivePath]     = useState('');
  const activePoints = useRef<Point[]>([]);
  // All points ever drawn — used to compute the tight bounding box on demand
  const allPoints    = useRef<Point[]>([]);

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
    setCompletedPaths([]);
    setActivePath('');
    activePoints.current = [];
    allPoints.current    = [];
  }, []);

  const getImageUri = useCallback(async (): Promise<string> => {
    const uri = await (viewShotRef.current as any)?.capture();
    if (!uri) throw new Error('ViewShot capture failed');
    return uri;
  }, []);

  const hasStrokes = useCallback(
    () => completedPaths.length > 0 || activePath.length > 0,
    [completedPaths, activePath],
  );

  // Returns the tight bounding box of all drawn points in logical (CSS) pixels.
  // The caller must account for stroke width and device pixel ratio when cropping.
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
    <ViewShot
      ref={viewShotRef}
      options={{ format: 'png' }}
      style={[styles.capture, { width: size, height: size }]}
    >
      <View style={[styles.wrapper, { width: size, height: size }]}>
        {/* SVG is non-interactive — prevents it from hijacking touch events on Android */}
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
    </ViewShot>
  );
});

DrawingCanvas.displayName = 'DrawingCanvas';
export default DrawingCanvas;

const styles = StyleSheet.create({
  capture: {
    backgroundColor: '#fff',
    overflow: 'hidden',
  },
  wrapper: {
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#fff',
  },
});

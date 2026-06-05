import React, {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { PanResponder, Platform, StyleSheet, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import * as FileSystem from 'expo-file-system/legacy';
import { WebView } from 'react-native-webview';

// ── DrawingCanvas ─────────────────────────────────────────────────────────────
//
// Architecture:
//   - Touch events are captured via PanResponder → drawn visually with react-native-svg
//   - Raw point arrays are stored in a ref (completedStrokes) alongside the SVG paths
//   - On getImageUri(), raw points are sent to a hidden WebView that renders them
//     directly on a <canvas> element and returns a PNG base64 string
//   - This avoids the SVG→img loading path which is blocked in sandboxed WebViews
//
// Previous approach (SVG via data URL) failed because:
//   a) data:image/svg+xml URLs are blocked in the RN WebView sandbox
//   b) A race condition cleared resolveCapture/rejectCapture refs before
//      FileSystem.writeAsStringAsync completed, causing silent Promise hangs

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

// Hidden WebView renders strokes directly on <canvas> — no SVG loading step.
// Receives: array of stroke arrays (each stroke = [{x,y}, ...])
// Returns:  { ok: true, base64: "..." } or { ok: false, error: "..." }
const CONVERTER_HTML = `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
</head>
<body style="margin:0;padding:0;background:white;">
<canvas id="c"></canvas>
<script>
window.drawStrokes = function(strokes, strokeWidth, w, h) {
  try {
    var canvas = document.getElementById('c');

    // Always render at 1:1 logical pixel resolution regardless of devicePixelRatio.
    // The coordinates coming in from PanResponder are already in logical (point) units,
    // so we keep the canvas in logical pixels to avoid any coordinate mismatch on
    // high-DPI iOS devices (retina / ProMotion screens).
    canvas.width  = w;
    canvas.height = h;
    canvas.style.width  = w + 'px';
    canvas.style.height = h + 'px';

    var ctx = canvas.getContext('2d');

    // White background
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, w, h);

    // Draw each stroke
    ctx.strokeStyle = '#111111';
    ctx.lineWidth   = strokeWidth;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';

    for (var s = 0; s < strokes.length; s++) {
      var pts = strokes[s];
      if (!pts || pts.length === 0) continue;

      if (pts.length === 1) {
        // Single tap → filled dot
        ctx.beginPath();
        ctx.arc(pts[0].x, pts[0].y, strokeWidth / 2, 0, Math.PI * 2);
        ctx.fillStyle = '#111111';
        ctx.fill();
        continue;
      }

      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (var i = 1; i < pts.length - 1; i++) {
        var mx = (pts[i].x + pts[i+1].x) / 2;
        var my = (pts[i].y + pts[i+1].y) / 2;
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
      }
      ctx.lineTo(pts[pts.length-1].x, pts[pts.length-1].y);
      ctx.stroke();
    }

    var base64 = canvas.toDataURL('image/png').split(',')[1];
    window.ReactNativeWebView.postMessage(JSON.stringify({ ok: true, base64: base64 }));
  } catch(e) {
    window.ReactNativeWebView.postMessage(JSON.stringify({ ok: false, error: String(e) }));
  }
};
</script>
</body></html>`;

const DrawingCanvas = forwardRef<DrawingCanvasRef, Props>(({ size }, ref) => {
  // SVG path strings — used only for live visual rendering via react-native-svg
  const [completedPaths, setCompletedPaths] = useState<string[]>([]);
  const [activePath,     setActivePath]     = useState('');

  // Raw point arrays — sent to WebView for PNG conversion (avoids SVG parsing)
  const completedStrokes = useRef<Point[][]>([]);
  const activePoints     = useRef<Point[]>([]);
  const allPoints        = useRef<Point[]>([]);
  const lastUriRef       = useRef<string | null>(null);

  // WebView refs for canvas rendering
  const webViewRef     = useRef<WebView>(null);
  const webViewReady   = useRef(false);
  const resolveCapture = useRef<((uri: string) => void) | null>(null);
  const rejectCapture  = useRef<((e: Error) => void) | null>(null);

  // ── iOS coordinate fix ──────────────────────────────────────────────────────
  // On iOS, PanResponder's locationX/locationY can be reported relative to a
  // parent container rather than the actual touch layer when the canvas is
  // nested inside absolute-positioned views. This causes strokes to appear
  // shifted/distorted vs. what the user actually drew.
  // Fix: measure the touch layer's screen position once on layout, then
  // subtract it from pageX/pageY (which are always window-relative and correct).
  const touchLayerRef = useRef<View>(null);
  const originRef     = useRef({ x: 0, y: 0 });

  const onTouchLayerLayout = useCallback(() => {
    touchLayerRef.current?.measure((_x, _y, _w, _h, pageX, pageY) => {
      originRef.current = { x: pageX, y: pageY };
    });
  }, []);

  // Returns the corrected (x, y) relative to the canvas for any native event.
  // On Android locationX/Y are reliable; on iOS we use pageX/Y minus measured origin.
  function getCanvasPoint(nativeEvent: { locationX: number; locationY: number; pageX: number; pageY: number }) {
    if (Platform.OS === 'ios') {
      return {
        x: nativeEvent.pageX - originRef.current.x,
        y: nativeEvent.pageY - originRef.current.y,
      };
    }
    return { x: nativeEvent.locationX, y: nativeEvent.locationY };
  }

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder:  () => true,

      onPanResponderGrant: (e) => {
        const { x, y } = getCanvasPoint(e.nativeEvent);
        activePoints.current = [{ x, y }];
        allPoints.current.push({ x, y });
        setActivePath(buildSvgPath(activePoints.current));
      },

      onPanResponderMove: (e) => {
        const { x, y } = getCanvasPoint(e.nativeEvent);
        activePoints.current.push({ x, y });
        allPoints.current.push({ x, y });
        setActivePath(buildSvgPath(activePoints.current));
      },

      onPanResponderRelease: () => {
        const pts = [...activePoints.current];
        const d   = buildSvgPath(pts);
        if (d) {
          setCompletedPaths(prev => [...prev, d]);
          completedStrokes.current.push(pts);
        }
        activePoints.current = [];
        setActivePath('');
      },

      onPanResponderTerminate: () => {
        const pts = [...activePoints.current];
        const d   = buildSvgPath(pts);
        if (d) {
          setCompletedPaths(prev => [...prev, d]);
          completedStrokes.current.push(pts);
        }
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
    activePoints.current     = [];
    allPoints.current        = [];
    completedStrokes.current = [];
  }, []);

  // Called when WebView HTML finishes loading — safe to inject JS after this
  const onWebViewLoad = useCallback(() => {
    webViewReady.current = true;
  }, []);

  // Receives the PNG base64 back from the WebView canvas.
  // IMPORTANT: refs are grabbed into locals BEFORE clearing them — this fixes
  // the race condition where the catch block ran after refs were already null.
  const onWebViewMessage = useCallback(async (event: { nativeEvent: { data: string } }) => {
    // Grab resolve/reject into locals and immediately clear refs
    const resolve = resolveCapture.current;
    const reject  = rejectCapture.current;
    resolveCapture.current = null;
    rejectCapture.current  = null;

    if (!resolve || !reject) return; // stale or duplicate message

    try {
      const msg = JSON.parse(event.nativeEvent.data) as { ok: boolean; base64?: string; error?: string };
      if (msg.ok && msg.base64) {
        const uri = `${FileSystem.cacheDirectory ?? ''}drawing_${Date.now()}.png`;
        await FileSystem.writeAsStringAsync(uri, msg.base64, {
          encoding: FileSystem.EncodingType.Base64,
        });
        lastUriRef.current = uri;
        resolve(uri);
      } else {
        reject(new Error(msg.error ?? 'WebView canvas rendering failed'));
      }
    } catch (e) {
      // FileSystem.writeAsStringAsync failed — reject with the actual error
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  }, []);

  /**
   * Renders all drawn strokes to a PNG via the hidden WebView <canvas>.
   * Returns a file:// URI — compatible with <Image> and the backend.
   */
  const getImageUri = useCallback((): Promise<string> => {
    return new Promise((resolve, reject) => {
      if (!webViewRef.current || !webViewReady.current) {
        reject(new Error('WebView not ready — wait a moment and try again'));
        return;
      }

      // Include any in-progress active stroke
      const allStrokes: Point[][] = [...completedStrokes.current];
      if (activePoints.current.length > 0) {
        allStrokes.push([...activePoints.current]);
      }

      const strokeW = Math.max(8, size * 0.026);

      resolveCapture.current = resolve;
      rejectCapture.current  = reject;

      webViewRef.current.injectJavaScript(
        `window.drawStrokes(${JSON.stringify(allStrokes)}, ${strokeW}, ${size}, ${size}); true;`,
      );

      // Safety timeout — cancels the hanging promise if WebView never responds
      setTimeout(() => {
        if (resolveCapture.current === resolve) {
          resolveCapture.current = null;
          rejectCapture.current  = null;
          reject(new Error('Canvas rendering timed out — try again'));
        }
      }, 8_000);
    });
  }, [size]);
  // completedStrokes and activePoints are refs — always current, no dep needed

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
    <View style={[styles.wrapper, { width: size, height: size }]}>
      {/* Hidden WebView — renders strokes on <canvas> and returns PNG base64 */}
      <WebView
        ref={webViewRef}
        source={{ html: CONVERTER_HTML }}
        onLoad={onWebViewLoad}
        onMessage={onWebViewMessage}
        javaScriptEnabled
        style={styles.hiddenWebView}
        scrollEnabled={false}
        // Prevent iOS WKWebView from applying its own content scaling
        scalesPageToFit={false}
        automaticallyAdjustContentInsets={false}
      />

      {/* Live SVG preview of what the user is drawing */}
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

      {/* Touch capture layer — must be last so it sits on top */}
      <View
        ref={touchLayerRef}
        style={StyleSheet.absoluteFill}
        onLayout={onTouchLayerLayout}
        {...panResponder.panHandlers}
      />
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
  // 1×1 invisible — JS runs but takes no visual space
  hiddenWebView: {
    position: 'absolute',
    width:    1,
    height:   1,
    opacity:  0,
  },
});

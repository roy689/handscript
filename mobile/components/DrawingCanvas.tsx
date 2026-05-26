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
import { WebView } from 'react-native-webview';

// SVG→PNG conversion via hidden WebView (react-native-view-shot was removed — caused native crash on standalone APK)
// The WebView renders the SVG on a <canvas> and postMessages back base64 PNG.

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

// Static HTML for the hidden WebView converter
const CONVERTER_HTML = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:white;">
<script>
window.convertSvg = function(svgString, w, h) {
  try {
    var canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, w, h);
    var img = new Image();
    img.onload = function() {
      ctx.drawImage(img, 0, 0, w, h);
      var base64 = canvas.toDataURL('image/png').split(',')[1];
      window.ReactNativeWebView.postMessage(JSON.stringify({ ok: true, base64: base64 }));
    };
    img.onerror = function() {
      window.ReactNativeWebView.postMessage(JSON.stringify({ ok: false, error: 'img load failed' }));
    };
    var encoded = encodeURIComponent(svgString);
    img.src = 'data:image/svg+xml,' + encoded;
  } catch(e) {
    window.ReactNativeWebView.postMessage(JSON.stringify({ ok: false, error: String(e) }));
  }
};
</script>
</body></html>`;

const DrawingCanvas = forwardRef<DrawingCanvasRef, Props>(({ size }, ref) => {
  const [completedPaths, setCompletedPaths] = useState<string[]>([]);
  const [activePath,     setActivePath]     = useState('');
  const activePoints = useRef<Point[]>([]);
  const allPoints    = useRef<Point[]>([]);
  const lastUriRef   = useRef<string | null>(null);

  // WebView refs for SVG→PNG conversion
  const webViewRef      = useRef<WebView>(null);
  const webViewReady    = useRef(false);
  const resolveCapture  = useRef<((uri: string) => void) | null>(null);
  const rejectCapture   = useRef<((e: Error) => void) | null>(null);

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

  // Called when the hidden WebView finishes loading — now safe to inject JS
  const onWebViewLoad = useCallback(() => {
    webViewReady.current = true;
  }, []);

  // Receives the base64 PNG back from the WebView canvas
  const onWebViewMessage = useCallback(async (event: { nativeEvent: { data: string } }) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data) as { ok: boolean; base64?: string; error?: string };
      if (msg.ok && msg.base64 && resolveCapture.current) {
        const resolve = resolveCapture.current;
        resolveCapture.current = null;
        rejectCapture.current  = null;
        const uri = (FileSystem.cacheDirectory ?? '') + `drawing_${Date.now()}.png`;
        await FileSystem.writeAsStringAsync(uri, msg.base64, { encoding: FileSystem.EncodingType.Base64 });
        lastUriRef.current = uri;
        resolve(uri);
      } else if (!msg.ok && rejectCapture.current) {
        const reject = rejectCapture.current;
        resolveCapture.current = null;
        rejectCapture.current  = null;
        reject(new Error(msg.error ?? 'WebView conversion failed'));
      }
    } catch (e) {
      rejectCapture.current?.(e instanceof Error ? e : new Error(String(e)));
      resolveCapture.current = null;
      rejectCapture.current  = null;
    }
  }, []);

  /**
   * Converts the current drawing to a PNG by rendering the SVG on a WebView <canvas>.
   * Returns a file:// URI pointing to a PNG — compatible with <Image> and the backend.
   */
  const getImageUri = useCallback((): Promise<string> => {
    return new Promise((resolve, reject) => {
      const allPaths = [...completedPaths, activePath].filter(Boolean);
      const strokeW  = Math.max(8, size * 0.026);

      const svgContent = `<?xml version="1.0" encoding="utf-8"?><svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" fill="white"/>${allPaths.map(d => `<path d="${d}" stroke="#111111" stroke-width="${strokeW}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`).join('')}</svg>`;

      if (!webViewRef.current || !webViewReady.current) {
        reject(new Error('WebView not ready'));
        return;
      }

      resolveCapture.current = resolve;
      rejectCapture.current  = reject;

      // Pass SVG as JSON-encoded string so all characters are safely escaped
      const svgJson = JSON.stringify(svgContent);
      webViewRef.current.injectJavaScript(`window.convertSvg(${svgJson}, ${size}, ${size}); true;`);

      // Timeout safety net
      setTimeout(() => {
        if (resolveCapture.current === resolve) {
          resolveCapture.current = null;
          rejectCapture.current  = null;
          reject(new Error('SVG→PNG conversion timed out'));
        }
      }, 10_000);
    });
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
      {/* Hidden WebView — converts SVG paths to PNG via <canvas> */}
      <WebView
        ref={webViewRef}
        source={{ html: CONVERTER_HTML }}
        onLoad={onWebViewLoad}
        onMessage={onWebViewMessage}
        javaScriptEnabled
        style={styles.hiddenWebView}
        scrollEnabled={false}
        pointerEvents="none"
      />

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
  // Invisible WebView for SVG→PNG conversion — 1×1 so JS runs but takes no space
  hiddenWebView: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
  },
});

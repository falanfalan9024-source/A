/**
 * AutoCropCV - خوارزمية الكشف التلقائي الكاملة
 * ─────────────────────────────────────────────
 * 1. Gaussian Blur            (إزالة الضوضاء)
 * 2. Otsu + Adaptive Thresh.  (تحويل ثنائي تكيفي)
 * 3. Canny Edge Detection     (كشف الحواف)
 * 4. Morphological Dilate & Close (توصيل الحواف)
 * 5. findContours / Suzuki-Abe (استخراج الخطوط المحيطية)
 * 6. Convex Hull              (الغلاف الخارجي)
 * 7. Ramer-Douglas-Peucker   (approxPolyDP - استخراج الزوايا)
 * 8. Euclidean Distance       (حساب الأبعاد)
 * 9. warpPerspective          (تصحيح المنظور)
 */

'use strict';

const AutoCropCV = (() => {

  /* ═══════════════════════════════════════════════════════
     1. GAUSSIAN BLUR
     ═══════════════════════════════════════════════════════ */
  function makeGaussKernel(radius) {
    const sigma = Math.max(1, radius / 2.5);
    const size = 2 * radius + 1;
    const k = new Float32Array(size * size);
    let sum = 0;
    for (let y = -radius; y <= radius; y++) {
      for (let x = -radius; x <= radius; x++) {
        const v = Math.exp(-(x * x + y * y) / (2 * sigma * sigma));
        k[(y + radius) * size + (x + radius)] = v;
        sum += v;
      }
    }
    for (let i = 0; i < k.length; i++) k[i] /= sum;
    return { k, size, radius };
  }

  function gaussianBlur(gray, w, h, radius) {
    const { k, size, radius: r } = makeGaussKernel(radius);
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let val = 0;
        for (let ky = 0; ky < size; ky++) {
          for (let kx = 0; kx < size; kx++) {
            const sx = Math.min(w - 1, Math.max(0, x + kx - r));
            const sy = Math.min(h - 1, Math.max(0, y + ky - r));
            val += k[ky * size + kx] * gray[sy * w + sx];
          }
        }
        out[y * w + x] = val | 0;
      }
    }
    return out;
  }

  /* ═══════════════════════════════════════════════════════
     GRAYSCALE CONVERSION
     ═══════════════════════════════════════════════════════ */
  function toGray(rgba, w, h) {
    const gray = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < w * h; i++, j += 4) {
      gray[i] = (0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2]) | 0;
    }
    return gray;
  }

  /* ═══════════════════════════════════════════════════════
     2A. OTSU'S THRESHOLDING
     ═══════════════════════════════════════════════════════ */
  function otsuThreshold(gray) {
    const hist = new Int32Array(256);
    for (const v of gray) hist[v]++;
    const total = gray.length;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];

    let wB = 0, sumB = 0, maxBetween = 0, threshold = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (wB === 0) continue;
      const wF = total - wB;
      if (wF === 0) break;
      sumB += t * hist[t];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > maxBetween) { maxBetween = between; threshold = t; }
    }
    return threshold;
  }

  /* ═══════════════════════════════════════════════════════
     2B. ADAPTIVE THRESHOLDING  (integral-image based)
     ═══════════════════════════════════════════════════════ */
  function adaptiveThreshold(gray, w, h, blockSize = 25, C = 10) {
    const half = blockSize >> 1;
    // Build integral image
    const integral = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        integral[(y + 1) * (w + 1) + (x + 1)] =
          gray[y * w + x] +
          integral[y * (w + 1) + (x + 1)] +
          integral[(y + 1) * (w + 1) + x] -
          integral[y * (w + 1) + x];
      }
    }
    const bin = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const x1 = Math.max(0, x - half);
        const y1 = Math.max(0, y - half);
        const x2 = Math.min(w, x + half + 1);
        const y2 = Math.min(h, y + half + 1);
        const area = (x2 - x1) * (y2 - y1);
        const localSum =
          integral[y2 * (w + 1) + x2] -
          integral[y1 * (w + 1) + x2] -
          integral[y2 * (w + 1) + x1] +
          integral[y1 * (w + 1) + x1];
        bin[y * w + x] = gray[y * w + x] < (localSum / area) - C ? 255 : 0;
      }
    }
    return bin;
  }

  /* ═══════════════════════════════════════════════════════
     3. CANNY EDGE DETECTION
     ═══════════════════════════════════════════════════════ */
  function canny(gray, w, h, lowT, highT) {
    const N = w * h;
    const mag = new Float32Array(N);
    const ang = new Float32Array(N);

    // Sobel
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const gx =
          -gray[(y - 1) * w + (x - 1)] + gray[(y - 1) * w + (x + 1)]
          - 2 * gray[y * w + (x - 1)] + 2 * gray[y * w + (x + 1)]
          - gray[(y + 1) * w + (x - 1)] + gray[(y + 1) * w + (x + 1)];
        const gy =
          gray[(y - 1) * w + (x - 1)] + 2 * gray[(y - 1) * w + x] + gray[(y - 1) * w + (x + 1)]
          - gray[(y + 1) * w + (x - 1)] - 2 * gray[(y + 1) * w + x] - gray[(y + 1) * w + (x + 1)];
        const i = y * w + x;
        mag[i] = Math.sqrt(gx * gx + gy * gy);
        ang[i] = Math.atan2(gy, gx);
      }
    }

    // Non-Maximum Suppression
    const nms = new Float32Array(N);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const a = (((ang[i] * 180 / Math.PI) % 180) + 180) % 180;
        let n1, n2;
        if (a < 22.5 || a >= 157.5) { n1 = mag[y * w + x - 1]; n2 = mag[y * w + x + 1]; }
        else if (a < 67.5) { n1 = mag[(y - 1) * w + x + 1]; n2 = mag[(y + 1) * w + x - 1]; }
        else if (a < 112.5) { n1 = mag[(y - 1) * w + x]; n2 = mag[(y + 1) * w + x]; }
        else { n1 = mag[(y - 1) * w + x - 1]; n2 = mag[(y + 1) * w + x + 1]; }
        nms[i] = (mag[i] >= n1 && mag[i] >= n2) ? mag[i] : 0;
      }
    }

    // Double threshold
    const STRONG = 255, WEAK = 128;
    const edges = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (nms[i] >= highT) edges[i] = STRONG;
      else if (nms[i] >= lowT) edges[i] = WEAK;
    }

    // Hysteresis (stack-based)
    const stack = [];
    for (let i = 0; i < N; i++) { if (edges[i] === STRONG) stack.push(i); }
    while (stack.length) {
      const i = stack.pop();
      const x = i % w, y = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const ni = ny * w + nx;
          if (edges[ni] === WEAK) { edges[ni] = STRONG; stack.push(ni); }
        }
      }
    }
    // Suppress remaining weak edges
    for (let i = 0; i < N; i++) { if (edges[i] === WEAK) edges[i] = 0; }

    return edges;
  }

  /* ═══════════════════════════════════════════════════════
     4. MORPHOLOGICAL OPERATIONS
     ═══════════════════════════════════════════════════════ */
  function morphDilate(bin, w, h, r) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let mx = 0;
        for (let dy = -r; dy <= r && !mx; dy++) {
          for (let dx = -r; dx <= r && !mx; dx++) {
            const nx = Math.min(w - 1, Math.max(0, x + dx));
            const ny = Math.min(h - 1, Math.max(0, y + dy));
            if (bin[ny * w + nx]) mx = 255;
          }
        }
        out[y * w + x] = mx;
      }
    }
    return out;
  }

  function morphErode(bin, w, h, r) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let mn = 255;
        for (let dy = -r; dy <= r && mn; dy++) {
          for (let dx = -r; dx <= r && mn; dx++) {
            const nx = Math.min(w - 1, Math.max(0, x + dx));
            const ny = Math.min(h - 1, Math.max(0, y + dy));
            if (!bin[ny * w + nx]) mn = 0;
          }
        }
        out[y * w + x] = mn;
      }
    }
    return out;
  }

  // Close = Dilate then Erode
  function morphClose(bin, w, h, r) {
    return morphErode(morphDilate(bin, w, h, r), w, h, r);
  }

  /* ═══════════════════════════════════════════════════════
     5. FIND CONTOURS  (BFS – Suzuki-Abe simplified)
     ═══════════════════════════════════════════════════════ */
  function findContours(edges, w, h, minLen = 30) {
    const visited = new Uint8Array(w * h);
    const contours = [];

    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const idx = y * w + x;
        if (!edges[idx] || visited[idx]) continue;

        // BFS / flood-fill on edge pixels
        const pts = [];
        const queue = [idx];
        visited[idx] = 1;

        while (queue.length) {
          const cur = queue.pop();
          pts.push(cur);
          const cx = cur % w, cy = (cur / w) | 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (!dx && !dy) continue;
              const nx = cx + dx, ny = cy + dy;
              if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
              const ni = ny * w + nx;
              if (edges[ni] && !visited[ni]) { visited[ni] = 1; queue.push(ni); }
            }
          }
        }

        if (pts.length >= minLen) {
          contours.push(pts.map(p => ({ x: p % w, y: (p / w) | 0 })));
        }
      }
    }
    return contours;
  }

  /* ═══════════════════════════════════════════════════════
     6. CONVEX HULL  (Andrew's Monotone Chain)
     ═══════════════════════════════════════════════════════ */
  function convexHull(pts) {
    if (pts.length < 3) return pts.slice();

    const sorted = pts.slice().sort((a, b) => a.x !== b.x ? a.x - b.x : a.y - b.y);

    function cross(O, A, B) {
      return (A.x - O.x) * (B.y - O.y) - (A.y - O.y) * (B.x - O.x);
    }

    const lower = [];
    for (const p of sorted) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
        lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = sorted.length - 1; i >= 0; i--) {
      const p = sorted[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
        upper.pop();
      upper.push(p);
    }
    lower.pop(); upper.pop();
    return lower.concat(upper);
  }

  /* ═══════════════════════════════════════════════════════
     7. RAMER-DOUGLAS-PEUCKER  (approxPolyDP)
     ═══════════════════════════════════════════════════════ */
  function rdp(pts, eps) {
    if (pts.length < 3) return pts.slice();

    let maxD = 0, maxI = 0;
    const start = pts[0], end = pts[pts.length - 1];
    const dx = end.x - start.x, dy = end.y - start.y;
    const linLen = Math.sqrt(dx * dx + dy * dy);

    for (let i = 1; i < pts.length - 1; i++) {
      const d = linLen > 0
        ? Math.abs(dy * pts[i].x - dx * pts[i].y + end.x * start.y - end.y * start.x) / linLen
        : euclid(pts[i], start);
      if (d > maxD) { maxD = d; maxI = i; }
    }

    if (maxD > eps) {
      const left = rdp(pts.slice(0, maxI + 1), eps);
      const right = rdp(pts.slice(maxI), eps);
      return left.slice(0, -1).concat(right);
    }
    return [start, end];
  }

  /* ═══════════════════════════════════════════════════════
     8. EUCLIDEAN DISTANCE
     ═══════════════════════════════════════════════════════ */
  function euclid(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function polyPerimeter(pts) {
    let p = 0;
    for (let i = 0; i < pts.length; i++) {
      p += euclid(pts[i], pts[(i + 1) % pts.length]);
    }
    return p;
  }

  function polyArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length;
      a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
    }
    return Math.abs(a) / 2;
  }

  /* ═══════════════════════════════════════════════════════
     ORDER CORNERS  →  [TL, TR, BR, BL]  (counter-clockwise)
     • TL = أصغر مجموع (x+y)        — أعلى-يسار
     • BR = أكبر مجموع (x+y)        — أسفل-يمين
     • TR = أكبر فرق (x-y)          — أعلى-يمين
     • BL = أصغر فرق (x-y)          — أسفل-يسار
     • التحقق من الاتجاه: cross(tl→tr→br) يجب أن يكون > 0
       في نظام الإحداثيات حيث y ينزل للأسفل (canvas)
     ═══════════════════════════════════════════════════════ */
  function orderCorners(pts) {
    const sums = pts.map(p => p.x + p.y);
    const diffs = pts.map(p => p.x - p.y);
    let ordered = [
      pts[sums.indexOf(Math.min(...sums))],   // TL
      pts[diffs.indexOf(Math.max(...diffs))],  // TR
      pts[sums.indexOf(Math.max(...sums))],    // BR
      pts[diffs.indexOf(Math.min(...diffs))]   // BL
    ];
    // التحقق من الاتجاه: cross product (TR-TL) × (BR-TR)
    // في نظام canvas حيث y للأسفل، CCW يعطي cross < 0
    const [tl, tr, br] = ordered;
    const cross = (tr.x - tl.x) * (br.y - tr.y) - (tr.y - tl.y) * (br.x - tr.x);
    if (cross > 0) {
      // عكس عقارب الساعة (CCW) — نعكس TR و BL لجعلها CW متوافقاً مع canvas
      ordered = [ordered[0], ordered[3], ordered[2], ordered[1]];
    }
    return ordered;
  }

  /* ═══════════════════════════════════════════════════════
     9A. GET PERSPECTIVE TRANSFORM  (Homography 3×3)
         Gaussian Elimination – 8 DOF system
     ═══════════════════════════════════════════════════════ */
  function getPerspectiveTransform(srcPts, dstPts) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const { x: sx, y: sy } = srcPts[i];
      const { x: dx, y: dy } = dstPts[i];
      A.push([sx, sy, 1, 0, 0, 0, -dx * sx, -dx * sy]);
      A.push([0, 0, 0, sx, sy, 1, -dy * sx, -dy * sy]);
      b.push(dx);
      b.push(dy);
    }
    const h = gaussElim(A, b);
    if (!h) return null;
    return [
      [h[0], h[1], h[2]],
      [h[3], h[4], h[5]],
      [h[6], h[7], 1.0]
    ];
  }

  function gaussElim(A, b) {
    const n = 8;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let col = 0; col < n; col++) {
      // Partial pivot
      let maxRow = col;
      for (let row = col + 1; row < n; row++) {
        if (Math.abs(M[row][col]) > Math.abs(M[maxRow][col])) maxRow = row;
      }
      [M[col], M[maxRow]] = [M[maxRow], M[col]];
      if (Math.abs(M[col][col]) < 1e-10) return null;
      // Eliminate
      for (let row = 0; row < n; row++) {
        if (row === col) continue;
        const f = M[row][col] / M[col][col];
        for (let k = col; k <= n; k++) M[row][k] -= f * M[col][k];
      }
    }
    return M.map((row, i) => row[n] / row[i]);
  }

  /* ═══════════════════════════════════════════════════════
     9B. WARP PERSPECTIVE
         Inverse mapping + bilinear interpolation
     ═══════════════════════════════════════════════════════ */
  function warpPerspective(srcData, srcW, srcH, orderedCorners, dstW, dstH) {
    const [tl, tr, br, bl] = orderedCorners;

    // Forward: corner → destination rectangle
    // Inverse homography: dst pixel → src pixel
    const H = getPerspectiveTransform(
      [{ x: 0, y: 0 }, { x: dstW, y: 0 }, { x: dstW, y: dstH }, { x: 0, y: dstH }],
      [tl, tr, br, bl]
    );
    if (!H) return null;

    const sd = srcData.data;
    const out = new Uint8ClampedArray(dstW * dstH * 4);

    for (let y = 0; y < dstH; y++) {
      for (let x = 0; x < dstW; x++) {
        const denom = H[2][0] * x + H[2][1] * y + H[2][2];
        const sx = (H[0][0] * x + H[0][1] * y + H[0][2]) / denom;
        const sy = (H[1][0] * x + H[1][1] * y + H[1][2]) / denom;

        // Bilinear interpolation
        const x0 = Math.floor(sx), y0 = Math.floor(sy);
        const x1 = x0 + 1, y1 = y0 + 1;
        const fx = sx - x0, fy = sy - y0;

        const oi = (y * dstW + x) * 4;

        if (x0 < 0 || y0 < 0 || x1 >= srcW || y1 >= srcH) {
          out[oi] = out[oi + 1] = out[oi + 2] = 255;
          out[oi + 3] = 255;
          continue;
        }

        const i00 = (y0 * srcW + x0) * 4;
        const i10 = (y0 * srcW + x1) * 4;
        const i01 = (y1 * srcW + x0) * 4;
        const i11 = (y1 * srcW + x1) * 4;

        for (let c = 0; c < 4; c++) {
          out[oi + c] =
            sd[i00 + c] * (1 - fx) * (1 - fy) +
            sd[i10 + c] * fx * (1 - fy) +
            sd[i01 + c] * (1 - fx) * fy +
            sd[i11 + c] * fx * fy + 0.5 | 0;
        }
      }
    }
    return new ImageData(out, dstW, dstH);
  }

  /* ═══════════════════════════════════════════════════════
     FIND BEST QUADRILATERAL — pyimagesearch-style
     ──────────────────────────────────────────────
     خوارزمية معتمدة من pyimagesearch Document Scanner:
     1. نحسب convex hull لكل contour
     2. نطبّق approxPolyDP (RDP) مع epsilon=2% من المحيط
     3. إذا حصلنا على 4 زوايا نتحقق من:
        a) المساحة لا تقل عن 5% من الصورة
        b) نسبة العرض/الطول معقولة (0.3 - 4.0)
        c) الزوايا الأربع ليست متداخلة (valid quadrilateral)
     4. نختار أكبر quadrilateral صالح
     ═══════════════════════════════════════════════════════ */
  function findBestQuad(contours, pw, ph) {
    const minArea = pw * ph * 0.02; // 2% min area (زيادة فرص العثور على رباعي صالح)

    let best = null, bestArea = 0;

    // فرز contours حسب المساحة (الأكبر أولاً) — هذا يسرّع إيجاد أفضل نتيجة
    const sortedContours = contours
      .filter(c => c.length >= 5)
      .map(c => ({ pts: c, area: Math.abs(polyArea(c)) }))
      .filter(c => c.area > minArea)
      .sort((a, b) => b.area - a.area)
      .slice(0, 25); // أفضل 25 contours (زيادة فرص إيجاد رباعي صحيح)


    for (const { pts: contour } of sortedContours) {
      // 1. Convex hull
      const hull = convexHull(contour);
      if (hull.length < 4) continue;

      // 2. perimeter
      const perim = polyPerimeter(hull);

      // 3. approxPolyDP مع epsilon = 2% من المحيط (نسبة pyimagesearch)
      const eps = perim * 0.02;
      const closed = [...hull, hull[0]];
      const approx = rdp(closed, eps);
      const corners = approx.length > 1 && approx[0].x === approx[approx.length - 1].x &&
        approx[0].y === approx[approx.length - 1].y
        ? approx.slice(0, -1)
        : approx.slice();

      if (corners.length !== 4) continue;

      // 4a. فحص المساحة
      const area = polyArea(corners);
      if (area < minArea) continue;

      // 4b. فحص نسبة العرض/الطول (aspect ratio)
      //      يجب أن يكون المستمسك بنسبة معقولة (0.3 إلى 4.0)
      const rect = boundingRect(corners);
      const aspect = rect.w / rect.h;
      if (aspect < 0.3 || aspect > 4.0) continue;

      // 4c. فحص صلاحية المضلّع (no self-intersection)
      if (!isValidQuad(corners)) continue;

      // 5. اختر الأكبر
      if (area > bestArea) {
        bestArea = area;
        best = corners;
      }
    }
    return best;
  }

  // bounding box لمضلّع
  function boundingRect(pts) {
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  // فحص صلاحية quadrilateral (لا يحتوي على تقاطع ذاتي)
  function isValidQuad(pts) {
    // 4 جوانب
    const edges = [];
    for (let i = 0; i < 4; i++) {
      const a = pts[i], b = pts[(i + 1) % 4];
      edges.push({
        x1: a.x, y1: a.y, x2: b.x, y2: b.y
      });
    }
    // فحص عدم تقاطع الأضداد
    return !segmentsIntersect(edges[0], edges[2]) && !segmentsIntersect(edges[1], edges[3]);
  }

  function segmentsIntersect(s1, s2) {
    const d1 = direction(s2.x1, s2.y1, s2.x2, s2.y2, s1.x1, s1.y1);
    const d2 = direction(s2.x1, s2.y1, s2.x2, s2.y2, s1.x2, s1.y2);
    const d3 = direction(s1.x1, s1.y1, s1.x2, s1.y2, s2.x1, s2.y1);
    const d4 = direction(s1.x1, s1.y1, s1.x2, s1.y2, s2.x2, s2.y2);

    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;

    if (d1 === 0 && onSegment(s2.x1, s2.y1, s2.x2, s2.y2, s1.x1, s1.y1)) return true;
    if (d2 === 0 && onSegment(s2.x1, s2.y1, s2.x2, s2.y2, s1.x2, s1.y2)) return true;
    if (d3 === 0 && onSegment(s1.x1, s1.y1, s1.x2, s1.y2, s2.x1, s2.y1)) return true;
    if (d4 === 0 && onSegment(s1.x1, s1.y1, s1.x2, s1.y2, s2.x2, s2.y2)) return true;

    return false;
  }

  function direction(x1, y1, x2, y2, x3, y3) {
    return (x3 - x1) * (y2 - y1) - (x2 - x1) * (y3 - y1);
  }

  function onSegment(x1, y1, x2, y2, x3, y3) {
    return x3 >= Math.min(x1, x2) && x3 <= Math.max(x1, x2) &&
      y3 >= Math.min(y1, y2) && y3 <= Math.max(y1, y2);
  }

  /* ═══════════════════════════════════════════════════════
     VISUAL OVERLAY DRAWING
     ═══════════════════════════════════════════════════════ */
  function drawOverlay(overlayCanvas, mainCanvas, corners, w, h) {
    overlayCanvas.width = mainCanvas.offsetWidth;
    overlayCanvas.height = mainCanvas.offsetHeight;
    const ctx = overlayCanvas.getContext('2d');
    ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

    const sx = mainCanvas.offsetWidth / w;
    const sy = mainCanvas.offsetHeight / h;

    const sc = corners.map(p => ({ x: p.x * sx, y: p.y * sy }));

    // Draw quadrilateral
    ctx.strokeStyle = '#6366f1';
    ctx.lineWidth = 3;
    ctx.shadowColor = 'rgba(99,102,241,0.7)';
    ctx.shadowBlur = 12;
    ctx.setLineDash([10, 5]);
    ctx.beginPath();
    ctx.moveTo(sc[0].x, sc[0].y);
    for (let i = 1; i < sc.length; i++) ctx.lineTo(sc[i].x, sc[i].y);
    ctx.closePath();
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.setLineDash([]);

    // Corner labels
    const labels = ['TL', 'TR', 'BR', 'BL'];
    const labelColors = ['#10b981', '#06b6d4', '#f59e0b', '#ec4899'];
    sc.forEach((p, i) => {
      // Glow circle
      ctx.fillStyle = labelColors[i];
      ctx.shadowColor = labelColors[i];
      ctx.shadowBlur = 16;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      // White inner
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      ctx.fill();
      // Label
      ctx.fillStyle = labelColors[i];
      ctx.font = 'bold 11px monospace';
      ctx.fillText(labels[i], p.x + 14, p.y + 4);
    });
  }

  /* ═══════════════════════════════════════════════════════
     MAIN DETECT FUNCTION
     Returns: { corners: [{x,y}×4], scale, pw, ph }
              corners are in ORIGINAL canvas coordinates
     ═══════════════════════════════════════════════════════ */
  async function detect(canvas, onProgress) {
    const W = canvas.width, H = canvas.height;
    const prog = onProgress || (() => { });

    // ── Scale down for processing ─────────────────
    prog(5, 'تجهيز الصورة...');
    await tick();
    const scale = Math.min(1, 900 / Math.max(W, H));
    const pw = Math.round(W * scale), ph = Math.round(H * scale);

    const off = document.createElement('canvas');
    off.width = pw; off.height = ph;
    off.getContext('2d').drawImage(canvas, 0, 0, pw, ph);
    const imgData = off.getContext('2d').getImageData(0, 0, pw, ph);

    // ── 1. Grayscale ──────────────────────────────
    prog(10, 'تحويل الصورة إلى تدرج الرمادي...');
    await tick();
    let gray = toGray(imgData.data, pw, ph);

    // ── 2. Gaussian Blur ──────────────────────────
    prog(18, 'Gaussian Blur — إزالة الضوضاء...');
    await tick();

    // حاولين blur لزيادة فرصة ظهور الحواف بوضوح
    // (الأول الافتراضي، والثاني إذا فشل الكشف)
    const grayBase = gaussianBlur(gray, pw, ph, 2);

    // Auto thresholds based on Otsu (على النسخة الأساسية)
    const otsuTBase = otsuThreshold(grayBase);

    // ── محاولات كشف متتابعة (Fallback) ─────────────
    const candidates = [
      // (lowMul, highMul, dilateR, closeR, minLenContours)
      [0.40, 1.20, 2, 3, 25],
      [0.36, 1.15, 2, 3, 22],
      // أكثر رقة للحواف
      [0.30, 1.00, 2, 3, 18],
      // تقوية التوصيل
      [0.35, 1.10, 3, 4, 20],
      // تقليل minLen لالتقاط contours أقصر
      [0.28, 0.95, 3, 4, 15],
      // مسار آخر للتوازن بين noise وedge continuity
      [0.33, 1.05, 2, 4, 18],
    ];

    let bestQuad = null;

    for (let attempt = 0; attempt < candidates.length; attempt++) {
      const [lowMul, highMul, dilateR, closeR, minLenContours] = candidates[attempt];

      if (attempt === 0) gray = grayBase;
      else gray = gaussianBlur(grayBase, pw, ph, attempt === 1 ? 2 : 3);

      prog(32 + attempt * 8, 'Canny + تحسين الحواف (محاولة ' + (attempt + 1) + ')...');
      await tick();

      const otsuT = attempt === 0 ? otsuTBase : otsuThreshold(gray);
      const low = Math.max(10, otsuT * lowMul);
      const high = Math.min(255, otsuT * highMul);

      let edges = canny(gray, pw, ph, low, high);

      prog(50 + attempt * 8, 'Morphological Close — توصيل الحواف (محاولة ' + (attempt + 1) + ')...');
      await tick();
      edges = morphDilate(edges, pw, ph, dilateR);
      edges = morphClose(edges, pw, ph, closeR);

      prog(65 + attempt * 6, 'findContours — استخراج الخطوط المحيطية...');
      await tick();
      const contours = findContours(edges, pw, ph, minLenContours);

      if (!contours.length) continue;

      prog(80 + attempt * 4, 'Convex Hull + RDP — تحديد الزوايا الأربع...');
      await tick();

      const quad = findBestQuad(contours, pw, ph);
      if (quad) {
        bestQuad = quad;
        break;
      }
    }

    if (!bestQuad) {
      prog(100, 'لم يتم التعرف على وثيقة واضحة');
      return null;
    }

    // ── 8. Scale corners to original resolution ───
    prog(90, 'حساب المسافات الأوكليدية...');
    await tick();
    const corners = bestQuad.map(p => ({
      x: p.x / scale,
      y: p.y / scale
    }));

    prog(100, 'اكتمل الكشف ✓');
    return { corners, pw, ph, scale };
  }

  /* ═══════════════════════════════════════════════════════
     APPLY WARP to main canvas
     ──────────────────────────────────────────────
     • يأخذ الزوايا الأربع المرتبة [TL, TR, BR, BL]
     • يحسب أبعاد المُستطَح (الضلع العلوي والجانب الأيسر)
     • يطبّق homography لتصحيح المنظور وقص المستمسك
     ═══════════════════════════════════════════════════════ */
  async function applyWarp(canvas, corners) {
    const W = canvas.width, H = canvas.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const imgData = ctx.getImageData(0, 0, W, H);

    const ordered = orderCorners(corners);
    const [tl, tr, br, bl] = ordered;

    // ── 8. Euclidean distances → أبعاد المُسطّح ─────
    // dstW = متوسط الضلعين الأفقيين العلوي والسفلي (لتجنب الانحراف)
    // dstH = متوسط الضلعين العموديين الأيسر والأيمن
    const topW = euclid(tl, tr);
    const botW = euclid(bl, br);
    const leftH = euclid(tl, bl);
    const rightH = euclid(tr, br);
    const dstW = Math.round(Math.max(topW, botW));
    const dstH = Math.round(Math.max(leftH, rightH));

    if (dstW < 50 || dstH < 50) return false;

    // ── 9. warpPerspective ────────────────────────
    const result = warpPerspective(imgData, W, H, ordered, dstW, dstH);
    if (!result) return false;

    canvas.width = dstW;
    canvas.height = dstH;
    canvas.getContext('2d').putImageData(result, 0, 0);
    return { dstW, dstH };
  }

  /* ═══════════════════════════════════════════════════════
     HELPERS
     ═══════════════════════════════════════════════════════ */
  function tick() { return new Promise(r => setTimeout(r, 0)); }

  /* ── Public API ────────────────────────────────────── */
  return { detect, applyWarp, drawOverlay, orderCorners, euclid };

})();

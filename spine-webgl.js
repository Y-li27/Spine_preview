/*
 * CGSS Spine プレビュー WebGL レンダラー (カスタム描画、spine-ts WebGL パッケージに依存しない)。
 * spine-core の Skeleton/Attachment データを直接使用:
 *   - MeshAttachment.computeWorldVertices(slot, 0, len, world, 0, 2)
 *   - RegionAttachment.computeWorldVertices(bone, world, 0, 2)
 * 三角形ごとに頂点を共有してラスタライズ -> Canvas 2D clip のように三角形の境界線にアンチエイリアスの隙間が発生しません。
 *
 * 使い方:
 *   var glRenderer = new CGSSWebGLRenderer(canvas);       // 内部で WebGL コンテキストを生成
 *   glRenderer.triangleRendering = true;                   // プレビューページの仕様との互換性維持のため残す
 *   glRenderer.setTransform(scale, tx, ty);                // ワールド -> キャンバスピクセル
 *   glRenderer.clear(0.2, 0.2, 0.2, 1);                    // 背景クリア
 *   glRenderer.draw(skeleton);
 */
(function (global) {
  'use strict';

  var VERT_SRC =
    'attribute vec2 aPos;' +
    'attribute vec2 aUV;' +
    'attribute vec4 aColor;' +
    'varying vec2 vUV;' +
    'varying vec4 vColor;' +
    'void main(){ gl_Position = vec4(aPos, 0.0, 1.0); vUV = aUV; vColor = aColor; }';

  var FRAG_SRC =
    'precision mediump float;' +
    'varying vec2 vUV;' +
    'varying vec4 vColor;' +
    'uniform sampler2D uTex;' +
    // 输出预乘颜色，与 canvas 'lighter'/'source-over' 的合成规则一致
    'void main(){ vec4 t = texture2D(uTex, vUV);' +
    'float a = t.a * vColor.a;' +
    'gl_FragColor = vec4(t.rgb * vColor.rgb * a, a); }';

  function compileShader(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error('shader compile: ' + gl.getShaderInfoLog(sh));
    }
    return sh;
  }

  function CGSSWebGLRenderer(canvas, opts) {
    opts = opts || {};
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: !!opts.preserveDrawingBuffer,
      antialias: false
    }) || canvas.getContext('experimental-webgl', {
      alpha: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: !!opts.preserveDrawingBuffer,
      antialias: false
    });
    if (!this.gl) throw new Error('WebGL 不可用');
    var gl = this.gl;
    this.program = gl.createProgram();
    gl.attachShader(this.program, compileShader(gl, gl.VERTEX_SHADER, VERT_SRC));
    gl.attachShader(this.program, compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC));
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      throw new Error('program link: ' + gl.getProgramInfoLog(this.program));
    }
    this.aPos = gl.getAttribLocation(this.program, 'aPos');
    this.aUV = gl.getAttribLocation(this.program, 'aUV');
    this.aColor = gl.getAttribLocation(this.program, 'aColor');
    this.uTex = gl.getUniformLocation(this.program, 'uTex');

    this.vbo = gl.createBuffer();
    this.texCache = {};
    this.width = canvas.width || 1;
    this.height = canvas.height || 1;
    this.triangleRendering = true; // 兼容旧调用
    this._scale = 1; this._tx = 0; this._ty = 0;
    this._batch = [];
  }

  CGSSWebGLRenderer.prototype.resize = function (w, h) {
    this.width = w; this.height = h;
    this.canvas.width = w; this.canvas.height = h;
    this.gl.viewport(0, 0, w, h);
  };

  CGSSWebGLRenderer.prototype.setTransform = function (scale, tx, ty) {
    this._scale = scale; this._tx = tx; this._ty = ty;
  };

  CGSSWebGLRenderer.prototype.clear = function (r, g, b, a) {
    var gl = this.gl;
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(r, g, b, a);
    gl.clear(gl.COLOR_BUFFER_BIT);
  };

  CGSSWebGLRenderer.prototype._texture = function (img) {
    if (!img) return null;
    if (this.texCache[img.__cgssTexId]) return this.texCache[img.__cgssTexId];
    var gl = this.gl;
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (!img.__cgssTexId) img.__cgssTexId = Math.random().toString(36).slice(2);
    this.texCache[img.__cgssTexId] = tex;
    return tex;
  };

  CGSSWebGLRenderer.prototype._expand = function (x0, y0, u0, v0, x1, y1, u1, v1, x2, y2, u2, v2) {
    var pad = 0.85 / (Math.abs(this._scale) || 1);
    var cx = (x0 + x1 + x2) / 3, cy = (y0 + y1 + y2) / 3;
    var cu = (u0 + u1 + u2) / 3, cv = (v0 + v1 + v2) / 3;
    function g(x, y, u, v) {
      var dx = x - cx, dy = y - cy, len = Math.sqrt(dx * dx + dy * dy) || 1;
      return [x + dx / len * pad, y + dy / len * pad, cu + (u - cu) * 0.998, cv + (v - cv) * 0.998];
    }
    return [g(x0, y0, u0, v0), g(x1, y1, u1, v1), g(x2, y2, u2, v2)];
  };

  CGSSWebGLRenderer.prototype._push = function (tex, x, y, u, v, cr, cg, cb, ca) {
    // 世界->画布像素
    var sx = x * this._scale + this._tx;
    var sy = y * this._scale + this._ty;
    // 像素->NDC（y 向下）
    var nx = sx / this.width * 2 - 1;
    var ny = 1 - sy / this.height * 2;
    this._batch.push(nx, ny, u, v, cr, cg, cb, ca);
  };

  CGSSWebGLRenderer.prototype._flush = function () {
    if (!this._batch.length) return;
    var gl = this.gl;
    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(this._batch), gl.DYNAMIC_DRAW);
    var stride = 8 * 4;
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(this.aUV);
    gl.vertexAttribPointer(this.aUV, 2, gl.FLOAT, false, stride, 8);
    gl.enableVertexAttribArray(this.aColor);
    gl.vertexAttribPointer(this.aColor, 4, gl.FLOAT, false, stride, 16);
    gl.uniform1i(this.uTex, 0);
    gl.drawArrays(gl.TRIANGLES, 0, this._batch.length / 8);
    this._batch.length = 0;
  };

  CGSSWebGLRenderer.prototype._setBlend = function (mode) {
    var gl = this.gl;
    if (mode === 1) { // additive
      gl.blendFunc(gl.ONE, gl.ONE);
    } else if (mode === 2) { // multiply
      gl.blendFunc(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA);
    } else if (mode === 3) { // screen
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR);
    } else {
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }
  };

  CGSSWebGLRenderer.prototype.draw = function (skeleton) {
    var gl = this.gl;
    gl.enable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.program);

    var skeletonColor = skeleton.color;
    var drawOrder = skeleton.drawOrder;
    var currentTex = null, currentBlend = -1;
    var self = this;

    function beginTex(tex, blend) {
      if (currentTex === tex && currentBlend === blend) return;
      self._flush();
      currentTex = tex;
      currentBlend = blend;
      if (tex) gl.bindTexture(gl.TEXTURE_2D, tex);
      self._setBlend(blend);
    }

    for (var i = 0, n = drawOrder.length; i < n; i++) {
      var slot = drawOrder[i];
      var attachment = slot.attachment;
      if (!attachment) continue;
      var slotColor = slot.color;
      var attachmentColor = attachment.color;
      if (!attachmentColor) attachmentColor = { r: 1, g: 1, b: 1, a: 1 };
      var cr = skeletonColor.r * slotColor.r * attachmentColor.r;
      var cg = skeletonColor.g * slotColor.g * attachmentColor.g;
      var cb = skeletonColor.b * slotColor.b * attachmentColor.b;
      var ca = skeletonColor.a * slotColor.a * attachmentColor.a;
      var blend = slot.data.blendMode || 0;

      if (attachment instanceof spine.MeshAttachment) {
        var mesh = attachment;
        if (!mesh.region || !mesh.region.renderObject) continue;
        var tex = this._texture(mesh.region.renderObject.texture.getImage());
        if (!tex) continue;
        var wl = mesh.worldVerticesLength || mesh.vertices.length;
        var world = this._world || new Float32Array(0);
        var need = wl;
        if (world.length < need) world = new Float32Array(need);
        this._world = world;
        mesh.computeWorldVertices(slot, 0, wl, world, 0, 2);
        var uvs = mesh.uvs, tris = mesh.triangles;
        beginTex(tex, blend);
        for (var t = 0; t < tris.length; t += 3) {
          var i0 = tris[t] * 2, i1 = tris[t + 1] * 2, i2 = tris[t + 2] * 2;
          var ex = this._expand(
            world[i0], world[i0 + 1], uvs[i0], uvs[i0 + 1],
            world[i1], world[i1 + 1], uvs[i1], uvs[i1 + 1],
            world[i2], world[i2 + 1], uvs[i2], uvs[i2 + 1]);
          for (var p = 0; p < 3; p++) this._push(tex, ex[p][0], ex[p][1], ex[p][2], ex[p][3], cr, cg, cb, ca);
        }
      } else if (attachment instanceof spine.RegionAttachment) {
        var region = attachment;
        var tex2 = this._texture(region.region.renderObject.texture.getImage());
        if (!tex2) continue;
        var world4 = this._world4 || new Float32Array(8);
        this._world4 = world4;
        region.computeWorldVertices(slot.bone, world4, 0, 2);
        var uvs2 = region.uvs;
        beginTex(tex2, blend);
        var quad = [0, 1, 2, 0, 2, 3];
        for (var q = 0; q < quad.length; q += 3) {
          var a = quad[q] * 2, b = quad[q + 1] * 2, c = quad[q + 2] * 2;
          var ex2 = this._expand(
            world4[a], world4[a + 1], uvs2[a], uvs2[a + 1],
            world4[b], world4[b + 1], uvs2[b], uvs2[b + 1],
            world4[c], world4[c + 1], uvs2[c], uvs2[c + 1]);
          for (var p2 = 0; p2 < 3; p2++) this._push(tex2, ex2[p2][0], ex2[p2][1], ex2[p2][2], ex2[p2][3], cr, cg, cb, ca);
        }
      }
    }
    this._flush();
  };

  global.CGSSWebGLRenderer = CGSSWebGLRenderer;
})(typeof window !== 'undefined' ? window : globalThis);
Grokの応答が完了しました

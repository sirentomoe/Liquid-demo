/* ============================================================
   液态玻璃 WebGL 增强模块(方案4)—— 与 DOM 方案完全解耦
   职责:全屏画布绘制背景 + 弹窗边缘环内真折射(SDF法线 + 色散)
   开: LiquidGlassWebGL.enable()  关: disable()  切换: toggle()
   彻底移除本效果:删除 index.html 中对本文件的 <script> 引用
   ============================================================ */
(function () {
  const modal = document.getElementById('modal');
  let canvas = null, gl = null, prog = null, u = {}, rafId = 0;

  const VERT = 'attribute vec2 aPos;void main(){gl_Position=vec4(aPos,0.,1.);}';

  const FRAG = [
    'precision mediump float;',
    'uniform sampler2D uTex;',
    'uniform vec2 uRes;uniform vec2 uImgRes;uniform vec4 uRect;',
    'uniform float uRadius;uniform float uEdge;uniform float uStrength;uniform float uChroma;uniform float uDebug;uniform float uTestBg;uniform float uStripe;',
    // CSS background cover 映射:与 body {background:center/cover fixed} 一致
    'vec2 coverUv(vec2 p){float s=max(uRes.x/uImgRes.x,uRes.y/uImgRes.y);',
    '  vec2 off=(uRes-uImgRes*s)*0.5;return (p-off)/(uImgRes*s);}',
    // 圆角矩形 SDF
    'float sdRoundRect(vec2 p,vec2 b,float r){vec2 q=abs(p)-b+r;',
    '  return length(max(q,0.))+min(max(q.x,q.y),0.)-r;}',
    // 测试条纹:与 CSS 版同色,周期 uStripe(物理px)
    'vec3 testPattern(vec2 p){vec2 m=mod(p,vec2(uStripe));float h=uStripe*0.5;',
    '  if(m.x<h) return (m.y<h) ? vec3(1.0,0.231,0.188) : vec3(1.0);',
    '  else return (m.y<h) ? vec3(0.0,0.478,1.0) : vec3(0.102);}',
    // 统一采样入口:条纹模式与纹理模式都走这里,折射/色散共用
    'vec3 sampleBg(vec2 pos){',
    '  if(uTestBg>0.5) return testPattern(pos);',
    '  return texture2D(uTex,coverUv(pos)).rgb;}',
    'void main(){',
    '  vec2 p=gl_FragCoord.xy;',
    '  vec2 c=uRect.xy+uRect.zw*0.5;',           // 弹窗中心(gl坐标系,y向上)
    '  vec2 local=p-c;',
    '  vec2 b=uRect.zw*0.5-1.0;',
    '  float d=sdRoundRect(local,b,uRadius);',
    '  if(uDebug>0.5 && d<0.0 && d>-uEdge*1.2){gl_FragColor=vec4(1.0,0.0,0.0,1.0);return;}', // 调试:环画红
    '  if(d>0.0){gl_FragColor=vec4(sampleBg(p),1.0);return;}',  // 弹窗外:原背景
    // 边缘环:高斯长尾 + 法线折射(与 SVG 贴图同一曲线)
    '  float tt=-d/(uEdge*1.1);float t=exp(-tt*tt*3.5);',
    '  vec2 q=abs(local)-(b-uRadius);vec2 ax=max(q,0.);vec2 n;',
    '  if(ax.x>0.||ax.y>0.){n=normalize(ax);}',
    '  else if(q.x>q.y){n=vec2(sign(local.x),0.);}',
    '  else{n=vec2(0.,sign(local.y));}',
    '  vec2 disp=n*t*uStrength;',
    // RGB 分离折射 = 色散
    '  vec3 col;',
    '  col.r=sampleBg(p+disp*(1.0-uChroma)).r;',
    '  col.g=sampleBg(p+disp).g;',
    '  col.b=sampleBg(p+disp*(1.0+uChroma)).b;',
    '  gl_FragColor=vec4(col,1.0);',
    '}'
  ].join('\n');

  function initGL() {
    gl = canvas.getContext('webgl', { antialias: false });
    if (!gl) return false;
    function compile(type, src) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
        console.error('[LiquidGlass] shader error:', gl.getShaderInfoLog(s));
      return s;
    }
    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
      console.error('[LiquidGlass] link error:', gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    ['uRes','uImgRes','uRect','uRadius','uEdge','uStrength','uChroma','uTex','uDebug','uTestBg','uStripe']
      .forEach(k => u[k] = gl.getUniformLocation(prog, k));
    return true;
  }

  function loadTexture(cb) {
    const img = new Image();
    img.onload = () => {
      // 超过 GPU 最大纹理尺寸时先缩小,否则 texImage2D 静默失败
      const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      let src = img, iw = img.naturalWidth, ih = img.naturalHeight;
      if (iw > maxTex || ih > maxTex) {
        const k = maxTex / Math.max(iw, ih);
        iw = Math.floor(iw * k); ih = Math.floor(ih * k);
        const cv = document.createElement('canvas');
        cv.width = iw; cv.height = ih;
        cv.getContext('2d').drawImage(img, 0, 0, iw, ih);
        src = cv;
      }
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); // 图像y翻转,与gl坐标系对齐
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      u.img = [iw, ih];
      console.log('[LiquidGlass] ready | dpr:', window.devicePixelRatio,
        '| maxTex:', maxTex, '| tex:', iw + 'x' + ih,
        '| img:', img.naturalWidth + 'x' + img.naturalHeight);
      cb();
    };
    img.src = window.LIQUID_GLASS_BG;
  }

  function readParams() {
    return {
      radius: parseFloat(document.getElementById('glass-radius').value),
      edge: parseFloat(document.getElementById('edge').value) * 1.2, // mask余量一致
      strength: parseFloat(document.getElementById('refract').value),
      chroma: parseFloat(document.getElementById('chroma').value),
    };
  }

  function frame() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vw = window.innerWidth, vh = window.innerHeight;
    if (canvas.width !== vw * dpr || canvas.height !== vh * dpr) {
      canvas.width = vw * dpr; canvas.height = vh * dpr;
      gl.viewport(0, 0, canvas.width, canvas.height);
    }
    const r = modal.getBoundingClientRect();
    const P = readParams();
    // DOM坐标(y向下)→ gl坐标(y向上)
    const rectGL = [r.left * dpr, (vh - r.bottom) * dpr, r.width * dpr, r.height * dpr];
    gl.uniform2f(u.uRes, canvas.width, canvas.height);
    gl.uniform2f(u.uImgRes, u.img[0], u.img[1]);
    gl.uniform4f(u.uRect, ...rectGL);
    gl.uniform1f(u.uRadius, P.radius * dpr);
    gl.uniform1f(u.uEdge, P.edge * dpr);
    gl.uniform1f(u.uStrength, P.strength * 0.5 * dpr); // SVG位移=scale/2,等效
    gl.uniform1f(u.uChroma, P.chroma);
    gl.uniform1f(u.uDebug, document.getElementById('gl-debug').checked ? 1.0 : 0.0);
    gl.uniform1f(u.uTestBg, document.body.classList.contains('test-bg') ? 1.0 : 0.0);
    gl.uniform1f(u.uStripe, 160.0 * dpr);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    rafId = requestAnimationFrame(frame);
  }

  function enable() {
    if (canvas) return true;
    canvas = document.createElement('canvas');
    canvas.className = 'glass-canvas';
    document.body.appendChild(canvas);
    if (!initGL()) { canvas.remove(); canvas = null; return false; }
    document.body.classList.add('webgl-mode');
    loadTexture(() => { frame(); });
    return true;
  }

  function disable() {
    if (!canvas) return;
    cancelAnimationFrame(rafId);
    document.body.classList.remove('webgl-mode');
    canvas.remove(); canvas = null; gl = null;
  }

  window.LiquidGlassWebGL = {
    enable, disable,
    toggle() { return canvas ? (disable(), false) : (enable(), true); },
    isEnabled() { return !!canvas; },
  };
})();








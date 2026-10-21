// Canvas fallback for browsers that cannot initialize the supplied WebGL renderer.
export function mountASCIIFallback(container, canvas, settingsRef, wakeRef) {
  const context = canvas?.getContext('2d');
  if (!context) return undefined;
  const primary = container.querySelector('canvas');
  if (primary) primary.style.display = 'none';
  canvas.style.display = 'block';
  container.dataset.renderer = 'canvas2d';
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let frame = 0, disposed = false, visible = true, previous = 0, time = 0;
  let width = 1, height = 1, ratio = 1;
  function draw() {
    const settings = settingsRef.current;
    const colors = settings.colors || ['#222', '#ddd', '#fff'];
    const glyphs = Array.from(settings.characters || ' .:+xX0#');
    const cell = Math.max(10, settings.cellSize || 16);
    const density = Math.min(1, Math.max(0, settings.density ?? .65));
    const gradient = context.createRadialGradient(width * .5, height * .72, 0, width * .5, height * .72, Math.max(width, height) * .7);
    gradient.addColorStop(0, colors[Math.min(1, colors.length - 1)]);
    gradient.addColorStop(1, colors[0]);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.globalAlpha = Math.min(.3, settings.gradientOpacity ?? .3);
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
    context.font = `${cell * .78}px ${settings.fontFamily || 'ui-monospace, monospace'}`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    for (let row = 0; row < height / cell; row++) {
      for (let column = 0; column < width / cell; column++) {
        const seed = Math.sin(column * 127.1 + row * 311.7) * 43758.5453;
        const random = seed - Math.floor(seed);
        if (random > density) continue;
        const x = (column + .5) * cell, y = (row + .5) * cell;
        const nx = (x / width - .5) * 2, ny = y / height;
        const horizon = .63 + Math.sin(nx * 2.7 + time * .18) * .1 + nx * nx * .17;
        const distance = Math.abs(ny - horizon);
        const wave = .55 + .45 * Math.sin(distance * 57 - time * .8 + nx * 4);
        const envelope = Math.exp(-distance * 5.3) * (.2 + wave * .8);
        const index = Math.min(glyphs.length - 1, Math.floor(envelope * (glyphs.length - 1)));
        context.globalAlpha = envelope * (settings.glyphOpacity ?? .65) * (.55 + random * .45);
        context.fillStyle = colors[Math.min(colors.length - 1, Math.floor(envelope * colors.length))];
        context.fillText(glyphs[index], x, y);
      }
    }
    context.globalAlpha = 1;
  }
  function tick(now) {
    frame = 0;
    if (disposed || !visible || document.hidden) return;
    if (now - previous >= 80) {
      time += Math.min((now - (previous || now)) / 1000, .1) * (settingsRef.current.speed ?? 1);
      previous = now;
      draw();
    }
    if (!reduce) frame = requestAnimationFrame(tick);
  }
  function wake() {
    if (disposed || !visible || document.hidden) return;
    if (reduce) draw();
    else if (!frame) frame = requestAnimationFrame(tick);
  }
  function resize() {
    width = Math.max(1, container.clientWidth);
    height = Math.max(1, container.clientHeight);
    ratio = Math.min(settingsRef.current.dpr || window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    draw();
    wake();
  }
  const resizeObserver = new ResizeObserver(resize);
  const intersection = new IntersectionObserver(entries => {
    visible = entries.some(entry => entry.isIntersecting);
    if (!visible) { cancelAnimationFrame(frame); frame = 0; }
    else { previous = 0; wake(); }
  });
  resizeObserver.observe(container);
  intersection.observe(container);
  document.addEventListener('visibilitychange', wake);
  wakeRef.current = wake;
  resize();
  return () => {
    disposed = true;
    cancelAnimationFrame(frame);
    resizeObserver.disconnect();
    intersection.disconnect();
    document.removeEventListener('visibilitychange', wake);
    wakeRef.current = null;
  };
}
